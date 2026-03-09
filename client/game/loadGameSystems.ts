import type { DestructionTrail } from '../scene/DestructionTrail.js';
import type { FragmentSystem } from '../scene/FragmentSystem.js';
import type { ParticleSystem } from '../scene/ParticleSystem.js';
import type { PowerUpRenderer } from '../scene/PowerUpRenderer.js';
import type { SceneManager } from '../scene/SceneManager.js';
import type { TornadoMesh } from '../scene/TornadoMesh.js';
import type { WorldRenderer } from '../scene/WorldRenderer.js';

export type TornadoMeshInstance = TornadoMesh;

export interface GameSystems {
    sceneManager: SceneManager;
    worldRenderer: WorldRenderer;
    powerUpRenderer: PowerUpRenderer;
    particleSystem: ParticleSystem;
    destructionTrail: DestructionTrail;
    fragmentSystem: FragmentSystem;
    createTornadoMesh: (isLocal: boolean, skinId: string) => TornadoMeshInstance;
}

export async function loadGameSystems(canvas: HTMLCanvasElement): Promise<GameSystems> {
    const [
        { SceneManager },
        { WorldRenderer },
        { PowerUpRenderer },
        { ParticleSystem },
        { DestructionTrail },
        { FragmentSystem },
        { TornadoMesh },
    ] = await Promise.all([
        import('../scene/SceneManager.js'),
        import('../scene/WorldRenderer.js'),
        import('../scene/PowerUpRenderer.js'),
        import('../scene/ParticleSystem.js'),
        import('../scene/DestructionTrail.js'),
        import('../scene/FragmentSystem.js'),
        import('../scene/TornadoMesh.js'),
    ]);

    let sceneManager;
    try {
        sceneManager = new SceneManager(canvas);
    } catch (e) {
        // WebGL completely unavailable — show user-facing error instead of black screen
        console.error('[Fatal] WebGL init failed:', e);
        const err = document.createElement('div');
        err.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#111;color:#fff;font:600 1.2rem/1.6 Outfit,sans-serif;text-align:center;padding:2rem;';
        err.innerHTML = 'Your browser could not start WebGL.<br>Try closing other tabs or updating your browser.';
        document.body.appendChild(err);
        throw e; // stop module execution
    }

    return {
        sceneManager,
        worldRenderer: new WorldRenderer(sceneManager.scene),
        powerUpRenderer: new PowerUpRenderer(sceneManager.scene),
        particleSystem: new ParticleSystem(sceneManager.scene),
        destructionTrail: new DestructionTrail(sceneManager.scene),
        fragmentSystem: new FragmentSystem(sceneManager.scene),
        createTornadoMesh: (isLocal, skinId) => new TornadoMesh(isLocal, skinId),
    };
}
