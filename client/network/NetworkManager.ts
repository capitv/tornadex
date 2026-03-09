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
    /**
     * Snapshot of prev.players saved BEFORE clearing _mergedPlayers.
     * prev.players may alias _mergedPlayers (from the previous applyDelta return).
     */
    private _prevPlayersSnapshot: PlayerState[] = [];
    private _mergedPlayers: PlayerState[] = [];

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
                const normalizedState = this.normalizeFullState(state);
                this.cachedFullState = normalizedState;
                // Rebuild the player map from the new full state
                this.cachedPlayerMap.clear();
                for (const p of normalizedState.players) {
                    this.cachedPlayerMap.set(p.id, { ...p });
                }
                if (this.onStateCallback) {
                    this.onStateCallback(normalizedState);
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

    /**
     * Full keyframes may omit the destroyed-object baseline to avoid
     * re-sending a growing list every few seconds. Reuse the previous baseline
     * when that happens so downstream code still receives a normal GameState.
     */
    private normalizeFullState(state: GameState): GameState {
        if (!state.destroyedObjectIdsOmitted || !this.cachedFullState) {
            return state;
        }
        return {
            ...state,
            destroyedObjectIds: this.cachedFullState.destroyedObjectIds.slice(),
            destroyedObjectIdsOmitted: undefined,
        };
    }
    /**
     * Merge a DeltaGameState onto the previous full GameState.
     *
     * CRITICAL DESIGN: No object pool. Previous approach used a pool that
     * returned the SAME objects stored in prev.players, causing mergePlayer
     * to read-and-write the same object simultaneously (aliasing corruption).
     *
     * Current approach:
     *  - Existing players: merge IN-PLACE onto the prev object (zero alloc)
     *  - New players: fresh object (rare — only on join)
     */
    private applyDelta(prev: GameState, delta: DeltaGameState): GameState {
        // ---- Players ----
        const deltaMap = this._deltaMap;
        deltaMap.clear();
        for (const dp of delta.players) {
            deltaMap.set(dp.id, dp);
        }

        // Snapshot prev.players BEFORE clearing _mergedPlayers, because
        // prev.players may be the same array reference as _mergedPlayers
        // (from the previous applyDelta return value stored in cachedFullState).
        const prevSnapshot = this._prevPlayersSnapshot;
        prevSnapshot.length = 0;
        for (let i = 0; i < prev.players.length; i++) {
            prevSnapshot[i] = prev.players[i];
        }

        const mergedPlayers = this._mergedPlayers;
        mergedPlayers.length = 0;
        const seenIds = this._seenIds;
        seenIds.clear();

        for (const prevPlayer of prevSnapshot) {
            seenIds.add(prevPlayer.id);
            const dp = deltaMap.get(prevPlayer.id);
            if (dp) {
                // Merge in-place: mutate prevPlayer directly (no pool, no aliasing)
                mergedPlayers.push(this.mergePlayer(prevPlayer, dp));
            } else {
                // Not in this delta tick — keep the previous state object as-is
                mergedPlayers.push(prevPlayer);
            }
        }

        // Handle brand-new players that weren't in prev.players at all
        for (const dp of delta.players) {
            if (!seenIds.has(dp.id)) {
                // New player — fresh object (not pooled)
                mergedPlayers.push(this.deltaToFullPlayer(dp));
            }
        }

        // ---- Destroyed IDs ----
        const destroyedObjectIds = prev.destroyedObjectIds;
        if (delta.newDestroyedObjectIds && delta.newDestroyedObjectIds.length > 0) {
            for (const id of delta.newDestroyedObjectIds) {
                destroyedObjectIds.push(id);
            }
        }

        // Update the cached player map
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
     * Merge delta fields IN-PLACE onto the previous PlayerState.
     * Only fields present in the delta overwrite. Returns the same object.
     * Zero allocation — no pool needed.
     */
    private mergePlayer(prev: PlayerState, dp: DeltaPlayerState): PlayerState {
        // Always-present fields from delta
        prev.id       = dp.id;
        prev.x        = dp.x;
        prev.y        = dp.y;
        prev.rotation = dp.rotation;
        // Conditionally-present fields: only overwrite if delta includes them
        if (dp.name          !== undefined) prev.name          = dp.name;
        if (dp.radius        !== undefined) prev.radius        = dp.radius;
        if (dp.score         !== undefined) prev.score         = dp.score;
        if (dp.velocityX     !== undefined) prev.velocityX     = dp.velocityX;
        if (dp.velocityY     !== undefined) prev.velocityY     = dp.velocityY;
        if (dp.alive         !== undefined) prev.alive         = dp.alive;
        if (dp.stamina       !== undefined) prev.stamina       = dp.stamina;
        if (dp.activeEffects !== undefined) prev.activeEffects = dp.activeEffects;
        if (dp.protected     !== undefined) prev.protected     = dp.protected;
        if (dp.afk           !== undefined) prev.afk           = dp.afk;
        if (dp.lastInputSeq  !== undefined) prev.lastInputSeq  = dp.lastInputSeq;
        return prev;
    }

    /**
     * Convert a DeltaPlayerState (new player) into a complete PlayerState.
     * Creates a fresh object — only called when a genuinely new player joins (rare).
     */
    private deltaToFullPlayer(dp: DeltaPlayerState): PlayerState {
        return {
            id:            dp.id,
            x:             dp.x,
            y:             dp.y,
            rotation:      dp.rotation,
            name:          dp.name          ?? '',
            radius:        dp.radius        ?? 1,
            score:         dp.score         ?? 0,
            velocityX:     dp.velocityX     ?? 0,
            velocityY:     dp.velocityY     ?? 0,
            alive:         dp.alive         ?? true,
            stamina:       dp.stamina       ?? 100,
            activeEffects: dp.activeEffects ?? [],
            protected:     dp.protected     ?? false,
            afk:           dp.afk           ?? false,
            lastInputSeq:  dp.lastInputSeq  ?? 0,
        };
    }
}
