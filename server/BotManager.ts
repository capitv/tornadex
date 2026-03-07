// ============================================
// Bot Manager - AI-controlled tornado bots
// ============================================

import { Player } from './Player.js';
import { Game } from './Game.js';
import { World } from './World.js';
import { SpatialGrid, SpatialEntity } from './SpatialGrid.js';
import { InputPayload } from '../shared/types.js';
import { WORLD_SIZE, TICK_RATE } from './constants.js';
import { Logger } from './Logger.js';

const botLogger = new Logger('BotManager');

// ---- Tuning constants ----
/** Always fill the room to this many total players (humans + bots). */
const TARGET_TOTAL_PLAYERS = 8;

const BOT_RESPAWN_DELAY_TICKS_MIN = TICK_RATE * 3; // 3 seconds
const BOT_RESPAWN_DELAY_TICKS_MAX = TICK_RATE * 5; // 5 seconds

const VIEW_RANGE     = 150; // units — bots can "see" within this distance
const FLEE_RANGE     = 100; // units — flee from bigger players within this range
const POWERUP_RANGE  = 100; // units — seek power-ups within this range
const OBJ_RANGE_MULT = 3;   // multiplier on bot radius for object seeking

// How many ticks until a wandering bot picks a new target
const WANDER_MIN_TICKS = TICK_RATE * 5;   //  5 seconds
const WANDER_MAX_TICKS = TICK_RATE * 10;  // 10 seconds

// ---- Stuck detection ----
/** How often (in ticks) we sample the bot's position for stuck detection. */
const STUCK_SAMPLE_INTERVAL = 20;
/** How many historical position samples we keep. */
const STUCK_HISTORY_LENGTH  = 5;
/** If net displacement over the full history window is below this, the bot is stuck. */
const STUCK_DISTANCE_THRESHOLD = 2;
/** How many ticks the bot moves in a random "escape" direction when stuck. */
const STUCK_ESCAPE_TICKS = 40;

// ---- Terrain avoidance ----
/**
 * When the direct path to a target passes through a bad terrain zone (water/mountain),
 * the bot deflects its heading by this many radians to steer around it.
 * We sample a single point 30 units ahead along the current heading.
 */
const TERRAIN_AVOID_ANGLE = Math.PI / 4;  // 45 degrees
const TERRAIN_LOOKAHEAD   = 30;           // units ahead to probe

const BOT_NAMES = [
    'Twister', 'Cyclone', 'Gusty', 'Whirlwind', 'Tempest',
    'Stormy', 'Vortex', 'Zephyr', 'Gale', 'Sirocco',
    'Bora', 'Haboob', 'Squall', 'Mistral', 'Derecho',
];

// Personality presets — vary aggression, caution, and wander style
interface BotPersonality {
    /** Multiplier on VIEW_RANGE for hunting prey (0.7 = cautious, 1.3 = aggressive) */
    huntRangeMult: number;
    /** Multiplier on FLEE_RANGE (1.5 = very cautious, 0.8 = daring) */
    fleeRangeMult: number;
    /** Minimum size ratio over prey before chasing (1.3 = needs to be clearly bigger) */
    chaseRatioThreshold: number;
    /** Prefer objects over players? */
    prefersObjects: boolean;
    /** Speed boost aggressiveness: 1.0 = always boost when able, 0 = never */
    boostRate: number;
}

const PERSONALITIES: BotPersonality[] = [
    { huntRangeMult: 1.3, fleeRangeMult: 0.8, chaseRatioThreshold: 1.25, prefersObjects: false, boostRate: 1.0 },  // Aggressive
    { huntRangeMult: 1.0, fleeRangeMult: 1.2, chaseRatioThreshold: 1.35, prefersObjects: true,  boostRate: 0.6 },  // Balanced
    { huntRangeMult: 0.7, fleeRangeMult: 1.5, chaseRatioThreshold: 1.5,  prefersObjects: true,  boostRate: 0.3 },  // Cautious/Grower
    { huntRangeMult: 1.1, fleeRangeMult: 1.0, chaseRatioThreshold: 1.3,  prefersObjects: false, boostRate: 0.8 },  // Opportunistic
    { huntRangeMult: 0.9, fleeRangeMult: 1.3, chaseRatioThreshold: 1.4,  prefersObjects: true,  boostRate: 0.5 },  // Cautious/Hunter
];

