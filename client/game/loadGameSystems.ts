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

    const sceneManager = new SceneManager(canvas);

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
