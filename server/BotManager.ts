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

// Base VIEW_RANGE — actual range is scaled by personality and size tier
const VIEW_RANGE     = 150; // units — bots can "see" within this distance
const FLEE_RANGE     = 100; // units — flee from bigger players within this range
const POWERUP_RANGE  = 100; // units — seek power-ups within this range
const OBJ_RANGE_MULT = 3;   // multiplier on bot radius for object seeking

// Size-tier overrides (applied on top of personality multipliers)
/** Small bots (F0-F1, radius < 2.0): flee detection radius = N * own radius */
const SMALL_FLEE_RADIUS_MULT  = 3.5; // detect threats from much farther away
/** Medium bots (F2-F3): expanded view range multiplier */
const MEDIUM_VIEW_RANGE_MULT  = 1.5;
/** Medium bots: chase threshold — bot must be at least this many times larger than prey */
const MEDIUM_CHASE_RATIO      = 1.11; // 1.11x = close to ABSORB_RATIO (1.1), very opportunistic
/** Large bots (F4-F5, radius > 5.0): view range multiplier */
const LARGE_VIEW_RANGE_MULT   = 2.5;
/** Large bots: they will chase any player up to this fraction of their own radius */
const LARGE_CHASE_RATIO       = 1.05;
/** Large bots: gravity-center search range when no prey is visible */
const LARGE_GRAVITY_RANGE     = 300;

// How many ticks until a wandering bot picks a new target
const WANDER_MIN_TICKS = TICK_RATE * 5;   //  5 seconds
const WANDER_MAX_TICKS = TICK_RATE * 10;  // 10 seconds

// ---- Jitter (human-like movement variation) ----
/**
 * Per-tick random angular noise applied to all movement headings.
 * Small bots get more jitter (erratic fleeing), large bots get less (purposeful).
 */
const JITTER_SMALL  = 0.35; // ±~20 degrees
const JITTER_MEDIUM = 0.20; // ±~11 degrees
const JITTER_LARGE  = 0.10; // ±~6 degrees

// ---- Edge avoidance ----
/**
 * When the bot is within this margin of the world boundary, it steers back toward
 * the center to avoid getting stuck in corners.
 */
const EDGE_MARGIN = WORLD_SIZE * 0.07; // 70 units from edge

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
    /** Multiplier on VIEW_RANGE for hunting prey (0.7 = cautious, 1.5 = aggressive) */
    huntRangeMult: number;
    /** Multiplier on FLEE_RANGE (1.8 = very cautious, 0.7 = daring) */
    fleeRangeMult: number;
    /** Minimum size ratio over prey before chasing (1.3 = needs to be clearly bigger) */
    chaseRatioThreshold: number;
    /** Prefer objects over players? */
    prefersObjects: boolean;
    /** Speed boost aggressiveness: 1.0 = always boost when able, 0 = never */
    boostRate: number;
}

