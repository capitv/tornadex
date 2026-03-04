// ============================================
// Fragment System — Breaking animation for destroyed objects
// Pooled mesh fragments that fly, spin, and fall with gravity
// ============================================

import * as THREE from 'three';
import type { WorldObjectType } from '../../shared/types.js';

// ------------------------------------
// Per-type fragment configuration
// ------------------------------------
interface FragmentConfig {
    geometries: THREE.BufferGeometry[];
    colors: number[];
    countMin: number;
    countMax: number;
    launchSpeed: number;    // horizontal spread
    launchUpMin: number;    // minimum upward velocity
    launchUpMax: number;    // maximum upward velocity
    spinSpeed: number;      // max radians/sec per axis
    scale: number;          // base fragment scale
}

const CONFIGS: Record<WorldObjectType, FragmentConfig> = {
    tree: {
        geometries: [
            // Trunk pieces — elongated cylinders
            new THREE.CylinderGeometry(0.06, 0.09, 0.55, 5),
            new THREE.CylinderGeometry(0.05, 0.07, 0.35, 5),
            // Leaf clusters — flat discs
            new THREE.CylinderGeometry(0.30, 0.25, 0.06, 7),
            new THREE.CylinderGeometry(0.22, 0.18, 0.05, 7),
        ],
        colors: [0x5c4033, 0x4a3020, 0x3a2818, 0x2d6a1f, 0x3e8c2a, 0x226a15],
        countMin: 5, countMax: 7,
        launchSpeed: 3.5, launchUpMin: 3, launchUpMax: 7,
        spinSpeed: 6, scale: 1.0,
    },
    house: {
        geometries: [
            // Flat wall panels — wide thin slabs
            new THREE.BoxGeometry(0.70, 0.08, 0.40),
            new THREE.BoxGeometry(0.55, 0.07, 0.55),
            // Small bricks / rubble cubes
            new THREE.BoxGeometry(0.16, 0.09, 0.09),
            new THREE.BoxGeometry(0.12, 0.12, 0.12),
        ],
        colors: [0xc8bfb0, 0xddd5c5, 0xb8a898, 0x8b4513, 0xa0522d, 0x9e9e9e],
        countMin: 5, countMax: 7,
        launchSpeed: 4.0, launchUpMin: 3.5, launchUpMax: 8,
        spinSpeed: 5, scale: 1.0,
    },
    car: {
        geometries: [
            // Elongated chassis / body panels
            new THREE.BoxGeometry(0.60, 0.12, 0.28),
            new THREE.BoxGeometry(0.42, 0.10, 0.22),
            // Wheels — small cylinders
            new THREE.CylinderGeometry(0.13, 0.13, 0.09, 8),
            new THREE.CylinderGeometry(0.10, 0.10, 0.08, 8),
        ],
        colors: [0x8a8a8a, 0xb0b0b0, 0x4a4a4a, 0x222222, 0x1a1a1a, 0x87ceeb],
        countMin: 4, countMax: 6,
        launchSpeed: 5.0, launchUpMin: 4, launchUpMax: 9,
        spinSpeed: 8, scale: 1.0,
    },
    animal: {
        geometries: [
            new THREE.SphereGeometry(0.14, 5, 4),          // fur chunk
            new THREE.BoxGeometry(0.15, 0.12, 0.20),       // body piece
        ],
        colors: [0x8b6914, 0x654321, 0xd2691e, 0xa0522d],
        countMin: 3, countMax: 4,
        launchSpeed: 3.0, launchUpMin: 2.5, launchUpMax: 6,
        spinSpeed: 5, scale: 0.9,
    },
    building: {
        geometries: [
            new THREE.BoxGeometry(0.4, 0.4, 0.3),          // concrete slab
            new THREE.BoxGeometry(0.25, 0.55, 0.25),       // column piece
            new THREE.TetrahedronGeometry(0.25),            // rubble chunk
        ],
        colors: [0x7f8c8d, 0x95a5a6, 0x606c76, 0xb0b3b5, 0x4a4f52],
        countMin: 5, countMax: 6,
        launchSpeed: 4.5, launchUpMin: 4, launchUpMax: 10,
        spinSpeed: 4, scale: 1.2,
    },
    trailer_park: {
        geometries: [
            new THREE.BoxGeometry(0.55, 0.18, 0.28),       // wall panel
            new THREE.BoxGeometry(0.30, 0.14, 0.30),       // corner chunk
            new THREE.TetrahedronGeometry(0.18),            // rubble lump
        ],
        colors: [0xd4c5a9, 0xc8b89a, 0xbfad8e, 0x9e9e9e, 0x8b8b8b],
        countMin: 6, countMax: 9,
        launchSpeed: 5.0, launchUpMin: 4, launchUpMax: 10,
        spinSpeed: 6, scale: 1.1,
    },
    stadium: {
        geometries: [
            new THREE.BoxGeometry(0.6, 0.35, 0.5),         // concrete seating slab
            new THREE.BoxGeometry(0.35, 0.6, 0.35),        // support column
            new THREE.TetrahedronGeometry(0.30),            // concrete chunk
            new THREE.BoxGeometry(0.20, 0.20, 0.60),       // railing piece
        ],
        colors: [0x909090, 0xa8a8a8, 0x707070, 0xe8451a, 0xc0392b],
        countMin: 8, countMax: 12,
        launchSpeed: 5.5, launchUpMin: 5, launchUpMax: 14,
        spinSpeed: 3, scale: 1.4,
    },
    bridge: {
        geometries: [
            new THREE.BoxGeometry(0.7, 0.25, 0.5),         // deck slab
            new THREE.BoxGeometry(0.28, 0.6, 0.28),        // pillar fragment
            new THREE.TetrahedronGeometry(0.28),            // rubble chunk
            new THREE.BoxGeometry(0.15, 0.15, 0.55),       // rebar/girder piece
        ],
        colors: [0x8a8a8a, 0x969696, 0x6e6e6e, 0xb0b0b0, 0x4a4a4a],
        countMin: 7, countMax: 10,
        launchSpeed: 5.5, launchUpMin: 4, launchUpMax: 12,
        spinSpeed: 4, scale: 1.3,
    },
};

