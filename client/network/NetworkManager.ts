// ============================================
// Network Manager — Socket.IO Client
// ============================================

import { io, Socket } from 'socket.io-client';
import type {
    ServerToClientEvents,
    ClientToServerEvents,
    GameState,
    DeltaGameState,
    DeltaPlayerState,
    PlayerState,
    InputPayload,
    JoinedPayload,
} from '../../shared/types.js';

export class NetworkManager {
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private onStateCallback: ((state: GameState) => void) | null = null;
    private onDeathCallback: ((killerName: string) => void) | null = null;
    private onJoinedCallback: ((data: JoinedPayload) => void) | null = null;
    private onDisconnectCallback: (() => void) | null = null;
    private onReconnectCallback: (() => void) | null = null;
    private onChatMessageCallback: ((data: { name: string; msg: string; timestamp: number }) => void) | null = null;

    // ---- Delta reconstruction state ----
    /**
     * The last full GameState received. Delta packets are merged onto this
     * to produce a complete state before handing it to onStateCallback.
     */
    private cachedFullState: GameState | null = null;
    /**
     * Map of player ID → full PlayerState cached from the last update.
     * Kept in sync with cachedFullState.players for O(1) player lookups during merge.
     */
    private cachedPlayerMap: Map<string, PlayerState> = new Map();
    // Pre-allocated reusable containers for applyDelta (avoid per-tick allocations)
    private _deltaMap: Map<string, DeltaPlayerState> = new Map();
    private _seenIds: Set<string> = new Set();
    private _mergedPlayers: PlayerState[] = [];

    // ---- PlayerState object pool (avoid per-tick allocations) ----
    private _playerPool: PlayerState[] = [];
    private _playerPoolIdx: number = 0;

    playerId: string = '';
    /** The last name passed to join(). Used to re-join automatically after reconnect. */
    private playerName: string = '';
    /** The last seed passed to join(), if any. */
    private playerSeed: number | undefined = undefined;
    /** True once the player has joined at least once this session. */
    private hasJoined: boolean = false;

    // ---- Ping tracking ----
    /** Rolling buffer of the last 3 round-trip measurements (ms). */
    private pingSamples: number[] = [];
    /** Smoothed average of pingSamples. Exposed via getPing(). */
    private currentPing: number = 0;
    /** True while a ping:check is in flight (prevents overlapping probes). */
    private pingInFlight: boolean = false;

    // ---- Bandwidth monitoring ----
    /** Bytes received in the current 1-second window (estimated via JSON.stringify). */
    private bytesThisSecond: number = 0;
    /** Packets received in the current 1-second window. */
    private packetsThisSecond: number = 0;
    /** Smoothed bytes-per-second reading. Updated once per second. */
    private currentBytesPerSec: number = 0;
    /** Smoothed packets-per-second reading. Updated once per second. */
    private currentPacketsPerSec: number = 0;
    /** Interval handle for the 1-second bandwidth accumulator flush. */
    private bandwidthIntervalId: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.socket = io({
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
        });

        this.socket.on('connect', () => {
            if (import.meta.env.DEV) console.log('[Network] Connected:', this.socket.id);

            // If this is a RE-connect (not the very first connect) and the player
            // has already joined, automatically re-send player:join so the server
            // can restore the grace-period tornado.
            if (this.hasJoined && this.playerName) {
                if (import.meta.env.DEV) console.log('[Network] Reconnected — re-joining as:', this.playerName);
                // Reset delta state so we don't merge deltas onto a stale full state
                this.resetDeltaState();
                const rejoinData = this.playerSeed !== undefined
                    ? { name: this.playerName, seed: this.playerSeed }
                    : { name: this.playerName };
                this.socket.emit('player:join', rejoinData);
                if (this.onReconnectCallback) {
                    this.onReconnectCallback();
                }
            }
        });

        // Full state — store as the new baseline and fire the callback directly
        this.socket.on('game:state', (state) => {
            try {
                this.accountPayload(state);
                this.cachedFullState = state;
                // Rebuild the player map from the new full state
                this.cachedPlayerMap.clear();
                for (const p of state.players) {
                    this.cachedPlayerMap.set(p.id, { ...p });
                }
                if (this.onStateCallback) {
                    this.onStateCallback(state);
                }
            } catch (err) {
                console.error('[Network] Error processing game:state:', err);
                // Critical event — request a full resync
                this.requestResync();
            }
        });

