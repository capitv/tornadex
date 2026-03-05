// ============================================
// Skybox Manager — Animated Stormy Sky + Lightning System
// ============================================

import * as THREE from 'three';

// ---- Cloud Billboard Vertex Shader ------------------------------------
// Billboards are PlaneGeometry meshes. We override the position in the
// vertex shader to always face the camera (spherical billboarding) so we
// never need to call lookAt() per frame in JS.
const cloudVertexShader = `
uniform vec3  uCameraRight;   // camera's right vector in world space
uniform vec3  uCameraUp;      // camera's up vector in world space

attribute float aSize;        // per-instance half-size
attribute float aOpacity;     // per-instance opacity
attribute float aTimeOffset;  // per-instance phase offset for subtle wobble

varying float vOpacity;
varying vec2  vUv;
varying float vTimeOffset;

void main() {
    vUv          = uv;
    vOpacity     = aOpacity;
    vTimeOffset  = aTimeOffset;

    // With InstancedMesh the instance transform is in instanceMatrix.
    // We extract the world-space centre from column 3 of the instance matrix.
    vec3 worldCenter = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);

    // Billboard: expand the quad toward camera right/up
    // position.x and position.y are -0.5..0.5 from PlaneGeometry
    vec3 worldPos    = worldCenter
                     + uCameraRight * position.x * aSize
                     + uCameraUp    * position.y * aSize;

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

// ---- Cloud Billboard Fragment Shader ----------------------------------
// Draws a procedural soft cloud puff using layered smoothstep circles.
// The result is an alpha-masked blob — no textures required.
const cloudFragmentShader = `
uniform float uTime;

varying float vOpacity;
varying vec2  vUv;
varying float vTimeOffset;

// Cheap 2-D hash
float hash2(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float valueNoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbmCloud(vec2 p) {
    float v   = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 3; i++) {
        v   += amp * valueNoise2(p);
        p   *= 2.1;
        amp *= 0.48;
    }
    return v;
}

void main() {
    // Centre the UV so (0,0) is the middle of the quad
    vec2 centred = vUv - 0.5;

    // Radial falloff: solid centre, soft feathered edge
    float dist = length(centred) * 2.0;   // 0 at centre, 1 at corner
    float radial = 1.0 - smoothstep(0.3, 1.0, dist);

    // Slow FBM wobble to break up the circular silhouette
    float t   = uTime * 0.04 + vTimeOffset;
    vec2 uvN  = centred * 2.8 + vec2(t * 0.3, t * 0.15);
    float noise = fbmCloud(uvN);

    // Combine radial mask with FBM edge distortion
    float shape = radial * smoothstep(0.25, 0.65, noise + radial * 0.5);

    // Soft cloud colour: near-white with a subtle cool/grey tint
    vec3 cloudCol = mix(vec3(0.55, 0.60, 0.65), vec3(0.82, 0.86, 0.90), shape);

    float alpha = shape * vOpacity;
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(cloudCol, alpha);
}
`;

// ---- Vertex Shader ------------------------------------------------
// Passes the local-space elevation (-1..+1) to the fragment shader.
// Using local position.y (sphere normal Y) avoids UV seam artifacts
// at the poles and gives a perfectly smooth gradient.
const skyVertexShader = `
varying float vElevation; // -1 = straight down, 0 = horizon, +1 = straight up

void main() {
    // normalize(position).y == position.y for a unit sphere
    vElevation = normalize(position).y;

    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    // Push to far plane so sky never occludes geometry
    gl_Position.z = gl_Position.w;
}
`;

// ---- Fragment Shader -----------------------------------------------
// Clean gradient sky using sphere elevation (no UV seam artifacts).
// vElevation passed from vertex shader: 0=horizon, +1=zenith, -1=underground.
const skyFragmentShader = `
uniform float uLightningFlash;
uniform vec3  uHorizonColor;
uniform vec3  uZenithColor;

varying float vElevation;

