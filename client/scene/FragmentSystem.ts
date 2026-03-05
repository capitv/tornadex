// ============================================
// Fragment System — Breaking animation for destroyed objects
// InstancedMesh-based: 1 draw call instead of 96
// ============================================

import * as THREE from 'three';
import type { WorldObjectType } from '../../shared/types.js';

// ------------------------------------
// Per-type fragment configuration
// ------------------------------------
interface FragmentConfig {
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
        colors: [0x5c4033, 0x4a3020, 0x3a2818, 0x2d6a1f, 0x3e8c2a, 0x226a15],
        countMin: 5, countMax: 7,
        launchSpeed: 3.5, launchUpMin: 3, launchUpMax: 7,
        spinSpeed: 6, scale: 1.0,
    },
    house: {
        colors: [0xc8bfb0, 0xddd5c5, 0xb8a898, 0x8b4513, 0xa0522d, 0x9e9e9e],
        countMin: 5, countMax: 7,
        launchSpeed: 4.0, launchUpMin: 3.5, launchUpMax: 8,
        spinSpeed: 5, scale: 1.0,
    },
    car: {
        colors: [0x8a8a8a, 0xb0b0b0, 0x4a4a4a, 0x222222, 0x1a1a1a, 0x87ceeb],
        countMin: 4, countMax: 6,
        launchSpeed: 5.0, launchUpMin: 4, launchUpMax: 9,
        spinSpeed: 8, scale: 1.0,
    },
    animal: {
        colors: [0x8b6914, 0x654321, 0xd2691e, 0xa0522d],
        countMin: 3, countMax: 4,
        launchSpeed: 3.0, launchUpMin: 2.5, launchUpMax: 6,
        spinSpeed: 5, scale: 0.9,
    },
    building: {
        colors: [0x7f8c8d, 0x95a5a6, 0x606c76, 0xb0b3b5, 0x4a4f52],
        countMin: 5, countMax: 6,
        launchSpeed: 4.5, launchUpMin: 4, launchUpMax: 10,
        spinSpeed: 4, scale: 1.2,
    },
    trailer_park: {
        colors: [0xd4c5a9, 0xc8b89a, 0xbfad8e, 0x9e9e9e, 0x8b8b8b],
        countMin: 6, countMax: 9,
        launchSpeed: 5.0, launchUpMin: 4, launchUpMax: 10,
        spinSpeed: 6, scale: 1.1,
    },
    stadium: {
        colors: [0x909090, 0xa8a8a8, 0x707070, 0xe8451a, 0xc0392b],
        countMin: 8, countMax: 12,
        launchSpeed: 5.5, launchUpMin: 5, launchUpMax: 14,
        spinSpeed: 3, scale: 1.4,
    },
    bridge: {
        colors: [0x8a8a8a, 0x969696, 0x6e6e6e, 0xb0b0b0, 0x4a4a4a],
        countMin: 7, countMax: 10,
        launchSpeed: 5.5, launchUpMin: 4, launchUpMax: 12,
        spinSpeed: 4, scale: 1.3,
    },
};

// ------------------------------------
// Per-fragment state (plain data, no THREE objects)
// ------------------------------------
interface FragmentState {
    // position
    px: number; py: number; pz: number;
    // rotation (euler angles)
    rotX: number; rotY: number; rotZ: number;
    // velocity
    vx: number; vy: number; vz: number;
    // spin rates (rad/s)
    rx: number; ry: number; rz: number;
    // scale
    scale: number;
    // life
    life: number;
    maxLife: number;
    // color (r,g,b in 0-1)
    cr: number; cg: number; cb: number;
}

// ------------------------------------
// Pool constants
// ------------------------------------
const MAX_FRAGMENTS = 96;
const GRAVITY = 14;

