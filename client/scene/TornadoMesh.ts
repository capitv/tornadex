// ============================================
// Tornado Mesh — Solid Core + Volumetric Effects
// ============================================

import * as THREE from 'three';
import { getGraphicsPreset } from '../settings/GraphicsConfig.js';
import { getSmokeTexture } from './TextureAtlas.js';
import { type TornadoSkin, getSkinById, brightenColor } from './TornadoSkins.js';

// Particle counts and geometry quality are read from the active graphics preset
// at construction time. Changing the quality level after construction affects
// newly created TornadoMesh instances only (acceptable per requirements).
const _preset    = getGraphicsPreset();
const DUST_COUNT    = _preset.dustCount;
const DEBRIS_COUNT  = _preset.debrisCount;
const CLOUD_COUNT   = _preset.cloudCount;
const RADIAL_SEGS   = _preset.radialSegments;

// ---- Boost trail constants ----
const TRAIL_COUNT = 40; // Maximum simultaneous trail particles

// ---- Shaped debris constants ----
// Each type occupies a fixed number of InstancedMesh slots.
// Active count is driven by setRadius(); hidden slots are parked at y=-9999.
const BOX_SLOTS    = 24; // house-chunk / concrete-block rectangles
const FLAT_SLOTS   = 18; // car-panel / plank thin slabs
const CHUNK_SLOTS  = 18; // irregular rubble (low-poly icosahedra)

// Scratch Object3D reused every frame when writing instance matrices
const _shapedDummy = new THREE.Object3D();

// ---- AFK fade constants ----
/** Target opacity when a tornado is AFK (40% = semi-transparent but still visible). */
const AFK_OPACITY = 0.40;
/**
 * Lerp speed per millisecond for the AFK opacity transition.
 * At ~60 fps (16 ms/frame) this yields ~1.6 % change per frame,
 * completing the full fade in roughly 1 second.
 */
const AFK_FADE_SPEED = 0.001;

// Shared smoke/dust particle texture — fetched from the TextureAtlas singleton
// so it is created exactly once and reused by every TornadoMesh instance.
// Previously createSmokeTexture() ran per-instance, triggering a redundant
// canvas allocation and GPU texture upload for every tornado in the game.
const smokeTexture = getSmokeTexture();

// Inner cone scale factors — hoisted out of update() to avoid per-frame array allocation
const CONE_SCALES = [0.60, 0.15] as const;

export class TornadoMesh {
    group: THREE.Group;

    // Core Solid Funnel — outer deformed cylinder (GPU) + inner solid cones
    private coreMesh: THREE.Mesh;
    private coreGeo: THREE.CylinderGeometry;
    private originalCorePos: Float32Array;
    private coreMat: THREE.MeshLambertMaterial;
    private coreUniforms!: {
        uTime: { value: number }; uRadius: { value: number };
        uFunnelHeight: { value: number }; uGroundWidth: { value: number };
        uCloudWidth: { value: number }; uFunnelPower: { value: number };
        uVelocityX: { value: number }; uVelocityZ: { value: number };
    };
    private innerCones: THREE.Mesh[] = [];

    // Lighting / Details
    private flashLight: THREE.PointLight;

    // Particles
    private debris: THREE.Points;
    private dustRing: THREE.Points;
    private fluffyClouds: THREE.Points;

    // Arrays
    private debrisPositions: Float32Array;
    private debrisColors: Float32Array;
    private debrisSizes: Float32Array;
    private debrisSeeds: Float32Array;

    private dustPositions: Float32Array;
    private dustColors: Float32Array;
    private dustSizes: Float32Array;

    private cloudPositions: Float32Array;
    private cloudColors: Float32Array;
    private cloudSizes: Float32Array;
    private cloudSeeds: Float32Array;

    private shadowMesh: THREE.Mesh;
    private shadowMeshOuter: THREE.Mesh;

    // ---- Shaped debris (InstancedMesh) ----
    private boxDebris:   THREE.InstancedMesh;
    private flatDebris:  THREE.InstancedMesh;
    private chunkDebris: THREE.InstancedMesh;

    // Per-instance seeds: [heightRatio, angleOffset, orbitFuzz, spinSpeed] × slot
    private boxSeeds:   Float32Array;
    private flatSeeds:  Float32Array;
    private chunkSeeds: Float32Array;

    // How many slots are currently active (scaled by radius)
    private visibleBoxes:  number = 0;
    private visibleFlats:  number = 0;
    private visibleChunks: number = 0;

    private baseRadius: number = 1;
    /** Target radius that baseRadius lerps toward each frame. */
    private targetRadius: number = 1;
    private time: number = 0;
    private isLocal: boolean;

    // Per-tornado internal lightning flash state
    private flashTimer: number = 0;       // countdown in ms until next internal flash
    private flashPhase: number = 0;       // 0 = idle, 1 = bright, 2 = dim
    private flashElapsed: number = 0;     // ms into current phase

    // Physics / Leaning
    private lastPos: THREE.Vector3 = new THREE.Vector3();
    private velocity: THREE.Vector3 = new THREE.Vector3();

    // ---- Boost / Trail state ----
    private isBoosting: boolean = false;

    // Trail particle type
    private static readonly _trailParticleTemplate = { wx: 0, wz: 0, vx: 0, vz: 0, life: 0, size: 0, height: 0 };
    // Pre-allocated trail particle pool (swap-and-pop, no allocation at runtime)
    private trailParticles: Array<{
        wx: number;   // world-space X at spawn
        wz: number;   // world-space Z at spawn
        vx: number;   // drift velocity X
        vz: number;   // drift velocity Z
        life: number; // 0-1, decreasing to 0
        size: number; // base size
        height: number; // Y position (local)
    }>;
    private trailActiveCount: number = 0;
    /** Previous frame's trail active count — used to detect transition to zero for one final GPU upload. */
    private _prevTrailActive: number = 0;

    // Three.js objects for the trail
    private trailPoints: THREE.Points;
    private trailPositions: Float32Array;
    private trailColors: Float32Array;
    private trailSizes: Float32Array;

    // ---- Spawn / Safe-Zone Shield Effect ----
    /** Whether this tornado is currently protected (spawn protection or safe zone). */
    private isProtected: boolean = false;
    /** Translucent dome rendered around the funnel while protected. */
    private shieldMesh: THREE.Mesh;
    /** Soft green glow emitted from within when protected. */
    private shieldLight: THREE.PointLight;