        // Delta state — merge onto the cached full state and fire the callback
        this.socket.on('game:delta', (delta: DeltaGameState) => {
            try {
                this.accountPayload(delta);
                if (!this.cachedFullState) {
                    // No baseline yet — cannot reconstruct. Drop and wait for the next keyframe.
                    console.warn('[Network] Received game:delta before game:state baseline — dropping');
                    return;
                }
                const reconstructed = this.applyDelta(this.cachedFullState, delta);
                // Update the cached state for the next delta
                this.cachedFullState = reconstructed;
                if (this.onStateCallback) {
                    // Tag so the debug overlay can distinguish full vs delta
                    (reconstructed as any)._isDelta = true;
                    this.onStateCallback(reconstructed);
                }
            } catch (err) {
                console.error('[Network] Error processing game:delta:', err);
                // Critical event — request a full resync
                this.requestResync();
            }
        });

        this.socket.on('game:death', (data) => {
            try {
                if (this.onDeathCallback) {
                    this.onDeathCallback(data.killerName);
                }
            } catch (err) {
                console.error('[Network] Error processing game:death:', err);
            }
        });

        this.socket.on('game:joined', (data) => {
            try {
                this.playerId = data.id;
                if (this.onJoinedCallback) {
                    this.onJoinedCallback(data);
                }
            } catch (err) {
                console.error('[Network] Error processing game:joined:', err);
            }
        });

        // Server-initiated RTT probe — echo timestamp back immediately
        this.socket.on('server:rtt_ping', (data) => {
            try {
                this.socket.emit('server:rtt_pong', { t: data.t });
            } catch (err) {
                console.error('[Network] Error processing server:rtt_ping:', err);
            }
        });

        // Chat message from server
        this.socket.on('chat:message', (data) => {
            if (this.onChatMessageCallback) {
                this.onChatMessageCallback(data);
            }
        });

        this.socket.on('disconnect', () => {
            try {
                if (import.meta.env.DEV) console.log('[Network] Disconnected');
                if (this.onDisconnectCallback) {
                    this.onDisconnectCallback();
                }
            } catch (err) {
                console.error('[Network] Error processing disconnect:', err);
            }
        });

        // Receive the echoed timestamp and compute RTT
        this.socket.on('ping:reply', (data) => {
            try {
                if (!this.pingInFlight) return;
                this.pingInFlight = false;
                const rtt = performance.now() - data.clientTime;
                this.pingSamples.push(rtt);
                if (this.pingSamples.length > 3) this.pingSamples.shift();
                const sum = this.pingSamples.reduce((a, b) => a + b, 0);
                this.currentPing = Math.round(sum / this.pingSamples.length);
            } catch (err) {
                console.error('[Network] Error processing ping:reply:', err);
            }
        });

