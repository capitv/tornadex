// ============================================
// Particle System — Dust and Destruction Effects
// ============================================

import * as THREE from 'three';
import { getGraphicsPreset, onGraphicsChange } from '../settings/GraphicsConfig.js';

// Particle priority levels — higher value = higher priority = kept longer when pool is full
export const enum ParticlePriority {
    LOW    = 0, // Ambient dust, cosmetic wisps
    MEDIUM = 1, // Generic destruction debris
    HIGH   = 2, // Player-caused destruction, important events
}

// Particle type tags for management and debugging
export type ParticleType = 'dust' | 'destruction' | 'explosion' | 'water';

interface Particle {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    life: number;
    maxLife: number;
    size: number;
    r: number;
    g: number;
    b: number;
    // Priority recycling fields
    priority: ParticlePriority;
    type: ParticleType;
    spawnTime: number; // monotonic counter for "oldest particle" tracking
}

// Absolute maximum buffer size (High preset).  The active graphics preset may
// cap actual usage lower via this.maxParticles — the GPU buffer is allocated
// once at construction so we never need to reallocate it.
const BUFFER_MAX_PARTICLES = 1000;

// Monotonic counter — lightweight age stamp, avoids Date.now() in hot loops
let _spawnClock = 0;

// ---- Waterspout particle pool (separate budget so it never competes with dust/destruction) ----
const MAX_WATER_PARTICLES = 300;

export class ParticleSystem {
    private points: THREE.Points;
    private positions: Float32Array;
    private colors: Float32Array;
    private sizes: Float32Array;
    private pool: Particle[] = [];
    private active: Particle[] = [];

    // ---- Waterspout separate pool ----
    private waterPoints: THREE.Points;
    private waterPositions: Float32Array;
    private waterColors: Float32Array;
    private waterSizes: Float32Array;
    private waterPool: Particle[] = [];
    private waterActive: Particle[] = [];

    // Splash ring meshes — keyed by a tornado ID so we can reuse/remove them
    private splashRings: Map<string, THREE.Mesh> = new Map();
    private scene: THREE.Scene;

    // Internal time counter for animated splash rings
    private waterTime: number = 0;

    // High-water marks to minimize GPU buffer writes
    private _prevActiveCount: number = 0;
    private _prevWaterActiveCount: number = 0;

    // Effective particle cap — read from graphics preset, updated on quality change.
    // Must never exceed BUFFER_MAX_PARTICLES (the allocated GPU buffer size).
    private maxParticles: number = getGraphicsPreset().maxParticles;

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        // ---- Main pool ----
        // Always allocate the full buffer; the active cap (maxParticles) limits usage.
        this.positions = new Float32Array(BUFFER_MAX_PARTICLES * 3);
        this.colors = new Float32Array(BUFFER_MAX_PARTICLES * 3);
        this.sizes = new Float32Array(BUFFER_MAX_PARTICLES);

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        geom.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
        geom.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

