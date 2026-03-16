import * as THREE from 'three';
import { SupercellState } from '../../shared/types.js';

export class SupercellRenderer {
    private scene: THREE.Scene;
    private mesh: THREE.Mesh;
    private material: THREE.MeshBasicMaterial;
    
    // Animate visual rotation
    private rotationSpeed = 0.5; // radians per second
    
    constructor(scene: THREE.Scene) {
        this.scene = scene;

        // Create a large flat cylinder or circle to represent the storm
        // The radius will be updated dynamically based on state
        const geometry = new THREE.CylinderGeometry(1, 1, 0.5, 64);
        
        // Dark purple/redish hue for a menacing storm, very transparent
        this.material = new THREE.MeshBasicMaterial({
            color: 0x220033,
            transparent: true,
            opacity: 0.0, // starts invisible
            depthWrite: false, // doesn't obscure other transparent objects
            side: THREE.FrontSide
        });

        this.mesh = new THREE.Mesh(geometry, this.material);
        
        // Start far below ground, we'll position it when active
        this.mesh.position.set(0, -10, 0);
        
        // Render after regular ground but before tornados
        this.mesh.renderOrder = 1;

        this.scene.add(this.mesh);
    }

    update(state: SupercellState | undefined, dt: number) {
        if (!state || !state.active) {
            // Fade out if inactive
            if (this.material.opacity > 0) {
                this.material.opacity = Math.max(0, this.material.opacity - dt * 1.5);
                if (this.material.opacity <= 0) {
                    this.mesh.visible = false;
                }
            } else {
                this.mesh.visible = false;
            }
            return;
        }

        this.mesh.visible = true;

        // Fade in
        if (this.material.opacity < 0.4) {
            this.material.opacity = Math.min(0.4, this.material.opacity + dt * 0.5);
        }

        // Set position to the center from state
        this.mesh.position.set(state.x, 0.1, state.y); // just above ground

        // Set scale dynamically based on the supercell radius
        // The geometry has radius 1, so scale directly sets the actual size
        // Scale X and Z for radius, scale Y is thickness
        this.mesh.scale.set(state.radius, 1, state.radius);

        // Slowly rotate it for effect
        this.mesh.rotation.y += this.rotationSpeed * dt;
    }

    destroy() {
        if (this.mesh && this.scene) {
            this.scene.remove(this.mesh);
        }
        if (this.mesh.geometry) this.mesh.geometry.dispose();
        if (this.material) this.material.dispose();
    }
}
