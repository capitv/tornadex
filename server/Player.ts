// ============================================
// Player (Tornado) - Server-side State
// ============================================

import { PlayerState, InputPayload, ActiveEffect, PowerUpType } from '../shared/types.js';
import {
    PLAYER_SPEED, PLAYER_MIN_RADIUS, PLAYER_MAX_RADIUS,
    PLAYER_SPAWN_RADIUS, IDLE_DECAY_RATE, IDLE_SCORE_DECAY,
    WORLD_SIZE, SPEED_SIZE_FACTOR, ABSORB_RATIO,
    POWERUP_DURATION, SPEED_BOOST_MULTIPLIER,
    SPAWN_PROTECTION_MS,
} from './constants.js';

export class Player {
    id: string;
    name: string;
    x: number;
    y: number;
    radius: number;
    rotation: number = 0;
    score: number = 0;
    velocityX: number = 0;
    velocityY: number = 0;
    alive: boolean = true;
    stamina: number = 100; // 0-100

    // Map of power-up type → tick timestamp when effect expires
    activeEffects: Map<PowerUpType, number> = new Map();
    // Running tick counter used for effect expiry
    tickCount: number = 0;

    /** Epoch ms timestamp after which spawn protection expires (0 = no protection). */
    spawnProtectedUntil: number = 0;

    private input: InputPayload = { angle: 0, active: false, boost: false, seq: 0 };
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

        // Grant spawn protection immediately on creation
        this.spawnProtectedUntil = Date.now() + SPAWN_PROTECTION_MS;
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

    update(dt: number, speedMultiplier: number = 1): void {
        if (!this.alive) return;

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
            const clampedSpeed = Math.max(speed, PLAYER_SPEED * 0.3 * boostMultiplier); // Never slower than 30% base speed

            this.velocityX = Math.cos(this.input.angle) * clampedSpeed;
            this.velocityY = Math.sin(this.input.angle) * clampedSpeed;

            // Stamina drain/regen
            if (canBoost) {
                this.stamina = Math.max(0, this.stamina - 4.0); // Drains in ~1.25s
                // When stamina runs out, enforce a 1.5-second cooldown (30 ticks)
                if (this.stamina <= 0) {
                    this.boostCooldown = 30;
                }
            } else {
                this.stamina = Math.min(100, this.stamina + 0.4); // Regens in ~12.5s
            }
        } else {
            this.idleTicks++;
            // Slow down when no input
            this.velocityX *= 0.92;
            this.velocityY *= 0.92;

            // Tiered decay when idle:
            //   > 40 ticks (~2s): base rate (1x)
            //   > 60 ticks (~3s): fast rate (3x)
            //   > 160 ticks (~8s): very fast rate (8x)
            if (this.idleTicks > 160) {
                // 8x decay — severe AFK penalty
                this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - IDLE_DECAY_RATE * 8);
                this.score  = Math.max(0, this.score - IDLE_SCORE_DECAY * 8);
            } else if (this.idleTicks > 60) {
                // 3x decay — moderate AFK penalty
                this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - IDLE_DECAY_RATE * 3);
                this.score  = Math.max(0, this.score - IDLE_SCORE_DECAY * 3);
            } else if (this.idleTicks > 40) {
                // 1x decay — grace period just ended
                this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - IDLE_DECAY_RATE);
                this.score  = Math.max(0, this.score - IDLE_SCORE_DECAY);
            }
            // Regen stamina while idle too
            this.stamina = Math.min(100, this.stamina + 0.4);
        }

        // Active size decay — larger tornados naturally lose radius over time even while moving.
        // This prevents F4/F5 tornados from staying giant forever.
        // Decay starts above radius 2.0 (F1+) and scales with size.
        if (this.radius > 2.0) {
            const decayRate = (this.radius - 2.0) * 0.0008; // bigger = faster decay
            this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - decayRate);
        }

        // Apply velocity
        this.x += this.velocityX * dt;
        this.y += this.velocityY * dt;

        // Admin controls for testing sizes
        if (this.input.adminGrow) {
            this.radius = Math.min(PLAYER_MAX_RADIUS, this.radius + 0.05); // Rapid growth
        }
        if (this.input.adminShrink) {
            this.radius = Math.max(PLAYER_MIN_RADIUS, this.radius - 0.05); // Rapid shrink
        }

        // Clamp to world bounds
        this.x = Math.max(this.radius, Math.min(WORLD_SIZE - this.radius, this.x));
        this.y = Math.max(this.radius, Math.min(WORLD_SIZE - this.radius, this.y));
    }

    grow(points: number, radiusGrowth: number): void {
        this.score += points;
        this.radius = Math.min(PLAYER_MAX_RADIUS, this.radius + radiusGrowth);
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
        // Re-grant spawn protection on respawn
        this.spawnProtectedUntil = Date.now() + SPAWN_PROTECTION_MS;
    }

    toState(now?: number): PlayerState {
        // Convert the internal Map into a flat array for the network payload.
        // Each entry carries the effect type and how many ticks (≈ seconds × TICK_RATE)
        // remain so the client can display accurate countdown timers.
        const activeEffects: ActiveEffect[] = [];
        for (const [type, expiry] of this.activeEffects) {
            if (this.tickCount < expiry) {
                activeEffects.push({ type, expiresAt: expiry - this.tickCount });
            }
        }

        return {
            id: this.id,
            name: this.name,
            x: this.x,
            y: this.y,
            radius: this.radius,
            rotation: this.rotation,
            score: this.score,
            velocityX: this.velocityX,
            velocityY: this.velocityY,
            alive: this.alive,
            stamina: this.stamina,
            activeEffects,
            // Protected when spawn invulnerability is active OR the shield power-up is active.
            // The safe-zone check is done in Game.ts; the client only needs the boolean.
            protected: this.isSpawnProtected(now) || this.hasEffect('shield'),
            // AFK flag — true once idle ticks exceed 60 (~3 seconds); resets on any input.
            afk: this.idleTicks > 60,
            // Echo back the last processed input sequence for client-side reconciliation.
            lastInputSeq: this.lastInputSeq,
        };
    }
}
