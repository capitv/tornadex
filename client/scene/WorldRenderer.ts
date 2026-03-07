// ============================================
// World Renderer — Ground, Buildings, Cars, Animals, Trees
// Features: LOD, Frustum Culling (spatial chunks), Improved Instanced Rendering
// ============================================

import * as THREE from 'three';
import type { WorldObject, TerrainZone, SafeZone } from '../../shared/types.js';
import { getAtlasSubTexture, AtlasRegions } from './TextureAtlas.js';
import { getGraphicsPreset, onGraphicsChange } from '../settings/GraphicsConfig.js';

// Colors by object type
const TYPE_COLORS: Record<string, number[]> = {
    tree:         [0x2d8a4e, 0x3ba55d, 0x228b22, 0x1a6b30, 0x4caf50, 0x2e7d32, 0x1b5e20],
    barn:         [0x8B4513, 0xA0522D, 0xCD853F],
    car:          [0xe74c3c, 0x3498db, 0xf39c12, 0x9b59b6, 0x1abc9c],
    animal:       [0x8b6914, 0x654321, 0xd2691e],
    trailer_park: [0xd4c5a9, 0xc8b89a, 0xbfad8e, 0xe0d4bc],
    stadium:      [0xa8a8a8, 0x909090, 0xb5b5b5],
};

// ---- LOD thresholds (instance-level defaults; overridden by graphics preset) ----
// Objects closer than LOD_NEAR_DISTANCE use full detail geometry.
// Objects between LOD_NEAR_DISTANCE and LOD_FAR_DISTANCE use simplified geometry.
// Objects beyond LOD_FAR_DISTANCE are hidden (scene fog handles the pop).
// Note: these are now stored as instance variables — see WorldRenderer class body.
const DEFAULT_LOD_NEAR = 150;
const DEFAULT_LOD_FAR  = 350;

// ---- Tree-specific LOD thresholds ----
// Trees are the most numerous object (~8000) and use aggressive LOD to cut triangles.
// Close (0-TREE_LOD_NEAR): full 3D geometry (trunk + foliage sphere)
// Medium (TREE_LOD_NEAR - TREE_LOD_FAR): billboard sprite (2 triangles, camera-facing)
// Far (TREE_LOD_FAR+): culled entirely
const DEFAULT_TREE_LOD_NEAR = 0;     // Trees always use billboard (no detail tier)
const DEFAULT_TREE_LOD_FAR  = 99999; // Never cull — 8000 billboards = 16K tris, negligible
const TREE_LOD_TRANSITION   = 5; // units of overlap for smooth fade (unused for now, reserved)

// Run LOD + frustum check every N frames to amortise CPU cost across frames
const LOD_UPDATE_INTERVAL = 15;

// ---- Spatial chunk size for frustum culling ----
// World is divided into CHUNK_SIZE x CHUNK_SIZE cells; only visible cells process
// LOD transitions, avoiding work on off-screen geometry.
const CHUNK_SIZE = 200;

// ---- Mesh-key lookup tables ----
const DETAIL_KEYS: Record<string, string[]> = {
    tree:         ['treeTrunk', 'tree'],
    barn:         ['barnBase', 'barnRoof'],
    car:          ['car', 'carCabin'],
    animal:       ['animal', 'animalHead'],
    trailer_park: ['trailerBase0', 'trailerBase1', 'trailerBase2'],
    stadium:      ['stadiumBase', 'stadiumRing'],
};

const LOD_KEYS: Record<string, string[]> = {
    tree:         ['treeLOD'],
    barn:         ['barnLOD'],
    car:          ['carLOD'],
    animal:       ['animalLOD'],
    trailer_park: ['trailerParkLOD'],
    stadium:      ['stadiumLOD'],
};

type LodLevel = 'detail' | 'lod' | 'hidden';

interface ChunkEntry {
    objId:       number;
    type:        string;
    detailIndex: number; // slot in the global detail InstancedMesh
    lodIndex:    number; // slot in the global LOD InstancedMesh
}

interface Chunk {
    key:     string;
    entries: ChunkEntry[];
    bounds:  THREE.Box3; // AABB for frustum intersection test
}

export class WorldRenderer {
    private group: THREE.Group;
    private ground!: THREE.Mesh;
    private zoneMeshes: THREE.Mesh[] = [];
    private safeZoneMeshes: THREE.Mesh[] = [];
    private gridHelper!: THREE.GridHelper;

    // Instance Tracking
    private objectInstances: Map<number, { type: string; index: number }> = new Map();
    private instancedMeshes: Record<string, THREE.InstancedMesh[]> = {};
    private dummy = new THREE.Object3D();

    // Performance: cache destroyed state so we only process NEWLY destroyed IDs
    private currentlyHidden: Set<number> = new Set();

    // Performance: store positions separately so getObjectPosition doesn't decompose matrices
    private objectPositions: Map<number, { x: number; y: number }> = new Map();

    // Performance: reusable math objects to avoid GC
    private _mat4 = new THREE.Matrix4();
    private _pos = new THREE.Vector3();
    private _quat = new THREE.Quaternion();
    private _scale = new THREE.Vector3();

    // ---- LOD state ----
    private objectLodLevel: Map<number, LodLevel> = new Map();
    private objectLodIndex: Map<number, number>    = new Map();
    private lodTypeCounters: Record<string, number> = {};
    private _lodFrame = 0;
    // Billboard shader uniform — updated each frame so tree LOD planes face camera
    private _billboardCamPos = { value: new THREE.Vector3() };
    // Cache of original LOD matrices keyed by "type:lodIndex" so _showLodSlot can
    // restore the correct scale after _hideLodSlot zeroed it out.
    private _originalLodMatrices: Map<string, THREE.Matrix4> = new Map();

    // ---- LOD distances (updated from graphics preset) ----
    private _lodNearDistance = DEFAULT_LOD_NEAR;
    private _lodFarDistance  = DEFAULT_LOD_FAR;
    // Tree-specific aggressive LOD distances
    private _treeLodNearDistance = DEFAULT_TREE_LOD_NEAR;
    private _treeLodFarDistance  = DEFAULT_TREE_LOD_FAR;

    // ---- Frustum culling ----
    private chunks: Map<string, Chunk>    = new Map();
    private _frustum          = new THREE.Frustum();
    private _projScreenMatrix = new THREE.Matrix4();

    // ---- Suction animation state ----
    // Stores the per-object suction lean applied last frame so we can restore when
    // the tornado moves away (avoids objects staying permanently tilted).
    // Key = objectId, value = current lean strength (0=normal, 1=full lean)
    private _suctionStrength: Map<number, number> = new Map();
    // Reusable scratch objects for suction matrix writes (no per-frame allocation)
    private _suctionPos   = new THREE.Vector3();
    private _suctionScale = new THREE.Vector3();
    private _suctionQuat  = new THREE.Quaternion();
    private _suctionMat4  = new THREE.Matrix4();
    // Throttle suction updates (every 2 frames — visual is too smooth to need every frame)
    private _suctionFrame = 0;

    constructor(private scene: THREE.Scene) {
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Apply initial LOD distances from graphics preset
        this._applyPresetLod(getGraphicsPreset());

        // Update LOD distances when quality changes
        onGraphicsChange((preset) => {
            this._applyPresetLod(preset);
        });
    }

    /** Map graphics preset cull distance to LOD near/far values. */
    private _applyPresetLod(preset: ReturnType<typeof getGraphicsPreset>): void {
        if (isFinite(preset.worldCullDistance)) {
            // Low quality: cull distance is finite, compress LOD range to match
            this._lodFarDistance  = preset.worldCullDistance;
            this._lodNearDistance = Math.min(DEFAULT_LOD_NEAR, preset.worldCullDistance * 0.5);
            // Tree distances: use the tighter of preset-based or default tree thresholds
            this._treeLodFarDistance  = Math.min(DEFAULT_TREE_LOD_FAR, preset.worldCullDistance);
            this._treeLodNearDistance = Math.min(DEFAULT_TREE_LOD_NEAR, this._treeLodFarDistance * 0.4);
        } else {
            // Medium / High quality: use default LOD distances
            this._lodNearDistance = DEFAULT_LOD_NEAR;
            this._lodFarDistance  = DEFAULT_LOD_FAR;
            this._treeLodNearDistance = DEFAULT_TREE_LOD_NEAR;
            this._treeLodFarDistance  = DEFAULT_TREE_LOD_FAR;
        }
    }

    public getElevation(x: number, z: number): number {
        return 0;
    }

    private initEnvironment(worldSize: number): void {
        // Ground - soft grassy green
        const groundGeo = new THREE.PlaneGeometry(worldSize, worldSize, 30, 30);
        const groundMat = new THREE.MeshLambertMaterial({ color: 0x2e422c });
        this.ground = new THREE.Mesh(groundGeo, groundMat);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.set(worldSize / 2, -0.01, worldSize / 2);
        this.ground.receiveShadow = true;

        // Apply elevation to terrain
        const positions = groundGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < positions.length; i += 3) {
            const px = positions[i] + worldSize / 2; // local X to world X
            const py = positions[i + 1] + worldSize / 2; // local Y to world Z
            positions[i + 2] = this.getElevation(px, py); // Z is up after rotation
        }
        groundGeo.computeVertexNormals();
        this.group.add(this.ground);

        // Add asphalt roads crossing the map
        const roadMat = new THREE.MeshLambertMaterial({ color: 0x1f2326 });
        const roadWidth = 12;

