// ============================================
// PowerUpRenderer — Floating glowing orbs for power-ups
// ============================================
//
// Each active power-up is rendered as:
//   - A sphere mesh with emissive colour (blue/green/yellow)
//   - A PointLight for a local glow halo
//   - A sine-wave Y animation (bobbing)
//   - A slow Y-axis rotation on the sphere
//
// Collected (inactive) power-ups are hidden instantly.
// ============================================

import * as THREE from 'three';
import type { PowerUp, PowerUpType } from '../../shared/types.js';

// Visual config per type
const TYPE_CONFIG: Record<PowerUpType, { color: number; emissive: number; lightIntensity: number }> = {
    speed:  { color: 0x42a5f5, emissive: 0x1565c0, lightIntensity: 1.8 },  // blue
    growth: { color: 0x66bb6a, emissive: 0x1b5e20, lightIntensity: 1.8 },  // green
    shield: { color: 0xffd54f, emissive: 0xe65100, lightIntensity: 2.0 },  // golden yellow
};

// How high the orb floats above the ground baseline
const BASE_HEIGHT = 2.5;
// Amplitude of the bobbing sine wave (world units)
const BOB_AMPLITUDE = 0.4;
// Speed of the bobbing oscillation (radians per second)
const BOB_SPEED = 1.5;
// Sphere radius
const ORB_RADIUS = 0.7;

interface OrbEntry {
    group: THREE.Group;
    mesh: THREE.Mesh;
    light: THREE.PointLight;
    groundElevation: number;
    // Per-orb phase offset so all orbs don't bob in sync
    phaseOffset: number;
}

export class PowerUpRenderer {
    private scene: THREE.Scene;
    // Map from power-up id → orb entry
    private orbs: Map<number, OrbEntry> = new Map();

    constructor(scene: THREE.Scene) {
        this.scene = scene;
    }

    /**
     * Synchronise the visible orbs with the current power-up state snapshot.
     * Called on every game:state event from the server.
     */
    update(powerUps: PowerUp[]): void {
        const activeIds = new Set<number>();

        for (const pu of powerUps) {
            if (!pu.active) {
                // Collected — hide if we were showing it
                const orb = this.orbs.get(pu.id);
                if (orb) {
                    orb.group.visible = false;
                }
                continue;
            }

            activeIds.add(pu.id);

            let orb = this.orbs.get(pu.id);

            if (!orb) {
                // First time we see this power-up — create the 3D orb
                orb = this.createOrb(pu.id, pu.type, pu.x, pu.y);
            }

            // Ensure it's visible and positioned correctly
            orb.group.visible = true;
        }

        // Remove orbs for power-up IDs that are no longer in the list
        // (shouldn't normally happen, but guards against server restarts)
        for (const [id, orb] of this.orbs) {
            if (!powerUps.some(p => p.id === id)) {
                this.scene.remove(orb.group);
                orb.mesh.geometry.dispose();
                (orb.mesh.material as THREE.Material).dispose();
                this.orbs.delete(id);
            }
        }
    }

    /**
     * Animate all visible orbs. Call once per frame with elapsed seconds.
     */
    animate(timeSec: number): void {
        for (const orb of this.orbs.values()) {
            if (!orb.group.visible) continue;

            // Bob up and down
            const y = orb.groundElevation + BASE_HEIGHT
                + Math.sin(timeSec * BOB_SPEED + orb.phaseOffset) * BOB_AMPLITUDE;
            orb.group.position.y = y;

            // Spin slowly around Y
            orb.mesh.rotation.y = timeSec * 1.2 + orb.phaseOffset;

            // Pulse the light intensity slightly
            orb.light.intensity = TYPE_CONFIG[orb.mesh.userData.type as PowerUpType].lightIntensity
                * (0.85 + 0.15 * Math.sin(timeSec * 2.5 + orb.phaseOffset));
        }
    }

    /** Remove all orbs from the scene (e.g. on disconnect / game reset). */
    dispose(): void {
        for (const orb of this.orbs.values()) {
            this.scene.remove(orb.group);
            orb.mesh.geometry.dispose();
            (orb.mesh.material as THREE.Material).dispose();
        }
        this.orbs.clear();
    }

    // ---- Private helpers ----

    private createOrb(id: number, type: PowerUpType, wx: number, wy: number): OrbEntry {
        const cfg = TYPE_CONFIG[type];

        // Sphere
        const geo = new THREE.SphereGeometry(ORB_RADIUS, 16, 12);
        const mat = new THREE.MeshStandardMaterial({
            color: cfg.color,
            emissive: cfg.emissive,
            emissiveIntensity: 0.6,
            roughness: 0.2,
            metalness: 0.4,
            transparent: true,
            opacity: 0.92,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.type = type;
        mesh.castShadow = false;

        // Outer glow ring (a slightly larger transparent sphere)
        const glowGeo = new THREE.SphereGeometry(ORB_RADIUS * 1.35, 12, 10);
        const glowMat = new THREE.MeshBasicMaterial({
            color: cfg.color,
            transparent: true,
            opacity: 0.12,
            side: THREE.BackSide,
            depthWrite: false,
        });
        const glowMesh = new THREE.Mesh(glowGeo, glowMat);

        // Point light for environmental glow
        const light = new THREE.PointLight(cfg.color, cfg.lightIntensity, 12);

        const group = new THREE.Group();
        group.add(mesh);
        group.add(glowMesh);
        group.add(light);

        // Position the group at the world-space XZ position
        // Y will be animated each frame; start at BASE_HEIGHT so it's not at origin
        group.position.set(wx, BASE_HEIGHT, wy);

        this.scene.add(group);

        const entry: OrbEntry = {
            group,
            mesh,
            light,
            groundElevation: 0,       // flat world baseline; refine below if terrain height available
            phaseOffset: (id * 1.618) % (Math.PI * 2),  // golden-ratio spread so orbs desync
        };

        this.orbs.set(id, entry);
        return entry;
    }
}
