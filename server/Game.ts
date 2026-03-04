// ============================================
// Game Loop - Core Server Game Logic
// ============================================

import { GameState, PlayerState, DeltaGameState, DeltaPlayerState, LeaderboardEntry, KillEvent, OBJECT_VALUES, NpcVehicle, PowerUp } from '../shared/types.js';
import { Player } from './Player.js';
import { World } from './World.js';
import { SpatialGrid } from './SpatialGrid.js';
import { BotManager } from './BotManager.js';
import { ReplayBuffer } from './ReplayBuffer.js';
import { leaderboard as persistentLeaderboard } from './Leaderboard.js';
import { Logger } from './Logger.js';
import { AntiCheat } from './AntiCheat.js';
import {
    TICK_RATE, TICK_INTERVAL, GRID_CELL_SIZE,
    WATER_SPEED_MULT, WATER_DECAY_RATE, MOUNTAIN_DECAY_RATE,
    PLAYER_MIN_RADIUS, ATTRACTION_RADIUS_MULT,
    SAFE_ZONE_MAX_RADIUS,
    POWERUP_COLLECT_RADIUS, GROWTH_BOOST_MULTIPLIER,
    VEHICLE_POINTS, VEHICLE_GROWTH, VEHICLE_SIZE, VEHICLE_COLLISION_RADIUS,
} from './constants.js';

const logger = new Logger('Game');

// Distance thresholds for LOD (Level of Detail) network updates
const NEAR_DISTANCE = 200;   // Full detail every tick
const MED_DISTANCE  = 500;   // Full detail every 2 ticks
// > MED_DISTANCE             // Position only every 4 ticks

// How many ticks to skip between updates for each band
const MED_TICK_INTERVAL  = 2;
const FAR_TICK_INTERVAL  = 4;

/** Entry stored in the disconnected-player grace-period map. */
interface DisconnectedEntry {
    player: Player;
    timer: ReturnType<typeof setTimeout>;
    oldSocketId: string;
}

export class Game {
    players: Map<string, Player> = new Map();
    /** Players in the 10-second reconnect grace window, keyed by player NAME. */
    disconnectedPlayers: Map<string, DisconnectedEntry> = new Map();
    world: World;
    private grid: SpatialGrid;
    private botManager: BotManager;
    private antiCheat: AntiCheat = new AntiCheat();
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private tickCount: number = 0;
    private playerTickCounters: Map<string, number> = new Map();
    private _alivePlayers: Player[] = [];
    private cachedLeaderboard: LeaderboardEntry[] = [];
    private leaderboardTick: number = 0;
    private onPlayerStateUpdate: ((playerId: string, state: GameState) => void) | null = null;
    private onPlayerDeltaUpdate: ((playerId: string, delta: DeltaGameState) => void) | null = null;
    private onPlayerDeath: ((playerId: string, killerName: string) => void) | null = null;
    /** Optional hook called at the end of every tick with the wall-clock duration in ms. */
    private onTickMetrics: ((tickMs: number) => void) | null = null;

    // ---- Anti-cheat: per-tick tracking ----
    private objectsDestroyedByPlayer: Map<string, boolean> = new Map();
    private absorbedThisTick: Set<string> = new Set();

    // ---- Delta compression state ----
    /** Per-player snapshot of the last full state sent. Keyed by socket ID. */
    private previousPlayerStates: Map<string, Map<string, PlayerState>> = new Map();
    /** Per-player snapshot of the last leaderboard sent. Keyed by socket ID. */
    private previousLeaderboards: Map<string, LeaderboardEntry[]> = new Map();
    /** Per-player snapshot of the last powerUps array sent. Keyed by socket ID. */
    private previousPowerUps: Map<string, string> = new Map(); // JSON string for fast compare
    /** Per-player snapshot of the last vehicles array sent. Keyed by socket ID. */
    private previousVehicles: Map<string, string> = new Map(); // JSON string for fast compare
    /** Per-player set of ALL destroyed IDs acknowledged so far. Keyed by socket ID. */
    private acknowledgedDestroyedIds: Map<string, Set<number>> = new Map();
    /** How many ticks each player has received (for keyframe scheduling). */
    private playerSentTicks: Map<string, number> = new Map();
    /** Send a full keyframe every N ticks to prevent drift. */
    private static readonly KEYFRAME_INTERVAL = 100;