        // 4 Vertical roads (segmented to follow terrain)
        for (let i = 1; i <= 4; i++) {
            const rx = (worldSize / 5) * i;
            const rGeo = new THREE.PlaneGeometry(roadWidth, worldSize, 1, 50);

            // Align vertices to terrain
            const rPos = rGeo.attributes.position.array as Float32Array;
            for (let v = 0; v < rPos.length; v += 3) {
                const px = rPos[v] + rx;
                const py = rPos[v + 1] + worldSize / 2;
                rPos[v + 2] = this.getElevation(px, py) + 0.05; // Slightly above ground
            }
            rGeo.computeVertexNormals();

            const road = new THREE.Mesh(rGeo, roadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.set(rx, 0, worldSize / 2);
            road.receiveShadow = true;
            this.group.add(road);
        }

        // 4 Horizontal roads (segmented)
        for (let i = 1; i <= 4; i++) {
            const rz = (worldSize / 5) * i;
            const rGeo = new THREE.PlaneGeometry(worldSize, roadWidth, 50, 1);

            // Align vertices to terrain (elevated slightly above vertical roads)
            const rPos = rGeo.attributes.position.array as Float32Array;
            for (let v = 0; v < rPos.length; v += 3) {
                const px = rPos[v] + worldSize / 2;
                const py = rPos[v + 1] + rz;
                rPos[v + 2] = this.getElevation(px, py) + 0.06;
            }
            rGeo.computeVertexNormals();

            const road = new THREE.Mesh(rGeo, roadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.set(worldSize / 2, 0, rz);
            road.receiveShadow = true;
            this.group.add(road);
        }

        this.gridHelper = new THREE.GridHelper(worldSize, 40, 0x2a4a30, 0x2a4a30);
        this.gridHelper.position.set(worldSize / 2, 0.01, worldSize / 2);
        (this.gridHelper.material as THREE.Material).transparent = true;
        (this.gridHelper.material as THREE.Material).opacity = 0.15;
        this.group.add(this.gridHelper);
    }

    createGround(worldSize: number): void {
        // Higher subdivision for terrain hills
        const groundGeo = new THREE.PlaneGeometry(worldSize, worldSize, 80, 80);

        // Atlas grass texture — tiled across the ground plane
        const grassTex  = getAtlasSubTexture(AtlasRegions.GRASS);
        grassTex.wrapS  = THREE.RepeatWrapping;
        grassTex.wrapT  = THREE.RepeatWrapping;
        // One tile every ~20 world units gives a nicely visible grassy pattern
        grassTex.repeat.set(worldSize / 20, worldSize / 20);

        const groundMat = new THREE.MeshLambertMaterial({
            color: 0x3a5a40,  // tint preserved so shading matches original art style
            map: grassTex,
        });
        this.ground = new THREE.Mesh(groundGeo, groundMat);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.set(worldSize / 2, -0.01, worldSize / 2);
        this.ground.receiveShadow = true;

        // Create gentle terrain hills
        const positions = groundGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < positions.length; i += 3) {
            const px = positions[i];
            const py = positions[i + 1];
            // Layered sine waves for natural rolling hills
            let height = 0;
            height += Math.sin(px * 0.012) * Math.cos(py * 0.015) * 1.8;
            height += Math.sin(px * 0.025 + 1.5) * Math.sin(py * 0.02 + 0.8) * 1.0;
            height += Math.cos(px * 0.04 + py * 0.03) * 0.5;
            positions[i + 2] = Math.max(0, height); // Z is up after rotation
        }
        groundGeo.computeVertexNormals();
        this.group.add(this.ground);

        // Add asphalt roads crossing the map — atlas road texture (shared singleton)
        const roadTex  = getAtlasSubTexture(AtlasRegions.ROAD);
        roadTex.wrapS  = THREE.RepeatWrapping;
        roadTex.wrapT  = THREE.RepeatWrapping;
        // One tile per 12 world units (road width) keeps lane markings proportional
        roadTex.repeat.set(1, worldSize / 12);

        const roadMat = new THREE.MeshLambertMaterial({
            color: 0x1f2326, // dark tint preserves the original asphalt look
            map: roadTex,
        });
        const roadWidth = 12;

        // 4 Vertical roads (segmented to follow terrain)
        for (let i = 1; i <= 4; i++) {
            const rx = (worldSize / 5) * i;
            const rGeo = new THREE.PlaneGeometry(roadWidth, worldSize, 1, 50);

            // Align vertices to terrain
            const rPos = rGeo.attributes.position.array as Float32Array;
            for (let v = 0; v < rPos.length; v += 3) {
                const px = rPos[v] + rx;
                const py = rPos[v + 1] + worldSize / 2;
                rPos[v + 2] = this.getElevation(px, py) + 0.05; // Slightly above ground
            }
            rGeo.computeVertexNormals();

            const road = new THREE.Mesh(rGeo, roadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.set(rx, 0, worldSize / 2);
            road.receiveShadow = true;
            this.group.add(road);
        }

        // 4 Horizontal roads (segmented) — separate texture instance so repeat differs
        const hRoadTex = getAtlasSubTexture(AtlasRegions.ROAD);
        hRoadTex.wrapS  = THREE.RepeatWrapping;
        hRoadTex.wrapT  = THREE.RepeatWrapping;
        hRoadTex.repeat.set(worldSize / 12, 1);

        const hRoadMat = new THREE.MeshLambertMaterial({
            color: 0x1f2326,
            map: hRoadTex,
        });

        for (let i = 1; i <= 4; i++) {
            const rz = (worldSize / 5) * i;
            const rGeo = new THREE.PlaneGeometry(worldSize, roadWidth, 50, 1);

            // Align vertices to terrain (elevated slightly above vertical roads)
            const rPos = rGeo.attributes.position.array as Float32Array;
            for (let v = 0; v < rPos.length; v += 3) {
                const px = rPos[v] + worldSize / 2;
                const py = rPos[v + 1] + rz;
                rPos[v + 2] = this.getElevation(px, py) + 0.06;
            }
            rGeo.computeVertexNormals();

            const road = new THREE.Mesh(rGeo, hRoadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.set(worldSize / 2, 0, rz);
            road.receiveShadow = true;
            this.group.add(road);
        }

        this.gridHelper = new THREE.GridHelper(worldSize, 40, 0x2a4a30, 0x2a4a30);
        this.gridHelper.position.set(worldSize / 2, 0.01, worldSize / 2);
        (this.gridHelper.material as THREE.Material).transparent = true;
        (this.gridHelper.material as THREE.Material).opacity = 0.15;
        this.group.add(this.gridHelper);
    }

    createZones(zones: TerrainZone[]): void {
        for (const zone of zones) {
            if (zone.type === 'water') {
                this.createLake(zone);
            } else {
                // Mountain zones stay rectangular
                const geo = new THREE.PlaneGeometry(zone.width, zone.height);
                const mat = new THREE.MeshLambertMaterial({
                    color: 0x5a5a5a,
                    transparent: true,
                    opacity: 0.4,
                });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.rotation.x = -Math.PI / 2;
                mesh.position.set(zone.x + zone.width / 2, 0.15, zone.y + zone.height / 2);
                mesh.receiveShadow = true;
                this.group.add(mesh);
                this.zoneMeshes.push(mesh);
            }
        }
    }

    /**
     * Creates a natural-looking lake using an irregular ellipse with vertex noise
     * plus a lighter shore ring around it.
     */
    private createLake(zone: TerrainZone): void {
        const cx = zone.x + zone.width / 2;
        const cz = zone.y + zone.height / 2;
        const rx = zone.width / 2;
        const rz = zone.height / 2;
        const segments = 48;

        // --- Shore ring (lighter, slightly bigger) ---
        const shoreShape = new THREE.Shape();
        const shoreScale = 1.15; // 15% bigger than water
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            // Organic noise using layered sine
            const noise = 1.0
                + Math.sin(angle * 3.0 + 1.7) * 0.08
                + Math.sin(angle * 5.3 + 0.4) * 0.05
                + Math.sin(angle * 7.1 + 2.9) * 0.03;
            const sx = Math.cos(angle) * rx * shoreScale * noise;
            const sy = Math.sin(angle) * rz * shoreScale * noise;
            if (i === 0) shoreShape.moveTo(sx, sy);
            else shoreShape.lineTo(sx, sy);
        }
        const shoreGeo = new THREE.ShapeGeometry(shoreShape, 1);
        const shoreMat = new THREE.MeshLambertMaterial({
            color: 0x8b7d5e, // sandy brown shore
            transparent: true,
            opacity: 0.5,
        });
        const shoreMesh = new THREE.Mesh(shoreGeo, shoreMat);
        shoreMesh.rotation.x = -Math.PI / 2;
        shoreMesh.position.set(cx, 0.12, cz);
        shoreMesh.receiveShadow = true;
        this.group.add(shoreMesh);
        this.zoneMeshes.push(shoreMesh);

        // --- Water body (irregular ellipse with noise) ---
        const waterShape = new THREE.Shape();
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            // Same noise pattern as shore so they match
            const noise = 1.0
                + Math.sin(angle * 3.0 + 1.7) * 0.08
                + Math.sin(angle * 5.3 + 0.4) * 0.05
                + Math.sin(angle * 7.1 + 2.9) * 0.03;
            const wx = Math.cos(angle) * rx * noise;
            const wy = Math.sin(angle) * rz * noise;
            if (i === 0) waterShape.moveTo(wx, wy);
            else waterShape.lineTo(wx, wy);
        }
        const waterGeo = new THREE.ShapeGeometry(waterShape, 1);
        const waterMat = new THREE.MeshLambertMaterial({
            color: 0x1a6b8a,
            transparent: true,
            opacity: 0.65,
        });
        const waterMesh = new THREE.Mesh(waterGeo, waterMat);
        waterMesh.rotation.x = -Math.PI / 2;
        waterMesh.position.set(cx, 0.18, cz);
        waterMesh.receiveShadow = true;
        this.group.add(waterMesh);
        this.zoneMeshes.push(waterMesh);

        // --- Shallow highlights (smaller, lighter inner blob) ---
        const innerShape = new THREE.Shape();
        const innerScale = 0.55;
        const innerOffset = 0.6; // offset the highlight off-center
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const noise = 1.0
                + Math.sin(angle * 2.3 + 4.1) * 0.12
                + Math.sin(angle * 4.7 + 1.2) * 0.06;
            const ix = Math.cos(angle) * rx * innerScale * noise;
            const iy = Math.sin(angle) * rz * innerScale * noise;
            if (i === 0) innerShape.moveTo(ix, iy);
            else innerShape.lineTo(ix, iy);
        }
        const innerGeo = new THREE.ShapeGeometry(innerShape, 1);
        const innerMat = new THREE.MeshLambertMaterial({
            color: 0x2a8faa,
            transparent: true,
            opacity: 0.3,
        });
        const innerMesh = new THREE.Mesh(innerGeo, innerMat);
        innerMesh.rotation.x = -Math.PI / 2;
        innerMesh.position.set(
            cx + rx * 0.15 * innerOffset,
            0.2,
            cz - rz * 0.1 * innerOffset,
        );
        this.group.add(innerMesh);
        this.zoneMeshes.push(innerMesh);
    }

    /**
     * Render safe haven zones as green-tinted glowing circles on the ground.
     * Each zone has two layers: a solid base disc and a brighter rim ring for the glow effect.
     */
    createSafeZones(safeZones: SafeZone[]): void {
        for (const zone of safeZones) {
            // --- Filled circle (base, soft green) ---
            const baseGeo = new THREE.CircleGeometry(zone.radius, 64);
            const baseMat = new THREE.MeshBasicMaterial({
                color: 0x00ff88,
                transparent: true,
                opacity: 0.12,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            const baseMesh = new THREE.Mesh(baseGeo, baseMat);
            baseMesh.rotation.x = -Math.PI / 2;
            baseMesh.position.set(zone.x, 0.08, zone.y);
            this.group.add(baseMesh);
            this.safeZoneMeshes.push(baseMesh);

            // --- Outer ring (bright glow rim) ---
            const ringGeo = new THREE.RingGeometry(zone.radius * 0.88, zone.radius, 64);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x44ffaa,
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.rotation.x = -Math.PI / 2;
            ringMesh.position.set(zone.x, 0.10, zone.y);
            this.group.add(ringMesh);
            this.safeZoneMeshes.push(ringMesh);

            // --- Inner pulse ring (narrower, brighter) ---
            const innerRingGeo = new THREE.RingGeometry(zone.radius * 0.94, zone.radius, 64);
            const innerRingMat = new THREE.MeshBasicMaterial({
                color: 0xaaffcc,
                transparent: true,
                opacity: 0.80,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            const innerRingMesh = new THREE.Mesh(innerRingGeo, innerRingMat);
            innerRingMesh.rotation.x = -Math.PI / 2;
            innerRingMesh.position.set(zone.x, 0.12, zone.y);
            this.group.add(innerRingMesh);
            this.safeZoneMeshes.push(innerRingMesh);
        }
    }

    /**
     * Animate the safe zone rings with a gentle pulse so they read as active zones.
     * Call this every frame from the render loop. `time` is elapsed seconds.
     */
    updateSafeZones(time: number): void {
        // Meshes are stored in groups of 3 per zone: [base, rim, innerRing]
        for (let i = 0; i < this.safeZoneMeshes.length; i++) {
            const mesh = this.safeZoneMeshes[i];
            const mat = mesh.material as THREE.MeshBasicMaterial;
            const role = i % 3; // 0 = base, 1 = rim, 2 = innerRing

            if (role === 0) {
                // Base: slow breathing opacity
                mat.opacity = 0.08 + Math.sin(time * 1.2) * 0.04;
            } else if (role === 1) {
                // Rim: medium pulse
                mat.opacity = 0.40 + Math.sin(time * 1.8 + 1.0) * 0.15;
            } else {
                // Inner ring: fast, bright pulse
                mat.opacity = 0.60 + Math.sin(time * 2.5 + 2.0) * 0.20;
            }
        }
    }

    public cloudCeiling!: THREE.Mesh;

    // ---- Cloud ceiling deformation state ----
    // Stores the un-deformed (local) Y value for every vertex in the ceiling plane.
    // Because the plane is rotated -PI/2 on X, Three.js internally maps the flat
    // XY plane so that the "height" axis is stored in the Z component of each
    // position attribute.  We cache those base Z values once and restore them
    // each frame before applying fresh tornado pulls.
    private _cloudBaseZ: Float32Array | null = null;
    // Direct reference to the raw Float32Array backing the position BufferAttribute.
    // Cached once at construction to avoid repeated property lookups each frame.
    private _cloudPosArray: Float32Array | null = null;
    // Frame counter used to throttle deformation work to every 3 frames.
    private _cloudDeformFrame = 0;
    // Half-size of the ceiling geometry in world units (set in createCloudCeiling).
    private _cloudHalfSize = 0;

    // Pre-allocated typed arrays for cloud deformation (max 64 tornados).
    private _cloudTLx = new Float32Array(64);
    private _cloudTLy = new Float32Array(64);
    private _cloudTDepth = new Float32Array(64);
    private _cloudTInvInfl2 = new Float32Array(64);
    private _cloudTCullR2 = new Float32Array(64);

    // Pre-allocated tornado descriptor objects for cloud deformation (max 64).
    private _cloudTornadoPool: { lx: number; ly: number; influence2: number; depth: number; cullRadius: number }[] =
        Array.from({ length: 64 }, () => ({ lx: 0, ly: 0, influence2: 0, depth: 0, cullRadius: 0 }));

    createCloudCeiling(worldSize: number): void {
        // 80x80 segments give 6 561 vertices — enough resolution for smooth
        // gaussian depressions without being prohibitively expensive.
        const segments = 80;
        const skyGeo = new THREE.PlaneGeometry(worldSize * 4, worldSize * 4, segments, segments);
        const skyMat = new THREE.MeshLambertMaterial({
            color: 0x4a5568, // Matches horizon/fog color for seamless blend
            side: THREE.DoubleSide
        });
        const sky = new THREE.Mesh(skyGeo, skyMat);
        sky.rotation.x = Math.PI / 2;
        sky.position.set(worldSize / 2, 45, worldSize / 2);
        this.group.add(sky);
        this.cloudCeiling = sky;

        // Cache the flat base Z values (all zero for a freshly created plane).
        const positions = skyGeo.attributes.position as THREE.BufferAttribute;
        const posArray = positions.array as Float32Array;
        this._cloudPosArray = posArray;
        this._cloudBaseZ = new Float32Array(positions.count);
        for (let i = 0; i < positions.count; i++) {
            // stride is 3 floats (x, y, z) per vertex; Z is at index i*3+2
            this._cloudBaseZ[i] = posArray[i * 3 + 2];
        }
        this._cloudHalfSize = worldSize * 2; // half of worldSize * 4

        const stormLight = new THREE.PointLight(0x446688, 1.0, 500);
        stormLight.position.set(worldSize / 2, 30, worldSize / 2);
        this.group.add(stormLight);
    }

    /**
     * Deform the cloud ceiling downward above each tornado, creating a
     * "wall cloud" / mesocyclone lowering effect.
     *
     * Call this every frame (or every few frames) from the render loop.
     * `tornadoPositions` uses world-space X/Z coordinates and a radius value
     * that matches the server-side tornado radius (same scale used everywhere
     * else in the game).
     *
     * The plane is rotated -PI/2 on X, so its local geometry lies in the XY
     * plane and the "vertical" displacement we want lives in the Z component
     * of each position attribute.  Downward in world space means NEGATIVE Z in
     * the plane's local space.
     */
    updateCloudDeformation(tornadoPositions: { x: number; z: number; radius: number }[]): void {
        if (!this.cloudCeiling || !this._cloudBaseZ) return;

        // Throttle to every 3 frames — deformations are smooth enough that
        // one missed frame is imperceptible.
        this._cloudDeformFrame++;
        if (this._cloudDeformFrame % 3 !== 0) return;

        const geo = this.cloudCeiling.geometry as THREE.BufferGeometry;
        const baseZ = this._cloudBaseZ;
        const count = baseZ.length;

        // The plane is centred on the mesh's local origin; the mesh is placed
        // at (worldSize/2, baseCeilingY, worldSize/2) in world space.
        // We convert each tornado's world-space (x, z) into the plane's local
        // XY space:  localX = tornadoX - meshX,  localY = tornadoZ - meshZ
        // (Y in local plane space corresponds to world Z because of the -PI/2
        // rotation applied to the mesh.)
        const meshWorldX = this.cloudCeiling.position.x;
        const meshWorldZ = this.cloudCeiling.position.z;

        // Pre-convert tornado positions to plane-local coordinates and
        // pre-compute per-tornado constants so the inner vertex loop is lean.
        // Reuse pre-allocated pool objects to avoid per-frame allocations.
        const tornLen = tornadoPositions.length;
        for (let i = 0; i < tornLen; i++) {
            const t = tornadoPositions[i];
            const influence = t.radius * 10;
            const obj = this._cloudTornadoPool[i];
            obj.lx = t.x - meshWorldX;
            obj.ly = t.z - meshWorldZ;
            obj.influence2 = influence * influence;
            obj.depth = t.radius * 3;
            obj.cullRadius = influence * 3; // beyond 3σ the pull is negligible
        }

        // Pre-compute per-tornado derived constants outside the vertex loop.
        // Reuse pre-allocated Float32Arrays (sized to 64, always > tornLen).
        const tLx        = this._cloudTLx;
        const tLy        = this._cloudTLy;
        const tDepth     = this._cloudTDepth;
        const tInvInfl2  = this._cloudTInvInfl2;
        const tCullR2    = this._cloudTCullR2;
        for (let t = 0; t < tornLen; t++) {
            const at = this._cloudTornadoPool[t];
            tLx[t]       = at.lx;
            tLy[t]       = at.ly;
            tDepth[t]    = at.depth;
            tInvInfl2[t] = 1.0 / at.influence2;
            tCullR2[t]   = at.cullRadius * at.cullRadius;
        }

        // Direct reference to the raw position Float32Array — avoids per-call
        // bounds checks and stride math of the getX/getY/setZ accessors.
        const arr = this._cloudPosArray!;

        // If no active tornados, restore flat geometry and bail out.
        if (tornLen === 0) {
            let needsUpdate = false;
            for (let i = 0; i < count; i++) {
                const zi = i * 3 + 2;
                if (arr[zi] !== baseZ[i]) {
                    arr[zi] = baseZ[i];
                    needsUpdate = true;
                }
            }
            if (needsUpdate) geo.attributes.position.needsUpdate = true;
            return;
        }

        for (let i = 0; i < count; i++) {
            const base = i * 3;
            const vx = arr[base];         // X component
            const vy = arr[base + 1];     // Y component

            let totalPull = 0;

            for (let t = 0; t < tornLen; t++) {
                const dx = vx - tLx[t];
                const dy = vy - tLy[t];
                const dist2 = dx * dx + dy * dy;

                // Skip vertices too far from this tornado (beyond ~3σ).
                if (dist2 > tCullR2[t]) continue;

                // Fast polynomial approximation of Gaussian falloff
                const u = 1.0 - dist2 * tInvInfl2[t];
                if (u > 0) totalPull += tDepth[t] * u * u;
            }

            // Downward in world space = negative Z in the plane's local frame.
            arr[base + 2] = baseZ[i] - totalPull;
        }

        geo.attributes.position.needsUpdate = true;
        // computeVertexNormals() is intentionally skipped here: the cloud ceiling
        // is semi-transparent, high up, and uses MeshLambertMaterial with ambient
        // lighting that makes normal precision imperceptible at this scale.
        // Normals are recomputed every 9th frame to keep a minimal lighting cue
        // without paying the full per-frame cost (~6 k vertex cross-products).
        if (this._cloudDeformFrame % 9 === 0) {
            geo.computeVertexNormals();
        }
    }

    createInitialObjects(objects: WorldObject[]): void {
        // Count instances per type
        const counts: Record<string, number> = {};
        for (const obj of objects) {
            counts[obj.type] = (counts[obj.type] || 0) + 1;
        }

        // Initialize InstancedMeshes (detail + LOD pools)
        this.initInstancedMeshes(counts);

        // Keep track of current index per type
        const indices: Record<string, number> = {
            tree: 0, barn: 0, car: 0, animal: 0,
            trailer_park: 0, stadium: 0,
        };

        for (const obj of objects) {
            const idx = indices[obj.type]++;
            this.objectInstances.set(obj.id, { type: obj.type, index: idx });
            this.objectPositions.set(obj.id, { x: obj.x, y: obj.y });
            this.setInstanceData(obj, idx);

            // Allocate a LOD slot and write the simplified matrix
            const lodIdx = this.lodTypeCounters[obj.type] ?? 0;
            this.lodTypeCounters[obj.type] = lodIdx + 1;
            this.objectLodIndex.set(obj.id, lodIdx);
            this.setLodInstanceData(obj, lodIdx);
            // Trees use billboard always (no 3D detail tier) for massive triangle savings.
            // Other types start with detail visible and LOD hidden.
            if (obj.type === 'tree') {
                // Show billboard, hide detail geometry
                this._hideDetailSlot(obj.type, idx);
                this.objectLodLevel.set(obj.id, 'lod');
            } else {
                this._hideLodSlot(obj.type, lodIdx);
                this.objectLodLevel.set(obj.id, 'detail');
            }
        }

        // Trees never use 3D detail meshes — set instance count to 0 so Three.js
        // skips them entirely (GPU won't process any tree detail triangles).
        for (const key of DETAIL_KEYS['tree'] ?? []) {
            const im = this.instancedMeshes[key]?.[0];
            if (im) im.count = 0;
        }

        // Build spatial chunks for frustum culling
        this.buildChunks(objects);
    }

    private initInstancedMeshes(counts: Record<string, number>): void {
        // Shared materials — one instance per visual type minimises GPU state changes.
        // Per-instance colour variety comes from setColorAt (stored in the instanceColor buffer).
        const matTreeTrunk      = new THREE.MeshLambertMaterial({ color: 0x5c4033 });
        const matTreeFoliage    = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const matBarnBase       = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const matBarnRoof       = new THREE.MeshLambertMaterial({ color: 0x8B4513 });
        const matCarBody        = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const matCarCabin       = new THREE.MeshLambertMaterial({ color: 0x87ceeb });
        const matAnimal         = new THREE.MeshLambertMaterial({ color: 0xffffff });
        // Trailer park — beige/tan mobile home walls
        const matTrailerBase    = new THREE.MeshLambertMaterial({ color: 0xffffff });
        // Stadium — grey concrete body + coloured event ring on top
        const matStadiumBase    = new THREE.MeshLambertMaterial({ color: 0x909090 });
        const matStadiumRing    = new THREE.MeshLambertMaterial({ color: 0xe8451a }); // bright red ring

        // LOD materials — flat single colour, no sub-part detail
        const matTreeLOD        = new THREE.MeshLambertMaterial({ color: 0x2d8a4e });
        const matBarnLOD        = new THREE.MeshLambertMaterial({ color: 0xA0522D });
        const matCarLOD         = new THREE.MeshLambertMaterial({ color: 0xe74c3c });
        const matAnimalLOD      = new THREE.MeshLambertMaterial({ color: 0x8b6914 });
        const matTrailerParkLOD = new THREE.MeshLambertMaterial({ color: 0xc8b89a });
        const matStadiumLOD     = new THREE.MeshLambertMaterial({ color: 0x909090 });

        const makeIM = (
            geo:       THREE.BufferGeometry,
            mat:       THREE.Material,
            key:       string,
            count:     number,
            colorType?: string,
        ): void => {
            const im = new THREE.InstancedMesh(geo, mat, count);
            im.castShadow    = false; // PERF: shadows on 5000+ instances devastates GPU
            im.receiveShadow = false;
            im.frustumCulled = false; // Culling is handled by our chunk system

            if (colorType) {
                const palette = TYPE_COLORS[colorType];
                if (palette) {
                    const c = new THREE.Color();
                    for (let i = 0; i < count; i++) {
                        c.setHex(palette[Math.floor(Math.random() * palette.length)]);
                        im.setColorAt(i, c);
                    }
                    if (im.instanceColor) im.instanceColor.needsUpdate = true;
                }
            }

            this.group.add(im);
            if (!this.instancedMeshes[key]) this.instancedMeshes[key] = [];
            this.instancedMeshes[key].push(im);
        };

        // ---- Detail geometry ----
        // Trees — 4 variations sharing the same instance pool; variation chosen per-object in setInstanceData
        if (counts.tree > 0) {
            makeIM(new THREE.CylinderGeometry(0.08, 0.14, 1.0, 5), matTreeTrunk,   'treeTrunk', counts.tree);
            makeIM(new THREE.SphereGeometry(0.55, 6, 5),            matTreeFoliage, 'tree',      counts.tree, 'tree');
        }
        if (counts.barn > 0) {
            makeIM(new THREE.BoxGeometry(3.0, 2.0, 2.0), matBarnBase, 'barnBase', counts.barn, 'barn');
            makeIM(new THREE.ConeGeometry(2.2, 1.2, 4),  matBarnRoof, 'barnRoof', counts.barn);
        }
        if (counts.car > 0) {
            makeIM(new THREE.BoxGeometry(1.0, 0.4, 0.6), matCarBody,  'car',      counts.car, 'car');
            makeIM(new THREE.BoxGeometry(0.5, 0.3, 0.5), matCarCabin, 'carCabin', counts.car);
        }
        if (counts.animal > 0) {
            makeIM(new THREE.SphereGeometry(0.25, 6, 5), matAnimal, 'animal',     counts.animal, 'animal');
            makeIM(new THREE.SphereGeometry(0.12, 6, 5), matAnimal, 'animalHead', counts.animal);
        }
        // Trailer park — 3 staggered wide flat boxes simulating clustered mobile homes
        if (counts.trailer_park > 0) {
            // Each slot represents one "unit" of the trailer park.
            // Three mesh layers (trailerBase0/1/2) are positioned at slight offsets in setInstanceData.
            makeIM(new THREE.BoxGeometry(2.4, 0.7, 1.0), matTrailerBase, 'trailerBase0', counts.trailer_park, 'trailer_park');
            makeIM(new THREE.BoxGeometry(2.4, 0.7, 1.0), matTrailerBase, 'trailerBase1', counts.trailer_park, 'trailer_park');
            makeIM(new THREE.BoxGeometry(2.4, 0.7, 1.0), matTrailerBase, 'trailerBase2', counts.trailer_park, 'trailer_park');
        }
        // Stadium — large oval base (CylinderGeometry approximates oval) + a ring on top
        if (counts.stadium > 0) {
            makeIM(new THREE.CylinderGeometry(4.5, 4.5, 2.0, 16), matStadiumBase, 'stadiumBase', counts.stadium, 'stadium');
            makeIM(new THREE.TorusGeometry(4.0, 0.4, 6, 16),       matStadiumRing, 'stadiumRing', counts.stadium);
        }
        // ---- LOD geometry (one mesh part per type — minimal vertex count) ----
        // Tree LOD: billboard sprite — a camera-facing plane (2 triangles) with a
        // procedural tree-shaped texture. The vertex shader rotates each instance to
        // face the camera, so no per-frame JS matrix updates are needed.
        if (counts.tree > 0) {
            const billboardGeo = new THREE.PlaneGeometry(2.0, 2.5);
            const billboardMat = this._createTreeBillboardMaterial();
            const im = new THREE.InstancedMesh(billboardGeo, billboardMat, counts.tree);
            im.castShadow    = false;
            im.receiveShadow = false;
            im.frustumCulled = false;

            // Apply per-instance colours from the tree palette
            const palette = TYPE_COLORS['tree'];
            if (palette) {
                const c = new THREE.Color();
                for (let i = 0; i < counts.tree; i++) {
                    c.setHex(palette[Math.floor(Math.random() * palette.length)]);
                    im.setColorAt(i, c);
                }
                if (im.instanceColor) im.instanceColor.needsUpdate = true;
            }

            this.group.add(im);
            if (!this.instancedMeshes['treeLOD']) this.instancedMeshes['treeLOD'] = [];
            this.instancedMeshes['treeLOD'].push(im);
        }
        // Barn LOD: single box
        if (counts.barn > 0) {
            makeIM(new THREE.BoxGeometry(3.0, 3.0, 2.0), matBarnLOD, 'barnLOD', counts.barn, 'barn');
        }
        // Car LOD: flat single box
        if (counts.car > 0) {
            makeIM(new THREE.BoxGeometry(1.0, 0.5, 0.6), matCarLOD, 'carLOD', counts.car, 'car');
        }
        // Animal LOD: small single box
        if (counts.animal > 0) {
            makeIM(new THREE.BoxGeometry(0.5, 0.4, 0.4), matAnimalLOD, 'animalLOD', counts.animal, 'animal');
        }
        // Trailer park LOD: single wide flat box
        if (counts.trailer_park > 0) {
            makeIM(new THREE.BoxGeometry(6.0, 0.7, 3.0), matTrailerParkLOD, 'trailerParkLOD', counts.trailer_park, 'trailer_park');
        }
        // Stadium LOD: single squat cylinder
        if (counts.stadium > 0) {
            makeIM(new THREE.CylinderGeometry(4.5, 4.5, 2.5, 8), matStadiumLOD, 'stadiumLOD', counts.stadium, 'stadium');
        }
    }

    // ============================================================
    // Billboard material for tree LOD — GPU-side camera-facing
    // ============================================================

    /**
     * Creates a ShaderMaterial that:
     * 1. Rotates each instanced plane to face the camera (cylindrical billboard —
     *    rotates around Y axis only, so trees stay upright).
     * 2. Draws a procedural tree silhouette: brown trunk rectangle at bottom,
     *    green circle canopy on top, with soft alpha edges.
     * 3. Supports per-instance colour from instanceColor buffer.
     */
    private _createTreeBillboardMaterial(): THREE.ShaderMaterial {
        return new THREE.ShaderMaterial({
            uniforms: {
                uCameraPos: this._billboardCamPos,
            },
            vertexShader: /* glsl */ `
                uniform vec3 uCameraPos;
                varying vec2 vUv;
                varying vec3 vInstanceColor;

                void main() {
                    vUv = uv;

                    // Read per-instance colour (falls back to white if no instanceColor)
                    #ifdef USE_INSTANCING_COLOR
                        vInstanceColor = instanceColor;
                    #else
                        vInstanceColor = vec3(1.0);
                    #endif

                    // Extract instance position from the instance matrix (column 3)
                    vec3 instancePos = vec3(
                        instanceMatrix[3][0],
                        instanceMatrix[3][1],
                        instanceMatrix[3][2]
                    );

                    // Extract instance scale from the instance matrix columns
                    float scaleX = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
                    float scaleY = length(vec3(instanceMatrix[1][0], instanceMatrix[1][1], instanceMatrix[1][2]));

                    // Cylindrical billboard: rotate around Y to face camera
                    vec3 toCamera = uCameraPos - instancePos;
                    toCamera.y = 0.0; // keep upright
                    float len = length(toCamera);
                    if (len > 0.001) toCamera /= len;

                    // right = cross(up, toCamera)
                    vec3 up = vec3(0.0, 1.0, 0.0);
                    vec3 right = cross(up, toCamera);

                    // Build billboard vertex position
                    vec3 worldPos = instancePos
                        + right * position.x * scaleX
                        + up    * position.y * scaleY;

                    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                varying vec2 vUv;
                varying vec3 vInstanceColor;

                void main() {
                    // UV: (0,0) bottom-left to (1,1) top-right
                    // Tree shape: trunk at bottom (uv.y < 0.3), canopy circle on top

                    float alpha = 0.0;
                    vec3 color = vec3(0.0);

                    // --- Trunk: narrow rectangle at bottom-centre ---
                    float trunkWidth = 0.15;
                    float trunkTop   = 0.35;
                    if (vUv.y < trunkTop && abs(vUv.x - 0.5) < trunkWidth) {
                        color = vec3(0.36, 0.25, 0.20); // brown
                        alpha = 1.0;
                        // Soften edges
                        float edgeDist = trunkWidth - abs(vUv.x - 0.5);
                        alpha *= smoothstep(0.0, 0.03, edgeDist);
                        alpha *= smoothstep(0.0, 0.05, vUv.y); // fade at very bottom
                    }

                    // --- Canopy: circle centred at (0.5, 0.65) ---
                    vec2 canopyCentre = vec2(0.5, 0.62);
                    float canopyRadius = 0.38;
                    float dist = length(vUv - canopyCentre);
                    if (dist < canopyRadius) {
                        float canopyAlpha = smoothstep(canopyRadius, canopyRadius - 0.06, dist);
                        // Darken edges for depth cue
                        float shade = 0.7 + 0.3 * (1.0 - dist / canopyRadius);
                        vec3 foliageColor = vInstanceColor * shade;
                        // Blend canopy over trunk
                        color = mix(color, foliageColor, canopyAlpha);
                        alpha = max(alpha, canopyAlpha);
                    }

                    if (alpha < 0.05) discard;

                    gl_FragColor = vec4(color, alpha);
                }
            `,
            transparent: true,
            depthWrite: true,
            side: THREE.DoubleSide,
        });
    }

    // ============================================================
    // LOD instance matrix setup — simplified single-part geometry
    // Positions match the detail version so swapping is seamless
    // ============================================================

    private setLodInstanceData(obj: WorldObject, lodIdx: number): void {
        const baseElevation = this.getElevation(obj.x, obj.y);
        // Deterministic rotation from world position (no random — stable across LOD swaps)
        const rotY = ((obj.x * 7 + obj.y * 13) % 628) / 100;

        if (obj.type === 'tree') {
            const im = this.instancedMeshes['treeLOD']?.[0];
            if (!im) return;
            const sizeVar = 0.7 + ((obj.x * 3 + obj.y * 7) % 100) / 100 * 0.6;
            this.dummy.position.set(obj.x, baseElevation + 1.0 * sizeVar, obj.y);
            this.dummy.scale.set(sizeVar, sizeVar * 1.5, sizeVar);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            im.setMatrixAt(lodIdx, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
            // Cache original matrix for _showLodSlot restoration
            this._originalLodMatrices.set(`tree:${lodIdx}`, this.dummy.matrix.clone());
        }

        if (obj.type === 'barn') {
            const im = this.instancedMeshes['barnLOD']?.[0];
            if (!im) return;
            this.dummy.position.set(obj.x, baseElevation + 1.5, obj.y);
            this.dummy.scale.set(1, 1, 1);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            im.setMatrixAt(lodIdx, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
            this._originalLodMatrices.set(`barn:${lodIdx}`, this.dummy.matrix.clone());
        }

        if (obj.type === 'car') {
            const im = this.instancedMeshes['carLOD']?.[0];
            if (!im) return;
            this.dummy.position.set(obj.x, baseElevation + 0.25, obj.y);
            this.dummy.scale.set(1, 1, 1);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            im.setMatrixAt(lodIdx, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
            this._originalLodMatrices.set(`car:${lodIdx}`, this.dummy.matrix.clone());
        }

        if (obj.type === 'animal') {
            const im = this.instancedMeshes['animalLOD']?.[0];
            if (!im) return;
            this.dummy.position.set(obj.x, 0.2, obj.y);
            this.dummy.scale.set(1.2, 0.8, 0.8);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            im.setMatrixAt(lodIdx, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
            this._originalLodMatrices.set(`animal:${lodIdx}`, this.dummy.matrix.clone());
        }

        if (obj.type === 'trailer_park') {
            const im = this.instancedMeshes['trailerParkLOD']?.[0];
            if (!im) return;
            this.dummy.position.set(obj.x, baseElevation + 0.35, obj.y);
            this.dummy.scale.set(1, 1, 1);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            im.setMatrixAt(lodIdx, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
            this._originalLodMatrices.set(`trailer_park:${lodIdx}`, this.dummy.matrix.clone());
        }

        if (obj.type === 'stadium') {
            const im = this.instancedMeshes['stadiumLOD']?.[0];
            if (!im) return;
            this.dummy.position.set(obj.x, baseElevation + 1.25, obj.y);
            this.dummy.scale.set(1, 1, 1);
            this.dummy.rotation.set(0, rotY * 0.1, 0);
            this.dummy.updateMatrix();
            im.setMatrixAt(lodIdx, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
            this._originalLodMatrices.set(`stadium:${lodIdx}`, this.dummy.matrix.clone());
        }

    }

    // ============================================================
    // Spatial chunk construction
    // ============================================================

    private buildChunks(objects: WorldObject[]): void {
        const cellMap = new Map<string, WorldObject[]>();

        for (const obj of objects) {
            const cx  = Math.floor(obj.x / CHUNK_SIZE);
            const cz  = Math.floor(obj.y / CHUNK_SIZE); // obj.y is world Z
            const key = `${cx}_${cz}`;
            if (!cellMap.has(key)) cellMap.set(key, []);
            cellMap.get(key)!.push(obj);
        }

        for (const [key, objs] of cellMap) {
            const [cxStr, czStr] = key.split('_');
            const cx = parseInt(cxStr, 10);
            const cz = parseInt(czStr, 10);

            const bounds = new THREE.Box3(
                new THREE.Vector3(cx * CHUNK_SIZE,       0,  cz * CHUNK_SIZE),
                new THREE.Vector3((cx + 1) * CHUNK_SIZE, 50, (cz + 1) * CHUNK_SIZE),
            );

            const entries: ChunkEntry[] = objs.map((obj) => ({
                objId:       obj.id,
                type:        obj.type,
                detailIndex: this.objectInstances.get(obj.id)!.index,
                lodIndex:    this.objectLodIndex.get(obj.id) ?? 0,
            }));

            this.chunks.set(key, { key, entries, bounds });
        }
    }

    // ============================================================
    // Public LOD + frustum update — call this every frame from main.ts.
    // Internally throttled: a full pass runs only every LOD_UPDATE_INTERVAL frames.
    // ============================================================

    public updateLOD(camera: THREE.Camera): void {
        this._lodFrame++;

        // Update billboard camera uniform every frame (cheap — just a vec3 copy)
        this._billboardCamPos.value.copy(camera.position);

        if (this._lodFrame % LOD_UPDATE_INTERVAL !== 0) return;

        // Rebuild frustum from current camera matrices
        camera.updateMatrixWorld();
        this._projScreenMatrix.multiplyMatrices(
            (camera as THREE.PerspectiveCamera).projectionMatrix,
            camera.matrixWorldInverse,
        );
        this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

        const camPos = camera.position;

        for (const chunk of this.chunks.values()) {
            const chunkInFrustum = this._frustum.intersectsBox(chunk.bounds);

            for (const entry of chunk.entries) {
                // Destroyed objects stay hidden — skip them entirely
                if (this.currentlyHidden.has(entry.objId)) continue;

                const pos = this.objectPositions.get(entry.objId);
                if (!pos) continue;

                // Horizontal distance (camera height doesn't affect world-object LOD)
                const dx   = pos.x - camPos.x;
                const dz   = pos.y - camPos.z; // pos.y stores world Z
                const dist = Math.sqrt(dx * dx + dz * dz);

                const isTree  = entry.type === 'tree';
                const current = this.objectLodLevel.get(entry.objId) ?? 'detail';

                let target: LodLevel;

                if (isTree) {
                    // Trees ALWAYS use billboard — never 3D detail geometry.
                    // Only decision: billboard ('lod') vs culled ('hidden').
                    target = (!chunkInFrustum || dist > this._treeLodFarDistance) ? 'hidden' : 'lod';
                } else {
                    const lodNear = this._lodNearDistance;
                    const lodFar  = this._lodFarDistance;
                    const hysteresis = 15;

                    if (!chunkInFrustum || dist > lodFar) {
                        target = 'hidden';
                    } else if (dist > lodNear) {
                        target = current === 'detail' ? 'lod' : (dist < lodNear - hysteresis ? 'detail' : 'lod');
                    } else if (current === 'lod' && dist > lodNear - hysteresis) {
                        target = 'lod';
                    } else {
                        target = 'detail';
                    }

                    if (current === 'hidden' && target === 'lod' && dist > lodFar - hysteresis) {
                        target = 'hidden';
                    }
                }

                if (current === target) continue; // no state change, skip

                // Hide the currently visible representation
                if (current === 'detail') this._hideDetailSlot(entry.type, entry.detailIndex);
                else if (current === 'lod') this._hideLodSlot(entry.type, entry.lodIndex);

                // Show the new representation
                if (target === 'detail') this._showDetailSlot(entry.type, entry.detailIndex);
                else if (target === 'lod') this._showLodSlot(entry.type, entry.lodIndex);

                this.objectLodLevel.set(entry.objId, target);
            }
        }
    }

    // ============================================================
    // LOD slot helpers — hide / show without re-computing positions
    // ============================================================

    /** Shrink all detail mesh parts for one instance to near-zero scale */
    private _hideDetailSlot(type: string, index: number): void {
        const keys = DETAIL_KEYS[type] ?? [];
        for (const key of keys) {
            const im = this.instancedMeshes[key]?.[0];
            if (!im) continue;
            im.getMatrixAt(index, this._mat4);
            this._mat4.decompose(this._pos, this._quat, this._scale);
            this.dummy.position.copy(this._pos);
            this.dummy.quaternion.copy(this._quat);
            this.dummy.scale.set(0.0001, 0.0001, 0.0001);
            this.dummy.updateMatrix();
            im.setMatrixAt(index, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
        }
    }

    /** Restore detail mesh parts to their canonical scale */
    private _showDetailSlot(type: string, index: number): void {
        // Delegate to scaleInstance which already has per-type restore logic
        this.scaleInstance(type, index, 1);
    }

    /** Shrink all LOD mesh parts for one instance to near-zero scale */
    private _hideLodSlot(type: string, lodIndex: number): void {
        const keys = LOD_KEYS[type] ?? [];
        for (const key of keys) {
            const im = this.instancedMeshes[key]?.[0];
            if (!im) continue;
            im.getMatrixAt(lodIndex, this._mat4);
            this._mat4.decompose(this._pos, this._quat, this._scale);
            this.dummy.position.copy(this._pos);
            this.dummy.quaternion.copy(this._quat);
            this.dummy.scale.set(0.0001, 0.0001, 0.0001);
            this.dummy.updateMatrix();
            im.setMatrixAt(lodIndex, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
        }
    }

    /** Restore LOD mesh parts to the matrix baked in by setLodInstanceData */
    private _showLodSlot(type: string, lodIndex: number): void {
        const keys = LOD_KEYS[type] ?? [];
        // Use the cached original matrix (avoids reading back the 0.0001-scale hidden matrix)
        const cacheKey = `${type}:${lodIndex}`;
        const originalMatrix = this._originalLodMatrices.get(cacheKey);
        for (const key of keys) {
            const im = this.instancedMeshes[key]?.[0];
            if (!im) continue;
            if (originalMatrix) {
                im.setMatrixAt(lodIndex, originalMatrix);
            } else {
                // Fallback: read from current matrix (may be stale if hidden)
                im.getMatrixAt(lodIndex, this._mat4);
                this._mat4.decompose(this._pos, this._quat, this._scale);
                this.dummy.position.copy(this._pos);
                this.dummy.quaternion.copy(this._quat);
                this.dummy.scale.copy(this._scale);
                this.dummy.updateMatrix();
                im.setMatrixAt(lodIndex, this.dummy.matrix);
            }
            im.instanceMatrix.needsUpdate = true;
        }
    }

    private setInstanceData(obj: WorldObject, idx: number, visible: boolean = true): void {
        const scale = visible ? 1 : 0;
        const rotY = Math.random() * Math.PI * 2;

        if (obj.type === 'tree') {
            const imTrunk = this.instancedMeshes['treeTrunk'][0];
            const imFoliage = this.instancedMeshes['tree'][0];

            // 4 tree variations based on deterministic hash from position
            const variation = (Math.floor(obj.x * 7 + obj.y * 13)) % 4;

            let trunkH: number, foliageY: number;
            let fsx: number, fsy: number, fsz: number;
            let trunkSx = scale, trunkSy = scale, trunkSz = scale;

            switch (variation) {
                case 0: // Round oak (original)
                    trunkH = 0.6;
                    foliageY = 1.4;
                    fsx = scale; fsy = scale * 1.2; fsz = scale;
                    break;
                case 1: // Tall pine — narrow cone-like foliage
                    trunkH = 0.8;
                    trunkSy = scale * 1.4;
                    foliageY = 1.8;
                    fsx = scale * 0.5; fsy = scale * 2.0; fsz = scale * 0.5;
                    break;
                case 2: // Wide willow — large droopy canopy
                    trunkH = 0.5;
                    trunkSy = scale * 0.8;
                    foliageY = 1.1;
                    fsx = scale * 1.6; fsy = scale * 0.7; fsz = scale * 1.6;
                    break;
                case 3: // Bush — low and wide, no visible trunk
                    trunkH = 0.15;
                    trunkSy = scale * 0.3;
                    foliageY = 0.4;
                    fsx = scale * 1.2; fsy = scale * 0.6; fsz = scale * 1.2;
                    break;
                default:
                    trunkH = 0.6; foliageY = 1.4;
                    fsx = scale; fsy = scale * 1.2; fsz = scale;
            }

            // Small random size variation per tree
            const sizeVar = 0.7 + ((obj.x * 3 + obj.y * 7) % 100) / 100 * 0.6;
            const baseElevation = this.getElevation(obj.x, obj.y);

            this.dummy.position.set(obj.x, baseElevation + (trunkH * sizeVar), obj.y);
            this.dummy.scale.set(trunkSx * sizeVar, trunkSy * sizeVar, trunkSz * sizeVar);
            this.dummy.rotation.set(0, 0, 0);
            this.dummy.updateMatrix();
            imTrunk.setMatrixAt(idx, this.dummy.matrix);

            this.dummy.position.set(obj.x, baseElevation + (foliageY * sizeVar), obj.y);
            this.dummy.scale.set(fsx * sizeVar, fsy * sizeVar, fsz * sizeVar);
            this.dummy.updateMatrix();
            imFoliage.setMatrixAt(idx, this.dummy.matrix);

            imTrunk.instanceMatrix.needsUpdate = true;
            imFoliage.instanceMatrix.needsUpdate = true;
        }

        if (obj.type === 'barn') {
            const imBase = this.instancedMeshes['barnBase'][0];
            const imRoof = this.instancedMeshes['barnRoof'][0];
            const baseElevation = this.getElevation(obj.x, obj.y);

            this.dummy.position.set(obj.x, baseElevation + 1.0, obj.y);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.scale.set(scale, scale, scale);
            this.dummy.updateMatrix();
            imBase.setMatrixAt(idx, this.dummy.matrix);

            this.dummy.position.set(obj.x, baseElevation + 2.6, obj.y);
            this.dummy.rotation.set(0, rotY + Math.PI / 4, 0);
            this.dummy.updateMatrix();
            imRoof.setMatrixAt(idx, this.dummy.matrix);

            imBase.instanceMatrix.needsUpdate = true;
            imRoof.instanceMatrix.needsUpdate = true;
        }

        if (obj.type === 'car') {
            const imBody = this.instancedMeshes['car'][0];
            const imCabin = this.instancedMeshes['carCabin'][0];
            const baseElevation = this.getElevation(obj.x, obj.y);

            this.dummy.position.set(obj.x, baseElevation + 0.2, obj.y);
            this.dummy.scale.set(scale, scale, scale);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            imBody.setMatrixAt(idx, this.dummy.matrix);

            this.dummy.position.set(obj.x, baseElevation + 0.55, obj.y);
            this.dummy.updateMatrix();
            imCabin.setMatrixAt(idx, this.dummy.matrix);

            imBody.instanceMatrix.needsUpdate = true;
            imCabin.instanceMatrix.needsUpdate = true;
        }

        if (obj.type === 'animal') {
            const imBody = this.instancedMeshes['animal'][0];
            const imHead = this.instancedMeshes['animalHead'][0];

            this.dummy.position.set(obj.x, 0.3, obj.y);
            this.dummy.scale.set(scale * 1.2, scale * 0.8, scale * 0.8);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            imBody.setMatrixAt(idx, this.dummy.matrix);

            // Calculate head position based on body rotation
            const hx = Math.cos(rotY) * 0.3;
            const hz = -Math.sin(rotY) * 0.3;

            this.dummy.position.set(obj.x + hx, 0.35, obj.y + hz);
            this.dummy.scale.set(scale, scale, scale);
            this.dummy.updateMatrix();
            imHead.setMatrixAt(idx, this.dummy.matrix);

            imBody.instanceMatrix.needsUpdate = true;
            imHead.instanceMatrix.needsUpdate = true;
        }

        if (obj.type === 'trailer_park') {
            const im0 = this.instancedMeshes['trailerBase0']?.[0];
            const im1 = this.instancedMeshes['trailerBase1']?.[0];
            const im2 = this.instancedMeshes['trailerBase2']?.[0];
            if (!im0 || !im1 || !im2) return;
            const baseElevation = this.getElevation(obj.x, obj.y);

            // Three mobile homes arranged in a triangular cluster
            // Unit 0: centre
            this.dummy.position.set(obj.x,        baseElevation + 0.35, obj.y);
            this.dummy.scale.set(scale, scale, scale);
            this.dummy.rotation.set(0, rotY, 0);
            this.dummy.updateMatrix();
            im0.setMatrixAt(idx, this.dummy.matrix);

            // Unit 1: offset to the left/forward of rotY
            this.dummy.position.set(
                obj.x + Math.cos(rotY + Math.PI / 2) * 1.4,
                baseElevation + 0.35,
                obj.y + Math.sin(rotY + Math.PI / 2) * 1.4,
            );
            this.dummy.rotation.set(0, rotY + 0.15, 0);
            this.dummy.updateMatrix();
            im1.setMatrixAt(idx, this.dummy.matrix);

            // Unit 2: offset to the right/behind
            this.dummy.position.set(
                obj.x + Math.cos(rotY - Math.PI / 2) * 1.4,
                baseElevation + 0.35,
                obj.y + Math.sin(rotY - Math.PI / 2) * 1.4,
            );
            this.dummy.rotation.set(0, rotY - 0.15, 0);
            this.dummy.updateMatrix();
            im2.setMatrixAt(idx, this.dummy.matrix);

            im0.instanceMatrix.needsUpdate = true;
            im1.instanceMatrix.needsUpdate = true;
            im2.instanceMatrix.needsUpdate = true;
        }

        if (obj.type === 'stadium') {
            const imBase = this.instancedMeshes['stadiumBase']?.[0];
            const imRing = this.instancedMeshes['stadiumRing']?.[0];
            if (!imBase || !imRing) return;
            const baseElevation = this.getElevation(obj.x, obj.y);

            // Cylinder base centred on ground
            this.dummy.position.set(obj.x, baseElevation + 1.0 * scale, obj.y);
            this.dummy.scale.set(scale, scale, scale);
            this.dummy.rotation.set(0, rotY * 0.1, 0);
            this.dummy.updateMatrix();
            imBase.setMatrixAt(idx, this.dummy.matrix);

            // Torus ring sits at the top of the cylinder
            this.dummy.position.set(obj.x, baseElevation + 2.1 * scale, obj.y);
            this.dummy.scale.set(scale, scale, scale);
            this.dummy.rotation.set(Math.PI / 2, 0, 0); // lie flat
            this.dummy.updateMatrix();
            imRing.setMatrixAt(idx, this.dummy.matrix);

            imBase.instanceMatrix.needsUpdate = true;
            imRing.instanceMatrix.needsUpdate = true;
        }

    }

    /**
     * Apply a visual lean/lift/squeeze to world objects that are near a tornado.
     * Objects within 2× the destruction radius tilt toward the funnel, rise slightly,
     * and compress as if caught in the wind shear.
     *
     * Call once per frame from main.ts after updating tornado positions.
     * `tornadoPositions` is the same array passed to updateCloudDeformation.
     */
    // Reusable Quaternion for suction tilt — avoids allocation per object per frame
    private _tiltQuat = new THREE.Quaternion();
    // Reusable set for tracking affected object IDs — cleared each frame
    private _affectedThisFrame = new Set<number>();
    private _candidateIds = new Set<number>();
    private _dirtyInstancedMeshes = new Set<THREE.InstancedMesh>();

    public updateSuctionEffect(tornadoPositions: { x: number; z: number; radius: number }[]): void {
        this._suctionFrame++;
        // Throttle: run every other frame — the animation is smooth enough
        if (this._suctionFrame % 2 !== 0) return;
        if (tornadoPositions.length === 0) {
            // No tornadoes — restore any objects that were leaning
            if (this._suctionStrength.size > 0) {
                for (const [id, prevStrength] of this._suctionStrength) {
                    if (prevStrength > 0.001) {
                        const lvl = this.objectLodLevel.get(id) ?? 'detail';
                        if (lvl === 'detail') this._restoreObjectMatrix(id);
                    }
                }
                this._suctionStrength.clear();
            }
            return;
        }

        const affectedThisFrame = this._affectedThisFrame;
        affectedThisFrame.clear();

        // Spatial filtering: only check objects in chunks near each tornado.
        // Max suction radius = max tornado radius (~7) * 2.0 = 14 units.
        // CHUNK_SIZE = 200, so we only need to check the tornado's own chunk
        // and its immediate neighbours (3x3 = 9 chunks max per tornado).
        const candidateIds = this._candidateIds;
        candidateIds.clear();
        for (const t of tornadoPositions) {
            const cx = Math.floor(t.x / CHUNK_SIZE);
            const cz = Math.floor(t.z / CHUNK_SIZE);
            for (let dcx = -1; dcx <= 1; dcx++) {
                for (let dcz = -1; dcz <= 1; dcz++) {
                    const key = `${cx + dcx}_${cz + dcz}`;
                    const chunk = this.chunks.get(key);
                    if (!chunk) continue;
                    for (const entry of chunk.entries) {
                        candidateIds.add(entry.objId);
                    }
                }
            }
        }

        for (const id of candidateIds) {
            if (this.currentlyHidden.has(id)) continue;
            // Only apply suction to objects currently shown as full detail geometry.
            // LOD (billboard) and hidden objects must not have their detail mesh restored.
            const lodLevel = this.objectLodLevel.get(id) ?? 'detail';
            if (lodLevel !== 'detail') continue;

            const inst = this.objectInstances.get(id);
            if (!inst) continue;
            const pos = this.objectPositions.get(id);
            if (!pos) continue;

            // Find the nearest tornado and its influence
            let nearestDist2 = Infinity;
            let nearestTornado: { x: number; z: number; radius: number } | null = null;
            for (const t of tornadoPositions) {
                const dx = pos.x - t.x;
                const dz = pos.y - t.z; // pos.y stores world Z
                const d2 = dx * dx + dz * dz;
                if (d2 < nearestDist2) {
                    nearestDist2 = d2;
                    nearestTornado = t;
                }
            }
            if (!nearestTornado) continue;

            const suctionRadius = nearestTornado.radius * 2.0;
            const suctionRadius2 = suctionRadius * suctionRadius;

            if (nearestDist2 > suctionRadius2) {
                // Outside influence — restore if previously affected
                if (this._suctionStrength.has(id) && (this._suctionStrength.get(id) ?? 0) > 0.001) {
                    this._restoreObjectMatrix(id);
                    this._suctionStrength.set(id, 0);
                }
                continue;
            }

            affectedThisFrame.add(id);

            const dist = Math.sqrt(nearestDist2);
            const rawStrength = Math.max(0, 1.0 - dist / suctionRadius);
            const strength = rawStrength * rawStrength;
            this._suctionStrength.set(id, strength);
            if (strength < 0.005) continue;

            const keys = DETAIL_KEYS[inst.type] ?? [];
            if (keys.length === 0) continue;

            // Restore canonical matrix FIRST so we apply suction from the original
            // position — prevents liftY/tilt from accumulating frame over frame.
            this._restoreObjectMatrix(id);

            const primaryKey = keys[0];
            const im = this.instancedMeshes[primaryKey]?.[0];
            if (!im) continue;

            im.getMatrixAt(inst.index, this._suctionMat4);
            this._suctionMat4.decompose(this._suctionPos, this._suctionQuat, this._suctionScale);
            if (this._suctionScale.x < 0.01) continue;

            const dx = nearestTornado.x - pos.x;
            const dz = nearestTornado.z - pos.y;
            const invLen = dist > 0.001 ? 1.0 / dist : 0;
            const dirX = dx * invLen;
            const dirZ = dz * invLen;

            const tiltAngle = strength * 0.26;
            const tiltAxisX =  dirZ;
            const tiltAxisZ = -dirX;
            const halfAngle = tiltAngle * 0.5;
            const sinHalf   = Math.sin(halfAngle);
            const cosHalf   = Math.cos(halfAngle);
            this._tiltQuat.set(tiltAxisX * sinHalf, 0, tiltAxisZ * sinHalf, cosHalf).normalize();
            this._suctionQuat.multiplyQuaternions(this._tiltQuat, this._suctionQuat);

            // Apply lift as a fixed offset from the canonical position (not accumulated)
            const liftY = strength * nearestTornado.radius * 0.25;
            this._suctionPos.y += liftY;

            const squish = 1.0 - strength * 0.12;
            const stretch = 1.0 + strength * 0.08;
            this._suctionScale.x *= squish;
            this._suctionScale.z *= squish;
            this._suctionScale.y *= stretch;

            for (const key of keys) {
                const partIm = this.instancedMeshes[key]?.[0];
                if (!partIm) continue;

                if (key !== primaryKey) {
                    partIm.getMatrixAt(inst.index, this._suctionMat4);
                    this._suctionMat4.decompose(this._suctionPos, this._suctionQuat, this._suctionScale);
                    if (this._suctionScale.x < 0.01) continue;
                    this._suctionQuat.multiplyQuaternions(this._tiltQuat, this._suctionQuat);
                    this._suctionPos.y += liftY;
                    this._suctionScale.x *= squish;
                    this._suctionScale.z *= squish;
                    this._suctionScale.y *= stretch;
                }

                this.dummy.position.copy(this._suctionPos);
                this.dummy.quaternion.copy(this._suctionQuat);
                this.dummy.scale.copy(this._suctionScale);
                this.dummy.updateMatrix();
                partIm.setMatrixAt(inst.index, this.dummy.matrix);
                this._dirtyInstancedMeshes.add(partIm);
            }
        }

        // Batch-set needsUpdate once per dirty InstancedMesh
        for (const im of this._dirtyInstancedMeshes) {
            im.instanceMatrix.needsUpdate = true;
        }
        this._dirtyInstancedMeshes.clear();

        // Restore objects that were affected last frame but are no longer
        for (const [id, strength] of this._suctionStrength) {
            if (strength > 0.001 && !affectedThisFrame.has(id)) {
                // Only restore detail mesh if the object is still in 'detail' LOD level
                const lvl = this.objectLodLevel.get(id) ?? 'detail';
                if (lvl === 'detail') this._restoreObjectMatrix(id);
                this._suctionStrength.set(id, 0);
            }
        }
    }

    /** Restore an object's detail mesh to its canonical stored matrix. */
    private _restoreObjectMatrix(id: number): void {
        const inst = this.objectInstances.get(id);
        if (!inst) return;
        // Delegate to scaleInstance(type, index, 1) which already knows
        // the canonical per-type scale for each mesh part.
        this.scaleInstance(inst.type, inst.index, 1);
    }

    /**
     * @deprecated Use hideNewlyDestroyedObjects instead — avoids creating
     * a Set from the full destroyed IDs array every tick.
     */
    hideDestroyedObjects(destroyedIds: number[]): void {
        this.hideNewlyDestroyedObjects(destroyedIds);
    }

    /**
     * Hide only the newly-destroyed objects (a small list, usually 0-5 per tick).
     * No Set creation, no full-list iteration — O(k) where k = new destructions.
     */
    hideNewlyDestroyedObjects(newlyDestroyedIds: number[]): void {
        for (const id of newlyDestroyedIds) {
            if (this.currentlyHidden.has(id)) continue;
            const instance = this.objectInstances.get(id);
            if (!instance) continue;
            const level = this.objectLodLevel.get(id) ?? 'detail';
            if (level === 'detail') {
                this.scaleInstance(instance.type, instance.index, 0.0001);
            } else if (level === 'lod') {
                this._hideLodSlot(instance.type, this.objectLodIndex.get(id) ?? 0);
            }
            this.currentlyHidden.add(id);
        }
    }

    /**
     * Unhide a respawned object. Called when the server signals an object is active again.
     */
    unhideObject(id: number): void {
        if (!this.currentlyHidden.has(id)) return;
        const instance = this.objectInstances.get(id);
        if (instance) {
            if (instance.type === 'tree') {
                // Trees always use billboard — restore LOD slot, not detail
                const lodIdx = this.objectLodIndex.get(id) ?? 0;
                this._showLodSlot(instance.type, lodIdx);
                this.objectLodLevel.set(id, 'lod');
            } else {
                this.scaleInstance(instance.type, instance.index, 1);
                this.objectLodLevel.set(id, 'detail');
            }
        }
        this.currentlyHidden.delete(id);
    }

    private scaleInstance(type: string, index: number, scale: number): void {
        const keys = DETAIL_KEYS[type] ?? [];

        for (const key of keys) {
            const im = this.instancedMeshes[key]?.[0];
            if (!im) continue;

            // Reuse pre-allocated objects (zero GC)
            im.getMatrixAt(index, this._mat4);
            this._mat4.decompose(this._pos, this._quat, this._scale);

            this.dummy.position.copy(this._pos);
            this.dummy.quaternion.copy(this._quat);

            if (scale < 0.01) {
                this.dummy.scale.set(0.0001, 0.0001, 0.0001);
            } else {
                // Restore original non-uniform scales per mesh part
                if      (key === 'tree')                        this.dummy.scale.set(1, 1.2, 1);
                else if (key === 'animal' && type === 'animal') this.dummy.scale.set(1.2, 0.8, 0.8);
                else                                            this.dummy.scale.set(1, 1, 1);
                // All barn, trailer park, and stadium parts use uniform scale (1,1,1) — handled by the else above
            }

            this.dummy.updateMatrix();
            im.setMatrixAt(index, this.dummy.matrix);
            im.instanceMatrix.needsUpdate = true;
        }
    }

    getObjectPosition(id: number): { x: number; y: number } | null {
        // PERF: Direct lookup, no matrix decomposition
        return this.objectPositions.get(id) || null;
    }

    getObjectType(id: number): string | null {
        return this.objectInstances.get(id)?.type ?? null;
    }

    dispose(): void {
        for (const key in this.instancedMeshes) {
            for (const im of this.instancedMeshes[key]) {
                im.geometry.dispose();
                (im.material as THREE.Material).dispose();
            }
        }
        this.instancedMeshes = {};
        this.objectInstances.clear();
        this.objectLodLevel.clear();
        this.objectLodIndex.clear();
        this._originalLodMatrices.clear();
        this.chunks.clear();
    }
}