void main() {
    // t: 0 at/below horizon, 1 at zenith — ease-in so colour stays near horizon longer
    float t = clamp(vElevation, 0.0, 1.0);
    t = t * t;

    vec3 color = mix(uHorizonColor, uZenithColor, t);

    // Lightning flash
    color = mix(color, vec3(0.85, 0.92, 1.0), uLightningFlash * 0.75);

    gl_FragColor = vec4(color, 1.0);
}
`;

// ---- Lightning bolt geometry pool -----------------------------------
// Pre-allocated pool of bolt Line objects to avoid per-strike allocation.
const BOLT_SEGMENTS = 12;
const BOLT_POOL_SIZE = 3;

/** Update a pooled bolt's geometry with new jagged line positions. */
function updateBoltGeometry(
    bolt: THREE.Line,
    x: number,
    z: number,
    topY: number,
    seed: number
): void {
    const rng = (n: number) => Math.abs(Math.sin(seed * 127.1 + n * 311.7) * 43758.5453) % 1;
    const posAttr = bolt.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
        const t = i / BOLT_SEGMENTS;
        const y = topY * (1 - t);
        const jitter = (1 - t) * 2.5;
        const bx = x + (rng(i * 2) - 0.5) * jitter;
        const bz = z + (rng(i * 2 + 1) - 0.5) * jitter;
        posAttr.setXYZ(i, bx, y, bz);
    }
    posAttr.needsUpdate = true;
    bolt.geometry.computeBoundingSphere();
}

/** Create the fixed-size pool of bolt Line objects (hidden initially). */
function createBoltPool(scene: THREE.Scene): THREE.Line[] {
    const pool: THREE.Line[] = [];
    const templatePoints: THREE.Vector3[] = [];
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
        templatePoints.push(new THREE.Vector3(0, -9999, 0));
    }
    for (let b = 0; b < BOLT_POOL_SIZE; b++) {
        const geo = new THREE.BufferGeometry().setFromPoints(templatePoints);
        const mat = new THREE.LineBasicMaterial({
            color: 0xd0e8ff,
            transparent: true,
            opacity: 1.0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        const line = new THREE.Line(geo, mat);
        line.visible = false;
        line.renderOrder = 10;
        scene.add(line);
        pool.push(line);
    }
    return pool;
}

// ---- Strike descriptor --------------------------------------------
interface LightningStrike {
    bolt: THREE.Line;
    boltIndex: number;       // index into the bolt pool for returning on completion
    light: THREE.PointLight;
    lightIndex: number;      // index into the light pool for returning on completion
    phase: 'flash1' | 'dark' | 'flash2' | 'done';
    elapsed: number;
    // Phase durations in milliseconds
    flash1Duration: number;
    darkDuration: number;
    flash2Duration: number;
}

// ---- Cloud billboard descriptor -----------------------------------
interface CloudBillboard {
    // Wind drift velocity (world units / second)
    windX: number;
    windZ: number;
    // Current world-space position (we track it separately so wrap is cheap)
    wx: number;
    wy: number;
    wz: number;
}

// ====================================================================
// SkyboxManager
// ====================================================================
export class SkyboxManager {
    private skyMesh: THREE.Mesh;
    private skyMat: THREE.ShaderMaterial;

    // Scene reference (to add/remove bolt geometry and lights)
    private scene: THREE.Scene;

    // Lights that the lightning modulates (set from SceneManager)
    ambientLight!: THREE.AmbientLight;
    dirLight!: THREE.DirectionalLight;

    // Lightning state
    private strikes: LightningStrike[] = [];
    private nextStrikeIn: number = 5000 + Math.random() * 8000; // ms until first strike
    private elapsed: number = 0;

    // Pre-allocated bolt pool (geometry+material+line reused across strikes)
    private boltPool: THREE.Line[] = [];
    private boltAvailable: boolean[] = [];  // true = slot is free
    // Pre-allocated light pool for lightning strikes
    private lightPool: THREE.PointLight[] = [];
    private lightAvailable: boolean[] = [];

    // How large the biggest tornado in the scene is (drives frequency)
    private maxTornadoRadius: number = 1;

    // Base ambient intensity stored so we can restore after flash
    private baseAmbientIntensity: number = 0.4;
    private baseDirIntensity: number = 1.2;

    // Scene center / world size for placing bolts
    private worldCenter: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    private worldHalfSize: number = 1000;

    // ---- Cloud billboard system ----
    private clouds: CloudBillboard[] = [];
    private cloudMaterial: THREE.ShaderMaterial | null = null;
    private cloudInstancedMesh: THREE.InstancedMesh | null = null;
    // Reusable scratch objects for the billboard update
    private _camRight  = new THREE.Vector3();
    private _camUp     = new THREE.Vector3();
    private _tmpMatrix = new THREE.Matrix4();

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        // Horizon = same as scene fog (0x3d4b57) for seamless blend
        // Zenith = moderately darker grey — stormy but not pitch black
        const horizonColor = new THREE.Color(0x3d4b57);
        const zenithColor  = new THREE.Color(0x232c36);

        this.skyMat = new THREE.ShaderMaterial({
            vertexShader:   skyVertexShader,
            fragmentShader: skyFragmentShader,
            uniforms: {
                uLightningFlash: { value: 0 },
                uHorizonColor:   { value: horizonColor },
                uZenithColor:    { value: zenithColor },
            },
            side:       THREE.BackSide,   // render inside of sphere
            depthWrite: false,
            fog:        false,
        });

        // Large sphere — radius slightly inside the far-clip plane (1200)
        // so the camera always sits inside it.
        const skyGeo  = new THREE.SphereGeometry(1100, 32, 20);
        this.skyMesh  = new THREE.Mesh(skyGeo, this.skyMat);
        // Render before everything else (no depth fighting)
        this.skyMesh.renderOrder = -1;
        scene.add(this.skyMesh);

        // Pre-allocate lightning bolt + light pools
        this.boltPool = createBoltPool(scene);
        this.boltAvailable = new Array(BOLT_POOL_SIZE).fill(true);
        this.lightPool = [];
        this.lightAvailable = [];
        for (let i = 0; i < BOLT_POOL_SIZE; i++) {
            const light = new THREE.PointLight(0xaad4ff, 0, 300);
            light.visible = false;
            scene.add(light);
            this.lightPool.push(light);
            this.lightAvailable.push(true);
        }

        // Spawn the volumetric cloud billboard layer
        this.initClouds();
    }

    // Called by SceneManager after construction so we can modulate lights
    setLights(ambient: THREE.AmbientLight, dir: THREE.DirectionalLight): void {
        this.ambientLight = ambient;
        this.dirLight     = dir;
        this.baseAmbientIntensity = ambient.intensity;
        this.baseDirIntensity     = dir.intensity;
    }

    // Called once we know world size / center so bolts land in-bounds
    setWorldBounds(centerX: number, centerZ: number, halfSize: number): void {
        this.worldCenter.set(centerX, 0, centerZ);
        this.worldHalfSize = halfSize;
    }

    // Called every frame from main.ts with the largest live tornado radius
    setMaxTornadoRadius(r: number): void {
        this.maxTornadoRadius = r;
    }

    update(dtMs: number): void {
        this.elapsed += dtMs;

        // ---- countdown to next strike ----
        this.nextStrikeIn -= dtMs;
        if (this.nextStrikeIn <= 0) {
            this.triggerStrike();
            // Larger tornadoes => more frequent lightning (5-15s range)
            const frequencyFactor = Math.max(0.2, 1.0 - this.maxTornadoRadius * 0.06);
            const baseInterval = 5000 + Math.random() * 10000;
            this.nextStrikeIn = baseInterval * frequencyFactor;
        }

        // ---- advance active strikes ----
        let flashSum = 0;
        let ambientBoost = 0;

        for (let i = this.strikes.length - 1; i >= 0; i--) {
            const s = this.strikes[i];
            s.elapsed += dtMs;

            let localFlash = 0;

            if (s.phase === 'flash1') {
                const t = s.elapsed / s.flash1Duration;
                // Quick ramp up then decay
                localFlash = Math.max(0, 1.0 - t * 1.5);
                (s.bolt.material as THREE.LineBasicMaterial).opacity = 1 - t;
                s.light.intensity = (1 - t) * 8;

                if (s.elapsed >= s.flash1Duration) {
                    s.phase = 'dark';
                    s.elapsed = 0;
                    s.light.intensity = 0;
                    (s.bolt.material as THREE.LineBasicMaterial).opacity = 0;
                }
            } else if (s.phase === 'dark') {
                localFlash = 0;
                if (s.elapsed >= s.darkDuration) {
                    // Second, dimmer flash (reflection / re-strike)
                    s.phase = 'flash2';
                    s.elapsed = 0;
                    (s.bolt.material as THREE.LineBasicMaterial).opacity = 0.6;
                    s.light.intensity = 4;
                }
            } else if (s.phase === 'flash2') {
                const t = s.elapsed / s.flash2Duration;
                localFlash = Math.max(0, 0.5 - t);
                s.light.intensity = (1 - t) * 4;
                (s.bolt.material as THREE.LineBasicMaterial).opacity = 0.6 * (1 - t);

                if (s.elapsed >= s.flash2Duration) {
                    s.phase = 'done';
                }
            } else {
                // Return bolt and light to pool (no dispose — reused next strike)
                s.bolt.visible = false;
                s.light.visible = false;
                s.light.intensity = 0;
                this.boltAvailable[s.boltIndex] = true;
                this.lightAvailable[s.lightIndex] = true;
                this.strikes.splice(i, 1);
                continue;
            }

            flashSum   += localFlash;
            ambientBoost += localFlash * 0.35;
        }

        // Accumulate flash contributions (clamped)
        const totalFlash = Math.min(flashSum, 1.0);
        this.skyMat.uniforms.uLightningFlash.value = totalFlash;

        // Modulate scene lights so the whole world brightens
        if (this.ambientLight) {
            this.ambientLight.intensity = this.baseAmbientIntensity + ambientBoost;
        }
        if (this.dirLight) {
            this.dirLight.intensity = this.baseDirIntensity + totalFlash * 1.5;
        }

        // Keep sky centred on camera (no parallax — it's infinitely far away)
        // We move it every frame via the main loop since camera position changes
    }

    // Follow camera so the horizon is always in the right place.
    followCamera(cameraPosition: THREE.Vector3): void {
        this.skyMesh.position.copy(cameraPosition);
    }

    private triggerStrike(): void {
        // Find a free bolt slot from the pool
        let boltIdx = -1;
        for (let i = 0; i < BOLT_POOL_SIZE; i++) {
            if (this.boltAvailable[i]) { boltIdx = i; break; }
        }
        if (boltIdx === -1) return; // all pool slots in use, skip this strike

        // Find a free light slot from the pool
        let lightIdx = -1;
        for (let i = 0; i < BOLT_POOL_SIZE; i++) {
            if (this.lightAvailable[i]) { lightIdx = i; break; }
        }
        if (lightIdx === -1) return;

        // Pick a random position in the world (above the cloud ceiling ~45-80 units)
        const spread = this.worldHalfSize * 0.9;
        const bx = this.worldCenter.x + (Math.random() - 0.5) * spread * 2;
        const bz = this.worldCenter.z + (Math.random() - 0.5) * spread * 2;
        const topY = 45 + Math.random() * 35;

        const seed = Math.random() * 1000;
        const bolt = this.boltPool[boltIdx];
        updateBoltGeometry(bolt, bx, bz, topY, seed);
        bolt.visible = true;
        (bolt.material as THREE.LineBasicMaterial).opacity = 1.0;
        this.boltAvailable[boltIdx] = false;

        // Reuse pooled light
        const light = this.lightPool[lightIdx];
        light.position.set(bx, topY * 0.5, bz);
        light.intensity = 8;
        light.visible = true;
        this.lightAvailable[lightIdx] = false;

        const strike: LightningStrike = {
            bolt,
            boltIndex: boltIdx,
            light,
            lightIndex: lightIdx,
            phase: 'flash1',
            elapsed: 0,
            flash1Duration: 80 + Math.random() * 60,    // 80–140 ms
            darkDuration:   40 + Math.random() * 80,    // 40–120 ms gap
            flash2Duration: 60 + Math.random() * 60,    // 60–120 ms re-flash
        };

        this.strikes.push(strike);
    }

    // ================================================================
    // Cloud billboard initialisation
    // ================================================================
    private initClouds(): void {
        const COUNT = 40; // 30-50 range; 40 is a good balance

        // Shared ShaderMaterial — all clouds use the same program.
        // Per-cloud variation is baked into InstancedBufferAttributes.
        this.cloudMaterial = new THREE.ShaderMaterial({
            vertexShader:   cloudVertexShader,
            fragmentShader: cloudFragmentShader,
            uniforms: {
                uTime:        { value: 0 },
                uCameraRight: { value: new THREE.Vector3(1, 0, 0) },
                uCameraUp:    { value: new THREE.Vector3(0, 1, 0) },
            },
            transparent:  true,
            depthWrite:   false,
            // Normal blending so clouds look soft and semi-opaque (not additive fire-like)
            blending:     THREE.NormalBlending,
            side:         THREE.DoubleSide,
        });

        // Single shared PlaneGeometry (1×1 quad, centred at origin).
        // The vertex shader scales it using the per-instance aSize attribute.
        const planeGeo = new THREE.PlaneGeometry(1, 1);

        // Deterministic seeded RNG so the cloud layout is stable across hot-reloads.
        let seed = 42;
        const rng = (): number => {
            seed = (seed * 16807 + 0) % 2147483647;
            return (seed - 1) / 2147483646;
        };

        const SPREAD_RADIUS = 650; // half-width of the cloud field around origin

        // Pre-allocate per-instance attribute arrays
        const sizes       = new Float32Array(COUNT);
        const opacities   = new Float32Array(COUNT);
        const timeOffsets = new Float32Array(COUNT);

        for (let i = 0; i < COUNT; i++) {
            // aSize: half-size in world units — billboard spans 2×aSize
            sizes[i] = 20 + rng() * 40; // 20..60 world units wide

            // aOpacity: 0.1..0.3 — clouds are subtle, not solid
            opacities[i] = 0.10 + rng() * 0.20;

            // aTimeOffset: randomises each cloud's FBM wobble phase
            timeOffsets[i] = rng() * 100.0;

            // Random world-space position:
            //   X, Z — scattered in a disc of radius SPREAD_RADIUS around origin
            //   Y    — between 45 and 55 (above the cloud ceiling / tornado tops)
            const angle = rng() * Math.PI * 2;
            const r     = Math.sqrt(rng()) * SPREAD_RADIUS; // sqrt for uniform disc distribution
            const wx    = Math.cos(angle) * r;
            const wy    = 35 + rng() * 15;  // Y=35..50 — lower to avoid top clipping
            const wz    = Math.sin(angle) * r;

            // Per-cloud wind: mostly blowing in +X with a gentle Z component.
            // Heights nearer Y=55 drift slightly faster for a subtle parallax feel.
            const heightFrac = (wy - 45) / 10; // 0..1
            const windX = 2.0 + rng() * 3.0 + heightFrac * 1.5; // 2..6.5 units/s
            const windZ = (rng() - 0.5) * 1.5;                   // ±0.75 units/s

            this.clouds.push({ windX, windZ, wx, wy, wz });
        }

        // Attach per-instance attributes to the shared geometry
        planeGeo.setAttribute('aSize',       new THREE.InstancedBufferAttribute(sizes, 1));
        planeGeo.setAttribute('aOpacity',    new THREE.InstancedBufferAttribute(opacities, 1));
        planeGeo.setAttribute('aTimeOffset', new THREE.InstancedBufferAttribute(timeOffsets, 1));

        // Create a single InstancedMesh for all clouds
        const iMesh = new THREE.InstancedMesh(planeGeo, this.cloudMaterial, COUNT);
        iMesh.renderOrder = 1;       // draw on top of the skybox sphere (renderOrder -1)
        iMesh.frustumCulled = false;  // billboards can be outside normal frustum planes

        // Initialise every instance matrix to the cloud's world position (identity rotation, unit scale).
        const mat4 = this._tmpMatrix;
        for (let i = 0; i < COUNT; i++) {
            const c = this.clouds[i];
            mat4.makeTranslation(c.wx, c.wy, c.wz);
            iMesh.setMatrixAt(i, mat4);
        }
        iMesh.instanceMatrix.needsUpdate = true;

        this.cloudInstancedMesh = iMesh;
        this.scene.add(iMesh);
    }

    // ================================================================
    // Cloud billboard update — called from update() each frame
    // ================================================================
    updateClouds(cameraX: number, cameraZ: number, dtSec: number, camera: THREE.Camera): void {
        if (!this.cloudMaterial || !this.cloudInstancedMesh) return;

        // Extract camera right/up vectors for the billboard vertex shader.
        // These are the first and second columns of the view matrix inverse (= camera matrix).
        // Note: camera.matrixWorld is already updated by the main render loop, no need to call updateMatrixWorld here.
        this._camRight.setFromMatrixColumn(camera.matrixWorld, 0); // column 0 = right
        this._camUp.setFromMatrixColumn(camera.matrixWorld, 1);    // column 1 = up

        this.cloudMaterial.uniforms.uCameraRight.value.copy(this._camRight);
        this.cloudMaterial.uniforms.uCameraUp.value.copy(this._camUp);
        this.cloudMaterial.uniforms.uTime.value = this.elapsed * 0.001;

        // Wrap distance: clouds that drift more than this many units from the
        // camera in X or Z are teleported to the opposite side.
        const WRAP = 700;
        const mat4 = this._tmpMatrix;

        for (let i = 0; i < this.clouds.length; i++) {
            const c = this.clouds[i];

            // Drift in wind direction
            c.wx += c.windX * dtSec;
            c.wz += c.windZ * dtSec;

            // Wrap around camera so the field appears infinite
            const dx = c.wx - cameraX;
            const dz = c.wz - cameraZ;

            if (dx >  WRAP) c.wx -= WRAP * 2;
            if (dx < -WRAP) c.wx += WRAP * 2;
            if (dz >  WRAP) c.wz -= WRAP * 2;
            if (dz < -WRAP) c.wz += WRAP * 2;

            // Update instance matrix (translation only — billboard rotation is handled in the shader)
            mat4.makeTranslation(c.wx, c.wy, c.wz);
            this.cloudInstancedMesh.setMatrixAt(i, mat4);
        }

        this.cloudInstancedMesh.instanceMatrix.needsUpdate = true;
    }

    dispose(): void {
        this.skyMesh.geometry.dispose();
        this.skyMat.dispose();
        this.scene.remove(this.skyMesh);
        this.strikes = [];

        // Dispose pooled bolt geometries and materials
        for (const bolt of this.boltPool) {
            this.scene.remove(bolt);
            bolt.geometry.dispose();
            (bolt.material as THREE.Material).dispose();
        }
        this.boltPool = [];
        this.boltAvailable = [];

        // Dispose pooled lights
        for (const light of this.lightPool) {
            this.scene.remove(light);
            light.dispose();
        }
        this.lightPool = [];
        this.lightAvailable = [];

        // Dispose cloud instanced mesh
        if (this.cloudInstancedMesh) {
            this.scene.remove(this.cloudInstancedMesh);
            this.cloudInstancedMesh.geometry.dispose();
            this.cloudInstancedMesh.dispose();
            this.cloudInstancedMesh = null;
        }
        this.clouds = [];
        if (this.cloudMaterial) {
            this.cloudMaterial.dispose();
            this.cloudMaterial = null;
        }
    }
}