// Vertex shader: applies instanceMatrix, passes per-instance color + opacity to fragment
const VERT = /* glsl */`
attribute vec3 aColor;
attribute float aOpacity;

varying vec3 vColor;
varying float vOpacity;
varying vec3 vNormal;

void main() {
    vColor = aColor;
    vOpacity = aOpacity;

    // Transform normal by instance matrix (upper-left 3x3)
    mat3 normalMat = mat3(instanceMatrix);
    vNormal = normalize(normalMatrix * normalMat * normal);

    vec4 worldPos = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * worldPos;
}
`;

// Fragment shader: simple hemisphere/lambert-like shading
const FRAG = /* glsl */`
varying vec3 vColor;
varying float vOpacity;
varying vec3 vNormal;

void main() {
    // Simple hemisphere lighting: top = 1.0, bottom = 0.4
    float light = 0.4 + 0.6 * (0.5 + 0.5 * vNormal.y);
    gl_FragColor = vec4(vColor * light, vOpacity);
    if (vOpacity < 0.01) discard;
}
`;

export class FragmentSystem {
    private scene: THREE.Scene;
    private instancedMesh: THREE.InstancedMesh;
    private material: THREE.ShaderMaterial;
    private geometry: THREE.BoxGeometry;

    // Per-instance attributes
    private colorAttr: THREE.InstancedBufferAttribute;
    private opacityAttr: THREE.InstancedBufferAttribute;

    // Fragment state: slot index -> state. Active slots are packed at front.
    private states: FragmentState[] = [];
    private activeCount = 0;