    // ---- Replay buffer (pre-allocated ring buffer) ----
    readonly replayBuffer: ReplayBuffer = new ReplayBuffer();

    // ---- Session tracking for leaderboard (keyed by socket ID) ----
    private playerJoinTimes: Map<string, number> = new Map();

    constructor(seed: number) {
        this.world = new World(seed);
        this.grid = new SpatialGrid(GRID_CELL_SIZE);
        this.botManager = new BotManager(this, this.world);
    }

    setCallbacks(
        onPlayerStateUpdate: (playerId: string, state: GameState) => void,
        onPlayerDeath: (playerId: string, killerName: string) => void,
        onTickMetrics?: (tickMs: number) => void,
        onPlayerDeltaUpdate?: (playerId: string, delta: DeltaGameState) => void,
    ): void {
        this.onPlayerStateUpdate = onPlayerStateUpdate;
        this.onPlayerDeath = onPlayerDeath;
        this.onTickMetrics = onTickMetrics ?? null;
        this.onPlayerDeltaUpdate = onPlayerDeltaUpdate ?? null;
    }

    start(): void {
        logger.info(`Starting game loop at ${TICK_RATE} ticks/sec`);
        this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL);
        // Seed bots immediately — no real players are online yet
        this.botManager.onRealPlayerChange(0);
    }

    stop(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    addPlayer(id: string, name: string): Player {
        const player = new Player(id, name);
        this.players.set(id, player);
        this.playerTickCounters.set(id, 0);
        this.playerJoinTimes.set(id, Date.now());

        // Initialize delta state for this player
        this.previousPlayerStates.set(id, new Map());
        this.previousLeaderboards.set(id, []);
        this.previousPowerUps.set(id, '');
        this.previousVehicles.set(id, '');
        this.acknowledgedDestroyedIds.set(id, new Set());
        this.playerSentTicks.set(id, 0);

        logger.info(`Player joined: ${name} (${id}) — total: ${this.players.size}`);

        // Notify the bot manager only for real (non-bot) players so it can
        // scale the bot population appropriately.
        if (!id.startsWith('bot_')) {
            this.botManager.onRealPlayerChange(this.getRealPlayerCount());
        }

        return player;
    }

    removePlayer(id: string): void {
        const player = this.players.get(id);
        if (player) {
            logger.info(`Player left: ${player.name} (${id})`);
            this.players.delete(id);
            this.playerTickCounters.delete(id);

            // Clean up delta state for this player
            this.previousPlayerStates.delete(id);
            this.previousLeaderboards.delete(id);
            this.previousPowerUps.delete(id);
            this.previousVehicles.delete(id);
            this.acknowledgedDestroyedIds.delete(id);
            this.playerSentTicks.delete(id);
            this.playerJoinTimes.delete(id);

            // Clean up anti-cheat tracking
            this.antiCheat.removePlayer(id);

            // Notify the bot manager only for real (non-bot) players.
            if (!id.startsWith('bot_')) {
                this.botManager.onRealPlayerChange(this.getRealPlayerCount());
            }
        }
    }

    /**
     * Submit a finished (dead or disconnected) real-player session to the
     * persistent leaderboard if their score qualifies.
     */
    private submitToLeaderboard(player: Player): void {
        // Bots are excluded from the persistent leaderboard.
        if (player.id.startsWith('bot_')) return;
        if (player.score <= 0) return;

        const joinTime = this.playerJoinTimes.get(player.id) ?? Date.now();
        const duration = Math.floor((Date.now() - joinTime) / 1000);

        // Derive Fujita category from peak radius
        const r = player.radius;
        let maxCategory = 'F0';
        if (r >= 5.0)      maxCategory = 'F5';
        else if (r >= 4.0) maxCategory = 'F4';
        else if (r >= 3.0) maxCategory = 'F3';
        else if (r >= 2.0) maxCategory = 'F2';
        else if (r >= 1.0) maxCategory = 'F1';

        const qualified = persistentLeaderboard.addEntry({
            name:        player.name,
            score:       Math.floor(player.score),
            maxCategory,
            kills:       0,  // kill tracking is event-based; field reserved for future use
            duration,
        });

        if (qualified) {
            console.log(`[Leaderboard] New entry: ${player.name} — score ${Math.floor(player.score)} (${maxCategory})`);
        }
    }

    /**
     * Called when a real (non-bot) socket disconnects.
     * Keeps the Player alive in the game for RECONNECT_GRACE_MS milliseconds.
     * The tornado remains visible to others but receives no input (idles).
     * If the grace period expires without a reconnect, the player is removed.
     */
    disconnectPlayer(id: string): void {
        // Bots are never put in the grace-period map — remove them immediately.
        if (id.startsWith('bot_')) {
            this.removePlayer(id);
            return;
        }

        const player = this.players.get(id);
        if (!player) return;

        // Freeze the tornado in place.
        player.setInput({ active: false, boost: false, angle: 0 });

        // Record the session on disconnect (best-effort; score may still change
        // during the grace period but this captures the moment they left).
        this.submitToLeaderboard(player);

        logger.info(`Player disconnected (grace period): ${player.name} (${id})`);

        // Cancel any existing grace timer for this name (shouldn't happen, but be safe).
        const existing = this.disconnectedPlayers.get(player.name);
        if (existing) {
            clearTimeout(existing.timer);
        }

        const timer = setTimeout(() => {
            // Grace period expired — actually remove the player.
            logger.info(`Grace period expired for ${player.name} — removing`);
            this.disconnectedPlayers.delete(player.name);
            this.removePlayer(player.id);
        }, 10_000);

        this.disconnectedPlayers.set(player.name, {
            player,
            timer,
            oldSocketId: id,
        });
    }

    /**
     * Called when a player re-joins with the same name within the grace period.
     * Reassigns the existing Player to the new socket ID and cancels the removal timer.
     * Returns the restored Player, or null if no disconnected entry was found for this name.
     */
    reconnectPlayer(name: string, newSocketId: string): Player | null {
        const entry = this.disconnectedPlayers.get(name);
        if (!entry) return null;

        clearTimeout(entry.timer);
        this.disconnectedPlayers.delete(name);

        const { player, oldSocketId } = entry;

        // Move the player to the new socket ID.
        this.players.delete(oldSocketId);
        this.playerTickCounters.delete(oldSocketId);

        // Move delta state to the new socket ID (reset so next send is a full keyframe)
        this.previousPlayerStates.delete(oldSocketId);
        this.previousLeaderboards.delete(oldSocketId);
        this.previousPowerUps.delete(oldSocketId);
        this.previousVehicles.delete(oldSocketId);
        this.acknowledgedDestroyedIds.delete(oldSocketId);
        this.playerSentTicks.delete(oldSocketId);

        this.previousPlayerStates.set(newSocketId, new Map());
        this.previousLeaderboards.set(newSocketId, []);
        this.previousPowerUps.set(newSocketId, '');
        this.previousVehicles.set(newSocketId, '');
        this.acknowledgedDestroyedIds.set(newSocketId, new Set());
        this.playerSentTicks.set(newSocketId, 0);

        player.id = newSocketId;
        this.players.set(newSocketId, player);
        this.playerTickCounters.set(newSocketId, 0);

        logger.info(`Player reconnected: ${name} (${oldSocketId} → ${newSocketId})`);

        return player;
    }

    /** Returns the number of currently connected real (non-bot) players. */
    /** Returns the number of currently connected real (non-bot) players. */
    getRealPlayerCount(): number {
        let count = 0;
        for (const id of this.players.keys()) {
            if (!id.startsWith('bot_')) count++;
        }
        return count;
    }

    private tick(): void {
        const tickStart = Date.now();
        const dt = 1; // fixed timestep (1 tick)
        // Capture wall-clock time once per tick so every player state in this
        // tick carries the same serverTime (used by the client interpolation buffer).
        const tickServerTime = Date.now();

        // Collect kills that happen this tick to broadcast to all clients
        const pendingKills: KillEvent[] = [];

        // Reset per-tick anti-cheat tracking
        this.objectsDestroyedByPlayer.clear();
        this.absorbedThisTick.clear();

        // Update bot AI — must happen BEFORE player physics so that bot inputs
        // are set in time for this tick's movement calculations.
        this.botManager.update();

        // Rebuild spatial grid
        this.grid.clear();

        // Insert players
        for (const player of this.players.values()) {
            if (!player.alive) continue;
            this.grid.insert({
                id: player.id,
                x: player.x,
                y: player.y,
                radius: player.radius,
            });
        }

        // Insert active world objects
        const activeObjects = this.world.getActiveObjects();
        for (const obj of activeObjects) {
            this.grid.insert({
                id: obj.id,
                x: obj.x,
                y: obj.y,
                size: obj.size,
            });
        }

        // Update each player
        for (const player of this.players.values()) {
            if (!player.alive) continue;

            // Terrain zone effects
            const zone = this.world.getZoneAt(player.x, player.y);
            let speedMult = 1;
            if (zone === 'water') {
                speedMult = WATER_SPEED_MULT;
                player.grow(0, -WATER_DECAY_RATE);
                if (player.radius < PLAYER_MIN_RADIUS) {
                    player.radius = PLAYER_MIN_RADIUS;
                }
            } else if (zone === 'mountain') {
                player.grow(0, -MOUNTAIN_DECAY_RATE);
                if (player.radius < PLAYER_MIN_RADIUS) {
                    player.radius = PLAYER_MIN_RADIUS;
                }
            }

            player.update(dt, speedMult);

            // ---- Power-up collection ----
            for (const pu of this.world.powerUps) {
                if (!pu.active) continue;
                const pDx = player.x - pu.x;
                const pDy = player.y - pu.y;
                const pDist = Math.sqrt(pDx * pDx + pDy * pDy);
                // Collection radius = tornado radius + constant pick-up buffer
                if (pDist < player.radius + POWERUP_COLLECT_RADIUS) {
                    player.applyPowerUp(pu.type);
                    this.world.collectPowerUp(pu);
                    console.log(`[Game] ${player.name} collected power-up: ${pu.type}`);
                }
            }

            // Check collisions with world objects
            const nearby = this.grid.query(
                player.x, player.y,
                player.radius * ATTRACTION_RADIUS_MULT
            );

            for (const entity of nearby) {
                // Check if it's a world object (numeric id)
                if (typeof entity.id === 'number') {
                    const obj = this.world.objectsById.get(entity.id as number);
                    if (!obj || obj.destroyed) continue;

                    const dx = player.x - obj.x;
                    const dy = player.y - obj.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    // Can destroy if tornado radius is big enough and close enough.
                    // Use 1.8× player radius so the collision zone matches the visual funnel width.
                    if (player.radius >= obj.size && dist < player.radius * 1.8 + obj.size) {
                        this.world.destroyObject(obj);
                        const values = OBJECT_VALUES[obj.type];
                        // Rapid Growth power-up doubles radius gain from destroyed objects
                        const growthMult = player.hasEffect('growth') ? GROWTH_BOOST_MULTIPLIER : 1.0;
                        player.grow(values.points, values.growth * growthMult);
                        // Track for anti-cheat (legitimate radius growth source)
                        this.objectsDestroyedByPlayer.set(player.id, true);
                    }
                }
            }
        }

        // Check player vs player collisions
        this._alivePlayers.length = 0;
        for (const p of this.players.values()) {
            if (p.alive) this._alivePlayers.push(p);
        }
        const playerArray = this._alivePlayers;

        const safeZoneCache = new Map<string, boolean>();
        for (const p of playerArray) {
            safeZoneCache.set(p.id, p.radius < SAFE_ZONE_MAX_RADIUS && this.world.isInSafeZone(p.x, p.y));
        }

        for (let i = 0; i < playerArray.length; i++) {
            for (let j = i + 1; j < playerArray.length; j++) {
                const a = playerArray[i];
                const b = playerArray[j];

                const dist = a.distanceTo(b);
                const touchDist = a.radius + b.radius;

                if (dist < touchDist * 1.5) {
                    const bSpawnProtected = b.isSpawnProtected();
                    const aSpawnProtected = a.isSpawnProtected();

                    const bSafeZoneProtected = safeZoneCache.get(b.id)!;
                    const aSafeZoneProtected = safeZoneCache.get(a.id)!;

                    // Shield power-up also blocks absorption for its duration
                    const bShieldProtected = b.hasEffect('shield');
                    const aShieldProtected = a.hasEffect('shield');

                    const bProtected = bSpawnProtected || bSafeZoneProtected || bShieldProtected;
                    const aProtected = aSpawnProtected || aSafeZoneProtected || aShieldProtected;

                    // Compute size ratio (larger / smaller, always >= 1.0).
                    // This drives the absorption-vs-repulsion decision.
                    const sizeRatio = a.radius >= b.radius
                        ? a.radius / b.radius
                        : b.radius / a.radius;

                    // Absorption only fires when the bigger tornado is >= 1.5× the size
                    // of the smaller one AND the victim is unprotected.
                    // Below that threshold the tornados repel each other instead,
                    // creating tension and bouncing between equal-sized players.
                    const REPULSE_RATIO = 1.5;

                    if (a.canAbsorb(b) && !bProtected && sizeRatio >= REPULSE_RATIO) {
                        // A absorbs B — clearly larger (>= 1.5×) and B is unprotected
                        pendingKills.push({ killer: a.name, victim: b.name, killerRadius: a.radius });
                        a.grow(b.score * 0.3, b.radius * 0.12);
                        b.alive = false;
                        this.absorbedThisTick.add(b.id);
                        this.objectsDestroyedByPlayer.set(a.id, true);
                        this.submitToLeaderboard(b);
                        // Let the bot manager handle respawn scheduling for bots
                        this.botManager.notifyBotDied(b.id);
                        if (this.onPlayerDeath) {
                            this.onPlayerDeath(b.id, a.name);
                        }
                    } else if (b.canAbsorb(a) && !aProtected && sizeRatio >= REPULSE_RATIO) {
                        // B absorbs A — clearly larger (>= 1.5×) and A is unprotected
                        pendingKills.push({ killer: b.name, victim: a.name, killerRadius: b.radius });
                        b.grow(a.score * 0.3, a.radius * 0.12);
                        a.alive = false;
                        this.absorbedThisTick.add(a.id);
                        this.objectsDestroyedByPlayer.set(b.id, true);
                        this.submitToLeaderboard(a);
                        // Let the bot manager handle respawn scheduling for bots
                        this.botManager.notifyBotDied(a.id);
                        if (this.onPlayerDeath) {
                            this.onPlayerDeath(a.id, b.name);
                        }
                    } else {
                        // Similar-sized tornados (ratio < 1.5×) OR a player is protected.
                        // Apply size-aware repulsion:
                        //   pushStrength = 0.3 * (1 - sizeRatio / REPULSE_RATIO)
                        //   → ~0.3 when sizes are equal (ratio = 1.0)
                        //   → ~0.0 when ratio approaches 1.5 (near-absorption threshold)
                        const pushStrength = 0.3 * (1 - sizeRatio / REPULSE_RATIO);

                        // Push each tornado away from the other along the collision axis.
                        const angle = Math.atan2(b.y - a.y, b.x - a.x);
                        const cosA = Math.cos(angle);
                        const sinA = Math.sin(angle);

                        // The smaller tornado gets pushed proportionally more (inverse-mass
                        // weighting: each tornado displaced in proportion to the other's radius).
                        const totalRadius = a.radius + b.radius;
                        const aShare = (b.radius / totalRadius) * 2;
                        const bShare = (a.radius / totalRadius) * 2;

                        a.x -= cosA * pushStrength * aShare;
                        a.y -= sinA * pushStrength * aShare;
                        b.x += cosA * pushStrength * bShare;
                        b.y += sinA * pushStrength * bShare;
                    }
                }
            }
        }

        // ---- NPC Vehicle collision with tornados ----
        // Check every alive player against every alive vehicle.
        // Vehicle count is small (<=15) so a simple O(n*m) scan is fine.
        for (const player of this.players.values()) {
            if (!player.alive) continue;
            if (player.radius < VEHICLE_SIZE) continue;

            for (const vehicle of this.world.vehicles) {
                if (vehicle.destroyed) continue;

                const vDx = player.x - vehicle.x;
                const vDy = player.y - vehicle.y;
                const vDist = Math.sqrt(vDx * vDx + vDy * vDy);

                if (vDist < player.radius * 1.8 + VEHICLE_COLLISION_RADIUS) {
                    this.world.destroyVehicle(vehicle);
                    const growthMult = player.hasEffect('growth') ? GROWTH_BOOST_MULTIPLIER : 1.0;
                    player.grow(VEHICLE_POINTS, VEHICLE_GROWTH * growthMult);
                }
            }
        }

        // ---- Anti-cheat checks (after physics, before state broadcast) ----
        this.antiCheat.check(
            this.players.values(),
            this.absorbedThisTick,
            (id) => this.objectsDestroyedByPlayer.get(id) === true,
        );

        // Update world (respawns, power-up respawns) and advance vehicle positions
        this.world.update();
        this.world.updateVehicles();

        // Advance global tick counter
        this.tickCount++;

        // Use cached array (only rebuilt when the set actually changes)
        const destroyedObjectIds = this.world.getDestroyedIdsArray();

        if (this.tickCount - this.leaderboardTick >= 5) {
            this.leaderboardTick = this.tickCount;
            this.cachedLeaderboard = Array.from(this.players.values())
                .filter(p => p.alive)
                .sort((a, b) => b.score - a.score)
                .slice(0, 10)
                .map(p => ({ name: p.name, score: Math.floor(p.score), radius: p.radius }));
        }
        const leaderboard = this.cachedLeaderboard;

        // Power-ups snapshot — included every tick (small data, all clients need it)
        const powerUps = this.world.powerUps;

        // Vehicles snapshot — included every tick so the client can interpolate positions
        const vehicles = this.world.vehicles;

        // Pre-build full state snapshots for all players once (reused below).
        // Augment `protected` with safe-zone status so the client shows the
        // shield glow whenever a small tornado is standing in a safe haven.
        const allPlayerStates: PlayerState[] = [];
        for (const p of this.players.values()) {
            const state = p.toState();
            const inSafeZone = p.alive && (safeZoneCache.get(p.id) ?? (
                p.radius < SAFE_ZONE_MAX_RADIUS && this.world.isInSafeZone(p.x, p.y)
            ));
            if (inSafeZone) {
                state.protected = true;
            }
            allPlayerStates.push(state);
        }

        // Send a personalised state to each connected player
        for (const viewer of this.players.values()) {
            // Increment this player's personal tick counter
            const counter = (this.playerTickCounters.get(viewer.id) ?? 0) + 1;
            this.playerTickCounters.set(viewer.id, counter);

            const filteredPlayers = this.buildFilteredPlayerList(
                viewer,
                allPlayerStates,
                counter,
            );

            // Determine whether this tick should be a full keyframe or a delta.
            // Always send a full state on the first tick (sentTicks === 0) and every
            // KEYFRAME_INTERVAL ticks thereafter to prevent client drift.
            const sentTicks = this.playerSentTicks.get(viewer.id) ?? 0;
            const isKeyframe = sentTicks === 0 || (sentTicks % Game.KEYFRAME_INTERVAL === 0);
            this.playerSentTicks.set(viewer.id, sentTicks + 1);

            if (isKeyframe || !this.onPlayerDeltaUpdate) {
                // Full state — refresh the delta baseline for this player
                const state: GameState = {
                    players: filteredPlayers,
                    destroyedObjectIds,
                    leaderboard,
                    powerUps,
                    vehicles,
                    kills: pendingKills.length > 0 ? pendingKills : undefined,
                    serverTime: tickServerTime,
                };
                if (this.onPlayerStateUpdate) {
                    this.onPlayerStateUpdate(viewer.id, state);
                }
                // Update the delta baseline
                this.updateDeltaBaseline(viewer.id, filteredPlayers, leaderboard, powerUps, vehicles, destroyedObjectIds);
            } else {
                // Delta state — diff against the previous baseline
                const delta = this.buildDelta(
                    viewer.id,
                    filteredPlayers,
                    destroyedObjectIds,
                    leaderboard,
                    powerUps,
                    vehicles,
                    tickServerTime,
                    pendingKills,
                );
                this.onPlayerDeltaUpdate(viewer.id, delta);
                // Advance the baseline after diffing
                this.updateDeltaBaseline(viewer.id, filteredPlayers, leaderboard, powerUps, vehicles, destroyedObjectIds);
            }
        }

        // ---- Record snapshot into replay buffer ----
        // allPlayerStates was built above (full state for every player this tick).
        this.replayBuffer.record(this.tickCount, allPlayerStates, destroyedObjectIds);

        // Reset the per-tick newly-destroyed tracker
        this.world.flushNewlyDestroyed();

        // ---- Metrics hook ----
        if (this.onTickMetrics) {
            this.onTickMetrics(Date.now() - tickStart);
        }
    }

    /**
     * Build the player list for a specific viewer, applying distance-based LOD:
     *
     *  < NEAR_DISTANCE  (200):  full detail, every tick
     *  < MED_DISTANCE   (500):  full detail, every 2 ticks
     *  >= MED_DISTANCE  (500+): position only, every 4 ticks
     *
     * The viewer always receives their own full state every tick.
     */
    private buildFilteredPlayerList(
        viewer: Player,
        allStates: PlayerState[],
        counter: number,
    ): PlayerState[] {
        const result: PlayerState[] = [];

        for (const state of allStates) {
            // Always include the viewer themselves at full detail
            if (state.id === viewer.id) {
                result.push(state);
                continue;
            }

            const dx = state.x - viewer.x;
            const dy = state.y - viewer.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < NEAR_DISTANCE) {
                // Near: full detail every tick
                result.push(state);
            } else if (dist < MED_DISTANCE) {
                // Medium: full detail every MED_TICK_INTERVAL ticks
                if (counter % MED_TICK_INTERVAL === 0) {
                    result.push(state);
                }
            } else {
                // Far: position-only every FAR_TICK_INTERVAL ticks
                if (counter % FAR_TICK_INTERVAL === 0) {
                    result.push(this.toPositionOnlyState(state));
                }
            }
        }

        return result;
    }

    /**
     * Strip a PlayerState down to just the fields needed for distant rendering:
     * position, radius, alive flag, and identity. Everything else is zeroed/defaulted.
     */
    private toPositionOnlyState(state: PlayerState): PlayerState {
        return {
            id: state.id,
            name: state.name,
            x: state.x,
            y: state.y,
            radius: state.radius,
            alive: state.alive,
            // Preserve protection flag so distant players still render the shield glow
            protected: state.protected,
            // Omitted detail fields – set to neutral defaults
            rotation: 0,
            score: 0,
            velocityX: 0,
            velocityY: 0,
            stamina: 0,
            activeEffects: [],
            afk: state.afk,
            lastInputSeq: state.lastInputSeq,
        };
    }

    /**
     * Build a DeltaGameState for a specific viewer by diffing the current tick's
     * data against the stored baseline for that player.
     */
    private buildDelta(
        viewerId: string,
        currentPlayers: PlayerState[],
        currentDestroyedIds: number[],
        currentLeaderboard: LeaderboardEntry[],
        currentPowerUps: PowerUp[],
        currentVehicles: NpcVehicle[],
        serverTime: number,
        pendingKills: KillEvent[],
    ): DeltaGameState {
        const prevStates   = this.previousPlayerStates.get(viewerId)!;
        const prevLB       = this.previousLeaderboards.get(viewerId)!;
        const prevPUJson   = this.previousPowerUps.get(viewerId)!;
        const prevVehJson  = this.previousVehicles.get(viewerId)!;
        const ackedIds     = this.acknowledgedDestroyedIds.get(viewerId)!;

        // ---- Players delta ----
        const deltaPlayers: DeltaPlayerState[] = [];
        for (const cur of currentPlayers) {
            const prev = prevStates.get(cur.id);
            if (!prev) {
                // New player — send all fields so the client can seed its state
                deltaPlayers.push({
                    id:            cur.id,
                    x:             cur.x,
                    y:             cur.y,
                    rotation:      cur.rotation,
                    name:          cur.name,
                    radius:        cur.radius,
                    score:         cur.score,
                    velocityX:     cur.velocityX,
                    velocityY:     cur.velocityY,
                    alive:         cur.alive,
                    stamina:       cur.stamina,
                    activeEffects: cur.activeEffects,
                    protected:     cur.protected,
                    afk:           cur.afk,
                });
            } else {
                // Existing player — always send movement, conditionally send slow-changing fields
                const dp: DeltaPlayerState = {
                    id:       cur.id,
                    x:        cur.x,
                    y:        cur.y,
                    rotation: cur.rotation,
                };
                if (cur.name          !== prev.name)          dp.name          = cur.name;
                if (cur.radius        !== prev.radius)         dp.radius        = cur.radius;
                if (cur.score         !== prev.score)          dp.score         = cur.score;
                if (cur.velocityX     !== prev.velocityX)      dp.velocityX     = cur.velocityX;
                if (cur.velocityY     !== prev.velocityY)      dp.velocityY     = cur.velocityY;
                if (cur.alive         !== prev.alive)          dp.alive         = cur.alive;
                if (cur.stamina       !== prev.stamina)        dp.stamina       = cur.stamina;
                if (cur.protected     !== prev.protected)      dp.protected     = cur.protected;
                if (cur.afk           !== prev.afk)            dp.afk           = cur.afk;
                // activeEffects: compare by serialised length + content
                const curEffJson = JSON.stringify(cur.activeEffects);
                const prevEffJson = JSON.stringify(prev.activeEffects);
                if (curEffJson !== prevEffJson) {
                    dp.activeEffects = cur.activeEffects;
                }
                deltaPlayers.push(dp);
            }
        }

        // ---- Destroyed IDs: only send IDs not yet acknowledged by this player ----
        // Use the per-tick newly-destroyed list (typically 0-5 items) instead of
        // iterating the full destroyedIds array (thousands of items).
        const newDestroyedIds: number[] = [];
        for (const id of this.world.newlyDestroyedThisTick) {
            if (!ackedIds.has(id)) {
                newDestroyedIds.push(id);
            }
        }

        // ---- Leaderboard: only send when changed ----
        const curLBJson = JSON.stringify(currentLeaderboard);
        const prevLBJson = JSON.stringify(prevLB);
        const leaderboardDelta = curLBJson !== prevLBJson ? currentLeaderboard : undefined;

        // ---- PowerUps: only send when changed ----
        const curPUJson = JSON.stringify(currentPowerUps);
        const powerUpsDelta = curPUJson !== prevPUJson ? currentPowerUps : undefined;

        // ---- Vehicles: only send when any vehicle state changed ----
        const curVehJson = JSON.stringify(currentVehicles);
        const vehiclesDelta = curVehJson !== prevVehJson ? currentVehicles : undefined;

        const delta: DeltaGameState = {
            players:    deltaPlayers,
            serverTime: serverTime,
        };
        if (newDestroyedIds.length > 0)  delta.newDestroyedObjectIds = newDestroyedIds;
        if (leaderboardDelta)            delta.leaderboard            = leaderboardDelta;
        if (powerUpsDelta)               delta.powerUps               = powerUpsDelta;
        if (vehiclesDelta)               delta.vehicles               = vehiclesDelta;
        if (pendingKills.length > 0)     delta.kills                  = pendingKills;

        return delta;
    }

    /**
     * After sending a full or delta state, update the per-player baseline so the
     * next delta diff compares against what was actually sent this tick.
     */
    private updateDeltaBaseline(
        viewerId: string,
        currentPlayers: PlayerState[],
        currentLeaderboard: LeaderboardEntry[],
        currentPowerUps: PowerUp[],
        currentVehicles: NpcVehicle[],
        currentDestroyedIds: number[],
    ): void {
        // Update per-player state map
        const prevStates = this.previousPlayerStates.get(viewerId)!;
        // Snapshot the current state and collect IDs for cleanup
        const currentIds: string[] = [];
        for (const p of currentPlayers) {
            prevStates.set(p.id, { ...p });
            currentIds.push(p.id);
        }
        // Remove players no longer in the filtered list (only if the map grew)
        if (prevStates.size > currentIds.length) {
            const currentIdSet = new Set(currentIds);
            for (const id of prevStates.keys()) {
                if (!currentIdSet.has(id)) prevStates.delete(id);
            }
        }

        // Update leaderboard baseline
        this.previousLeaderboards.set(viewerId, currentLeaderboard);

        // Update power-ups baseline (stored as JSON string for O(1) compare)
        this.previousPowerUps.set(viewerId, JSON.stringify(currentPowerUps));

        // Update vehicles baseline (stored as JSON string for O(1) compare)
        this.previousVehicles.set(viewerId, JSON.stringify(currentVehicles));

        // Mark only newly-destroyed IDs as acknowledged (avoids iterating the full array)
        const ackedIds = this.acknowledgedDestroyedIds.get(viewerId)!;
        for (const id of this.world.newlyDestroyedThisTick) {
            ackedIds.add(id);
        }
    }
}
