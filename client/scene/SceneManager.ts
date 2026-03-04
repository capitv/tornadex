// ============================================
// Scene Manager — Three.js Setup, Camera, Lights
// ============================================

import * as THREE from 'three';
import { SkyboxManager } from './SkyboxManager.js';
import { getGraphicsPreset, onGraphicsChange } from '../settings/GraphicsConfig.js';

export class SceneManager {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;

    // Smoothed camera state (avoids jitter)
    private camPos: THREE.Vector3 = new THREE.Vector3(0, 10, 30);
    private camLookAt: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

    // Scratch vectors reused every frame in setCameraOffset (avoids per-frame allocation)
    private _targetPos = new THREE.Vector3();
    private _targetLook = new THREE.Vector3();

    // Lights exposed so SkyboxManager can modulate them during flashes
    ambientLight: THREE.AmbientLight;
    dirLight: THREE.DirectionalLight;

    // Skybox + lightning system
    skybox: SkyboxManager;

    // Reference to the canvas element so we can recreate the renderer on it
    private canvas: HTMLCanvasElement;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;

        // Scene — background matches fog/horizon as fallback behind the skybox
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x3d4b57);

        // Apply initial fog from preset
        const preset = getGraphicsPreset();
        this.scene.fog = new THREE.Fog(0x3d4b57, 100, preset.fogFar);

        // Camera — low angle perspective (showing horizon)
        this.camera = new THREE.PerspectiveCamera(
            55,
            window.innerWidth / window.innerHeight,
            0.1,
            1200
        );
        this.camera.position.copy(this.camPos);
        this.setCameraOffset(0, 0, 1);

        // Renderer — built from current preset
        this.renderer = this.createRenderer(preset.antialias);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(preset.pixelRatio);

        // Shadow quality
        this.renderer.shadowMap.enabled = preset.shadows;
        if (preset.shadows) {
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        }

        // Lighting
        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(this.ambientLight);

        this.dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
        this.dirLight.position.set(100, 150, 50);
        this.dirLight.castShadow = preset.shadows;
        if (preset.shadows) {
            this.dirLight.shadow.mapSize.width = 2048;
            this.dirLight.shadow.mapSize.height = 2048;
            this.dirLight.shadow.camera.near = 1;
            this.dirLight.shadow.camera.far = 500;
            this.dirLight.shadow.camera.left = -300;
            this.dirLight.shadow.camera.right = 300;
            this.dirLight.shadow.camera.top = 300;
            this.dirLight.shadow.camera.bottom = -300;
        }
        this.scene.add(this.dirLight);

        const hemiLight = new THREE.HemisphereLight(0x88aacc, 0x445533, 0.4);
        this.scene.add(hemiLight);

        // Skybox (must be added AFTER scene is set up)
        this.skybox = new SkyboxManager(this.scene);
        this.skybox.setLights(this.ambientLight, this.dirLight);

        // Resize
        window.addEventListener('resize', () => this.onResize());

        // React to graphics quality changes
        onGraphicsChange((newPreset) => {
            this.applyPreset(newPreset);
        });
    }

    // ---- Renderer helpers ----

    private createRenderer(antialias: boolean): THREE.WebGLRenderer {
        return new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias,
            powerPreference: 'high-performance',
        });
    }

    /**
     * Apply a new preset.  Because `antialias` is a constructor-only option we
     * must dispose and recreate the renderer when it changes.  All other
     * settings are applied in-place.
     */
    private applyPreset(preset: ReturnType<typeof getGraphicsPreset>): void {
        const needsRecreate = this.renderer.getContextAttributes()?.antialias !== preset.antialias;

        if (needsRecreate) {
            // Dispose old renderer and create a fresh one
            this.renderer.dispose();
            this.renderer = this.createRenderer(preset.antialias);
        }

        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(preset.pixelRatio);
        this.renderer.shadowMap.enabled = preset.shadows;
        if (preset.shadows) {
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        }

        // Update shadow casting on directional light
        this.dirLight.castShadow = preset.shadows;

        // Update fog draw distance
        if (this.scene.fog instanceof THREE.Fog) {
            this.scene.fog.far = preset.fogFar;
        }
    }

    setCameraOffset(x: number, y: number, radius: number): void {
        // Camera scales gently with size using a mix of log and linear
        // Allow higher scale capping so F5 can actually zoom out fully
        const clampedR = Math.min(radius, 25);

        // dist: Starts at 30, grows logarithmically early on, then aggressively linearly for huge wedges
        const dist = 30 + Math.log2(1 + clampedR) * 10 + (clampedR > 2 ? (clampedR - 2) * 15 : 0);

        // height: Must grow aggressively for large tornados so we look DOWN at them, avoiding cloud clipping
        const height = 9 + Math.log2(1 + clampedR) * 6 + (clampedR > 2 ? (clampedR - 2) * 12 : 0);

        this._targetPos.set(
            x - dist * 0.15,
            height,
            y + dist * 0.85
        );

        // Look-at height: Scales tightly with the tornado so we don't look completely over it
        const lookHeight = 2 + clampedR * 3.0;
        this._targetLook.set(x, lookHeight, y);

        // Smooth both position AND lookAt with very gentle lerp
        // This eliminates the "snapping" that causes background trembling
        this.camPos.lerp(this._targetPos, 0.04);
        this.camLookAt.lerp(this._targetLook, 0.04);

        // Apply smoothed values
        this.camera.position.copy(this.camPos);
        this.camera.lookAt(this.camLookAt);
    }

    // Called every frame from main.ts
    update(dtMs: number): void {
        // Keep the skybox sphere centred on the camera so the horizon is always correct
        this.skybox.followCamera(this.camera.position);
        this.skybox.update(dtMs);
        // Update cloud billboard positions and billboard orientation uniforms
        this.skybox.updateClouds(
            this.camera.position.x,
            this.camera.position.z,
            dtMs * 0.001,  // convert ms → seconds
            this.camera
        );
    }

    render(): void {
        this.renderer.render(this.scene, this.camera);
    }

    private onResize(): void {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }
}
