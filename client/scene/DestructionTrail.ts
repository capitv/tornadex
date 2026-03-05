// ============================================
// Destruction Trail — Dark ground marks left by the local tornado
// Uses a single InstancedMesh (1 draw call) instead of 128 individual meshes.
// ============================================

import * as THREE from 'three';

// How long a mark lasts (seconds). Use a range so marks feel organic.
const MARK_LIFE_MIN = 30;
const MARK_LIFE_MAX = 60;
const MAX_OPACITY = 0.55;

// Pool ceiling — enough for a full session without runaway growth
const MAX_MARKS = 128;

// Minimum world-space distance between consecutive marks so they don't stack
const MIN_MARK_DISTANCE_SQ = 4.0; // 2 units apart

// Reusable helpers (allocated once, reused every frame)
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

// Axis for the "flat on ground" rotation (−90 degrees around X)
const _flatQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -Math.PI / 2,
);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _yQuat = new THREE.Quaternion();

// ---------- Custom shader for per-instance opacity ----------
const vertexShader = /* glsl */ `
    attribute float instanceOpacity;
    varying float vOpacity;

    void main() {
        vOpacity = instanceOpacity;
        // instanceMatrix is provided automatically by InstancedMesh
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = /* glsl */ `
    varying float vOpacity;

    void main() {
        // Dark brownish ground-mark colour (0x1a1008 = rgb(26, 16, 8))
        gl_FragColor = vec4(0.102, 0.063, 0.031, vOpacity);
    }
`;

export class DestructionTrail {
    private scene: THREE.Scene;

    // Single instanced mesh
    private mesh: THREE.InstancedMesh;
    private geometry: THREE.CircleGeometry;
    private material: THREE.ShaderMaterial;

    // Per-instance opacity attribute
    private opacityArray: Float32Array;
    private opacityAttr: THREE.InstancedBufferAttribute;

    // Plain arrays for per-mark bookkeeping (parallel to instance indices)
    private count = 0; // number of active marks
    private life: Float32Array;      // remaining life in seconds
    private decayRate: Float32Array;  // opacity lost per second
    private opacity: Float32Array;    // current opacity
    // We store position/rotation/scale so we can rebuild the matrix each frame
    private posX: Float32Array;
    private posY: Float32Array;
    private posZ: Float32Array;
    private rotY: Float32Array;
    private radius: Float32Array;

    // Throttle
    private timeSinceLastMark = 0;
    private readonly SPAWN_INTERVAL = 0.3; // seconds

    // Avoid stacking marks at the same spot
    private lastMarkX = NaN;
    private lastMarkZ = NaN;

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        // Circle decal: radius 1.2, cheap 8-segment polygon
        this.geometry = new THREE.CircleGeometry(1.2, 8);

        this.material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_MARKS);
        this.mesh.frustumCulled = false; // marks are spread wide; skip per-object cull
        this.mesh.count = 0; // start with zero visible instances
        scene.add(this.mesh);

        // Per-instance opacity attribute
        this.opacityArray = new Float32Array(MAX_MARKS);
        this.opacityAttr = new THREE.InstancedBufferAttribute(this.opacityArray, 1);
        this.geometry.setAttribute('instanceOpacity', this.opacityAttr);

        // Bookkeeping arrays
        this.life = new Float32Array(MAX_MARKS);
        this.decayRate = new Float32Array(MAX_MARKS);
        this.opacity = new Float32Array(MAX_MARKS);
        this.posX = new Float32Array(MAX_MARKS);
        this.posY = new Float32Array(MAX_MARKS);
        this.posZ = new Float32Array(MAX_MARKS);
        this.rotY = new Float32Array(MAX_MARKS);
        this.radius = new Float32Array(MAX_MARKS);
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

        // --- Update existing marks (swap-and-pop removal) ---
        for (let i = this.count - 1; i >= 0; i--) {
            this.opacity[i] -= this.decayRate[i] * dtSec;

            if (this.opacity[i] <= 0) {
                // Swap-and-pop: move the last active mark into this slot
                const last = this.count - 1;
                if (i !== last) {
                    this.opacity[i] = this.opacity[last];
                    this.decayRate[i] = this.decayRate[last];
                    this.life[i] = this.life[last];
                    this.posX[i] = this.posX[last];
                    this.posY[i] = this.posY[last];
                    this.posZ[i] = this.posZ[last];
                    this.rotY[i] = this.rotY[last];
                    this.radius[i] = this.radius[last];
                }
                this.count--;
            }
        }

        // --- Rebuild instance matrices + opacity attribute ---
        for (let i = 0; i < this.count; i++) {
            _position.set(this.posX[i], this.posY[i], this.posZ[i]);
            // Combine the flat-on-ground rotation with a random Y rotation
            _yQuat.setFromAxisAngle(_yAxis, this.rotY[i]);
            _quaternion.multiplyQuaternions(_flatQuat, _yQuat);
            _scale.setScalar(this.radius[i]);
            _matrix.compose(_position, _quaternion, _scale);
            this.mesh.setMatrixAt(i, _matrix);
            this.opacityArray[i] = this.opacity[i];
        }

        this.mesh.count = this.count;
        if (this.count > 0) {
            this.mesh.instanceMatrix.needsUpdate = true;
            this.opacityAttr.needsUpdate = true;
        }
    }

    private _spawnMark(x: number, z: number, elevation: number): void {
        if (this.count >= MAX_MARKS) return; // pool exhausted — silent fail, never crash

        const idx = this.count;
        const life = MARK_LIFE_MIN + Math.random() * (MARK_LIFE_MAX - MARK_LIFE_MIN);
        const startOpacity = MAX_OPACITY * (0.7 + Math.random() * 0.3);

        this.posX[idx] = x;
        this.posY[idx] = elevation + 0.1; // slightly above ground to avoid z-fighting
        this.posZ[idx] = z;
        this.rotY[idx] = Math.random() * Math.PI * 2;
        this.radius[idx] = 0.8 + Math.random() * 0.8;
        this.opacity[idx] = startOpacity;
        this.decayRate[idx] = startOpacity / life;
        this.life[idx] = life;

        this.count++;
    }

    dispose(): void {
        this.scene.remove(this.mesh);
        this.mesh.dispose();
        this.geometry.dispose();
        this.material.dispose();
        this.count = 0;
    }
}