const PERSONALITIES: BotPersonality[] = [
    // Aggressive — hunts relentlessly, nearly fearless, boosts constantly
    { huntRangeMult: 1.5, fleeRangeMult: 0.7,  chaseRatioThreshold: 1.20, prefersObjects: false, boostRate: 1.0  },
    // Balanced — moderate hunter, moderate caution
    { huntRangeMult: 1.0, fleeRangeMult: 1.2,  chaseRatioThreshold: 1.35, prefersObjects: true,  boostRate: 0.6  },
    // Cautious/Grower — avoids fights, grows on objects, flees early
    { huntRangeMult: 0.6, fleeRangeMult: 1.8,  chaseRatioThreshold: 1.55, prefersObjects: true,  boostRate: 0.25 },
    // Opportunistic — punches above its weight when an easy kill is nearby
    { huntRangeMult: 1.2, fleeRangeMult: 1.0,  chaseRatioThreshold: 1.25, prefersObjects: false, boostRate: 0.85 },
    // Cautious/Hunter — hunts but retreats quickly when threatened
    { huntRangeMult: 0.9, fleeRangeMult: 1.4,  chaseRatioThreshold: 1.40, prefersObjects: true,  boostRate: 0.5  },
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
    /** Pre-allocated ring buffer of sampled positions (avoids push/shift/reset allocations). */
    positionHistory: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    /** Write-head into positionHistory ring buffer. */
    positionHistoryHead: number;
    /** How many valid entries are in the ring buffer (0..STUCK_HISTORY_LENGTH). */
    positionHistoryCount: number;
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
                    state.positionHistoryHead = 0;
                    state.positionHistoryCount = 0;
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
                // Ring buffer: write at head, advance, track count (no push/shift/new array)
                const slot = state.positionHistory[state.positionHistoryHead];
                slot.x = player.x;
                slot.y = player.y;
                state.positionHistoryHead = (state.positionHistoryHead + 1) % STUCK_HISTORY_LENGTH;
                if (state.positionHistoryCount < STUCK_HISTORY_LENGTH) state.positionHistoryCount++;

                // Only evaluate once we have a full history window
                if (state.positionHistoryCount === STUCK_HISTORY_LENGTH && state.escapeTicksLeft <= 0) {
                    // Oldest entry is at the current head (next write position overwrites oldest)
                    const oldest = state.positionHistory[state.positionHistoryHead];
                    const dx = player.x - oldest.x;
                    const dy = player.y - oldest.y;
                    const netDisplacementSq = dx * dx + dy * dy;
                    if (netDisplacementSq < STUCK_DISTANCE_THRESHOLD * STUCK_DISTANCE_THRESHOLD) {
                        // Bot is stuck — trigger an escape manoeuvre
                        state.escapeTicksLeft = STUCK_ESCAPE_TICKS;
                        state.escapeAngle = Math.random() * Math.PI * 2;
                        state.positionHistoryHead = 0;
                        state.positionHistoryCount = 0; // reset — no allocation
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
            positionHistory: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
            positionHistoryHead: 0,
            positionHistoryCount: 0,
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

    /**
     * Returns a per-tick jitter angle offset to make bot movement look more human.
     * Amplitude scales with the size tier: small bots are erratic, large are purposeful.
     */
    private getJitter(radius: number): number {
        const amplitude = radius < 2.0 ? JITTER_SMALL
            : radius < 5.0 ? JITTER_MEDIUM
            : JITTER_LARGE;
        return (Math.random() - 0.5) * amplitude;
    }

    /**
     * If the bot is near the world boundary, returns a corrective angle pointing back
     * toward the center-ish.  Returns null when the bot is safely away from all edges.
     */
    private getEdgeAvoidanceAngle(x: number, y: number): number | null {
        const nearLeft   = x < EDGE_MARGIN;
        const nearRight  = x > WORLD_SIZE - EDGE_MARGIN;
        const nearTop    = y < EDGE_MARGIN;
        const nearBottom = y > WORLD_SIZE - EDGE_MARGIN;

        if (!nearLeft && !nearRight && !nearTop && !nearBottom) return null;

        // Steer toward world center with a small random offset so bots don't all
        // converge on the exact center when spawning at the same edge.
        const cx = WORLD_SIZE / 2 + (Math.random() - 0.5) * 200;
        const cy = WORLD_SIZE / 2 + (Math.random() - 0.5) * 200;
        return Math.atan2(cy - y, cx - x);
    }

    private computeInput(state: BotState, avgRealRadius: number): InputPayload {
        const { player } = state;
        const personality = this.getScaledPersonality(state.personality, avgRealRadius);
        const { x, y, radius } = player;

        // ---- Priority 0: Escape from stuck state ----
        if (state.escapeTicksLeft > 0) {
            state.escapeTicksLeft--;
            return { angle: state.escapeAngle, active: true, boost: false };
        }

        // ---- Priority 0.5: Edge avoidance (overrides most actions) ----
        const edgeAngle = this.getEdgeAvoidanceAngle(x, y);
        if (edgeAngle !== null) {
            // Boost away from walls to unstick quickly
            return { angle: edgeAngle, active: true, boost: player.stamina > 20 };
        }

        // ---- Priority 1: Water urgency — if standing in water, leave immediately ----
        const currentZone = this.world.getZoneAt(x, y);
        if (currentZone === 'water') {
            const escapeAngle = this.findEscapeFromZone(x, y, 'water');
            return { angle: escapeAngle, active: true, boost: player.stamina > 15 };
        }

        // ========================================================
        // SIZE-TIER BEHAVIOUR BRANCHES
        // ========================================================

        if (radius < 2.0) {
            // ---- SMALL BOTS (F0-F1): survival is top priority ----
            return this.computeSmallBotInput(state, personality, x, y, radius);
        } else if (radius < 5.0) {
            // ---- MEDIUM BOTS (F2-F3): active hunters ----
            return this.computeMediumBotInput(state, personality, x, y, radius);
        } else {
            // ---- LARGE BOTS (F4-F5): apex predators ----
            return this.computeLargeBotInput(state, personality, x, y, radius);
        }
    }

    // ---- Small bot (F0-F1) logic ----
    private computeSmallBotInput(
        state: BotState, personality: BotPersonality,
        x: number, y: number, radius: number,
    ): InputPayload {
        const player = state.player;

        // Extended flee range: small bots detect threats from further away
        const fleeRange = Math.max(
            FLEE_RANGE * personality.fleeRangeMult,
            radius * SMALL_FLEE_RADIUS_MULT,
        );

        const fleeTarget = this.findFleeTarget(player, fleeRange);
        if (fleeTarget) {
            // Move directly away from threat
            const rawAngle = Math.atan2(y - fleeTarget.y, x - fleeTarget.x);

            // Optionally steer toward the nearest safe zone if one is close enough
            const safeZoneAngle = this.findNearestSafeZoneAngle(x, y, fleeRange * 1.5);
            let chosenAngle: number;
            if (safeZoneAngle !== null) {
                // Blend: 60% toward safe zone, 40% away from threat
                const sx = Math.cos(safeZoneAngle) * 0.6 + Math.cos(rawAngle) * 0.4;
                const sy = Math.sin(safeZoneAngle) * 0.6 + Math.sin(rawAngle) * 0.4;
                chosenAngle = Math.atan2(sy, sx);
            } else {
                chosenAngle = rawAngle;
            }

            const angle = this.applyTerrainAvoidance(x, y, chosenAngle + this.getJitter(radius));
            // Small bots always boost when fleeing and have stamina
            const boost = player.stamina > 10;
            return { angle, active: true, boost };
        }

        // No immediate threat: seek power-ups first (growth helps survival)
        const powerUp = this.findNearestPowerUp(x, y, POWERUP_RANGE);
        if (powerUp) {
            const rawAngle = Math.atan2(powerUp.y - y, powerUp.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            return { angle, active: true, boost: false };
        }

        // Seek safe zone passively if nearby (small bots like safe zones)
        const safeZoneAngle = this.findNearestSafeZoneAngle(x, y, fleeRange);
        if (safeZoneAngle !== null) {
            const angle = this.applyTerrainAvoidance(x, y, safeZoneAngle + this.getJitter(radius));
            return { angle, active: true, boost: false };
        }

        // Seek objects to grow
        const objTarget = this.findNearestDestroyableObject(x, y, radius * OBJ_RANGE_MULT);
        if (objTarget) {
            const rawAngle = Math.atan2(objTarget.y - y, objTarget.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            return { angle, active: true, boost: false };
        }

        return this.wander(state);
    }

    // ---- Medium bot (F2-F3) logic ----
    private computeMediumBotInput(
        state: BotState, personality: BotPersonality,
        x: number, y: number, radius: number,
    ): InputPayload {
        const player = state.player;

        // Still flee from significantly larger players
        const fleeRange = FLEE_RANGE * personality.fleeRangeMult;
        const fleeTarget = this.findFleeTarget(player, fleeRange);
        if (fleeTarget) {
            const rawAngle = Math.atan2(y - fleeTarget.y, x - fleeTarget.x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            const boost = player.stamina > 20 && personality.boostRate >= 0.4;
            return { angle, active: true, boost };
        }

        // Actively hunt players within expanded range
        const huntRange = VIEW_RANGE * personality.huntRangeMult * MEDIUM_VIEW_RANGE_MULT;
        // Use the tighter chase ratio: can chase players at up to 0.9x own radius
        const effectiveChaseRatio = Math.min(personality.chaseRatioThreshold, MEDIUM_CHASE_RATIO);

        if (!personality.prefersObjects) {
            const prey = this.findBestPrey(player, huntRange, effectiveChaseRatio);
            if (prey) {
                const rawAngle = Math.atan2(prey.y - y, prey.x - x);
                const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
                // Boost when prey is close (within 60 units) and stamina allows
                const distSq = (prey.x - x) * (prey.x - x) + (prey.y - y) * (prey.y - y);
                const boost = player.stamina > 30 && personality.boostRate >= 0.5 && distSq < 60 * 60;
                return { angle, active: true, boost };
            }
        }

        // Seek power-ups
        const powerUp = this.findNearestPowerUp(x, y, POWERUP_RANGE);
        if (powerUp) {
            const rawAngle = Math.atan2(powerUp.y - y, powerUp.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            return { angle, active: true, boost: false };
        }

        // Seek objects
        const objTarget = this.findNearestDestroyableObject(x, y, radius * OBJ_RANGE_MULT);
        if (objTarget) {
            const rawAngle = Math.atan2(objTarget.y - y, objTarget.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            return { angle, active: true, boost: false };
        }

        // Object-preferring bots hunt after objects
        if (personality.prefersObjects) {
            const prey = this.findBestPrey(player, huntRange, effectiveChaseRatio);
            if (prey) {
                const rawAngle = Math.atan2(prey.y - y, prey.x - x);
                const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
                const boost = player.stamina > 30 && personality.boostRate >= 0.5;
                return { angle, active: true, boost };
            }
        }

        return this.wander(state);
    }

    // ---- Large bot (F4-F5) logic ----
    private computeLargeBotInput(
        state: BotState, personality: BotPersonality,
        x: number, y: number, radius: number,
    ): InputPayload {
        const player = state.player;

        // Large bots only flee from players shielded AND larger (not worth the risk)
        // For unshielded opponents, they fight rather than flee even if slightly smaller
        const fleeRange = FLEE_RANGE * personality.fleeRangeMult * 0.5; // reduced fear
        const fleeTarget = this.findFleeTargetShieldedOnly(player, fleeRange);
        if (fleeTarget) {
            const rawAngle = Math.atan2(y - fleeTarget.y, x - fleeTarget.x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            return { angle, active: true, boost: player.stamina > 15 };
        }

        // Very wide hunt range with generous chase ratio
        const huntRange = VIEW_RANGE * personality.huntRangeMult * LARGE_VIEW_RANGE_MULT;
        const prey = this.findBestPrey(player, huntRange, LARGE_CHASE_RATIO);
        if (prey) {
            const rawAngle = Math.atan2(prey.y - y, prey.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            // Large bots boost aggressively when chasing
            const boost = player.stamina > 20 && personality.boostRate >= 0.3;
            return { angle, active: true, boost };
        }

        // No prey in range: use center-of-gravity targeting — move toward the
        // densest cluster of players/objects to maximise encounter rate.
        const gravityTarget = this.findGravityCenter(x, y, LARGE_GRAVITY_RANGE);
        if (gravityTarget) {
            const rawAngle = Math.atan2(gravityTarget.y - y, gravityTarget.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            // Boost toward the action when stamina is plentiful
            const boost = player.stamina > 40 && personality.boostRate >= 0.6;
            return { angle, active: true, boost };
        }

        // Fallback: seek power-ups then objects then wander
        const powerUp = this.findNearestPowerUp(x, y, POWERUP_RANGE * 1.5);
        if (powerUp) {
            const rawAngle = Math.atan2(powerUp.y - y, powerUp.x - x);
            const angle = this.applyTerrainAvoidance(x, y, rawAngle + this.getJitter(radius));
            return { angle, active: true, boost: false };
        }

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
     * Skips players that are shielded OR spawn-protected (same logic: untouchable).
     */
    private findFleeTarget(
        self: Player,
        range: number,
    ): { x: number; y: number } | null {
        let closest: { x: number; y: number } | null = null;
        let closestDistSq = range * range;
        const now = Date.now();

        for (const other of this.game.players.values()) {
            if (other.id === self.id || !other.alive) continue;
            // Only flee if the other can absorb us
            if (!other.canAbsorb(self)) continue;

            const dx = other.x - self.x;
            const dy = other.y - self.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closest = { x: other.x, y: other.y };
            }
        }

        return closest;
    }

    /**
     * Variant of findFleeTarget used by large bots: only flee from players that are
     * BOTH larger (can absorb us) AND currently shielded — normal opponents are not
     * worth avoiding for a predator-class tornado.
     */
    private findFleeTargetShieldedOnly(
        self: Player,
        range: number,
    ): { x: number; y: number } | null {
        let closest: { x: number; y: number } | null = null;
        let closestDistSq = range * range;

        for (const other of this.game.players.values()) {
            if (other.id === self.id || !other.alive) continue;
            if (!other.canAbsorb(self)) continue;
            // Large bots only retreat from shielded threats
            if (!other.hasEffect('shield') && !other.isSpawnProtected()) continue;

            const dx = other.x - self.x;
            const dy = other.y - self.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closest = { x: other.x, y: other.y };
            }
        }

        return closest;
    }

    /**
     * Find the best prey to chase: the highest-scoring player we can absorb within range.
     * Skips players that have a shield active (shielded players cannot be absorbed).
     * Among candidates, prefers the one with the highest score (more reward).
     */
    private findBestPrey(
        self: Player,
        range: number,
        ratioThreshold: number,
    ): { x: number; y: number } | null {
        let bestTarget: { x: number; y: number } | null = null;
        let bestScore = -1;
        const rangeSq = range * range;

        for (const other of this.game.players.values()) {
            if (other.id === self.id || !other.alive) continue;
            // Must be small enough for us to absorb
            if (self.radius < other.radius * ratioThreshold) continue;
            // Avoid shielded targets — we can't absorb them and pursuing is wasteful
            if (other.hasEffect('shield') || other.isSpawnProtected()) continue;

            const dx = other.x - self.x;
            const dy = other.y - self.y;
            const distSq = dx * dx + dy * dy;
            if (distSq > rangeSq) continue;

            // Prefer higher-score targets (more rewarding kill)
            if (other.score > bestScore) {
                bestScore = other.score;
                bestTarget = { x: other.x, y: other.y };
            }
        }

        return bestTarget;
    }

    /**
     * Legacy findPrey kept for internal use compatibility (used nowhere directly now,
     * but preserved so future callers have a simple nearest-prey option).
     */
    private findPrey(
        self: Player,
        range: number,
        ratioThreshold: number,
    ): { x: number; y: number } | null {
        let closest: { x: number; y: number } | null = null;
        let closestDistSq = range * range;

        for (const other of this.game.players.values()) {
            if (other.id === self.id || !other.alive) continue;
            if (self.radius < other.radius * ratioThreshold) continue;
            // Skip shielded/protected players
            if (other.hasEffect('shield') || other.isSpawnProtected()) continue;

            const dx = other.x - self.x;
            const dy = other.y - self.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
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
        let closestDistSq = range * range;

        for (const pu of this.world.powerUps) {
            if (!pu.active) continue;
            const dx = pu.x - x;
            const dy = pu.y - y;
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
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
     * Find the angle toward the nearest safe zone within `range`.
     * Returns null if no safe zone is within range.
     */
    private findNearestSafeZoneAngle(x: number, y: number, range: number): number | null {
        let closestDistSq = range * range;
        let bestAngle: number | null = null;

        for (const sz of this.world.safeZones) {
            const dx = sz.x - x;
            const dy = sz.y - y;
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                bestAngle = Math.atan2(dy, dx);
            }
        }

        return bestAngle;
    }

    /**
     * Compute the "center of gravity" of all alive players and active power-ups within
     * `range`.  Used by large bots to navigate toward the most populated area when
     * no direct prey is visible.  Returns null if no relevant entities are found.
     */
    private findGravityCenter(x: number, y: number, range: number): { x: number; y: number } | null {
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        const rangeSq = range * range;

        for (const other of this.game.players.values()) {
            if (!other.alive) continue;
            const dx = other.x - x;
            const dy = other.y - y;
            if (dx * dx + dy * dy < rangeSq) {
                sumX += other.x;
                sumY += other.y;
                count++;
            }
        }

        // Also weight toward active power-ups
        for (const pu of this.world.powerUps) {
            if (!pu.active) continue;
            const dx = pu.x - x;
            const dy = pu.y - y;
            if (dx * dx + dy * dy < rangeSq) {
                sumX += pu.x;
                sumY += pu.y;
                count++;
            }
        }

        if (count === 0) return null;
        return { x: sumX / count, y: sumY / count };
    }

    /**
     * Wandering behaviour: move toward current target; pick a new one when close or timer expires.
     * Adds slight noise to direction to avoid perfectly straight-line paths.
     */
    private wander(state: BotState): InputPayload {
        const { player } = state;
        const dx = state.wanderTarget.x - player.x;
        const dy = state.wanderTarget.y - player.y;
        const distSq = dx * dx + dy * dy;

        state.wanderTicksLeft--;

        // Refresh target when close or timer elapsed
        if (distSq < 400 || state.wanderTicksLeft <= 0) {
            state.wanderTarget = this.randomWorldPoint();
            state.wanderTicksLeft = this.randomWanderTicks();
        }

        // Add random angular noise each tick so bots don't travel in perfectly straight lines
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
        // Scan from a random start index to distribute names without shuffle+sort allocation
        const len = BOT_NAMES.length;
        const start = Math.floor(Math.random() * len);
        for (let i = 0; i < len; i++) {
            const name = BOT_NAMES[(start + i) % len];
            if (!this.usedNames.has(name)) {
                this.usedNames.add(name);
                return name;
            }
        }
        // All base names in use — append a counter
        const base = BOT_NAMES[this.botCounter % len];
        const tagged = `${base}${Math.floor(this.botCounter / len) + 2}`;
        this.usedNames.add(tagged);
        return tagged;
    }
}
