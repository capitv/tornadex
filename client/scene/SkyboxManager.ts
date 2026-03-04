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

    // Billboard: expand the quad toward camera right/up
    // position.x and position.y are -0.5..0.5 from PlaneGeometry
    vec3 worldCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
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
// Passes UVs and world-space position to the fragment shader.
// The sphere is rendered with depthWrite=false so it always sits
// behind everything, and we disable fog on it manually.
const skyVertexShader = `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
    vUv = uv;
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    // Always render at maximum depth
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    // Push to far plane so it never occludes geometry
    gl_Position.z = gl_Position.w;
}
`;

// ---- Fragment Shader -----------------------------------------------
// Cheap layered noise that approximates animated storm clouds.
// Two octaves of value noise scrolled at different speeds/directions
// give a convincing cloud-bank feel without being expensive.
const skyFragmentShader = `
uniform float uTime;
uniform float uLightningFlash;    // 0..1, added as bright white flash
uniform vec3  uHorizonColor;      // fog-matching horizon colour
uniform vec3  uZenithColor;       // darker overhead colour

varying vec2 vUv;
varying vec3 vWorldPos;

// --- Cheap hash-based value noise ---
float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
        v   += amp * valueNoise(p);
        p   *= 2.1;
        amp *= 0.5;
    }
    return v;
}

void main() {
    // Vertical gradient: zenith (top of sphere) -> horizon (equator)
    // vUv.y == 1 at north pole, 0 at equator on a SphereGeometry
    float horizon = 1.0 - clamp(vUv.y * 1.8, 0.0, 1.0);

    // --- Cloud layer 1: large slow banks scrolling left --
    vec2 uv1 = vUv * vec2(3.5, 1.8) + vec2(-uTime * 0.008, uTime * 0.003);
    float cloud1 = fbm(uv1);

    // --- Cloud layer 2: smaller faster wisps scrolling right --
    vec2 uv2 = vUv * vec2(6.0, 3.0) + vec2(uTime * 0.012, -uTime * 0.006);
    float cloud2 = fbm(uv2);

    // Combine and threshold to get solid dark cloud patches
    float clouds = cloud1 * 0.7 + cloud2 * 0.3;
    clouds = smoothstep(0.38, 0.72, clouds);     // dark => 0, bright => 1

    // Clouds are slightly lighter for a less oppressively dark sky
    vec3 cloudDark  = mix(vec3(0.16, 0.19, 0.23), vec3(0.24, 0.28, 0.33), horizon);
    vec3 cloudLight = mix(vec3(0.28, 0.32, 0.38), vec3(0.36, 0.40, 0.45), horizon);
    vec3 cloudColor = mix(cloudDark, cloudLight, clouds);

    // Sky gradient behind the clouds
    vec3 skyColor = mix(uZenithColor, uHorizonColor, horizon);

    // Mix sky + clouds (clouds cover most of the sky for storm look)
    float cloudCoverage = clamp(clouds * 1.4 + 0.3, 0.0, 1.0);
    vec3 color = mix(skyColor, cloudColor, cloudCoverage);

    // Lightning flash: pure white/blue-white tint over the whole sky
    color = mix(color, vec3(0.85, 0.92, 1.0), uLightningFlash * 0.75);

    // Smooth fade at the very bottom — use a gentler curve so the horizon
    // colour extends further down and there is no visible dark band.
    float fadeBottom = clamp(vUv.y * 2.5, 0.0, 1.0);
    fadeBottom = fadeBottom * fadeBottom; // ease-in for smoother blend
    color = mix(uHorizonColor, color, fadeBottom);

    gl_FragColor = vec4(color, 1.0);
}
`;

