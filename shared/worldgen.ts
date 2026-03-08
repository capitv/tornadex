import type { SafeZone, TerrainZone, WorldObject, WorldObjectType } from './types.js';
import { OBJECT_SIZES } from './types.js';
import { mulberry32 } from './prng.js';
import {
    DEFAULT_OBJECT_CLUSTER_COUNT,
    OBJECT_COUNTS,
    ROAD_HALF_WIDTH,
    SAFE_ZONE_RADIUS,
    TRAILER_PARK_CLUSTER_COUNT,
    TREE_CLUSTER_COUNT,
    WORLD_SIZE,
    WORLD_ZONE_COUNT,
} from './worldConfig.js';

export interface StaticWorldLayout {
    worldSize: number;
    zones: TerrainZone[];
    safeZones: SafeZone[];
    objects: WorldObject[];
}

function clampToWorld(value: number): number {
    return Math.max(0, Math.min(WORLD_SIZE, value));
}

function isOnRoad(x: number, y: number, halfWidth: number = ROAD_HALF_WIDTH): boolean {
    for (let i = 1; i <= 4; i++) {
        const roadPos = (WORLD_SIZE / 5) * i;
        if (Math.abs(x - roadPos) < halfWidth) return true;
        if (Math.abs(y - roadPos) < halfWidth) return true;
    }
    return false;
}

export function generateStaticWorldLayout(seed: number): StaticWorldLayout {
    const rng = mulberry32(seed);
    const zones: TerrainZone[] = [];
    const safeZones: SafeZone[] = [];
    const objects: WorldObject[] = [];
    let nextObjectId = 0;

    const createObjectAt = (type: WorldObjectType, x: number, y: number): WorldObject => ({
        id: nextObjectId++,
        type,
        x,
        y,
        size: OBJECT_SIZES[type],
        health: 1,
        destroyed: false,
        respawnTimer: 0,
    });

    for (let i = 0; i < WORLD_ZONE_COUNT; i++) {
        const types: Array<'water' | 'mountain'> = ['water', 'mountain'];
        const type = types[Math.floor(rng() * types.length)];
        const size = 80 + rng() * 200;

        zones.push({
            x: rng() * WORLD_SIZE,
            y: rng() * WORLD_SIZE,
            width: size + rng() * 100,
            height: size + rng() * 100,
            type,
        });
    }

    const baseSafeZonePositions = [
        { x: WORLD_SIZE * 0.20, y: WORLD_SIZE * 0.20 },
        { x: WORLD_SIZE * 0.80, y: WORLD_SIZE * 0.20 },
        { x: WORLD_SIZE * 0.20, y: WORLD_SIZE * 0.80 },
        { x: WORLD_SIZE * 0.80, y: WORLD_SIZE * 0.80 },
    ];
    const maxSafeZoneOffset = WORLD_SIZE * 0.10;

    for (const pos of baseSafeZonePositions) {
        const ox = (rng() - 0.5) * 2 * maxSafeZoneOffset;
        const oy = (rng() - 0.5) * 2 * maxSafeZoneOffset;
        safeZones.push({
            x: pos.x + ox,
            y: pos.y + oy,
            radius: SAFE_ZONE_RADIUS,
        });
    }

    const types = Object.keys(OBJECT_COUNTS) as WorldObjectType[];
    for (const type of types) {
        const count = OBJECT_COUNTS[type];
        if (count <= 0) continue;

        if (type === 'trailer_park') {
            const perCluster = Math.ceil(count / TRAILER_PARK_CLUSTER_COUNT);
            for (let c = 0; c < TRAILER_PARK_CLUSTER_COUNT; c++) {
                const cx = rng() * WORLD_SIZE;
                const cy = rng() * WORLD_SIZE;
                let spawned = 0;
                for (let attempt = 0; spawned < perCluster && attempt < perCluster * 5; attempt++) {
                    const angle = rng() * Math.PI * 2;
                    const dist = rng() * 30;
                    const nx = clampToWorld(cx + Math.cos(angle) * dist);
                    const ny = clampToWorld(cy + Math.sin(angle) * dist);
                    if (!isOnRoad(nx, ny)) {
                        objects.push(createObjectAt(type, nx, ny));
                        spawned++;
                    }
                }
            }
            continue;
        }

        const clusters: Array<{ x: number; y: number; radius: number }> = [];
        const numClusters = type === 'tree' ? TREE_CLUSTER_COUNT : DEFAULT_OBJECT_CLUSTER_COUNT;
        for (let c = 0; c < numClusters; c++) {
            clusters.push({
                x: rng() * WORLD_SIZE,
                y: rng() * WORLD_SIZE,
                radius: 50 + rng() * 150,
            });
        }

        for (let i = 0; i < count; i++) {
            const cluster = clusters[Math.floor(rng() * clusters.length)];
            let nx = 0;
            let ny = 0;
            let placed = false;

            for (let attempt = 0; attempt < 5; attempt++) {
                const angle = rng() * Math.PI * 2;
                const dist = rng() * cluster.radius;
                nx = clampToWorld(cluster.x + Math.cos(angle) * dist);
                ny = clampToWorld(cluster.y + Math.sin(angle) * dist);
                if (!isOnRoad(nx, ny)) {
                    placed = true;
                    break;
                }
            }

            if (!placed) continue;
            objects.push(createObjectAt(type, nx, ny));
        }
    }

    return {
        worldSize: WORLD_SIZE,
        zones,
        safeZones,
        objects,
    };
}