    // Reusable matrix / quaternion / euler for building instance matrices
    private _mat4 = new THREE.Matrix4();
    private _pos = new THREE.Vector3();
    private _quat = new THREE.Quaternion();
    private _scale = new THREE.Vector3();
    private _euler = new THREE.Euler();
    private _color = new THREE.Color();

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        // Shared geometry — a small box; shape differences are invisible at fragment scale
        this.geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);

        // ShaderMaterial with per-instance color and opacity
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        // Create InstancedMesh
        this.instancedMesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_FRAGMENTS);
        this.instancedMesh.count = 0; // start with nothing visible
        this.instancedMesh.castShadow = false;
        this.instancedMesh.receiveShadow = false;
        this.instancedMesh.frustumCulled = false; // fragments are spread out; skip per-instance frustum test
        this.scene.add(this.instancedMesh);

        // Create per-instance buffer attributes
        const colorArray = new Float32Array(MAX_FRAGMENTS * 3);
        const opacityArray = new Float32Array(MAX_FRAGMENTS);
        this.colorAttr = new THREE.InstancedBufferAttribute(colorArray, 3);
        this.opacityAttr = new THREE.InstancedBufferAttribute(opacityArray, 1);
        this.geometry.setAttribute('aColor', this.colorAttr);
        this.geometry.setAttribute('aOpacity', this.opacityAttr);

        // Pre-allocate state slots
        for (let i = 0; i < MAX_FRAGMENTS; i++) {
            this.states.push({
                px: 0, py: 0, pz: 0,
                rotX: 0, rotY: 0, rotZ: 0,
                vx: 0, vy: 0, vz: 0,
                rx: 0, ry: 0, rz: 0,
                scale: 1,
                life: 0, maxLife: 2,
                cr: 1, cg: 1, cb: 1,
            });
        }
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
            if (this.activeCount >= MAX_FRAGMENTS) return; // pool exhausted

            const slot = this.activeCount;
            this.activeCount++;

            const s = this.states[slot];

            // Pick random color
            const colorHex = cfg.colors[Math.floor(Math.random() * cfg.colors.length)];
            this._color.setHex(colorHex);
            s.cr = this._color.r;
            s.cg = this._color.g;
            s.cb = this._color.b;

            // Position: spawn at object location with tiny random offset
            s.px = x + (Math.random() - 0.5) * 1.2;
            s.py = elevation + 0.3 + Math.random() * 0.5;
            s.pz = z + (Math.random() - 0.5) * 1.2;

            // Scale
            s.scale = cfg.scale * (0.75 + Math.random() * 0.5);

            // Outward velocity in random horizontal direction
            const angle = Math.random() * Math.PI * 2;
            const hSpeed = cfg.launchSpeed * (0.5 + Math.random() * 0.8);
            s.vx = Math.cos(angle) * hSpeed;
            s.vz = Math.sin(angle) * hSpeed;
            s.vy = cfg.launchUpMin + Math.random() * (cfg.launchUpMax - cfg.launchUpMin);

            // Random spin
            const spin = cfg.spinSpeed;
            s.rx = (Math.random() - 0.5) * spin * 2;
            s.ry = (Math.random() - 0.5) * spin * 2;
            s.rz = (Math.random() - 0.5) * spin * 2;

            // Lifetime: 2–3 seconds
            s.maxLife = 2.0 + Math.random() * 1.0;
            s.life = s.maxLife;

            // Random initial rotation
            s.rotX = Math.random() * Math.PI * 2;
            s.rotY = Math.random() * Math.PI * 2;
            s.rotZ = Math.random() * Math.PI * 2;
        }
    }

    /** Call once per frame. dt is milliseconds. */
    update(dt: number): void {
        const dtSec = dt / 1000;

        // Simulate and compact: iterate backwards so swap-remove is safe
        for (let i = this.activeCount - 1; i >= 0; i--) {
            const s = this.states[i];

            s.life -= dtSec;

            if (s.life <= 0) {
                // Swap with last active and shrink
                this.activeCount--;
                if (i < this.activeCount) {
                    // Copy last active state into this slot
                    const last = this.states[this.activeCount];
                    this.states[i] = last;
                    this.states[this.activeCount] = s; // move dead state to end
                }
                continue;
            }

            // Gravity
            s.vy -= GRAVITY * dtSec;

            // Move
            s.px += s.vx * dtSec;
            s.py += s.vy * dtSec;
            s.pz += s.vz * dtSec;

            // Bounce off the ground
            if (s.py < 0.05) {
                s.py = 0.05;
                if (s.vy < 0) {
                    s.vy = -s.vy * 0.25;
                    s.vx *= 0.6;
                    s.vz *= 0.6;
                    s.rx *= 0.4;
                    s.ry *= 0.4;
                    s.rz *= 0.4;
                }
            }

            // Spin
            s.rotX += s.rx * dtSec;
            s.rotY += s.ry * dtSec;
            s.rotZ += s.rz * dtSec;
        }

        // Build instance matrices and update attributes for all active fragments
        for (let i = 0; i < this.activeCount; i++) {
            const s = this.states[i];

            // Build matrix from position + rotation + scale
            this._pos.set(s.px, s.py, s.pz);
            this._euler.set(s.rotX, s.rotY, s.rotZ);
            this._quat.setFromEuler(this._euler);
            this._scale.set(s.scale, s.scale, s.scale);
            this._mat4.compose(this._pos, this._quat, this._scale);
            this.instancedMesh.setMatrixAt(i, this._mat4);

            // Color
            const ci = i * 3;
            this.colorAttr.array[ci] = s.cr;
            this.colorAttr.array[ci + 1] = s.cg;
            this.colorAttr.array[ci + 2] = s.cb;

            // Opacity: fade out in the last portion of life
            const fadeWindow = Math.min(0.6, s.maxLife * 0.3);
            (this.opacityAttr.array as Float32Array)[i] = s.life < fadeWindow ? s.life / fadeWindow : 1.0;
        }

        // Update GPU buffers once
        this.instancedMesh.count = this.activeCount;

        if (this.activeCount > 0) {
            this.instancedMesh.instanceMatrix.needsUpdate = true;
            this.colorAttr.needsUpdate = true;
            this.opacityAttr.needsUpdate = true;
        }
    }

    dispose(): void {
        this.scene.remove(this.instancedMesh);
        this.instancedMesh.dispose();
        this.material.dispose();
        this.geometry.dispose();
        this.states = [];
        this.activeCount = 0;
    }
}