        // Flush bandwidth counters once per second into the publicly-readable smoothed values
        this.bandwidthIntervalId = setInterval(() => {
            this.currentBytesPerSec   = this.bytesThisSecond;
            this.currentPacketsPerSec = this.packetsThisSecond;
            this.bytesThisSecond   = 0;
            this.packetsThisSecond = 0;
        }, 1000);
    }

    join(name: string, seed?: number): void {
        this.playerName = name;
        this.playerSeed = seed;
        this.hasJoined = true;
        this.socket.emit('player:join', seed !== undefined ? { name, seed } : { name });
    }

    sendInput(input: InputPayload): void {
        this.socket.emit('player:input', input);
    }

    respawn(): void {
        this.socket.emit('player:respawn');
    }

    onState(cb: (state: GameState) => void): void {
        this.onStateCallback = cb;
    }

    onDeath(cb: (killerName: string) => void): void {
        this.onDeathCallback = cb;
    }

    onJoined(cb: (data: JoinedPayload) => void): void {
        this.onJoinedCallback = cb;
    }

    /** Called when the socket disconnects unexpectedly. */
    onDisconnect(cb: () => void): void {
        this.onDisconnectCallback = cb;
    }

    /** Called when the socket successfully reconnects and re-join has been sent. */
    onReconnect(cb: () => void): void {
        this.onReconnectCallback = cb;
    }

    /** Register a callback for incoming chat messages. */
    onChatMessage(cb: (data: { name: string; msg: string; timestamp: number }) => void): void {
        this.onChatMessageCallback = cb;
    }

    /** Send a chat message to the server. */
    sendChat(msg: string): void {
        this.socket.emit('chat:send', msg);
    }

    get id(): string {
        return this.playerId;
    }

    // ---- Ping API ----

    /**
     * Send a single ping probe. Safe to call periodically; overlapping
     * probes are silently dropped so only one RTT is measured at a time.
     */
    measurePing(): void {
        if (this.pingInFlight) return;
        this.pingInFlight = true;
        this.socket.emit('ping:check', { clientTime: performance.now() });
    }

    /**
     * Returns the smoothed ping (average of last 3 samples) in milliseconds.
     * Returns 0 until the first measurement completes.
     */
    getPing(): number {
        return this.currentPing;
    }

    // ---- Bandwidth API ----

    /**
     * Estimated bytes received per second (updated once per second).
     * Based on JSON.stringify().length of each incoming payload.
     */
    getBytesPerSec(): number {
        return this.currentBytesPerSec;
    }

    /**
     * Number of game-state packets received per second (updated once per second).
     */
    getPacketsPerSec(): number {
        return this.currentPacketsPerSec;
    }

    /**
     * Accumulate a received payload's estimated byte size.
     * JSON.stringify().length is used as a byte-count approximation
     * (accurate for ASCII game state payloads).
     */
    private accountPayload(payload: unknown): void {
        // Rough byte estimation without JSON.stringify (which was 1-3ms per call).
        // For game state packets the payload is a plain object with arrays;
        // we estimate ~50 bytes per player + 4 bytes per destroyed ID + 200 base.
        const p = payload as Record<string, unknown>;
        let estimate = 200;
        if (Array.isArray(p.players)) estimate += p.players.length * 50;
        if (Array.isArray(p.destroyedObjectIds)) estimate += p.destroyedObjectIds.length * 4;
        if (Array.isArray(p.newDestroyedObjectIds)) estimate += (p.newDestroyedObjectIds as unknown[]).length * 4;
        this.bytesThisSecond += estimate;
        this.packetsThisSecond++;
    }

    /** Release the bandwidth accumulator interval (call on cleanup). */
    destroy(): void {
        if (this.bandwidthIntervalId !== null) {
            clearInterval(this.bandwidthIntervalId);
            this.bandwidthIntervalId = null;
        }
    }

    // ---- Resync ----

    /**
     * Request a full state resync from the server. Called when a critical
     * event handler (game:state, game:delta) throws during processing.
     * Resets local delta state so the next full state can be cleanly applied.
     */
    private requestResync(): void {
        this.resetDeltaState();
        this.socket.emit('player:resync');
    }

    // ---- Delta reconstruction helpers ----

    /**
     * Clear delta reconstruction state. Called on reconnect so stale data
     * is not mixed with fresh data from the new session.
     */
    private resetDeltaState(): void {
        this.cachedFullState = null;
        this.cachedPlayerMap.clear();
    }

    /** Get a reusable PlayerState object from the pool, or create one if needed. */
    private _getPooledPlayer(): PlayerState {
        if (this._playerPoolIdx < this._playerPool.length) {
            return this._playerPool[this._playerPoolIdx++];
        }
        const p: PlayerState = {
            id: '', name: '', x: 0, y: 0, radius: 0, rotation: 0,
            score: 0, velocityX: 0, velocityY: 0, alive: true,
            stamina: 100, activeEffects: [], protected: false, afk: false, lastInputSeq: 0,
        };
        this._playerPool.push(p);
        this._playerPoolIdx++;
        return p;
    }

    /**
     * Merge a DeltaGameState onto the previous full GameState and return a
     * new complete GameState. The previous state is not mutated.
     */
    private applyDelta(prev: GameState, delta: DeltaGameState): GameState {
        // ---- Players ----
        // Reset pool index so we reuse existing PlayerState objects
        this._playerPoolIdx = 0;

        // Reuse pre-allocated containers (cleared, not re-allocated)
        const deltaMap = this._deltaMap;
        deltaMap.clear();
        for (const dp of delta.players) {
            deltaMap.set(dp.id, dp);
        }

        const mergedPlayers = this._mergedPlayers;
        mergedPlayers.length = 0;
        const seenIds = this._seenIds;
        seenIds.clear();

        for (const prevPlayer of prev.players) {
            seenIds.add(prevPlayer.id);
            const dp = deltaMap.get(prevPlayer.id);
            if (dp) {
                // Merge: start from the previous full state and overwrite changed fields
                mergedPlayers.push(this.mergePlayer(prevPlayer, dp));
            } else {
                // Not in this delta tick — keep the previous full state unchanged
                mergedPlayers.push(prevPlayer);
            }
        }

        // Handle brand-new players that weren't in prev.players at all
        for (const dp of delta.players) {
            if (!seenIds.has(dp.id)) {
                // New player — the delta will contain all fields (server sends full data for new players)
                mergedPlayers.push(this.deltaToFullPlayer(dp));
            }
        }

        // ---- Destroyed IDs ----
        // Append new destructions directly — no Set conversion needed since
        // the server only sends each ID once via newDestroyedObjectIds.
        const destroyedObjectIds = prev.destroyedObjectIds;
        if (delta.newDestroyedObjectIds && delta.newDestroyedObjectIds.length > 0) {
            // Push directly — we own this array (reconstructed state, not shared)
            for (const id of delta.newDestroyedObjectIds) {
                destroyedObjectIds.push(id);
            }
        }

        // Update the cached player map (set overwrites, no need to clear if same keys)
        for (const p of mergedPlayers) {
            this.cachedPlayerMap.set(p.id, p);
        }

        return {
            players:            mergedPlayers,
            destroyedObjectIds: destroyedObjectIds,
            leaderboard:        delta.leaderboard  ?? prev.leaderboard,
            powerUps:           delta.powerUps     ?? prev.powerUps,
            vehicles:           delta.vehicles     ?? prev.vehicles,
            kills:              delta.kills,
            serverTime:         delta.serverTime,
        };
    }

    /**
     * Merge a DeltaPlayerState onto a previous full PlayerState.
     * Only fields present in the delta overwrite the previous values.
     */
    private mergePlayer(prev: PlayerState, dp: DeltaPlayerState): PlayerState {
        const p = this._getPooledPlayer();
        p.id            = dp.id;
        p.x             = dp.x;
        p.y             = dp.y;
        p.rotation      = dp.rotation;
        p.name          = dp.name          !== undefined ? dp.name          : prev.name;
        p.radius        = dp.radius        !== undefined ? dp.radius        : prev.radius;
        p.score         = dp.score         !== undefined ? dp.score         : prev.score;
        p.velocityX     = dp.velocityX     !== undefined ? dp.velocityX     : prev.velocityX;
        p.velocityY     = dp.velocityY     !== undefined ? dp.velocityY     : prev.velocityY;
        p.alive         = dp.alive         !== undefined ? dp.alive         : prev.alive;
        p.stamina       = dp.stamina       !== undefined ? dp.stamina       : prev.stamina;
        p.activeEffects = dp.activeEffects !== undefined ? dp.activeEffects : prev.activeEffects;
        p.protected     = dp.protected     !== undefined ? dp.protected     : prev.protected;
        p.afk           = dp.afk           !== undefined ? dp.afk           : prev.afk;
        p.lastInputSeq  = dp.lastInputSeq  !== undefined ? dp.lastInputSeq  : prev.lastInputSeq;
        return p;
    }

    /**
     * Convert a fully-populated DeltaPlayerState (sent for new players) into a
     * complete PlayerState, using safe defaults for any missing optional fields.
     */
    private deltaToFullPlayer(dp: DeltaPlayerState): PlayerState {
        const p = this._getPooledPlayer();
        p.id            = dp.id;
        p.x             = dp.x;
        p.y             = dp.y;
        p.rotation      = dp.rotation;
        p.name          = dp.name          ?? '';
        p.radius        = dp.radius        ?? 1;
        p.score         = dp.score         ?? 0;
        p.velocityX     = dp.velocityX     ?? 0;
        p.velocityY     = dp.velocityY     ?? 0;
        p.alive         = dp.alive         ?? true;
        p.stamina       = dp.stamina       ?? 100;
        p.activeEffects = dp.activeEffects ?? [];
        p.protected     = dp.protected     ?? false;
        p.afk           = dp.afk           ?? false;
        p.lastInputSeq  = dp.lastInputSeq  ?? 0;
        return p;
    }
}
