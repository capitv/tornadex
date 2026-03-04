// ============================================
// Destruction Trail — Dark ground marks left by the local tornado
// ============================================

import * as THREE from 'three';

interface TrailMark {
    mesh: THREE.Mesh;
    opacity: number;         // current opacity (starts at MAX_OPACITY)
    decayRate: number;       // opacity lost per second
    inUse: boolean;
}

// How long a mark lasts (seconds). Use a range so marks feel organic.
const MARK_LIFE_MIN = 30;
const MARK_LIFE_MAX = 60;
const MAX_OPACITY = 0.55;

// Pool ceiling — enough for a full session without runaway growth
const MAX_MARKS = 256;

// Minimum world-space distance between consecutive marks so they don't stack
const MIN_MARK_DISTANCE_SQ = 4.0; // 2 units apart

export class DestructionTrail {
    private scene: THREE.Scene;

    // Shared geometry / material to minimise draw-calls
    private markGeo: THREE.CircleGeometry;
    private markMat: THREE.MeshBasicMaterial;

    // Object pool
    private pool: TrailMark[] = [];
    private active: TrailMark[] = [];

    // Throttle
    private timeSinceLastMark = 0;
    private readonly SPAWN_INTERVAL = 0.3; // seconds

    // Avoid stacking marks at the same spot
    private lastMarkX = NaN;
    private lastMarkZ = NaN;

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        // Circle decal: radius 1.2, cheap 8-segment polygon
        this.markGeo = new THREE.CircleGeometry(1.2, 8);
        this.markMat = new THREE.MeshBasicMaterial({
            color: 0x1a1008,        // very dark brown-black
            transparent: true,
            opacity: MAX_OPACITY,
            depthWrite: false,      // don't fight ground depth
            blending: THREE.NormalBlending,
        });

        // Pre-allocate pool
        for (let i = 0; i < MAX_MARKS; i++) {
            this.pool.push(this._createMark());
        }
    }

    private _createMark(): TrailMark {
        // Each mark is a separate Mesh so we can set individual opacity via
        // a cloned material. We clone once at creation and reuse it.
        const mat = this.markMat.clone();
        const mesh = new THREE.Mesh(this.markGeo, mat);
        mesh.rotation.x = -Math.PI / 2; // flat on the ground
        mesh.visible = false;
        this.scene.add(mesh);
        return { mesh, opacity: 0, decayRate: 0, inUse: false };
    }

    // Call every frame for the LOCAL player's position.
    // tornadoX/Z are world coords; elevation is the ground height at that point.
    tick(dt: number, tornadoX: number, tornadoZ: number, elevation: number): void {
        const dtSec = dt / 1000;

        // --- Spawn throttle ---
        this.timeSinceLastMark += dtSec;
        if (this.timeSinceLastMark >= this.SPAWN_INTERVAL) {
            // Distance check so marks don't pile up when tornado is stationary
            const dx = tornadoX - this.lastMarkX;
            const dz = tornadoZ - this.lastMarkZ;
            const distSq = dx * dx + dz * dz;

            if (isNaN(this.lastMarkX) || distSq >= MIN_MARK_DISTANCE_SQ) {
                this._spawnMark(tornadoX, tornadoZ, elevation);
                this.lastMarkX = tornadoX;
                this.lastMarkZ = tornadoZ;
            }
            this.timeSinceLastMark = 0;
        }

        // --- Update existing marks ---
        for (let i = this.active.length - 1; i >= 0; i--) {
            const mark = this.active[i];
            mark.opacity -= mark.decayRate * dtSec;

            if (mark.opacity <= 0) {
                // Return to pool
                mark.inUse = false;
                mark.mesh.visible = false;
                this.active.splice(i, 1);
                this.pool.push(mark);
            } else {
                (mark.mesh.material as THREE.MeshBasicMaterial).opacity = mark.opacity;
            }
        }
    }

    private _spawnMark(x: number, z: number, elevation: number): void {
        const mark = this.pool.pop();
        if (!mark) return; // pool exhausted — silent fail, never crash

        const life = MARK_LIFE_MIN + Math.random() * (MARK_LIFE_MAX - MARK_LIFE_MIN);

        // Vary the mark size slightly for an organic look
        const radius = 0.8 + Math.random() * 0.8;
        mark.mesh.scale.setScalar(radius);

        mark.mesh.position.set(x, elevation + 0.1, z); // 0.1 above ground to avoid z-fighting
        mark.mesh.rotation.y = Math.random() * Math.PI * 2; // random orientation

        mark.opacity = MAX_OPACITY * (0.7 + Math.random() * 0.3);
        mark.decayRate = mark.opacity / life;
        (mark.mesh.material as THREE.MeshBasicMaterial).opacity = mark.opacity;

        mark.inUse = true;
        mark.mesh.visible = true;

        this.active.push(mark);
    }

    dispose(): void {
        for (const mark of [...this.active, ...this.pool]) {
            this.scene.remove(mark.mesh);
            (mark.mesh.material as THREE.MeshBasicMaterial).dispose();
        }
        this.active = [];
        this.pool = [];
        this.markGeo.dispose();
        this.markMat.dispose();
    }
}
