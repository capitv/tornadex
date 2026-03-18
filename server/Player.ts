// ============================================
// Player (Tornado) - Server-side State
// ============================================

import { PlayerState, InputPayload, ActiveEffect, PowerUpType, SatelliteState } from '../shared/types.js';
import {
    PLAYER_SPEED, PLAYER_MIN_RADIUS, PLAYER_MAX_RADIUS,
    PLAYER_SPAWN_RADIUS, IDLE_DECAY_RATE, IDLE_SCORE_DECAY,
    WORLD_SIZE, SPEED_SIZE_FACTOR, ABSORB_RATIO,
    POWERUP_DURATION, SPEED_BOOST_MULTIPLIER,
    SPAWN_PROTECTION_MS, SPLIT_MIN_RADIUS, SPLIT_DURATION_TICKS,
} from './constants.js';

// ---- Position history for lag compensation ----
interface PositionSnapshot {
    x: number;
    y: number;
    radius: number;
    timestamp: number; // Date.now() epoch ms
}

/** Number of position snapshots to keep (~500ms at 20Hz = 10 entries, keep 12 for safety). */
const POSITION_HISTORY_SIZE = 12;

export class Player {
    private static round2(value: number): number {
        return Math.round(value * 100) / 100;
    }

    private static round3(value: number): number {
        return Math.round(value * 1000) / 1000;
    }

    private static round1(value: number): number {
        return Math.round(value * 10) / 10;
    }

    id: string;
    name: string;
    x: number;
    y: number;
    /** Position at the start of the current tick (before update). */
    prevX: number = 0;
    prevY: number = 0;
    radius: number;
    rotation: number = 0;
    /** Used by SpatialGrid for allocation-free dedup. */
    _queryGen?: number;
    /** Per-tick sequential index assigned before the collision loop. Used for numeric pair-key dedup. */
    _tickIdx: number = -1;

    /** Active satellite tornado state; null when split ability is not in use. */
    satellite: SatelliteState | null = null;
    score: number = 0;
    velocityX: number = 0;
    velocityY: number = 0;
    alive: boolean = true;
    stamina: number = 100; // 0-100
    inSupercell: boolean = false;

    // Map of power-up type → tick timestamp when effect expires
    activeEffects: Map<PowerUpType, number> = new Map();
    // Running tick counter used for effect expiry
    tickCount: number = 0;

    /** Epoch ms timestamp after which spawn protection expires (0 = no protection). */
    spawnProtectedUntil: number = 0;

    /** Round-trip time in ms, updated by server-side ping/pong. Used for lag compensation. */
    rtt: number = 0;

    // ---- Position history ring buffer (lag compensation) ----
    private posHistory: PositionSnapshot[] = new Array(POSITION_HISTORY_SIZE);
    private posHistoryHead: number = 0;   // next write index
    private posHistoryCount: number = 0;  // how many entries are populated

    private input: InputPayload = { angle: 0, active: false, boost: false, seq: 0 };
    /** Read the current input (used by Game.ts to check one-shot flags like split). */
    getInput(): InputPayload { return this.input; }
    private idleTicks: number = 0;
    /** Cooldown ticks remaining after stamina hits 0 — prevents E-spam micro-boosts. */
    private boostCooldown: number = 0;
    /** Last input sequence number acknowledged from this player's client. */
    lastInputSeq: number = 0;

    constructor(id: string, name: string) {
        this.id = id;
        this.name = name || 'Tornado';
        this.radius = PLAYER_SPAWN_RADIUS;

        // Random spawn position (avoiding edges)
        const margin = WORLD_SIZE * 0.1;
        this.x = margin + Math.random() * (WORLD_SIZE - margin * 2);
        this.y = margin + Math.random() * (WORLD_SIZE - margin * 2);
        this.prevX = this.x;
        this.prevY = this.y;

        // Grant spawn protection immediately on creation
        this.spawnProtectedUntil = Date.now() + SPAWN_PROTECTION_MS;

        // Pre-allocate ring buffer slots
        for (let i = 0; i < POSITION_HISTORY_SIZE; i++) {
            this.posHistory[i] = { x: 0, y: 0, radius: 0, timestamp: 0 };
        }
    }

    /** Returns true when spawn invulnerability is still active. */
    isSpawnProtected(now?: number): boolean {
        return (now ?? Date.now()) < this.spawnProtectedUntil;
    }

    setInput(input: InputPayload): void {
        this.input = input;
        // Track the highest seq we've seen so the client can reconcile
        if (input.seq != null && input.seq > this.lastInputSeq) {
            this.lastInputSeq = input.seq;
        }
    }

    applyPowerUp(type: PowerUpType): void {
        const duration = POWERUP_DURATION[type] ?? 0;
        this.activeEffects.set(type, this.tickCount + duration);
    }