// ------------------------------------
// Individual fragment instance
// ------------------------------------
interface Fragment {
    mesh: THREE.Mesh;
    // physics
    vx: number; vy: number; vz: number;
    rx: number; ry: number; rz: number; // spin rates (rad/s)
    life: number;          // 0→1, 1=alive
    maxLife: number;       // seconds
    inUse: boolean;
    // for fade-out
    mat: THREE.MeshLambertMaterial;
}

// ------------------------------------
// Pool constants
// ------------------------------------
const MAX_FRAGMENTS = 192;  // hard cap — won't grow beyond this
const GRAVITY = 14;         // world units / s²

export class FragmentSystem {
    private scene: THREE.Scene;
    private pool: Fragment[] = [];
    private active: Fragment[] = [];

    // Reuse these to avoid GC each frame
    private _v3 = new THREE.Vector3();

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        this._buildPool();
    }

    // ------------------------------------
    // Public API
    // ------------------------------------

    /** Spawn fragments for one destroyed object. */
    spawnFragments(x: number, z: number, elevation: number, type: WorldObjectType): void {
        const cfg = CONFIGS[type];
        if (!cfg) return;

        const count = cfg.countMin + Math.floor(Math.random() * (cfg.countMax - cfg.countMin + 1));

        for (let i = 0; i < count; i++) {
            const frag = this.pool.pop();
            if (!frag) return; // pool exhausted

            // Choose random geometry variant and color
            const geoIdx = Math.floor(Math.random() * cfg.geometries.length);
            const color = cfg.colors[Math.floor(Math.random() * cfg.colors.length)];

            // Swap geometry and color without creating new material/mesh
            frag.mesh.geometry = cfg.geometries[geoIdx];
            frag.mat.color.setHex(color);
            frag.mat.opacity = 1.0;

            // Position: spawn at object location at ground height, with a tiny random offset
            frag.mesh.position.set(
                x + (Math.random() - 0.5) * 1.2,
                elevation + 0.3 + Math.random() * 0.5,
                z + (Math.random() - 0.5) * 1.2,
            );

            // Scale: base config scale with slight variation
            const s = cfg.scale * (0.75 + Math.random() * 0.5);
            frag.mesh.scale.setScalar(s);

            // Outward velocity in random horizontal direction
            const angle = Math.random() * Math.PI * 2;
            const hSpeed = cfg.launchSpeed * (0.5 + Math.random() * 0.8);
            frag.vx = Math.cos(angle) * hSpeed;
            frag.vz = Math.sin(angle) * hSpeed;
            frag.vy = cfg.launchUpMin + Math.random() * (cfg.launchUpMax - cfg.launchUpMin);

            // Random spin
            const spin = cfg.spinSpeed;
            frag.rx = (Math.random() - 0.5) * spin * 2;
            frag.ry = (Math.random() - 0.5) * spin * 2;
            frag.rz = (Math.random() - 0.5) * spin * 2;

            // Lifetime: 2–3 seconds
            frag.maxLife = 2.0 + Math.random() * 1.0;
            frag.life = frag.maxLife;

            frag.mesh.rotation.set(
                Math.random() * Math.PI * 2,
                Math.random() * Math.PI * 2,
                Math.random() * Math.PI * 2,
            );
            frag.mesh.visible = true;
            frag.inUse = true;

            this.active.push(frag);
        }
    }

    /** Call once per frame. dt is milliseconds. */
    update(dt: number): void {
        const dtSec = dt / 1000;

        for (let i = this.active.length - 1; i >= 0; i--) {
            const f = this.active[i];

            f.life -= dtSec;

            if (f.life <= 0) {
                f.mesh.visible = false;
                f.inUse = false;
                // Swap-with-last-and-pop: O(1) instead of O(n) splice
                this.active[i] = this.active[this.active.length - 1];
                this.active.pop();
                this.pool.push(f);
                continue;
            }

            // Gravity
            f.vy -= GRAVITY * dtSec;

            // Move
            f.mesh.position.x += f.vx * dtSec;
            f.mesh.position.y += f.vy * dtSec;
            f.mesh.position.z += f.vz * dtSec;

            // Bounce off the ground (very simple — one bounce, then slide)
            if (f.mesh.position.y < 0.05) {
                f.mesh.position.y = 0.05;
                if (f.vy < 0) {
                    f.vy = -f.vy * 0.25;  // damped bounce
                    f.vx *= 0.6;
                    f.vz *= 0.6;
                    // Kill spin a bit on impact
                    f.rx *= 0.4;
                    f.ry *= 0.4;
                    f.rz *= 0.4;
                }
            }

            // Spin
            f.mesh.rotation.x += f.rx * dtSec;
            f.mesh.rotation.y += f.ry * dtSec;
            f.mesh.rotation.z += f.rz * dtSec;

            // Fade out in the last 0.6 seconds
            const fadeWindow = Math.min(0.6, f.maxLife * 0.3);
            if (f.life < fadeWindow) {
                f.mat.opacity = f.life / fadeWindow;
            }
        }
    }

    dispose(): void {
        for (const f of [...this.active, ...this.pool]) {
            this.scene.remove(f.mesh);
            f.mat.dispose();
        }
        this.active = [];
        this.pool = [];

        // Dispose shared geometries
        for (const cfg of Object.values(CONFIGS)) {
            for (const geo of cfg.geometries) {
                geo.dispose();
            }
        }
    }

    // ------------------------------------
    // Pool construction
    // ------------------------------------
    private _buildPool(): void {
        // We create MAX_FRAGMENTS fragments upfront.
        // Each fragment gets a MeshLambertMaterial (individual so opacity can differ),
        // but we use a BoxGeometry placeholder — real geometry is swapped on spawn.
        const placeholder = new THREE.BoxGeometry(0.3, 0.3, 0.3);

        for (let i = 0; i < MAX_FRAGMENTS; i++) {
            const mat = new THREE.MeshLambertMaterial({
                transparent: true,
                opacity: 1.0,
            });
            const mesh = new THREE.Mesh(placeholder, mat);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.visible = false;
            this.scene.add(mesh);

            this.pool.push({
                mesh,
                vx: 0, vy: 0, vz: 0,
                rx: 0, ry: 0, rz: 0,
                life: 0, maxLife: 2,
                inUse: false,
                mat,
            });
        }
    }
}