        const mat = new THREE.PointsMaterial({
            size: 0.5,
            vertexColors: true,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this.points = new THREE.Points(geom, mat);
        scene.add(this.points);

        // Pre-allocate the full pool at maximum capacity so we never need to
        // grow it at runtime (quality changes only lower the active cap).
        for (let i = 0; i < BUFFER_MAX_PARTICLES; i++) {
            this.pool.push({
                x: 0, y: 0, z: 0,
                vx: 0, vy: 0, vz: 0,
                life: 0, maxLife: 1,
                size: 0.3,
                r: 1, g: 1, b: 1,
                priority: ParticlePriority.LOW,
                type: 'dust',
                spawnTime: 0,
            });
        }

        // Listen for graphics quality changes and update the active cap in real time.
        onGraphicsChange((preset) => {
            this.maxParticles = Math.min(preset.maxParticles, BUFFER_MAX_PARTICLES);
        });

        // ---- Waterspout pool ----
        this.waterPositions = new Float32Array(MAX_WATER_PARTICLES * 3);
        this.waterColors = new Float32Array(MAX_WATER_PARTICLES * 3);
        this.waterSizes = new Float32Array(MAX_WATER_PARTICLES);

        const waterGeom = new THREE.BufferGeometry();
        waterGeom.setAttribute('position', new THREE.BufferAttribute(this.waterPositions, 3));
        waterGeom.setAttribute('color', new THREE.BufferAttribute(this.waterColors, 3));
        waterGeom.setAttribute('size', new THREE.BufferAttribute(this.waterSizes, 1));

        // Additive blending gives a bright, glowing, watery look
        const waterMat = new THREE.PointsMaterial({
            size: 0.6,
            vertexColors: true,
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this.waterPoints = new THREE.Points(waterGeom, waterMat);
        scene.add(this.waterPoints);

        // Pre-allocate water particle pool
        for (let i = 0; i < MAX_WATER_PARTICLES; i++) {
            this.waterPool.push({
                x: 0, y: 0, z: 0,
                vx: 0, vy: 0, vz: 0,
                life: 0, maxLife: 1,
                size: 0.4,
                r: 0.4, g: 0.8, b: 1.0,
                priority: ParticlePriority.LOW,
                type: 'water',
                spawnTime: 0,
            });
        }
    }

    // -----------------------------------------------------------------------
    // Pool acquisition with priority-based recycling
    //
    // When the free pool is empty, we recycle an active particle:
    //   1. First pass: find the oldest (smallest spawnTime) active particle
    //      whose priority is strictly below neededPriority.
    //   2. Second pass (fallback): if no lower-priority candidate exists,
    //      recycle the globally oldest active particle regardless of priority
    //      so HIGH-priority effects always get a slot.
    // -----------------------------------------------------------------------
    private acquireParticle(neededPriority: ParticlePriority): Particle | null {
        // Enforce the active graphics preset cap — if we're already at the limit
        // we must recycle an existing active particle rather than popping from pool.
        const atCap = this.active.length >= this.maxParticles;
        if (this.pool.length > 0 && !atCap) {
            return this.pool.pop()!;
        }
        if (this.active.length === 0) return null;

        // Pass 1 — oldest lower-priority victim
        let bestIdx = -1;
        let bestTime = Infinity;
        for (let i = 0; i < this.active.length; i++) {
            const p = this.active[i];
            if (p.priority < neededPriority && p.spawnTime < bestTime) {
                bestTime = p.spawnTime;
                bestIdx  = i;
            }
        }

        // Pass 2 — globally oldest fallback
        if (bestIdx === -1) {
            bestTime = Infinity;
            for (let i = 0; i < this.active.length; i++) {
                if (this.active[i].spawnTime < bestTime) {
                    bestTime = this.active[i].spawnTime;
                    bestIdx  = i;
                }
            }
        }

        if (bestIdx === -1) return null;

        const recycled = this.active[bestIdx];
        this.active[bestIdx] = this.active[this.active.length - 1];
        this.active.pop();
        return recycled;
    }

    // Spawn dust particles around tornado base
    emitDust(x: number, z: number, radius: number): void {
        const count = 3;
        for (let i = 0; i < count; i++) {
            const p = this.acquireParticle(ParticlePriority.LOW);
            if (!p) break;

            const angle = Math.random() * Math.PI * 2;
            const dist = radius * (0.8 + Math.random() * 0.6);

            p.x = x + Math.cos(angle) * dist;
            p.y = Math.random() * 0.5;
            p.z = z + Math.sin(angle) * dist;
            p.vx = (Math.random() - 0.5) * 0.3;
            p.vy = 0.1 + Math.random() * 0.2;
            p.vz = (Math.random() - 0.5) * 0.3;
            p.life = 1;
            p.maxLife = 0.5 + Math.random() * 0.5;
            p.size = 0.3 + Math.random() * 0.4;
            // Brown/tan dust
            p.r = 0.5 + Math.random() * 0.2;
            p.g = 0.4 + Math.random() * 0.15;
            p.b = 0.25;
            p.priority  = ParticlePriority.LOW;
            p.type      = 'dust';
            p.spawnTime = ++_spawnClock;

            this.active.push(p);
        }
    }

    // Generic explosion when type isn't known
    emitExplosion(x: number, z: number, size: number): void {
        this.emitDestruction(x, z, 'unknown');
    }

    // Spawn destruction effect.
    // Prefix the type string with "player:" (e.g. "player:car") to mark the
    // event as player-caused — those particles receive HIGH priority and will
    // survive longer under pool pressure than ambient LOW-priority dust.
    emitDestruction(x: number, z: number, type: string): void {
        const isPlayerCaused = type.startsWith('player:');
        const objectType     = isPlayerCaused ? type.slice(7) : type;
        const priority       = isPlayerCaused ? ParticlePriority.HIGH : ParticlePriority.MEDIUM;

        const count = 12;
        for (let i = 0; i < count; i++) {
            const p = this.acquireParticle(priority);
            if (!p) break;

            p.x = x + (Math.random() - 0.5) * 2;
            p.y = Math.random() * 2;
            p.z = z + (Math.random() - 0.5) * 2;
            p.vx = (Math.random() - 0.5) * 2;
            p.vy = 2 + Math.random() * 4;
            p.vz = (Math.random() - 0.5) * 2;
            p.life = 1;
            p.maxLife = 1 + Math.random() * 1;
            p.size = 0.3 + Math.random() * 0.6;
            p.priority  = priority;
            p.type      = 'destruction';
            p.spawnTime = ++_spawnClock;

            // Color based on object type
            switch (objectType) {
                case 'tree':
                    p.r = 0.2; p.g = 0.5 + Math.random() * 0.3; p.b = 0.15;
                    break;
                case 'house':
                case 'building':
                    p.r = 0.6; p.g = 0.55; p.b = 0.5;
                    break;
                case 'car':
                    p.r = 0.4 + Math.random() * 0.4; p.g = 0.2; p.b = 0.2;
                    break;
                case 'animal':
                    p.r = 0.5; p.g = 0.35; p.b = 0.2;
                    break;
                default:
                    p.r = 0.5; p.g = 0.5; p.b = 0.5;
            }

            this.active.push(p);
        }
    }

    // Returns the number of currently active (visible) main-pool particles.
    // Useful for debugging and performance monitoring in the HUD.
    getActiveCount(): number {
        return this.active.length;
    }

    // Returns the number of currently active water particles.
    getActiveWaterCount(): number {
        return this.waterActive.length;
    }

    // Returns a snapshot of pool capacity for monitoring / debug overlays.
    getPoolStats(): { active: number; pooled: number; total: number; waterActive: number; waterPooled: number } {
        return {
            active:      this.active.length,
            pooled:      this.pool.length,
            total:       this.maxParticles,
            waterActive: this.waterActive.length,
            waterPooled: this.waterPool.length,
        };
    }

    // =========================================================
    // Waterspout Effect — blue/cyan/white water column
    // =========================================================

    /**
     * Emit a frame's worth of waterspout particles and maintain the splash ring.
     *
     * @param tornadoId  Stable ID so we can track per-tornado splash ring meshes.
     * @param x          World X centre of the tornado.
     * @param z          World Z centre of the tornado.
     * @param radius     Tornado base radius — scales intensity and column width.
     */
    emitWaterspout(tornadoId: string, x: number, z: number, radius: number): void {
        // Scale emission count with radius so a tiny F0 has a subtle drizzle
        // while a large tornado pulls a fat roaring column.
        const baseCount = Math.floor(radius * 1.5 + 2);
        const upCount   = Math.min(baseCount, this.waterPool.length);

        // Column width tracks the tornado's funnel bottom width
        const columnRadius = Math.max(0.4, radius * 0.25);

        // ---- 1. Upward spiral column particles ----
        for (let i = 0; i < upCount; i++) {
            const p = this.waterPool.pop();
            if (!p) break;

            // Distribute around a ring that tightens toward the centre as they rise
            const angle = Math.random() * Math.PI * 2;
            const dist  = columnRadius * (0.3 + Math.random() * 0.7);

            p.x = x + Math.cos(angle) * dist;
            p.y = Math.random() * 0.3;          // spawn near the water surface
            p.z = z + Math.sin(angle) * dist;

            // Upward velocity with a tangential swirl component matching tornado spin
            const swirl  = (Math.random() - 0.5) * 1.2 * radius;
            const upSpeed = 1.5 + Math.random() * radius * 0.8;

            p.vx = Math.cos(angle + Math.PI / 2) * swirl * 0.4 + (Math.random() - 0.5) * 0.4;
            p.vy = upSpeed;
            p.vz = Math.sin(angle + Math.PI / 2) * swirl * 0.4 + (Math.random() - 0.5) * 0.4;

            p.life    = 1;
            p.maxLife = 0.6 + Math.random() * (0.4 + radius * 0.1);
            p.size    = 0.25 + Math.random() * (0.3 + radius * 0.05);

            // Blue/cyan/white palette — randomly pick a shade per particle
            const shade = Math.random();
            if (shade < 0.35) {
                // Deep cyan-blue
                p.r = 0.05 + Math.random() * 0.15;
                p.g = 0.55 + Math.random() * 0.25;
                p.b = 0.85 + Math.random() * 0.15;
            } else if (shade < 0.70) {
                // Bright cyan
                p.r = 0.15 + Math.random() * 0.2;
                p.g = 0.75 + Math.random() * 0.2;
                p.b = 0.9  + Math.random() * 0.1;
            } else {
                // White mist / foam
                p.r = 0.7 + Math.random() * 0.3;
                p.g = 0.85 + Math.random() * 0.15;
                p.b = 1.0;
            }

            this.waterActive.push(p);
        }

        // ---- 2. Base mist / spray particles (low, outward splash) ----
        const mistCount = Math.min(Math.floor(radius * 0.8 + 1), this.waterPool.length);
        for (let i = 0; i < mistCount; i++) {
            const p = this.waterPool.pop();
            if (!p) break;

            const angle = Math.random() * Math.PI * 2;
            const dist  = columnRadius * (1.0 + Math.random() * 1.5);

            p.x = x + Math.cos(angle) * dist;
            p.y = 0.05 + Math.random() * 0.2;
            p.z = z + Math.sin(angle) * dist;

            // Slow outward spray, mostly horizontal with a small upward kick
            p.vx = Math.cos(angle) * (0.5 + Math.random() * 1.0);
            p.vy = 0.4 + Math.random() * 0.6;
            p.vz = Math.sin(angle) * (0.5 + Math.random() * 1.0);

            p.life    = 1;
            p.maxLife = 0.3 + Math.random() * 0.3;
            p.size    = 0.2 + Math.random() * 0.25;

            // Lighter, frostier tones for the mist layer
            p.r = 0.4 + Math.random() * 0.4;
            p.g = 0.7 + Math.random() * 0.25;
            p.b = 0.9 + Math.random() * 0.1;

            this.waterActive.push(p);
        }

        // ---- 3. Splash ring — one animated ring mesh per tornado ----
        this.updateSplashRing(tornadoId, x, z, radius);
    }

    /** Create or update the animated splash ring at the water surface. */
    private updateSplashRing(tornadoId: string, x: number, z: number, radius: number): void {
        let ring = this.splashRings.get(tornadoId);

        if (!ring) {
            // RingGeometry(innerRadius, outerRadius, segments)
            const ringGeo  = new THREE.RingGeometry(0.1, 1.0, 48);
            const ringMat  = new THREE.MeshBasicMaterial({
                color: 0x55ddff,
                transparent: true,
                opacity: 0.35,
                side: THREE.DoubleSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            });
            ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = -Math.PI / 2;
            ring.position.y  = 0.06; // just above the water plane
            this.scene.add(ring);
            this.splashRings.set(tornadoId, ring);
        }

        // Pulse the ring outward — inner stays at funnel base, outer breathes
        const pulseScale = Math.max(0.4, radius * 0.35) * (1.0 + Math.sin(this.waterTime * 3.5) * 0.12);
        ring.position.set(x, 0.06, z);
        ring.scale.set(pulseScale, pulseScale, 1);

        // Fade opacity with a gentle pulse
        const mat = ring.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.25 + Math.sin(this.waterTime * 4.0 + 1.0) * 0.1;
    }

    /** Call when a tornado leaves water or is removed so the ring is cleaned up. */
    removeSplashRing(tornadoId: string): void {
        const ring = this.splashRings.get(tornadoId);
        if (ring) {
            this.scene.remove(ring);
            (ring.material as THREE.Material).dispose();
            ring.geometry.dispose();
            this.splashRings.delete(tornadoId);
        }
    }

    update(dt: number): void {
        const decay = dt * 0.016;
        this.waterTime += dt * 0.001;

        // Update active particles
        for (let i = this.active.length - 1; i >= 0; i--) {
            const p = this.active[i];
            p.life -= decay / p.maxLife;

            if (p.life <= 0) {
                // Return to pool
                this.pool.push(p);
                this.active[i] = this.active[this.active.length - 1];
                this.active.pop();
                continue;
            }

            // Physics
            p.x += p.vx * decay;
            p.y += p.vy * decay;
            p.z += p.vz * decay;
            p.vy -= 2.0 * decay; // gravity
            p.vx *= 0.98;
            p.vz *= 0.98;

            // Don't go below ground
            if (p.y < 0) {
                p.y = 0;
                p.vy = 0;
            }
        }

        // Write active particles to the GPU buffer
        for (let i = 0; i < this.active.length; i++) {
            const p = this.active[i];
            this.positions[i * 3] = p.x;
            this.positions[i * 3 + 1] = p.y;
            this.positions[i * 3 + 2] = p.z;
            this.colors[i * 3] = p.r * p.life;
            this.colors[i * 3 + 1] = p.g * p.life;
            this.colors[i * 3 + 2] = p.b * p.life;
            this.sizes[i] = p.size * p.life;
        }
        // Clear only the slots that were active last frame but are not now
        for (let i = this.active.length; i < this._prevActiveCount; i++) {
            this.positions[i * 3] = 0;
            this.positions[i * 3 + 1] = -100;
            this.positions[i * 3 + 2] = 0;
            this.sizes[i] = 0;
        }

        const activeCount = this.active.length;
        const hadOrHasActive = activeCount > 0 || this._prevActiveCount > 0;
        if (hadOrHasActive) {
            const uploadCount = Math.max(activeCount, this._prevActiveCount);

            const posAttr = this.points.geometry.attributes.position as THREE.BufferAttribute;
            posAttr.clearUpdateRanges();
            posAttr.addUpdateRange(0, uploadCount * 3);
            posAttr.needsUpdate = true;

            const colAttr = this.points.geometry.attributes.color as THREE.BufferAttribute;
            colAttr.clearUpdateRanges();
            colAttr.addUpdateRange(0, uploadCount * 3);
            colAttr.needsUpdate = true;

            const sizeAttr = this.points.geometry.attributes.size as THREE.BufferAttribute;
            sizeAttr.clearUpdateRanges();
            sizeAttr.addUpdateRange(0, uploadCount);
            sizeAttr.needsUpdate = true;
        }
        this._prevActiveCount = activeCount;

        // ---- Water particle update ----
        // Water particles have reduced gravity (they are being pulled up by the vortex)
        // and they fade out as they rise, giving a misty column effect.
        for (let i = this.waterActive.length - 1; i >= 0; i--) {
            const p = this.waterActive[i];
            p.life -= decay / p.maxLife;

            if (p.life <= 0) {
                this.waterPool.push(p);
                this.waterActive[i] = this.waterActive[this.waterActive.length - 1];
                this.waterActive.pop();
                continue;
            }

            p.x += p.vx * decay;
            p.y += p.vy * decay;
            p.z += p.vz * decay;

            // Waterspout particles fight gravity (upward suction) — very low net downward pull
            p.vy -= 0.6 * decay;

            // Gentle drag so they spread and slow naturally
            p.vx *= 0.97;
            p.vz *= 0.97;

            // Clamp: don't fall below the water surface
            if (p.y < 0) {
                p.y = 0;
                p.vy = Math.abs(p.vy) * 0.3; // small bounce
            }
        }

        // Write active water particles to their buffer
        for (let i = 0; i < this.waterActive.length; i++) {
            const p = this.waterActive[i];
            this.waterPositions[i * 3]     = p.x;
            this.waterPositions[i * 3 + 1] = p.y;
            this.waterPositions[i * 3 + 2] = p.z;
            // Additive blending means multiplying by life fades them out cleanly
            this.waterColors[i * 3]     = p.r * p.life;
            this.waterColors[i * 3 + 1] = p.g * p.life;
            this.waterColors[i * 3 + 2] = p.b * p.life;
            this.waterSizes[i] = p.size * (0.5 + p.life * 0.5); // shrink as they fade
        }
        // Clear only the slots that were active last frame but are not now
        for (let i = this.waterActive.length; i < this._prevWaterActiveCount; i++) {
            this.waterPositions[i * 3]     = 0;
            this.waterPositions[i * 3 + 1] = -100;
            this.waterPositions[i * 3 + 2] = 0;
            this.waterSizes[i] = 0;
        }
        const waterActiveCount = this.waterActive.length;
        const waterHadOrHasActive = waterActiveCount > 0 || this._prevWaterActiveCount > 0;
        if (waterHadOrHasActive) {
            const waterUploadCount = Math.max(waterActiveCount, this._prevWaterActiveCount);

            const wPosAttr = this.waterPoints.geometry.attributes.position as THREE.BufferAttribute;
            wPosAttr.clearUpdateRanges();
            wPosAttr.addUpdateRange(0, waterUploadCount * 3);
            wPosAttr.needsUpdate = true;

            const wColAttr = this.waterPoints.geometry.attributes.color as THREE.BufferAttribute;
            wColAttr.clearUpdateRanges();
            wColAttr.addUpdateRange(0, waterUploadCount * 3);
            wColAttr.needsUpdate = true;

            const wSizeAttr = this.waterPoints.geometry.attributes.size as THREE.BufferAttribute;
            wSizeAttr.clearUpdateRanges();
            wSizeAttr.addUpdateRange(0, waterUploadCount);
            wSizeAttr.needsUpdate = true;
        }
        this._prevWaterActiveCount = waterActiveCount;
    }
}