// ---- Lightning bolt geometry helper --------------------------------
// Builds a jagged line from sky to ground with a few random jogs.
// Returns a THREE.Line. Call dispose() on geometry + material when done.
function buildLightningBolt(
    x: number,
    z: number,
    topY: number,
    seed: number
): THREE.Line {
    const segments = 12;
    const points: THREE.Vector3[] = [];
    const rng = (n: number) => Math.abs(Math.sin(seed * 127.1 + n * 311.7) * 43758.5453) % 1;

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const y = topY * (1 - t);
        const jitter = (1 - t) * 2.5; // wilder near top, straighter near ground
        const bx = x + (rng(i * 2) - 0.5) * jitter;
        const bz = z + (rng(i * 2 + 1) - 0.5) * jitter;
        points.push(new THREE.Vector3(bx, y, bz));
    }

    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
        color: 0xd0e8ff,
        transparent: true,
        opacity: 1.0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    return new THREE.Line(geo, mat);
}

// ---- Strike descriptor --------------------------------------------
interface LightningStrike {
    bolt: THREE.Line;
    light: THREE.PointLight;
    phase: 'flash1' | 'dark' | 'flash2' | 'done';
    elapsed: number;
    // Phase durations in milliseconds
    flash1Duration: number;
    darkDuration: number;
    flash2Duration: number;
}

// ---- Cloud billboard descriptor -----------------------------------
interface CloudBillboard {
    mesh: THREE.Mesh;
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
    // Reusable scratch vectors for the billboard update uniforms
    private _camRight  = new THREE.Vector3();
    private _camUp     = new THREE.Vector3();

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        const horizonColor = new THREE.Color(0x3d4b57);
        const zenithColor  = new THREE.Color(0x263545);