interface BotState {
    player: Player;
    personality: BotPersonality;
    /** Current wander target position */
    wanderTarget: { x: number; y: number };
    /** Ticks remaining on the current wander target */
    wanderTicksLeft: number;
    /** Ticks remaining before respawning after death */
    respawnCountdown: number;
    /** Name pool index (for unique naming) */
    nameIndex: number;

    // ---- Stuck detection ----
    /** Ring buffer of sampled positions (sampled every STUCK_SAMPLE_INTERVAL ticks). */
    positionHistory: Array<{ x: number; y: number }>;
    /** Counts up to STUCK_SAMPLE_INTERVAL, then resets and records a sample. */
    stuckSampleTimer: number;
    /** Ticks remaining in escape mode (>0 = bot is executing a stuck-escape manoeuvre). */
    escapeTicksLeft: number;
    /** Fixed escape angle used while in escape mode. */
    escapeAngle: number;
}

export class BotManager {
    private game: Game;
    private world: World;
    private grid: SpatialGrid | null = null;
    private bots: Map<string, BotState> = new Map();
    private botCounter: number = 0;
    private usedNames: Set<string> = new Set();

    constructor(game: Game, world: World) {
        this.game = game;
        this.world = world;
    }

    /** Set the spatial grid reference so bots can use it for efficient lookups. */
    setGrid(grid: SpatialGrid): void {
        this.grid = grid;
    }

    // ------------------------------------------------------------------ //
    // Public API
    // ------------------------------------------------------------------ //

    /**
     * Compute the average radius of all real (non-bot) players in the room.
     * Used to scale bot difficulty based on room state.
     */
    private getRealPlayerAvgRadius(): number {
        let totalRadius = 0;
        let count = 0;
        for (const player of this.game.players.values()) {
            if (!player.id.startsWith('bot_') && player.alive) {
                totalRadius += player.radius;
                count++;
            }
        }
        return count > 0 ? totalRadius / count : 0;
    }

    /**
     * Returns an adjusted personality based on room difficulty scaling.
     * - Mid-game (avg radius > 3): bots become more aggressive hunters with higher speed
     * - Late-game (avg radius > 6): bots actively hunt smaller players
     */
    private getScaledPersonality(base: BotPersonality, avgRadius: number): BotPersonality {
        if (avgRadius > 6) {
            // Late-game: very aggressive, actively hunt smaller players
            return {
                huntRangeMult: base.huntRangeMult * 1.6,
                fleeRangeMult: base.fleeRangeMult * 0.7,
                chaseRatioThreshold: Math.max(1.1, base.chaseRatioThreshold * 0.8),
                prefersObjects: false, // always hunt players in late-game
                boostRate: Math.min(1.0, base.boostRate + 0.3),
            };
        } else if (avgRadius > 3) {
            // Mid-game: moderately more aggressive
            return {
                huntRangeMult: base.huntRangeMult * 1.3,
                fleeRangeMult: base.fleeRangeMult * 0.9,
                chaseRatioThreshold: Math.max(1.15, base.chaseRatioThreshold * 0.9),
                prefersObjects: base.prefersObjects,
                boostRate: Math.min(1.0, base.boostRate + 0.15),
            };
        }
        return base;
    }