    // ---- Vehicles inside funnel (F2+ only) ----
    /** Small car-shaped boxes that orbit inside the funnel for F2+ tornadoes. */
    private vehicleMeshes: THREE.Mesh[] = [];
    /** Per-vehicle seed data: [heightRatio, angleOffset, orbitFuzzX, spinRate] */
    private vehicleSeeds: Float32Array = new Float32Array(0);
    private static readonly VEHICLE_COUNT = 4;
    private static readonly _vehicleMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });

    // ---- Decay particles (emitted while shrinking) ----
    /** Radius stored from the previous frame to detect shrinkage. */
    private _prevRadius: number = -1;
    /** Pre-allocated decay particle pool (swap-and-pop, no runtime allocation). */
    private _decayParticles: Array<{
        x: number; y: number; z: number;
        vx: number; vy: number; vz: number;
        life: number; // 0→1, 1=alive
    }>;
    private _decayActiveCount: number = 0;
    private static readonly DECAY_MAX = 80;
    private _decayPoints: THREE.Points;
    private _decayPositions: Float32Array;
    private _decayColors: Float32Array;
    private _decaySizes: Float32Array;

    // ---- AFK / Idle Fade Effect ----
    /** Whether the server has flagged this tornado as AFK. */
    private isAfk: boolean = false;
    /**
     * Current opacity multiplier for the AFK fade, smoothly lerped between
     * 1.0 (fully visible) and AFK_OPACITY (semi-transparent).
     * Range: [AFK_OPACITY, 1.0].
     */
    private afkOpacity: number = 1.0;
    private _lastAfkOpacity: number = 1.0;

    /** The skin applied to this tornado (stored for runtime trail color access). */
    private skin: TornadoSkin;

    constructor(isLocal: boolean = false, skinId: string = 'classic') {
        this.isLocal = isLocal;
        this.skin = getSkinById(skinId);
        this.group = new THREE.Group();

        // ==========================================
        // 1. SOLID CORE MESH
        // ==========================================
        // openEnded = true removes the flat "discs" at the top and bottom
        // Radial segment count driven by graphics preset for quality/perf trade-off
        this.coreGeo = new THREE.CylinderGeometry(1, 1, 1, RADIAL_SEGS, 40, true);
        this.coreGeo.translate(0, 0.5, 0);
        this.originalCorePos = new Float32Array(this.coreGeo.attributes.position.array);

        const baseColor = isLocal ? brightenColor(this.skin.coreColor, 1.12) : this.skin.coreColor;

        // Store base positions as a separate attribute for GPU deformation.
        // The vertex shader reads from `basePosition` (immutable) and writes
        // the deformed position into `position`, so we never touch the CPU buffer.
        this.coreGeo.setAttribute(
            'basePosition',
            new THREE.Float32BufferAttribute(this.originalCorePos, 3),
        );

        this.coreUniforms = {
            uTime:        { value: 0 },
            uRadius:      { value: 1 },
            uFunnelHeight:{ value: 10 },
            uGroundWidth: { value: 0.2 },
            uCloudWidth:  { value: 3.5 },
            uFunnelPower: { value: 0.65 },
            uVelocityX:   { value: 0 },
            uVelocityZ:   { value: 0 },
        };

        this.coreMat = new THREE.MeshLambertMaterial({
            color: baseColor,
            emissive: this.skin.coreEmissive,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 1.0,
        });

        // Inject GPU vertex deformation into the stock Lambert shader.
        // This preserves the full Lambert lighting pipeline (fragment shader
        // unchanged) while offloading the per-vertex funnel deformation,
        // twist, wobble, lean and surface bumps entirely to the GPU.
        const uniforms = this.coreUniforms;
        this.coreMat.onBeforeCompile = (shader) => {
            // Inject our uniforms
            shader.uniforms.uTime         = uniforms.uTime;
            shader.uniforms.uRadius       = uniforms.uRadius;
            shader.uniforms.uFunnelHeight = uniforms.uFunnelHeight;
            shader.uniforms.uGroundWidth  = uniforms.uGroundWidth;
            shader.uniforms.uCloudWidth   = uniforms.uCloudWidth;
            shader.uniforms.uFunnelPower  = uniforms.uFunnelPower;
            shader.uniforms.uVelocityX    = uniforms.uVelocityX;
            shader.uniforms.uVelocityZ    = uniforms.uVelocityZ;

            // Declare basePosition attribute + uniforms before main()
            shader.vertexShader = shader.vertexShader.replace(
                'void main() {',
                /* glsl */ `
                attribute vec3 basePosition;
                uniform float uTime;
                uniform float uRadius;
                uniform float uFunnelHeight;
                uniform float uGroundWidth;
                uniform float uCloudWidth;
                uniform float uFunnelPower;
                uniform float uVelocityX;
                uniform float uVelocityZ;

                void main() {
                `,
            );

            // Replace the stock `#include <begin_vertex>` (which sets
            // `vec3 transformed = position;`) with our deformation code.
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                /* glsl */ `
                // --- GPU tornado deformation ---
                vec3 bp = basePosition;
                float t = bp.y;  // normalised height 0..1 (geometry translated +0.5 at construction)
                float tClamped = max(t, 0.0001);

                // Funnel profile
                float ff = pow(tClamped, uFunnelPower);
                float rAtH = uGroundWidth + (uCloudWidth - uGroundWidth) * ff;
                float nx = bp.x * rAtH;
                float nz = bp.z * rAtH;

                // Twist — faster at base, slower at top
                float rotSpeed = 3.0 - t * 1.5;
                float twistAngle = t * 6.283185 * 2.5 + uTime * rotSpeed;
                float cosA = cos(twistAngle);
                float sinA = sin(twistAngle);
                float tx = nx * cosA - nz * sinA;
                float tz = nx * sinA + nz * cosA;

                // Surface bumps — two sine waves for organic look
                float lenSq = bp.x * bp.x + bp.z * bp.z;
                if (lenSq > 0.001) {
                    float angle = atan(bp.z, bp.x);
                    float bump = sin(t * 15.0 - uTime * 5.0 + angle * 4.0) * min(uRadius * 0.08, 0.25)
                               + sin(t * 8.0  + uTime * 7.0 + angle * 2.0) * min(uRadius * 0.04, 0.12);
                    tx += bp.x * bump;
                    tz += bp.z * bump;
                }

                // Wobble
                float maxWobble = min(uRadius * 0.15, 0.6);
                float wobX = sin(uTime * 0.8 + t * 2.5) * maxWobble * t;
                float wobZ = cos(uTime * 0.6 + t * 3.0) * maxWobble * 0.8 * t;

                // Lean into velocity with S-curve "snake" effect:
                // base stays put, mid counter-leans slightly, top leans fully
                float leanStr = min(2.5, 1.5 / max(uRadius, 0.5));
                float snakeT = t * t * t - sin(t * 3.14159) * 0.15;

                vec3 transformed = vec3(
                    tx + wobX - uVelocityX * snakeT * leanStr,
                    t * uFunnelHeight,
                    tz + wobZ - uVelocityZ * snakeT * leanStr
                );
                `,
            );
        };
        // Unique cache key so Three.js doesn't reuse an un-patched program
        this.coreMat.customProgramCacheKey = () => 'tornado_gpu_deform';

        this.coreMesh = new THREE.Mesh(this.coreGeo, this.coreMat);
        this.coreMesh.castShadow = true;
        this.coreMesh.receiveShadow = true;
        // Disable automatic frustum culling — the bounding box doesn't account
        // for the GPU deformation, so Three.js would incorrectly cull the mesh.
        this.coreMesh.frustumCulled = false;
        this.group.add(this.coreMesh);

        // Inner cones — 2 layers to fill the funnel volume:
        //   [0] Outer fill (60%) — standard cone shape
        //   [1] Tight inner core (15%) — sharper taper for a focused vortex effect
        const coneConfigs = this.skin.innerConeColors.map(cc => ({
            color: isLocal ? brightenColor(cc.color, 1.12) : cc.color,
            opacity: cc.opacity,
        }));
        for (let ci = 0; ci < coneConfigs.length; ci++) {
            const cc = coneConfigs[ci];
            // Inner core (ci=1) uses a sharper taper: radiusTop=0.3 vs 1.0
            const radiusTop = ci === 0 ? 1.0 : 0.3;
            const coneGeo = new THREE.ConeGeometry(1, 1, Math.max(8, RADIAL_SEGS - 4), 1, false);
            // Scale top vertices to create the taper effect
            const posAttr = coneGeo.attributes.position;
            for (let v = 0; v < posAttr.count; v++) {
                const y = posAttr.getY(v);
                if (y > 0.4) { // top vertices of ConeGeometry
                    posAttr.setX(v, posAttr.getX(v) * radiusTop);
                    posAttr.setZ(v, posAttr.getZ(v) * radiusTop);
                }
            }
            posAttr.needsUpdate = true;
            coneGeo.rotateX(Math.PI);
            coneGeo.translate(0, 0.5, 0);
            const coneMat = new THREE.MeshLambertMaterial({
                color: cc.color,
                emissive: brightenColor(this.skin.coreEmissive, 0.6),
                side: THREE.FrontSide,
                transparent: true,
                opacity: cc.opacity,
            });
            const cone = new THREE.Mesh(coneGeo, coneMat);
            this.innerCones.push(cone);
            this.group.add(cone);
        }

        // ==========================================
        // 2. LIGHTNING / INTERNAL FLASH LIGHT
        // ==========================================
        this.flashLight = new THREE.PointLight(this.skin.flashColor, 0, 50);
        this.flashLight.position.set(0, 2, 0);
        this.group.add(this.flashLight);

        // ==========================================
        // 3. GROUND SHADOWS (primary tight + outer soft penumbra)
        // ==========================================
        // Primary shadow — tight umbra directly under the funnel base.
        // Dynamic scale/opacity/squish is applied every frame in update().
        const shadowGeo = new THREE.CircleGeometry(1.5, 32);
        const shadowMat = new THREE.MeshBasicMaterial({
            color: this.skin.shadowColor,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
        });
        this.shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
        this.shadowMesh.rotation.x = -Math.PI / 2;
        this.shadowMesh.position.y = 0.05;
        this.group.add(this.shadowMesh);

        // Secondary shadow — wide, soft penumbra ring around the primary.
        const outerShadowGeo = new THREE.CircleGeometry(1.5, 32);
        const outerShadowMat = new THREE.MeshBasicMaterial({
            color: this.skin.shadowOuterColor,
            transparent: true,
            opacity: 0.10,
            depthWrite: false,
        });
        this.shadowMeshOuter = new THREE.Mesh(outerShadowGeo, outerShadowMat);
        this.shadowMeshOuter.rotation.x = -Math.PI / 2;
        this.shadowMeshOuter.position.y = 0.03; // slightly lower → renders beneath primary
        this.group.add(this.shadowMeshOuter);

        // ==========================================
        // 4. DEBRIS PARTICLES
        // ==========================================
        this.debrisSeeds = new Float32Array(DEBRIS_COUNT * 3);
        this.debrisPositions = new Float32Array(DEBRIS_COUNT * 3);
        this.debrisColors = new Float32Array(DEBRIS_COUNT * 3);
        this.debrisSizes = new Float32Array(DEBRIS_COUNT);

        const debrisPalette = this.skin.debrisColors;

        for (let i = 0; i < DEBRIS_COUNT; i++) {
            this.debrisSeeds[i * 3] = Math.random();
            this.debrisSeeds[i * 3 + 1] = Math.random();
            this.debrisSeeds[i * 3 + 2] = Math.random();

            const c = debrisPalette[Math.floor(Math.random() * debrisPalette.length)];
            this.debrisColors[i * 3] = c[0] + Math.random() * 0.1;
            this.debrisColors[i * 3 + 1] = c[1] + Math.random() * 0.1;
            this.debrisColors[i * 3 + 2] = c[2] + Math.random() * 0.1;
            this.debrisSizes[i] = 0.2 + Math.random() * 0.4;
        }

        const debrisGeom = new THREE.BufferGeometry();
        debrisGeom.setAttribute('position', new THREE.BufferAttribute(this.debrisPositions, 3));
        debrisGeom.setAttribute('color', new THREE.BufferAttribute(this.debrisColors, 3));
        debrisGeom.setAttribute('size', new THREE.BufferAttribute(this.debrisSizes, 1));

        const debrisMat = new THREE.PointsMaterial({
            size: 1.0,
            vertexColors: true,
            transparent: true,
            opacity: 0.95,
            map: smokeTexture,
            blending: THREE.NormalBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this.debris = new THREE.Points(debrisGeom, debrisMat);
        this.group.add(this.debris);

        // ==========================================
        // 5. GROUND DUST (Swirling impact cloud)
        // ==========================================
        this.dustPositions = new Float32Array(DUST_COUNT * 3);
        this.dustColors = new Float32Array(DUST_COUNT * 3);
        this.dustSizes = new Float32Array(DUST_COUNT);

        for (let i = 0; i < DUST_COUNT; i++) {
            const b = this.skin.dustBrightness[0] + Math.random() * (this.skin.dustBrightness[1] - this.skin.dustBrightness[0]);
            this.dustColors[i * 3] = b * this.skin.dustTint[0];
            this.dustColors[i * 3 + 1] = b * this.skin.dustTint[1];
            this.dustColors[i * 3 + 2] = b * this.skin.dustTint[2];
            this.dustSizes[i] = 1.0 + Math.random() * 2.0;
        }

        const dustGeom = new THREE.BufferGeometry();
        dustGeom.setAttribute('position', new THREE.BufferAttribute(this.dustPositions, 3));
        dustGeom.setAttribute('color', new THREE.BufferAttribute(this.dustColors, 3));
        dustGeom.setAttribute('size', new THREE.BufferAttribute(this.dustSizes, 1));

        const dustMat = new THREE.PointsMaterial({
            size: 1.0,
            vertexColors: true,
            transparent: true,
            opacity: 0.50,
            map: smokeTexture,
            blending: THREE.NormalBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this.dustRing = new THREE.Points(dustGeom, dustMat);
        this.group.add(this.dustRing);

        // ==========================================
        // 6. OUTER CLOUD FLUFF
        // ==========================================
        this.cloudPositions = new Float32Array(CLOUD_COUNT * 3);
        this.cloudColors = new Float32Array(CLOUD_COUNT * 3);
        this.cloudSizes = new Float32Array(CLOUD_COUNT);
        this.cloudSeeds = new Float32Array(CLOUD_COUNT * 2);

        for (let i = 0; i < CLOUD_COUNT; i++) {
            this.cloudSeeds[i * 2] = Math.random();
            this.cloudSeeds[i * 2 + 1] = Math.random() * Math.PI * 2;

            const b = this.skin.cloudBrightness[0] + Math.random() * (this.skin.cloudBrightness[1] - this.skin.cloudBrightness[0]);
            this.cloudColors[i * 3] = b * this.skin.cloudTint[0];
            this.cloudColors[i * 3 + 1] = b * this.skin.cloudTint[1];
            this.cloudColors[i * 3 + 2] = b * this.skin.cloudTint[2];
        }

        const cloudGeom = new THREE.BufferGeometry();
        cloudGeom.setAttribute('position', new THREE.BufferAttribute(this.cloudPositions, 3));
        cloudGeom.setAttribute('color', new THREE.BufferAttribute(this.cloudColors, 3));
        cloudGeom.setAttribute('size', new THREE.BufferAttribute(this.cloudSizes, 1));

        const cloudMat = new THREE.PointsMaterial({
            size: 2.0,
            vertexColors: true,
            transparent: true,
            opacity: 0.35,
            map: smokeTexture,
            blending: THREE.NormalBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this.fluffyClouds = new THREE.Points(cloudGeom, cloudMat);
        this.group.add(this.fluffyClouds);

        // ==========================================
        // 7. BOOST WIND TRAIL
        // ==========================================
        // Pre-allocate trail particle pool (fixed size, reuse via swap-and-pop)
        this.trailParticles = new Array(TRAIL_COUNT);
        for (let i = 0; i < TRAIL_COUNT; i++) {
            this.trailParticles[i] = { wx: 0, wz: 0, vx: 0, vz: 0, life: 0, size: 0, height: 0 };
        }
        this.trailActiveCount = 0;

        this.trailPositions = new Float32Array(TRAIL_COUNT * 3);
        this.trailColors    = new Float32Array(TRAIL_COUNT * 3);
        this.trailSizes     = new Float32Array(TRAIL_COUNT);

        // Hide all trail particles below ground initially
        for (let i = 0; i < TRAIL_COUNT; i++) {
            this.trailPositions[i * 3 + 1] = -9999;
            this.trailSizes[i] = 0;
        }

        const trailGeom = new THREE.BufferGeometry();
        trailGeom.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
        trailGeom.setAttribute('color',    new THREE.BufferAttribute(this.trailColors, 3));
        trailGeom.setAttribute('size',     new THREE.BufferAttribute(this.trailSizes, 1));

        // Additive blending gives a bright, glowing wind-streak look
        const trailMat = new THREE.PointsMaterial({
            size: 1.5,
            vertexColors: true,
            transparent: true,
            opacity: 0.55,
            map: smokeTexture,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this.trailPoints = new THREE.Points(trailGeom, trailMat);
        // The trail is rendered in group-local space but we compute offsets
        // from the group's world position so the streaks stay behind in world space.
        this.group.add(this.trailPoints);

        // ==========================================
        // 8. SHAPED DEBRIS (InstancedMesh)
        // Three geometry types give recognisable silhouettes inside the funnel:
        //   BoxGeometry      → house chunks / concrete blocks
        //   flat BoxGeometry → car panels / wooden planks / sheet metal
        //   IcosahedronGeometry (detail=0) → irregular rubble / rocks
        //
        // All three use vertexColors so we can tint each instance differently at
        // construction time without needing separate materials.
        // frustumCulled=false because the tornado group moves each frame.
        // ==========================================

        const _pickRandom = (palette: number[]): THREE.Color =>
            new THREE.Color(palette[Math.floor(Math.random() * palette.length)]);

        // Helper: build seed array (4 floats per slot)
        const buildSeeds = (count: number): Float32Array => {
            const s = new Float32Array(count * 4);
            for (let i = 0; i < count; i++) {
                s[i * 4 + 0] = Math.random();                                  // heightRatio 0-1
                s[i * 4 + 1] = Math.random() * Math.PI * 2;                   // angleOffset
                s[i * 4 + 2] = 0.55 + Math.random() * 0.45;                  // orbitFuzz
                s[i * 4 + 3] = (Math.random() < 0.5 ? 1 : -1) * (1.5 + Math.random() * 3.0); // spinSpeed
            }
            return s;
        };

        // ── Box debris ─────────────────────────────────────────────────────
        const boxGeo = new THREE.BoxGeometry(0.5, 0.35, 0.25);
        const boxMat = new THREE.MeshLambertMaterial({ vertexColors: true });
        this.boxDebris = new THREE.InstancedMesh(boxGeo, boxMat, BOX_SLOTS);
        this.boxDebris.castShadow = false;
        this.boxDebris.frustumCulled = false;
        this.boxSeeds = buildSeeds(BOX_SLOTS);

        const boxPalette = this.skin.boxPalette;
        for (let i = 0; i < BOX_SLOTS; i++) {
            this.boxDebris.setColorAt(i, _pickRandom(boxPalette));
        }
        this.boxDebris.instanceColor!.needsUpdate = true;
        // Start all slots hidden
        this._parkInstance(this.boxDebris, BOX_SLOTS);
        this.group.add(this.boxDebris);

        // ── Flat debris ────────────────────────────────────────────────────
        const flatGeo = new THREE.BoxGeometry(0.75, 0.06, 0.40);
        const flatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
        this.flatDebris = new THREE.InstancedMesh(flatGeo, flatMat, FLAT_SLOTS);
        this.flatDebris.castShadow = false;
        this.flatDebris.frustumCulled = false;
        this.flatSeeds = buildSeeds(FLAT_SLOTS);

        const flatPalette = this.skin.flatPalette;
        for (let i = 0; i < FLAT_SLOTS; i++) {
            this.flatDebris.setColorAt(i, _pickRandom(flatPalette));
        }
        this.flatDebris.instanceColor!.needsUpdate = true;
        this._parkInstance(this.flatDebris, FLAT_SLOTS);
        this.group.add(this.flatDebris);

        // ── Chunk debris ───────────────────────────────────────────────────
        // detail=0 → 20 triangular faces, reads as rock/rubble
        const chunkGeo = new THREE.IcosahedronGeometry(0.28, 0);
        const chunkMat = new THREE.MeshLambertMaterial({ vertexColors: true });
        this.chunkDebris = new THREE.InstancedMesh(chunkGeo, chunkMat, CHUNK_SLOTS);
        this.chunkDebris.castShadow = false;
        this.chunkDebris.frustumCulled = false;
        this.chunkSeeds = buildSeeds(CHUNK_SLOTS);

        const chunkPalette = this.skin.chunkPalette;
        for (let i = 0; i < CHUNK_SLOTS; i++) {
            this.chunkDebris.setColorAt(i, _pickRandom(chunkPalette));
        }
        this.chunkDebris.instanceColor!.needsUpdate = true;
        this._parkInstance(this.chunkDebris, CHUNK_SLOTS);
        this.group.add(this.chunkDebris);

        // ==========================================
        // 9. VEHICLES INSIDE FUNNEL (F2+ only)
        // 4 small car-shaped boxes orbit at different heights inside the funnel.
        // Shown only when radius > 2.0 and scaled with radius.
        // ==========================================
        const vehicleGeo = new THREE.BoxGeometry(0.4, 0.2, 0.2);
        this.vehicleSeeds = new Float32Array(TornadoMesh.VEHICLE_COUNT * 4);
        for (let i = 0; i < TornadoMesh.VEHICLE_COUNT; i++) {
            this.vehicleSeeds[i * 4 + 0] = 0.12 + (i / TornadoMesh.VEHICLE_COUNT) * 0.55; // stagger heights
            this.vehicleSeeds[i * 4 + 1] = (i / TornadoMesh.VEHICLE_COUNT) * Math.PI * 2;  // spread around ring
            this.vehicleSeeds[i * 4 + 2] = 0.45 + Math.random() * 0.35;                    // orbit fuzz
            this.vehicleSeeds[i * 4 + 3] = (i % 2 === 0 ? 1 : -1) * (1.8 + Math.random() * 1.2); // spin direction/speed
        }
        for (let i = 0; i < TornadoMesh.VEHICLE_COUNT; i++) {
            const vm = new THREE.Mesh(vehicleGeo, TornadoMesh._vehicleMat);
            vm.castShadow = false;
            vm.frustumCulled = false;
            vm.visible = false;
            this.vehicleMeshes.push(vm);
            this.group.add(vm);
        }

        // ==========================================
        // 10. DECAY PARTICLES (emitted while shrinking)
        // Grey/brown falling debris particles emitted when the tornado loses radius.
        // ==========================================
        const DECAY_MAX = TornadoMesh.DECAY_MAX;
        // Pre-allocate decay particle pool (fixed size, reuse via swap-and-pop)
        this._decayParticles = new Array(DECAY_MAX);
        for (let i = 0; i < DECAY_MAX; i++) {
            this._decayParticles[i] = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 };
        }
        this._decayActiveCount = 0;

        this._decayPositions = new Float32Array(DECAY_MAX * 3);
        this._decayColors    = new Float32Array(DECAY_MAX * 3);
        this._decaySizes     = new Float32Array(DECAY_MAX);

        // Park all slots below ground initially
        for (let i = 0; i < DECAY_MAX; i++) {
            this._decayPositions[i * 3 + 1] = -9999;
            this._decaySizes[i] = 0;
        }

        const decayGeom = new THREE.BufferGeometry();
        decayGeom.setAttribute('position', new THREE.BufferAttribute(this._decayPositions, 3));
        decayGeom.setAttribute('color',    new THREE.BufferAttribute(this._decayColors,    3));
        decayGeom.setAttribute('size',     new THREE.BufferAttribute(this._decaySizes,     1));

        const decayMat = new THREE.PointsMaterial({
            size: 0.8,
            vertexColors: true,
            transparent: true,
            opacity: 0.80,
            map: smokeTexture,
            blending: THREE.NormalBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this._decayPoints = new THREE.Points(decayGeom, decayMat);
        this.group.add(this._decayPoints);

        // ==========================================
        // SHIELD EFFECT (Spawn / Safe-Zone Protection)
        // ==========================================
        // A semi-transparent sphere wrapped around the funnel that pulses green.
        // Hidden by default; activated via setProtected(true).
        const shieldGeo = new THREE.SphereGeometry(1, 16, 12);
        const shieldMat = new THREE.MeshBasicMaterial({
            color: 0x44ffaa,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.FrontSide,
            wireframe: false,
        });
        this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
        // Initially hidden
        this.shieldMesh.visible = false;
        this.group.add(this.shieldMesh);

        // Soft green point light — invisible until protection activates
        this.shieldLight = new THREE.PointLight(0x44ffaa, 0, 30);
        this.shieldLight.position.set(0, 3, 0);
        this.group.add(this.shieldLight);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /** Park all slots of an InstancedMesh below ground (invisible). */
    private _parkInstance(mesh: THREE.InstancedMesh, count: number): void {
        _shapedDummy.position.set(0, -9999, 0);
        _shapedDummy.scale.set(0.001, 0.001, 0.001);
        _shapedDummy.rotation.set(0, 0, 0);
        _shapedDummy.updateMatrix();
        for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _shapedDummy.matrix);
        mesh.instanceMatrix.needsUpdate = true;
    }

    /**
     * Write the transform for one shaped debris instance.
     * If visible=false the slot is parked below ground.
     */
    private _updateShapedSlot(
        mesh:        THREE.InstancedMesh,
        slotIndex:   number,
        seeds:       Float32Array,
        visible:     boolean,
        funnelHeight: number,
        groundWidth:  number,
        cloudWidth:   number,
        sizeScale:    number,
        wobbleX:      number,
        wobbleZ:      number,
    ): void {
        if (!visible) {
            _shapedDummy.position.set(0, -9999, 0);
            _shapedDummy.scale.set(0.001, 0.001, 0.001);
            _shapedDummy.rotation.set(0, 0, 0);
            _shapedDummy.updateMatrix();
            mesh.setMatrixAt(slotIndex, _shapedDummy.matrix);
            return;
        }

        const s0 = seeds[slotIndex * 4 + 0]; // heightRatio
        const s1 = seeds[slotIndex * 4 + 1]; // angleOffset
        const s2 = seeds[slotIndex * 4 + 2]; // orbitFuzz
        const s3 = seeds[slotIndex * 4 + 3]; // spinSpeed (signed)

        // Continuous upward spiral — loops every 1/0.15 time units
        const t = (s0 + this.time * 0.15) % 1.0;

        // Keep shaped debris in lower 70% of funnel so it's clearly visible
        const height = (0.05 + t * 0.65) * funnelHeight;

        // Orbit radius: follow funnel profile, pulled inward so pieces sit
        // INSIDE the wall rather than outside it
        const funnelFactor = Math.pow(t, 0.55);
        const funnelR = groundWidth + (cloudWidth - groundWidth) * funnelFactor;
        const orbitR  = funnelR * s2 * 0.80;

        const angle = s1 + this.time * s3;

        _shapedDummy.position.set(
            Math.cos(angle) * orbitR + wobbleX * t,
            height,
            Math.sin(angle) * orbitR + wobbleZ * t,
        );

        // Each piece tumbles on all three axes at its own rate
        _shapedDummy.rotation.set(
            this.time * s3 * 0.7,
            this.time * s3 * 1.1,
            this.time * s3 * 0.5,
        );

        const sc = Math.max(0.35, Math.min(sizeScale, 2.2));
        _shapedDummy.scale.set(sc, sc, sc);
        _shapedDummy.updateMatrix();
        mesh.setMatrixAt(slotIndex, _shapedDummy.matrix);
    }

    update(dt: number, rotation: number): void {
        this.time += dt * 0.012;

        // Smoothly lerp baseRadius toward targetRadius to avoid visual jumping
        // between server ticks. Rate 0.008/ms → ~12% per frame at 60fps,
        // reaches 95% of target in ~200ms.
        if (this.baseRadius !== this.targetRadius) {
            const lerpFactor = 1 - Math.exp(-dt * 0.008);
            this.baseRadius += (this.targetRadius - this.baseRadius) * lerpFactor;
            // Snap when close enough to avoid lingering micro-differences
            if (Math.abs(this.targetRadius - this.baseRadius) < 0.005) {
                this.baseRadius = this.targetRadius;
            }
        }

        const r = this.baseRadius;

        // Calculate smooth velocity for leaning effect
        const currentPos = this.group.position;
        const dx = currentPos.x - this.lastPos.x;
        const dz = currentPos.z - this.lastPos.z;

        // Exponential moving average for smooth leaning (normalized to per-second)
        this.velocity.x = this.velocity.x * 0.88 + dx * 0.12 * 12;
        this.velocity.z = this.velocity.z * 0.88 + dz * 0.12 * 12;
        this.lastPos.copy(currentPos);

        // Delayed visual shape progression (F1 looks like F0, etc.)
        const visualR = Math.max(0, r - 1.0);

        // Tornado dimensions — shape changes with Fujita category
        // Reverted to original tall height ("a altura tava legal")
        const funnelHeight = r * 10;

        // F0 stays VERY thin, F5 becomes massively wide
        // Using a smooth exponential curve that starts almost flat then rockets up.
        // F5 (r > 5) gets an additional 30% width boost so it feels imposing on entry.
        const f5WidthScale = r > 5.0 ? 1.30 : 1.0;
        const groundWidth = f5WidthScale * ((r < 2.0)
            ? Math.pow(r, 1.5) * 0.12 + 0.10  // F0/F1 are tiny
            : Math.pow(r, 2.0) * 0.25 + 0.10); // F3+ explode in width

        const cloudWidth = groundWidth + Math.max(3.0, r * 1.5);     // Always wider than base

        // Funnel power: steeper for longer
        const funnelPower = Math.max(0.15, 0.75 - visualR * 0.1);

        // ==========================================
        // 1. GPU VERTEX DEFORMATION — outer funnel wall
        // All deformation runs on the GPU via onBeforeCompile.
        // We only update 8 uniform values per frame (zero CPU vertex work).
        // ==========================================
        this.coreUniforms.uTime.value        = this.time;
        this.coreUniforms.uRadius.value      = r;
        this.coreUniforms.uFunnelHeight.value = funnelHeight;
        this.coreUniforms.uGroundWidth.value = groundWidth;
        this.coreUniforms.uCloudWidth.value  = cloudWidth;
        this.coreUniforms.uFunnelPower.value = funnelPower;
        this.coreUniforms.uVelocityX.value   = this.velocity.x;
        this.coreUniforms.uVelocityZ.value   = this.velocity.z;

        // Scale inner solid cones to fill the funnel volume
        const leanStr = Math.min(5.0, 3.0 / Math.max(r, 0.5));
        // 2 inner cones: outer fill (60%) + tight inner core (15%)
        for (let ci = 0; ci < this.innerCones.length; ci++) {
            const cone = this.innerCones[ci];
            const s = CONE_SCALES[ci] ?? 0.15;
            const coneBaseR = groundWidth * s;
            const coneTopR  = cloudWidth * s;
            const avgR = (coneBaseR + coneTopR) * 0.5;
            cone.scale.set(avgR, funnelHeight, avgR);
            cone.position.set(
                -this.velocity.x * 0.5 * leanStr,
                0,
                -this.velocity.z * 0.5 * leanStr,
            );
            cone.rotation.y = this.time * (2.0 - ci * 0.5);
        }

        // ==========================================
        // 2. PER-TORNADO INTERNAL FLASH LIGHT
        // Only activates on larger tornadoes (radius >= 2).
        // Creates an eerie internal glow that pulses irregularly.
        // ==========================================
        const dtMs = dt; // dt is already in ms from the game loop
        if (r >= 2) {
            this.flashTimer -= dtMs;

            if (this.flashPhase === 0 && this.flashTimer <= 0) {
                // Trigger a new flash — interval shrinks as tornado grows
                this.flashPhase = 1;
                this.flashElapsed = 0;
                this.flashTimer = 4000 + Math.random() * 6000 / Math.max(1, r * 0.3);
            }

            if (this.flashPhase === 1) {
                // Rising flash: 0 -> peak intensity over ~80 ms
                this.flashElapsed += dtMs;
                const t = Math.min(this.flashElapsed / 80, 1);
                const peakIntensity = Math.min(r * 0.6, 4.0);
                this.flashLight.intensity = t * peakIntensity;
                if (this.flashElapsed >= 80) {
                    this.flashPhase = 2;
                    this.flashElapsed = 0;
                }
            } else if (this.flashPhase === 2) {
                // Decay: peak -> 0 over ~150 ms
                this.flashElapsed += dtMs;
                const t = Math.min(this.flashElapsed / 150, 1);
                const peakIntensity = Math.min(r * 0.6, 4.0);
                this.flashLight.intensity = peakIntensity * (1 - t);
                if (this.flashElapsed >= 150) {
                    this.flashPhase = 0;
                    this.flashLight.intensity = 0;
                }
            }
        } else {
            // Small tornadoes have no internal glow
            this.flashLight.intensity = 0;
            this.flashPhase = 0;
        }

        // ==========================================
        // 3. ANIMATE DEBRIS
        // ==========================================
        for (let i = 0; i < DEBRIS_COUNT; i++) {
            const seed1 = this.debrisSeeds[i * 3];
            const seed2 = this.debrisSeeds[i * 3 + 1];
            const seed3 = this.debrisSeeds[i * 3 + 2];

            const t = (seed1 + this.time * 0.2) % 1.0;
            const height = t * funnelHeight * 0.8;

            const funnelFactor = Math.pow(t, 0.55);
            const orbitR = (groundWidth + (cloudWidth - groundWidth) * funnelFactor) * (0.6 + seed2 * 0.35);

            const debrisSpeed = 3.5 - t * 2.0;
            const angle = seed3 * Math.PI * 2 + this.time * debrisSpeed;

            const wobbleMax = Math.min(r * 0.15, 0.6);
            const wobbleX = Math.sin(this.time * 0.8 + t * 2.5) * wobbleMax * t - this.velocity.x * t * Math.min(5.0, 3.0 / Math.max(r, 0.5));
            const wobbleZ = Math.cos(this.time * 0.6 + t * 3.0) * wobbleMax * 0.8 * t - this.velocity.z * t * Math.min(5.0, 3.0 / Math.max(r, 0.5));

            const turb = Math.sin(this.time * 5 + seed1 * 10) * 0.1 * r;

            this.debrisPositions[i * 3] = Math.cos(angle) * orbitR + wobbleX;
            this.debrisPositions[i * 3 + 1] = height + turb;
            this.debrisPositions[i * 3 + 2] = Math.sin(angle) * orbitR + wobbleZ;
        }
        this.debris.geometry.attributes.position.needsUpdate = true;

        // ==========================================
        // 4. ANIMATE DUST RING
        // ==========================================
        const dustRadius = groundWidth * 1.8;
        for (let i = 0; i < DUST_COUNT; i++) {
            const angle = (i / DUST_COUNT) * Math.PI * 2 + this.time * 2.5;
            const dist = dustRadius * (0.7 + Math.sin(this.time * 2.0 + i * 1.5) * 0.25);
            const rise = (Math.sin(this.time * 3 + i) * 0.5 + 0.5) * (r * 0.8);

            this.dustPositions[i * 3] = Math.cos(angle) * dist;
            this.dustPositions[i * 3 + 1] = rise;
            this.dustPositions[i * 3 + 2] = Math.sin(angle) * dist;
        }
        this.dustRing.geometry.attributes.position.needsUpdate = true;

        // ==========================================
        // 5. ANIMATE OUTER FLUFF CLOUDS
        // ==========================================
        for (let i = 0; i < CLOUD_COUNT; i++) {
            const hRatio = this.cloudSeeds[i * 2]; // 0 to 1 height
            const seedAngle = this.cloudSeeds[i * 2 + 1];

            // Tighter at bottom, very wide and puffy at top
            const t = hRatio;
            const height = t * funnelHeight;

            const funnelFactor = Math.pow(t, 0.50); // Fluff spreads slightly wider than core
            const orbitR = (groundWidth + (cloudWidth - groundWidth) * funnelFactor) * (0.75 + Math.sin(this.time + i) * 0.1);

            const rotSpeed = 3.8 - t * 2.0;
            const angle = seedAngle + this.time * rotSpeed;

            // Lean proportional to size — F0 stays nearly vertical so smoke follows closely;
            // F5 leans dramatically into the wind. Old formula (3/r) was inverted: huge lean on tiny F0.
            const leanStrength = Math.min(3.0, r * 0.4);
            const leanX = -this.velocity.x * t * leanStrength;
            const leanZ = -this.velocity.z * t * leanStrength;

            const wobbleMax2 = Math.min(r * 0.15, 0.6);
            const wobbleX = Math.sin(this.time * 0.8 + t * 2.5) * wobbleMax2 * t + leanX;
            const wobbleZ = Math.cos(this.time * 0.6 + t * 3.0) * wobbleMax2 * 0.8 * t + leanZ;

            this.cloudPositions[i * 3] = Math.cos(angle) * orbitR + wobbleX;
            this.cloudPositions[i * 3 + 1] = height;
            this.cloudPositions[i * 3 + 2] = Math.sin(angle) * orbitR + wobbleZ;

            const sizeScale = Math.min(r, 4.0);
            this.cloudSizes[i] = (1.0 + t * 2.5) * sizeScale;
        }
        this.fluffyClouds.geometry.attributes.position.needsUpdate = true;
        this.fluffyClouds.geometry.attributes.size.needsUpdate = true;

        // ==========================================
        // 6. ANIMATE GROUND SHADOWS
        // Shadow footprint grows with base width AND funnel height (taller = wider
        // penumbra). Both rings pulse slightly in sync with the vortex rotation,
        // and are squished into an ellipse when the tornado is moving.
        // ==========================================
        const leanStrengthShadow = Math.min(5.0, 3.0 / Math.max(r, 0.5));

        // Base shadow width from funnel geometry
        const shadowBaseW    = groundWidth * 4.5;
        // Height contribution — logarithmic so F5 doesn't create absurdly wide shadow
        const heightContrib  = Math.log1p(funnelHeight) * 0.55;
        const primaryW       = shadowBaseW + heightContrib;
        const outerW         = primaryW * 1.85; // outer ring is always wider

        // Pulse: sinusoidal tied to rotation clock — gives breathing effect
        const pulsePrimary = 1.0 + Math.sin(this.time * 4.5) * 0.045;
        const pulseOuter   = 1.0 + Math.sin(this.time * 4.5 + Math.PI * 0.5) * 0.028;

        // Lean: squish shadow into an ellipse in the direction of motion
        const leanSpeed  = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
        const leanSquish = Math.min(leanSpeed * leanStrengthShadow * 0.12, 0.28);
        const leanAngle  = Math.atan2(this.velocity.z, this.velocity.x);

        this.shadowMesh.scale.set(
            primaryW * pulsePrimary,
            primaryW * pulsePrimary * (1.0 - leanSquish),
            1,
        );
        this.shadowMeshOuter.scale.set(
            outerW * pulseOuter,
            outerW * pulseOuter * (1.0 - leanSquish * 0.6),
            1,
        );

        // Rotate shadow disk so the squish axis faces the direction of motion
        this.shadowMesh.rotation.z      = leanAngle;
        this.shadowMeshOuter.rotation.z = leanAngle;

        // Opacity: bigger tornado → darker, with a tiny flicker each frame
        const opacityT   = Math.min(r / 8.0, 1.0);
        const flicker    = 1.0 + (Math.random() - 0.5) * 0.025;
        (this.shadowMesh.material as THREE.MeshBasicMaterial).opacity =
            (0.15 + opacityT * 0.35) * flicker;
        (this.shadowMeshOuter.material as THREE.MeshBasicMaterial).opacity =
            (0.05 + opacityT * 0.13) * flicker;

        // ==========================================
        // 7. ANIMATE SHAPED DEBRIS (InstancedMesh)
        // ==========================================
        const shapedLeanStrength = Math.min(5.0, 3.0 / Math.max(r, 0.5));
        const shapedWobbleMax    = Math.min(r * 0.15, 0.6);
        const sharedWobbleX      = Math.sin(this.time * 0.8) * shapedWobbleMax * 0.4
            - this.velocity.x * 0.4 * shapedLeanStrength;
        const sharedWobbleZ      = Math.cos(this.time * 0.6) * shapedWobbleMax * 0.8 * 0.4
            - this.velocity.z * 0.4 * shapedLeanStrength;
        const debrisSizeScale    = Math.max(0.35, Math.min(r * 0.35, 2.2));

        for (let i = 0; i < BOX_SLOTS; i++) {
            this._updateShapedSlot(
                this.boxDebris, i, this.boxSeeds, i < this.visibleBoxes,
                funnelHeight, groundWidth, cloudWidth,
                debrisSizeScale, sharedWobbleX, sharedWobbleZ,
            );
        }
        this.boxDebris.instanceMatrix.needsUpdate = true;

        for (let i = 0; i < FLAT_SLOTS; i++) {
            this._updateShapedSlot(
                this.flatDebris, i, this.flatSeeds, i < this.visibleFlats,
                funnelHeight, groundWidth, cloudWidth,
                debrisSizeScale, sharedWobbleX, sharedWobbleZ,
            );
        }
        this.flatDebris.instanceMatrix.needsUpdate = true;

        for (let i = 0; i < CHUNK_SLOTS; i++) {
            this._updateShapedSlot(
                this.chunkDebris, i, this.chunkSeeds, i < this.visibleChunks,
                funnelHeight, groundWidth, cloudWidth,
                debrisSizeScale, sharedWobbleX, sharedWobbleZ,
            );
        }
        this.chunkDebris.instanceMatrix.needsUpdate = true;

        // ==========================================
        // 8. SHIELD GLOW ANIMATION (Spawn / Safe-Zone Protection)
        // ==========================================
        if (this.isProtected) {
            // Show the shield mesh
            this.shieldMesh.visible = true;

            // Scale the shield sphere to wrap around the entire funnel.
            // The funnel top is at funnelHeight, base footprint is ~cloudWidth.
            const shieldR = Math.max(cloudWidth * 1.4, funnelHeight * 0.55);
            this.shieldMesh.scale.set(shieldR, funnelHeight * 0.55, shieldR);
            // Centre the sphere vertically so it encloses the funnel
            this.shieldMesh.position.set(0, funnelHeight * 0.5, 0);

            // Pulsing opacity — creates a "breathing" shield look
            // Two sine waves at different frequencies sum for irregular shimmer
            const pulse =
                0.10 + Math.sin(this.time * 3.5) * 0.06 +
                Math.sin(this.time * 7.2 + 1.3) * 0.03;
            (this.shieldMesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, pulse);

            // Green point light intensity pulses in sync
            this.shieldLight.intensity = 0.8 + Math.sin(this.time * 3.5) * 0.4;
            this.shieldLight.position.set(0, funnelHeight * 0.4, 0);
            this.shieldLight.distance = shieldR * 4;
        } else {
            this.shieldMesh.visible = false;
            this.shieldLight.intensity = 0;
        }

        // ==========================================
        // 9. AFK OPACITY FADE
        // Smoothly lerp afkOpacity toward 1.0 (active) or AFK_OPACITY (idle).
        // Applies to the core mesh and all particle systems so the whole
        // tornado becomes semi-transparent — subtle but clearly noticeable.
        // ==========================================
        const afkTarget = this.isAfk ? AFK_OPACITY : 1.0;
        // Clamp lerp factor so we don't overshoot on high-dt frames
        const afkStep = Math.min(AFK_FADE_SPEED * dt, 1.0);
        this.afkOpacity += (afkTarget - this.afkOpacity) * afkStep;
        const op = this.afkOpacity;

        if (Math.abs(op - this._lastAfkOpacity) > 0.001) {
            this._lastAfkOpacity = op;
            this.coreMat.opacity = op;
            for (const cone of this.innerCones) {
                (cone.material as THREE.MeshLambertMaterial).opacity = 0.95 * op;
            }
            (this.debris.material as THREE.PointsMaterial).opacity        = 0.95 * op;
            (this.dustRing.material as THREE.PointsMaterial).opacity      = 0.50 * op;
            (this.fluffyClouds.material as THREE.PointsMaterial).opacity  = 0.35 * op;
            (this.trailPoints.material as THREE.PointsMaterial).opacity   = 0.55 * op;
        }

        // ==========================================
        // 10. BOOST WIND TRAIL
        // ==========================================
        this._updateTrail(dt, funnelHeight);

        // ==========================================
        // 11. VEHICLES INSIDE FUNNEL (F2+ only)
        // ==========================================
        this._updateVehicles(funnelHeight, groundWidth, cloudWidth);

        // ==========================================
        // 12. DECAY PARTICLES (shrinking tornado)
        // ==========================================
        this._updateDecayParticles(dt, funnelHeight, groundWidth, cloudWidth);
    }

    /**
     * Set whether this tornado is currently boosting.
     * Call this every frame for the local player using InputHandler.getInput().boost.
     * For remote players, infer by detecting stamina decreasing between frames.
     */
    setBoosting(boosting: boolean): void {
        this.isBoosting = boosting;
    }

    private _updateTrail(dt: number, funnelHeight: number): void {
        const dtSec = dt * 0.001;
        const speed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);

        if (this.isBoosting && speed > 0.001) {
            const emitCount = Math.min(3, Math.ceil(speed * 8));
            const invLen    = 1.0 / speed;
            const trailDirX = -this.velocity.x * invLen;
            const trailDirZ = -this.velocity.z * invLen;
            const wx = this.group.position.x;
            const wz = this.group.position.z;
            const r  = this.baseRadius;

            for (let e = 0; e < emitCount; e++) {
                if (this.trailActiveCount >= TRAIL_COUNT) break;
                const spread   = r * 0.5 + 0.5;
                const lateralX = -trailDirZ;
                const lateralZ =  trailDirX;
                const lat      = (Math.random() - 0.5) * spread;
                const forward  = Math.random() * (r * 0.4 + 0.3);
                const spawnWX  = wx + trailDirX * forward + lateralX * lat;
                const spawnWZ  = wz + trailDirZ * forward + lateralZ * lat;
                const driftSpeed = 0.5 + Math.random() * 1.0;
                const driftAngle = Math.atan2(trailDirZ, trailDirX) + (Math.random() - 0.5) * 1.2;

                // Reuse particle from pool at trailActiveCount index
                const p = this.trailParticles[this.trailActiveCount];
                p.wx = spawnWX;
                p.wz = spawnWZ;
                p.vx = Math.cos(driftAngle) * driftSpeed;
                p.vz = Math.sin(driftAngle) * driftSpeed;
                p.life = 1.0;
                p.size = (0.8 + Math.random() * 1.4) * Math.max(1.0, r * 0.3);
                p.height = (Math.random() * 0.5 + 0.1) * Math.min(funnelHeight, 4.0);
                this.trailActiveCount++;
            }
        }

        const baseMeshX = this.group.position.x;
        const baseMeshZ = this.group.position.z;
        const lifetime  = 0.65; // seconds — within the 0.5-1 s requirement

        for (let i = this.trailActiveCount - 1; i >= 0; i--) {
            const p = this.trailParticles[i];
            p.life -= dtSec / lifetime;

            if (p.life <= 0) {
                // Swap-and-pop: move last active into this slot
                this.trailActiveCount--;
                if (i < this.trailActiveCount) {
                    const last = this.trailParticles[this.trailActiveCount];
                    const dead = this.trailParticles[i];
                    // Swap references
                    this.trailParticles[i] = last;
                    this.trailParticles[this.trailActiveCount] = dead;
                }
                continue;
            }

            p.wx += p.vx * dtSec;
            p.wz += p.vz * dtSec;
            p.vx *= 0.97;
            p.vz *= 0.97;

            // Convert to group-local space for the GPU buffer
            const localX = p.wx - baseMeshX;
            const localZ = p.wz - baseMeshZ;

            this.trailPositions[i * 3]     = localX;
            this.trailPositions[i * 3 + 1] = p.height;
            this.trailPositions[i * 3 + 2] = localZ;

            // Skin-tinted trail: bright at full life, fades toward darker tint.
            // Squared life for a soft hold-then-snap fade.
            const lifeEased = p.life * p.life;
            this.trailColors[i * 3]     = this.skin.trailColor[0] + (1.0 - this.skin.trailColor[0]) * 0.15 * p.life;
            this.trailColors[i * 3 + 1] = this.skin.trailColor[1] + (1.0 - this.skin.trailColor[1]) * 0.10 * p.life;
            this.trailColors[i * 3 + 2] = this.skin.trailColor[2];

            this.trailSizes[i] = p.size * lifeEased;
        }

        // Park unused buffer slots below ground
        for (let i = this.trailActiveCount; i < TRAIL_COUNT; i++) {
            this.trailPositions[i * 3 + 1] = -9999;
            this.trailSizes[i] = 0;
        }

        // Only upload trail buffers to the GPU when something changed:
        // either particles are active, or we just transitioned to zero
        // (need one final upload to park the last slots below ground).
        if (this.trailActiveCount > 0 || this._prevTrailActive > 0) {
            this.trailPoints.geometry.attributes.position.needsUpdate = true;
            this.trailPoints.geometry.attributes.color.needsUpdate    = true;
            this.trailPoints.geometry.attributes.size.needsUpdate     = true;
        }
        this._prevTrailActive = this.trailActiveCount;
    }

    private _updateVehicles(funnelHeight: number, groundWidth: number, cloudWidth: number): void {
        const r = this.baseRadius;
        const show = r > 2.0;

        for (let i = 0; i < TornadoMesh.VEHICLE_COUNT; i++) {
            const vm = this.vehicleMeshes[i];
            if (!show) {
                vm.visible = false;
                continue;
            }

            const s0 = this.vehicleSeeds[i * 4 + 0]; // height ratio
            const s1 = this.vehicleSeeds[i * 4 + 1]; // initial angle
            const s2 = this.vehicleSeeds[i * 4 + 2]; // orbit fuzz
            const s3 = this.vehicleSeeds[i * 4 + 3]; // spin rate (signed)

            // Continuous spiraling loop — cycles every few seconds
            const t = (s0 + this.time * 0.12) % 1.0;
            const height = (0.08 + t * 0.60) * funnelHeight;

            // Orbit inside the funnel wall at ~70% of funnel radius
            const funnelFactor = Math.pow(Math.max(t, 0.001), 0.55);
            const funnelR = groundWidth + (cloudWidth - groundWidth) * funnelFactor;
            const orbitR  = funnelR * s2 * 0.72;

            const angle = s1 + this.time * s3;
            vm.position.set(
                Math.cos(angle) * orbitR,
                height,
                Math.sin(angle) * orbitR,
            );

            // Tumble on all axes
            vm.rotation.x = this.time * s3 * 0.9;
            vm.rotation.y = this.time * s3 * 1.3;
            vm.rotation.z = this.time * s3 * 0.6;

            // Scale with radius (capped so vehicles don't become monsters)
            const sc = Math.max(0.4, Math.min((r - 2.0) * 0.3 + 0.5, 1.8));
            vm.scale.setScalar(sc);
            vm.visible = true;
        }
    }

    private _updateDecayParticles(dt: number, funnelHeight: number, groundWidth: number, cloudWidth: number): void {
        const r = this.baseRadius;
        const dtSec = dt * 0.001;
        const DECAY_MAX = TornadoMesh.DECAY_MAX;

        // Detect shrinkage — emit particles only when radius is decreasing
        if (this._prevRadius > 0 && r < this._prevRadius - 0.001) {
            // Emit 2-5 particles per frame while shrinking
            const emitCount = 2 + Math.floor(Math.random() * 4);
            for (let e = 0; e < emitCount && this._decayActiveCount < DECAY_MAX; e++) {
                const angle   = Math.random() * Math.PI * 2;
                const t       = Math.random(); // height ratio
                const fFactor = Math.pow(Math.max(t, 0.001), 0.55);
                const fR      = groundWidth + (cloudWidth - groundWidth) * fFactor;
                const dist    = fR * (0.8 + Math.random() * 0.5);
                const height  = t * funnelHeight;

                // Outward + downward velocity
                const outSpeed = 1.5 + Math.random() * 3.0;
                // Reuse particle from pool at _decayActiveCount index
                const p = this._decayParticles[this._decayActiveCount];
                p.x  = Math.cos(angle) * dist;
                p.y  = height;
                p.z  = Math.sin(angle) * dist;
                p.vx = Math.cos(angle) * outSpeed * 0.6 + (Math.random() - 0.5) * 1.5;
                p.vy = -1.5 - Math.random() * 2.5;  // falling downward
                p.vz = Math.sin(angle) * outSpeed * 0.6 + (Math.random() - 0.5) * 1.5;
                p.life = 1.0;
                this._decayActiveCount++;
            }
        }
        this._prevRadius = r;

        // Integrate physics and write to GPU buffer
        const GRAVITY_DECAY = 8.0;
        for (let i = this._decayActiveCount - 1; i >= 0; i--) {
            const p = this._decayParticles[i];
            p.life -= dtSec / 1.5; // 1.5s lifetime
            if (p.life <= 0) {
                // Swap-and-pop: move last active into this slot
                this._decayActiveCount--;
                if (i < this._decayActiveCount) {
                    const last = this._decayParticles[this._decayActiveCount];
                    const dead = this._decayParticles[i];
                    this._decayParticles[i] = last;
                    this._decayParticles[this._decayActiveCount] = dead;
                }
                continue;
            }

            p.vy -= GRAVITY_DECAY * dtSec;
            p.x += p.vx * dtSec;
            p.y += p.vy * dtSec;
            p.z += p.vz * dtSec;

            // Gentle drag
            p.vx *= 0.98;
            p.vz *= 0.98;
        }

        const active = this._decayActiveCount;
        for (let i = 0; i < active; i++) {
            const p = this._decayParticles[i];
            this._decayPositions[i * 3]     = p.x;
            this._decayPositions[i * 3 + 1] = p.y;
            this._decayPositions[i * 3 + 2] = p.z;

            // Grey/brown earthy colour
            const shade = 0.35 + Math.random() * 0.25;
            const lifeF = p.life;
            this._decayColors[i * 3]     = shade * lifeF;
            this._decayColors[i * 3 + 1] = shade * 0.85 * lifeF;
            this._decayColors[i * 3 + 2] = shade * 0.65 * lifeF;
            this._decaySizes[i]          = (0.25 + Math.random() * 0.35) * lifeF;
        }
        // Park unused slots
        for (let i = active; i < DECAY_MAX; i++) {
            this._decayPositions[i * 3 + 1] = -9999;
            this._decaySizes[i] = 0;
        }

        this._decayPoints.geometry.attributes.position.needsUpdate = true;
        this._decayPoints.geometry.attributes.color.needsUpdate    = true;
        this._decayPoints.geometry.attributes.size.needsUpdate     = true;
    }

    setRadius(radius: number): void {
        this.targetRadius = radius;

        // These visual properties can update immediately (non-geometric)
        (this.debris.material as THREE.PointsMaterial).size = 0.2 + Math.min(radius * 0.05, 0.8);
        (this.dustRing.material as THREE.PointsMaterial).size = 0.6 + Math.min(radius * 0.15, 2.0);

        // Shadow base scale is now fully driven by update() each frame —
        // no static setScale here avoids fighting with the dynamic pulse.

        this.flashLight.distance = radius * 25;

        // Scale shaped-debris visible count with Fujita category.
        // radius ≈ 1 → F0 (tiny), radius ≈ 7+ → F5 (100 % of slots active).
        // Power 1.4 curve: stays near-zero for F0/F1, ramps aggressively for F3+.
        const fraction = Math.max(0, Math.min(Math.pow((radius - 0.5) / 6.5, 1.4), 1.0));
        this.visibleBoxes  = Math.round(BOX_SLOTS   * fraction);
        this.visibleFlats  = Math.round(FLAT_SLOTS  * fraction);
        this.visibleChunks = Math.round(CHUNK_SLOTS * fraction);
    }

    /**
     * Set radius instantly without lerp — used when creating a new mesh so it
     * appears at the correct size on the very first frame.
     */
    setRadiusImmediate(radius: number): void {
        this.baseRadius = radius;
        this.targetRadius = radius;
        this.setRadius(radius);
    }

    /**
     * Enable or disable the spawn-protection / safe-zone shield glow.
     * When enabled the tornado flashes with a green aura.
     * When disabled the shield mesh and light are immediately hidden.
     */
    setProtected(value: boolean): void {
        this.isProtected = value;
        if (!value) {
            this.shieldMesh.visible = false;
            this.shieldLight.intensity = 0;
        }
    }

    /**
     * Mark this tornado as AFK or active.
     * When `afk` is true the funnel fades to 40 % opacity over ~1 second.
     * When `afk` is false it returns to full opacity over ~1 second.
     * Call every frame from the render loop, mirroring the pattern used by
     * `setProtected()` and `setBoosting()`.
     */
    setAfk(afk: boolean): void {
        this.isAfk = afk;
    }

    setPosition(x: number, y: number): void {
        this.group.position.set(x, 0, y);
    }

    dispose(): void {
        this.coreGeo.dispose();
        (this.coreMesh.material as THREE.Material).dispose();

        this.debris.geometry.dispose();
        (this.debris.material as THREE.Material).dispose();

        this.dustRing.geometry.dispose();
        (this.dustRing.material as THREE.Material).dispose();

        this.fluffyClouds.geometry.dispose();
        (this.fluffyClouds.material as THREE.Material).dispose();

        this.shadowMesh.geometry.dispose();
        (this.shadowMesh.material as THREE.Material).dispose();

        this.shadowMeshOuter.geometry.dispose();
        (this.shadowMeshOuter.material as THREE.Material).dispose();

        this.boxDebris.geometry.dispose();
        (this.boxDebris.material as THREE.Material).dispose();
        this.boxDebris.dispose();

        this.flatDebris.geometry.dispose();
        (this.flatDebris.material as THREE.Material).dispose();
        this.flatDebris.dispose();

        this.chunkDebris.geometry.dispose();
        (this.chunkDebris.material as THREE.Material).dispose();
        this.chunkDebris.dispose();

        this.shieldMesh.geometry.dispose();
        (this.shieldMesh.material as THREE.Material).dispose();
        this.shieldLight.dispose();

        this.trailPoints.geometry.dispose();
        (this.trailPoints.material as THREE.Material).dispose();
        this.trailParticles.length = 0;

        // Vehicle meshes share a static material — only dispose geometry
        for (const vm of this.vehicleMeshes) {
            vm.geometry.dispose();
        }
        this.vehicleMeshes.length = 0;

        this._decayPoints.geometry.dispose();
        (this._decayPoints.material as THREE.Material).dispose();
        this._decayParticles.length = 0;

        this.flashLight.dispose();
    }
}