        this.skyMat = new THREE.ShaderMaterial({
            vertexShader:   skyVertexShader,
            fragmentShader: skyFragmentShader,
            uniforms: {
                uTime:          { value: 0 },
                uLightningFlash:{ value: 0 },
                uHorizonColor:  { value: horizonColor },
                uZenithColor:   { value: zenithColor },
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

        // Advance shader time (seconds, slow)
        this.skyMat.uniforms.uTime.value = this.elapsed * 0.001;

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
                // Cleanup
                this.scene.remove(s.bolt);
                this.scene.remove(s.light);
                (s.bolt.geometry as THREE.BufferGeometry).dispose();
                (s.bolt.material as THREE.Material).dispose();
                s.light.dispose();
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
        // Pick a random position in the world (above the cloud ceiling ~45-80 units)
        const spread = this.worldHalfSize * 0.9;
        const bx = this.worldCenter.x + (Math.random() - 0.5) * spread * 2;
        const bz = this.worldCenter.z + (Math.random() - 0.5) * spread * 2;
        const topY = 45 + Math.random() * 35;

        const seed = Math.random() * 1000;
        const bolt = buildLightningBolt(bx, bz, topY, seed);
        bolt.renderOrder = 10;
        this.scene.add(bolt);

        // Point light at bolt origin
        const light = new THREE.PointLight(0xaad4ff, 8, 300);
        light.position.set(bx, topY * 0.5, bz);
        this.scene.add(light);

        const strike: LightningStrike = {
            bolt,
            light,
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
        // Per-cloud variation is baked into BufferGeometry attributes.
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
        // The vertex shader scales it using the per-vertex aSize attribute.
        const planeGeo = new THREE.PlaneGeometry(1, 1);

        // Deterministic seeded RNG so the cloud layout is stable across hot-reloads.
        let seed = 42;
        const rng = (): number => {
            seed = (seed * 16807 + 0) % 2147483647;
            return (seed - 1) / 2147483646;
        };

        const SPREAD_RADIUS = 650; // half-width of the cloud field around origin

        for (let i = 0; i < COUNT; i++) {
            // Each billboard gets its own BufferGeometry clone so we can embed
            // per-instance attributes (aSize, aOpacity, aTimeOffset) without
            // needing an InstancedMesh.  The geometry is tiny (4 verts) so the
            // overhead is negligible for 40 meshes.
            const geo = planeGeo.clone();

            const vertexCount = geo.attributes.position.count; // 4 for PlaneGeometry

            // aSize: half-size in world units — billboard spans 2×aSize
            const cloudSize = 20 + rng() * 40; // 20..60 world units wide
            const sizeAttr  = new Float32Array(vertexCount).fill(cloudSize);
            geo.setAttribute('aSize', new THREE.BufferAttribute(sizeAttr, 1));

            // aOpacity: 0.1..0.3 — clouds are subtle, not solid
            const opacity     = 0.10 + rng() * 0.20;
            const opacityAttr = new Float32Array(vertexCount).fill(opacity);
            geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacityAttr, 1));

            // aTimeOffset: randomises each cloud's FBM wobble phase
            const timeOff    = rng() * 100.0;
            const timeAttr   = new Float32Array(vertexCount).fill(timeOff);
            geo.setAttribute('aTimeOffset', new THREE.BufferAttribute(timeAttr, 1));

            const mesh = new THREE.Mesh(geo, this.cloudMaterial);
            mesh.renderOrder = 1; // draw on top of the skybox sphere (renderOrder -1)
            mesh.frustumCulled = false; // billboards can be outside normal frustum planes

            // Random world-space position:
            //   X, Z — scattered in a disc of radius SPREAD_RADIUS around origin
            //   Y    — between 45 and 55 (above the cloud ceiling / tornado tops)
            const angle = rng() * Math.PI * 2;
            const r     = Math.sqrt(rng()) * SPREAD_RADIUS; // sqrt for uniform disc distribution
            const wx    = Math.cos(angle) * r;
            const wy    = 45 + rng() * 10;  // Y=45..55
            const wz    = Math.sin(angle) * r;

            mesh.position.set(wx, wy, wz);
            this.scene.add(mesh);

            // Per-cloud wind: mostly blowing in +X with a gentle Z component.
            // Heights nearer Y=55 drift slightly faster for a subtle parallax feel.
            const heightFrac = (wy - 45) / 10; // 0..1
            const windX = 2.0 + rng() * 3.0 + heightFrac * 1.5; // 2..6.5 units/s
            const windZ = (rng() - 0.5) * 1.5;                   // ±0.75 units/s

            this.clouds.push({ mesh, windX, windZ, wx, wy, wz });
        }

        planeGeo.dispose(); // original template no longer needed
    }

    // ================================================================
    // Cloud billboard update — called from update() each frame
    // ================================================================
    updateClouds(cameraX: number, cameraZ: number, dtSec: number, camera: THREE.Camera): void {
        if (!this.cloudMaterial) return;

        // Extract camera right/up vectors for the billboard vertex shader.
        // These are the first and second columns of the view matrix inverse (= camera matrix).
        camera.updateMatrixWorld(false);
        this._camRight.setFromMatrixColumn(camera.matrixWorld, 0); // column 0 = right
        this._camUp.setFromMatrixColumn(camera.matrixWorld, 1);    // column 1 = up

        this.cloudMaterial.uniforms.uCameraRight.value.copy(this._camRight);
        this.cloudMaterial.uniforms.uCameraUp.value.copy(this._camUp);
        this.cloudMaterial.uniforms.uTime.value = this.elapsed * 0.001;

        // Wrap distance: clouds that drift more than this many units from the
        // camera in X or Z are teleported to the opposite side.
        const WRAP = 700;

        for (const c of this.clouds) {
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

            c.mesh.position.set(c.wx, c.wy, c.wz);
        }
    }

    dispose(): void {
        this.skyMesh.geometry.dispose();
        this.skyMat.dispose();
        this.scene.remove(this.skyMesh);
        for (const s of this.strikes) {
            this.scene.remove(s.bolt);
            this.scene.remove(s.light);
            (s.bolt.geometry as THREE.BufferGeometry).dispose();
            (s.bolt.material as THREE.Material).dispose();
            s.light.dispose();
        }
        this.strikes = [];

        // Dispose cloud billboards
        for (const c of this.clouds) {
            this.scene.remove(c.mesh);
            c.mesh.geometry.dispose();
        }
        this.clouds = [];
        if (this.cloudMaterial) {
            this.cloudMaterial.dispose();
            this.cloudMaterial = null;
        }
    }
}