    /**
     * Called every game tick (before player physics).
     * Updates AI decisions and handles respawning.
     */
    update(): void {
        const avgRadius = this.getRealPlayerAvgRadius();

        for (const [botId, state] of this.bots) {
            const player = state.player;

            if (!player.alive) {
                // Count down respawn
                state.respawnCountdown--;
                if (state.respawnCountdown <= 0) {
                    player.respawn();
                    // Pick a fresh wander target after respawn and reset stuck state
                    state.wanderTarget = this.randomWorldPoint();
                    state.wanderTicksLeft = this.randomWanderTicks();
                    state.positionHistory = [];
                    state.stuckSampleTimer = 0;
                    state.escapeTicksLeft = 0;
                }
                // No input while dead
                player.setInput({ angle: 0, active: false, boost: false });
                continue;
            }

            // ---- Stuck detection: sample position every STUCK_SAMPLE_INTERVAL ticks ----
            state.stuckSampleTimer++;
            if (state.stuckSampleTimer >= STUCK_SAMPLE_INTERVAL) {
                state.stuckSampleTimer = 0;
                state.positionHistory.push({ x: player.x, y: player.y });
                // Keep only the last STUCK_HISTORY_LENGTH samples
                if (state.positionHistory.length > STUCK_HISTORY_LENGTH) {
                    state.positionHistory.shift();
                }

                // Only evaluate once we have a full history window
                if (state.positionHistory.length === STUCK_HISTORY_LENGTH && state.escapeTicksLeft <= 0) {
                    const oldest = state.positionHistory[0];
                    const dx = player.x - oldest.x;
                    const dy = player.y - oldest.y;
                    const netDisplacement = Math.sqrt(dx * dx + dy * dy);
                    if (netDisplacement < STUCK_DISTANCE_THRESHOLD) {
                        // Bot is stuck — trigger an escape manoeuvre
                        state.escapeTicksLeft = STUCK_ESCAPE_TICKS;
                        state.escapeAngle = Math.random() * Math.PI * 2;
                        state.positionHistory = []; // reset history so we don't re-trigger immediately
                    }
                }
            }

            // Compute and apply AI input (with difficulty scaling)
            const input = this.computeInput(state, avgRadius);
            player.setInput(input);
        }
    }

    /**
     * Call whenever a real player joins or leaves.
     * Adjusts the number of active bots accordingly.
     */
    onRealPlayerChange(realPlayerCount: number): void {
        if (realPlayerCount === 0) {
            // No real players — remove all bots to save resources
            for (const botId of [...this.bots.keys()]) {
                this.removeBot(botId);
            }
            return;
        }

        const currentBotCount = this.bots.size;
        const targetBots = Math.max(0, TARGET_TOTAL_PLAYERS - realPlayerCount);

        if (currentBotCount < targetBots) {
            // Spawn bots to fill up to TARGET_TOTAL_PLAYERS
            const toSpawn = targetBots - currentBotCount;
            for (let i = 0; i < toSpawn; i++) {
                this.spawnBot();
            }
        } else if (currentBotCount > targetBots) {
            // Remove excess bots — pick the weakest (smallest radius) first
            const toRemove = currentBotCount - targetBots;
            const sortedBots = [...this.bots.entries()]
                .sort((a, b) => a[1].player.radius - b[1].player.radius);
            for (let i = 0; i < toRemove && i < sortedBots.length; i++) {
                this.removeBot(sortedBots[i][0]);
            }
        }
    }

    // ------------------------------------------------------------------ //
    // Bot spawning / removal
    // ------------------------------------------------------------------ //

    private spawnBot(): void {
        const id = `bot_${++this.botCounter}`;
        const name = this.pickName();
        const personality = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];

        const player = this.game.addPlayer(id, name);

        const state: BotState = {
            player,
            personality,
            wanderTarget: this.randomWorldPoint(),
            wanderTicksLeft: this.randomWanderTicks(),
            respawnCountdown: 0,
            nameIndex: this.botCounter,
            positionHistory: [],
            stuckSampleTimer: 0,
            escapeTicksLeft: 0,
            escapeAngle: 0,
        };