    hasEffect(type: PowerUpType): boolean {
        const expiry = this.activeEffects.get(type);
        return expiry !== undefined && this.tickCount < expiry;
    }

    update(dt: number, speedMultiplier: number = 1, now: number = Date.now()): void {
        if (!this.alive) return;

        // Save position before movement for swept collision detection
        this.prevX = this.x;
        this.prevY = this.y;

        this.tickCount++;

        // Expire elapsed effects
        for (const [type, expiry] of this.activeEffects) {
            if (this.tickCount >= expiry) {
                this.activeEffects.delete(type);
            }
        }

        // Rotation always spins
        this.rotation += 0.15 + (this.radius * 0.01);

        // Tick down boost cooldown
        if (this.boostCooldown > 0) this.boostCooldown--;

        // Boost requires: key held + stamina >= 10 + no cooldown active
        const canBoost = this.input.boost && this.stamina >= 10 && this.boostCooldown === 0;

        if (this.input.active) {
            this.idleTicks = 0;

            // Speed decreases slightly with size
            const boostMultiplier = canBoost ? 1.8 : 1.0;
            const powerUpSpeedMult = this.hasEffect('speed') ? SPEED_BOOST_MULTIPLIER : 1.0;
            const speed = PLAYER_SPEED * (1 - this.radius * SPEED_SIZE_FACTOR) * speedMultiplier * boostMultiplier * powerUpSpeedMult;
            // Minimum speed floor: 30% for small tornados, drops to 15% for F4+ (radius > 5)
            const minSpeedPct = this.radius > 5 ? 0.15 : 0.3;
            const clampedSpeed = Math.max(speed, PLAYER_SPEED * minSpeedPct * boostMultiplier);

            this.velocityX = Math.cos(this.input.angle) * clampedSpeed;
            this.velocityY = Math.sin(this.input.angle) * clampedSpeed;

            // Stamina drain/regen
            if (canBoost && !this.inSupercell) {
                this.stamina = Math.max(0, this.stamina - 4.0); // Drains in ~1.25s
                // When stamina runs out, enforce a 1.5-second cooldown (30 ticks)
                if (this.stamina <= 0) {
                    this.boostCooldown = 30;
                }
            } else if (this.inSupercell) {
                this.stamina = 100;
            } else if (!this.input.boost) {
                // Only regen when key is fully released — holding E during cooldown
                // keeps the player in a "forced rest" state, preventing micro-boost exploits.
                this.stamina = Math.min(100, this.stamina + 0.4); // Regens in ~12.5s
            }
        } else {
            this.idleTicks++;
            // Slow down when no input
            this.velocityX *= 0.92;
            this.velocityY *= 0.92;

            // Tiered decay when idle:
            //   > 60 ticks (~3s): base rate (1x)
            //   > 100 ticks (~5s): moderate rate (2.5x)
            //   > 220 ticks (~11s): severe AFK rate (6x)
            if (this.idleTicks > 220) {
                this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - IDLE_DECAY_RATE * 6);
                this.score  = Math.max(0, this.score - IDLE_SCORE_DECAY * 6);
            } else if (this.idleTicks > 100) {
                this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - IDLE_DECAY_RATE * 2.5);
                this.score  = Math.max(0, this.score - IDLE_SCORE_DECAY * 2.5);
            } else if (this.idleTicks > 60) {
                this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - IDLE_DECAY_RATE);
                this.score  = Math.max(0, this.score - IDLE_SCORE_DECAY);
            }
            // Regen stamina while idle too
            if (this.inSupercell) {
                this.stamina = 100;
            } else {
                this.stamina = Math.min(100, this.stamina + 0.4);
            }
        }

        // Active size decay: gentle at F3/F4, noticeably stronger at F5+ so players feel
        // pressure to keep eating. Without this F5 feels like a permanent plateau.
        if (this.radius > 3.0) {
            let decayRate: number;
            if (this.radius > 5.0) {
                // F5+: clearly perceptible — lose ~1 radius unit every ~25-30s without eating
                decayRate = (this.radius - 3.0) * 0.0008 + (this.radius - 5.0) * 0.0005;
            } else {
                // F3-F4: gentle, same as before
                decayRate = (this.radius - 3.0) * 0.00018;
            }
            this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - decayRate);
        }

        // ---- Satellite physics (split ability) ----
        // The satellite stays projected ahead of the main tornado in the
        // movement direction (like an extended arm that sweeps objects).
        if (this.satellite !== null) {
            const sat = this.satellite;
            sat.ticksLeft--;

            if (sat.ticksLeft <= 0 || sat.radius <= PLAYER_MIN_RADIUS) {
                // Merge: return satellite radius to main tornado
                this.radius = Math.min(PLAYER_MAX_RADIUS, this.radius + sat.radius);
                this.satellite = null;
            } else {
                // Target position: ahead of main tornado in movement direction
                const projectDist = this.radius * 3;
                const targetX = this.x + Math.cos(this.input.angle) * projectDist;
                const targetY = this.y + Math.sin(this.input.angle) * projectDist;

                // Smooth follow (lerp toward target so it doesn't teleport)
                const lerpRate = 0.25;
                sat.x += (targetX - sat.x) * lerpRate;
                sat.y += (targetY - sat.y) * lerpRate;

                // Clamp to world bounds
                sat.x = Math.max(sat.radius, Math.min(WORLD_SIZE - sat.radius, sat.x));
                sat.y = Math.max(sat.radius, Math.min(WORLD_SIZE - sat.radius, sat.y));

                // Store velocity for client interpolation
                sat.velocityX = sat.x - (sat.x - (targetX - sat.x) * lerpRate);
                sat.velocityY = sat.y - (sat.y - (targetY - sat.y) * lerpRate);
            }
        }

        // Apply velocity
        this.x += this.velocityX * dt;
        this.y += this.velocityY * dt;

        // Clamp to world bounds
        this.x = Math.max(this.radius, Math.min(WORLD_SIZE - this.radius, this.x));
        this.y = Math.max(this.radius, Math.min(WORLD_SIZE - this.radius, this.y));

        // Record position in history ring buffer for lag compensation
        this.recordPosition(now);
    }

    // ---- Position history (lag compensation) ----

    /** Push the current position into the ring buffer. */
    private recordPosition(now: number): void {
        const slot = this.posHistory[this.posHistoryHead];
        slot.x = this.x;
        slot.y = this.y;
        slot.radius = this.radius;
        slot.timestamp = now;
        this.posHistoryHead = (this.posHistoryHead + 1) % POSITION_HISTORY_SIZE;
        if (this.posHistoryCount < POSITION_HISTORY_SIZE) this.posHistoryCount++;
    }

    /**
     * Retrieve interpolated position at a past timestamp.
     * Returns current position if timestamp is newer than newest entry
     * or if no history is available.
     */
    getPositionAt(timestamp: number): { x: number; y: number; radius: number } {
        if (this.posHistoryCount === 0) {
            return { x: this.x, y: this.y, radius: this.radius };
        }

        // Read entries from oldest to newest
        const start = this.posHistoryCount < POSITION_HISTORY_SIZE
            ? 0
            : this.posHistoryHead; // oldest entry
        const count = this.posHistoryCount;

        // Get oldest and newest for bounds checking
        const oldestIdx = start % POSITION_HISTORY_SIZE;
        const newestIdx = (start + count - 1) % POSITION_HISTORY_SIZE;
        const oldest = this.posHistory[oldestIdx];
        const newest = this.posHistory[newestIdx];

        // Clamp: if requested time is before our oldest record, use oldest
        if (timestamp <= oldest.timestamp) {
            return { x: oldest.x, y: oldest.y, radius: oldest.radius };
        }
        // If requested time is at or after newest, use current position
        if (timestamp >= newest.timestamp) {
            return { x: this.x, y: this.y, radius: this.radius };
        }

        // Find the two entries that bracket the requested timestamp and interpolate
        for (let i = 0; i < count - 1; i++) {
            const aIdx = (start + i) % POSITION_HISTORY_SIZE;
            const bIdx = (start + i + 1) % POSITION_HISTORY_SIZE;
            const a = this.posHistory[aIdx];
            const b = this.posHistory[bIdx];

            if (timestamp >= a.timestamp && timestamp <= b.timestamp) {
                const span = b.timestamp - a.timestamp;
                if (span === 0) return { x: b.x, y: b.y, radius: b.radius };
                const t = (timestamp - a.timestamp) / span;
                return {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                    radius: a.radius + (b.radius - a.radius) * t,
                };
            }
        }

        // Fallback (should not reach here)
        return { x: this.x, y: this.y, radius: this.radius };
    }

    /**
     * Activate the split ability: project a smaller satellite tornado ahead.
     * Main keeps 80% radius; satellite gets 50% of original radius.
     * The satellite stays projected ahead of the main in the movement direction.
     */
    trySplit(): boolean {
        if (this.satellite !== null) return false;
        if (this.radius < SPLIT_MIN_RADIUS) return false;

        const originalR = this.radius;
        const satRadius = originalR * 0.5;
        this.radius = originalR * 0.8;

        // Project satellite forward in the current movement direction
        const angle = this.input.angle;
        const projectDist = this.radius * 3;
        this.satellite = {
            x: this.x + Math.cos(angle) * projectDist,
            y: this.y + Math.sin(angle) * projectDist,
            radius: satRadius,
            velocityX: 0,
            velocityY: 0,
            ticksLeft: SPLIT_DURATION_TICKS,
        };
        // Clamp satellite spawn position to world bounds
        this.satellite.x = Math.max(satRadius, Math.min(WORLD_SIZE - satRadius, this.satellite.x));
        this.satellite.y = Math.max(satRadius, Math.min(WORLD_SIZE - satRadius, this.satellite.y));
        return true;
    }

    grow(points: number, radiusGrowth: number): void {
        this.score += points;
        // Growth multiplier by radius band — calibrated so each Fujita stage
        // (F0-F2) is meaningfully long rather than a blink-and-miss-it transition.
        //
        // Old curve gave F0-F1 a 2.0× boost, causing players to rocket through
        // early stages. New curve keeps small tornados at 1.2× (still responsive
        // but without the runaway early snowball):
        //
        //  radius < 1.5  (F0-F1) : 1.2×  — was 2.0×, slowed down
        //  1.5 – 2.5     (F1-F2) : 1.0×  — was 1.55×, neutral growth
        //  2.5 – 4.0     (F2-F3) : 0.85× — slight early taper
        //  4.0 – 6.0     (F3 core): 0.7× — noticeable taper
        //  > 6.0         (F4+)   : 2.4/radius — existing formula preserved
        let growthMult = 1.0;
        if (this.radius < 1.5) {
            growthMult = 1.2;
        } else if (this.radius < 2.5) {
            growthMult = 1.0;
        } else if (this.radius < 4.0) {
            growthMult = 0.85;
        } else if (this.radius < 6.0) {
            growthMult = 0.35; // F4 range: halved (was 0.70) — reaching F5 now takes ~2× longer
        } else {
            growthMult = 1.2 / this.radius; // F5 range: halved (was 2.4/r)
        }
        
        let finalGrowth = radiusGrowth * growthMult;
        if (this.inSupercell) {
            // Apply constant multiplier from constants directly
            finalGrowth *= 2.0; 
        }

        this.radius = Math.min(PLAYER_MAX_RADIUS, this.radius + finalGrowth);
    }

    canAbsorb(other: Player): boolean {
        return this.radius > other.radius * ABSORB_RATIO;
    }

    distanceTo(other: { x: number; y: number }): number {
        const dx = this.x - other.x;
        const dy = this.y - other.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    respawn(): void {
        const margin = WORLD_SIZE * 0.1;
        this.x = margin + Math.random() * (WORLD_SIZE - margin * 2);
        this.y = margin + Math.random() * (WORLD_SIZE - margin * 2);
        this.radius = PLAYER_SPAWN_RADIUS;
        this.score = 0;
        this.velocityX = 0;
        this.velocityY = 0;
        this.alive = true;
        this.stamina = 100;
        this.idleTicks = 0;
        this.rotation = 0;
        this.activeEffects.clear();
        this.boostCooldown = 0;
        this.satellite = null;
        // Re-grant spawn protection on respawn
        this.spawnProtectedUntil = Date.now() + SPAWN_PROTECTION_MS;
        // Clear position history so lag compensation doesn't use pre-death positions
        this.posHistoryCount = 0;
        this.posHistoryHead = 0;
    }

    // Pre-allocated state object reused every tick (avoid per-tick allocation)
    private _cachedState: PlayerState = {
        id: '', name: '', x: 0, y: 0, radius: 0, rotation: 0,
        score: 0, velocityX: 0, velocityY: 0, alive: true,
        stamina: 100, activeEffects: [], protected: false, afk: false, lastInputSeq: 0,
        satellite: undefined,
    };
    private _cachedEffects: ActiveEffect[] = [];

    toState(now?: number): PlayerState {
        // Reuse cached effects array — truncate and refill
        const effects = this._cachedEffects;
        effects.length = 0;
        for (const [type, expiry] of this.activeEffects) {
            if (this.tickCount < expiry) {
                effects.push({ type, expiresAt: expiry - this.tickCount });
            }
        }

        // Mutate pre-allocated state object (caller must not hold references across ticks)
        const s = this._cachedState;
        s.id = this.id;
        s.name = this.name;
        s.x = Player.round2(this.x);
        s.y = Player.round2(this.y);
        s.radius = Player.round3(this.radius);
        s.rotation = Player.round3(this.rotation);
        s.score = Math.floor(this.score);
        s.velocityX = Player.round3(this.velocityX);
        s.velocityY = Player.round3(this.velocityY);
        s.alive = this.alive;
        s.stamina = Player.round1(this.stamina);
        s.activeEffects = effects;
        s.protected = this.isSpawnProtected(now) || this.hasEffect('shield');
        s.afk = this.idleTicks > 60;
        s.lastInputSeq = this.lastInputSeq;
        s.satellite = this.satellite ?? undefined;
        return s;
    }
}