        this.bots.set(id, state);
        botLogger.debug(`Spawned bot: ${name} (${id}), personality: ${JSON.stringify(personality)}`);
    }

    private removeBot(id: string): void {
        const state = this.bots.get(id);
        if (!state) return;
        botLogger.debug(`Removing bot: ${state.player.name} (${id})`);
        this.game.removePlayer(id);
        this.bots.delete(id);
    }

    // ------------------------------------------------------------------ //
    // AI decision making
    // ------------------------------------------------------------------ //

    private computeInput(state: BotState, avgRealRadius: number): InputPayload {
        const { player } = state;
        const personality = this.getScaledPersonality(state.personality, avgRealRadius);
        const { x, y, radius } = player;

        // ---- Priority 0: Escape from stuck state ----
        if (state.escapeTicksLeft > 0) {
            state.escapeTicksLeft--;
            return { angle: state.escapeAngle, active: true, boost: false };
        }

        // ---- Priority 0.5: Water urgency — if standing in water, leave immediately ----
        const currentZone = this.world.getZoneAt(x, y);
        if (currentZone === 'water') {
            // Find the nearest non-water point by sampling 8 cardinal + diagonal directions
            // and picking the direction that most quickly escapes the current water zone.
            const escapeAngle = this.findEscapeFromZone(x, y, 'water');
            return { angle: escapeAngle, active: true, boost: player.stamina > 15 };
        }

        // ---- Priority 1: Flee from bigger nearby players ----
        const fleeRange = FLEE_RANGE * personality.fleeRangeMult;
        const fleeTarget = this.findFleeTarget(player, fleeRange);
        if (fleeTarget) {
            // Move directly away from the threat, but apply terrain avoidance
            const rawAngle = Math.atan2(y - fleeTarget.y, x - fleeTarget.x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle);
            const boost = player.stamina > 20 && personality.boostRate >= 0.5;
            return { angle, active: true, boost };
        }

        // ---- Priority 2: Chase smaller nearby players ----
        if (!personality.prefersObjects) {
            const huntRange = VIEW_RANGE * personality.huntRangeMult;
            const prey = this.findPrey(player, huntRange, personality.chaseRatioThreshold);
            if (prey) {
                const rawAngle = Math.atan2(prey.y - y, prey.x - x);
                const angle = this.applyTerrainAvoidance(x, y, rawAngle);
                const boost = player.stamina > 30 && personality.boostRate >= 0.7;
                return { angle, active: true, boost };
            }
        }

        // ---- Priority 3: Seek nearby power-ups ----
        const powerUp = this.findNearestPowerUp(x, y, POWERUP_RANGE);
        if (powerUp) {
            const rawAngle = Math.atan2(powerUp.y - y, powerUp.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle);
            return { angle, active: true, boost: false };
        }

        // ---- Priority 4: Seek nearby destroyable objects ----
        const objTarget = this.findNearestDestroyableObject(x, y, radius * OBJ_RANGE_MULT);
        if (objTarget) {
            const rawAngle = Math.atan2(objTarget.y - y, objTarget.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle);
            return { angle, active: true, boost: false };
        }

        // ---- For object-preferring bots, hunt players AFTER objects ----
        if (personality.prefersObjects) {
            const huntRange = VIEW_RANGE * personality.huntRangeMult;
            const prey = this.findPrey(player, huntRange, personality.chaseRatioThreshold);
            if (prey) {
                const rawAngle = Math.atan2(prey.y - y, prey.x - x);
                const angle = this.applyTerrainAvoidance(x, y, rawAngle);
                const boost = player.stamina > 30 && personality.boostRate >= 0.7;
                return { angle, active: true, boost };
            }
        }

        // ---- Priority 5: Wander ----
        return this.wander(state);
    }

    /**
     * Check the terrain one lookahead step ahead along `heading`.
     * If it's a mountain or water zone, deflect the heading by TERRAIN_AVOID_ANGLE
     * (try left deflection first, then right; if both are bad, keep the deflected angle).
     */
    private applyTerrainAvoidance(x: number, y: number, heading: number): number {
        const probeX = x + Math.cos(heading) * TERRAIN_LOOKAHEAD;
        const probeY = y + Math.sin(heading) * TERRAIN_LOOKAHEAD;
        const probeZone = this.world.getZoneAt(probeX, probeY);

        if (probeZone === 'plain') {
            return heading; // clear path — no adjustment needed
        }

        // Try deflecting left (positive angle offset)
        const leftAngle = heading + TERRAIN_AVOID_ANGLE;
        const leftProbeX = x + Math.cos(leftAngle) * TERRAIN_LOOKAHEAD;
        const leftProbeY = y + Math.sin(leftAngle) * TERRAIN_LOOKAHEAD;
        if (this.world.getZoneAt(leftProbeX, leftProbeY) === 'plain') {
            return leftAngle;
        }

        // Try deflecting right (negative angle offset)
        const rightAngle = heading - TERRAIN_AVOID_ANGLE;
        const rightProbeX = x + Math.cos(rightAngle) * TERRAIN_LOOKAHEAD;
        const rightProbeY = y + Math.sin(rightAngle) * TERRAIN_LOOKAHEAD;
        if (this.world.getZoneAt(rightProbeX, rightProbeY) === 'plain') {
            return rightAngle;
        }

        // Both deflections are also bad — default to the left deflection to at least
        // change heading and let the stuck detector handle any remaining issues.
        return leftAngle;
    }

    /**
     * Called when the bot is currently inside a zone of `zoneType`.
     * Samples 8 directions and returns the angle that leads most quickly out of the zone.
     */
    private findEscapeFromZone(x: number, y: number, zoneType: 'water' | 'mountain'): number {
        const DIRECTIONS = 8;
        let bestAngle = Math.random() * Math.PI * 2;
        let bestFreeDistance = 0;

        for (let i = 0; i < DIRECTIONS; i++) {
            const angle = (i / DIRECTIONS) * Math.PI * 2;
            // Walk outward in this direction until we leave the zone or hit max range
            let freeDistance = 0;
            for (let dist = 10; dist <= 80; dist += 10) {
                const px = x + Math.cos(angle) * dist;
                const py = y + Math.sin(angle) * dist;
                if (this.world.getZoneAt(px, py) !== zoneType) {
                    freeDistance = dist;
                    break;
                }
            }
            if (freeDistance > bestFreeDistance) {
                bestFreeDistance = freeDistance;
                bestAngle = angle;
            }
        }

        return bestAngle;
    }

    /**
     * Find the nearest player (real or bot) that is bigger than us and within range.
     * Returns the position to flee from (the threat's position).
     */
    private findFleeTarget(
        self: Player,
        range: number,
    ): { x: number; y: number } | null {
        let closest: { x: number; y: number } | null = null;
        let closestDist = range;

        for (const other of this.game.players.values()) {
            if (other.id === self.id || !other.alive) continue;
            // Only flee if the other can absorb us
            if (!other.canAbsorb(self)) continue;

            const dist = self.distanceTo(other);
            if (dist < closestDist) {
                closestDist = dist;
                closest = { x: other.x, y: other.y };
            }
        }

        return closest;
    }

    /**
     * Find a nearby smaller player that we can chase and absorb.
     */
    private findPrey(
        self: Player,
        range: number,
        ratioThreshold: number,
    ): { x: number; y: number } | null {
        let closest: { x: number; y: number } | null = null;
        let closestDist = range;

        for (const other of this.game.players.values()) {
            if (other.id === self.id || !other.alive) continue;
            // Must be significantly smaller (not just canAbsorb threshold)
            if (self.radius < other.radius * ratioThreshold) continue;

            const dist = self.distanceTo(other);
            if (dist < closestDist) {
                closestDist = dist;
                closest = { x: other.x, y: other.y };
            }
        }

        return closest;
    }

    /**
     * Find the nearest active power-up within the given range.
     */
    private findNearestPowerUp(
        x: number,
        y: number,
        range: number,
    ): { x: number; y: number } | null {
        let closest: { x: number; y: number } | null = null;
        let closestDist = range;

        for (const pu of this.world.powerUps) {
            if (!pu.active) continue;
            const dx = pu.x - x;
            const dy = pu.y - y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < closestDist) {
                closestDist = dist;
                closest = { x: pu.x, y: pu.y };
            }
        }

        return closest;
    }

    /**
     * Find the nearest non-destroyed world object within range that the bot can destroy.
     * Uses the spatial grid when available for O(1)-ish lookup instead of scanning all 5600+ objects.
     */
    private findNearestDestroyableObject(
        x: number,
        y: number,
        range: number,
    ): { x: number; y: number } | null {
        // Use spatial grid for efficient lookup when available
        if (this.grid) {
            const nearby = this.grid.query(x, y, range);
            let closest: { x: number; y: number } | null = null;
            let closestDistSq = range * range;

            for (const entity of nearby) {
                // World objects have numeric IDs
                if (typeof entity.id !== 'number') continue;
                const obj = this.world.objectsById.get(entity.id as number);
                if (!obj || obj.destroyed) continue;
                const dx = obj.x - x;
                const dy = obj.y - y;
                const distSq = dx * dx + dy * dy;
                if (distSq < closestDistSq) {
                    closestDistSq = distSq;
                    closest = { x: obj.x, y: obj.y };
                }
            }

            return closest;
        }

        // Fallback: brute-force scan
        let closest: { x: number; y: number } | null = null;
        let closestDistSq = range * range;

        for (const obj of this.world.objects) {
            if (obj.destroyed) continue;
            const dx = obj.x - x;
            const dy = obj.y - y;
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closest = { x: obj.x, y: obj.y };
            }
        }

        return closest;
    }

    /**
     * Wandering behaviour: move toward current target; pick a new one when close or timer expires.
     * Adds slight noise to direction to avoid perfectly straight-line paths.
     */
    private wander(state: BotState): InputPayload {
        const { player } = state;
        const dx = state.wanderTarget.x - player.x;
        const dy = state.wanderTarget.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        state.wanderTicksLeft--;

        // Refresh target when close or timer elapsed
        if (dist < 20 || state.wanderTicksLeft <= 0) {
            state.wanderTarget = this.randomWorldPoint();
            state.wanderTicksLeft = this.randomWanderTicks();
        }

        // Add small random angular noise each tick so bots don't travel in perfectly straight lines
        const baseAngle = Math.atan2(dy, dx);
        const noise = (Math.random() - 0.5) * 0.3; // ±~17 degrees
        const angle = baseAngle + noise;

        return { angle, active: true, boost: false };
    }

    // ------------------------------------------------------------------ //
    // Death notification — called from Game.ts via the death callback
    // ------------------------------------------------------------------ //

    /**
     * Called when a bot dies so we can start its respawn countdown.
     * Game.ts already sets player.alive = false before calling onPlayerDeath.
     */
    notifyBotDied(botId: string): void {
        const state = this.bots.get(botId);
        if (!state) return;
        const delay = BOT_RESPAWN_DELAY_TICKS_MIN +
            Math.floor(Math.random() * (BOT_RESPAWN_DELAY_TICKS_MAX - BOT_RESPAWN_DELAY_TICKS_MIN + 1));
        state.respawnCountdown = delay;
    }

    /** Returns true if the given ID belongs to a managed bot. */
    isBot(id: string): boolean {
        return this.bots.has(id);
    }

    // ------------------------------------------------------------------ //
    // Utility
    // ------------------------------------------------------------------ //

    private randomWorldPoint(): { x: number; y: number } {
        const margin = WORLD_SIZE * 0.08;
        return {
            x: margin + Math.random() * (WORLD_SIZE - margin * 2),
            y: margin + Math.random() * (WORLD_SIZE - margin * 2),
        };
    }

    private randomWanderTicks(): number {
        return WANDER_MIN_TICKS + Math.floor(Math.random() * (WANDER_MAX_TICKS - WANDER_MIN_TICKS));
    }

    private pickName(): string {
        // Shuffle and try to find an unused name; fall back to appending a number
        const shuffled = [...BOT_NAMES].sort(() => Math.random() - 0.5);
        for (const name of shuffled) {
            if (!this.usedNames.has(name)) {
                this.usedNames.add(name);
                return name;
            }
        }
        // All base names in use — append a counter
        const base = BOT_NAMES[this.botCounter % BOT_NAMES.length];
        const tagged = `${base}${Math.floor(this.botCounter / BOT_NAMES.length) + 2}`;
        this.usedNames.add(tagged);
        return tagged;
    }
}
