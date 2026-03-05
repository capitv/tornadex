// ============================================
// World Manager - Objects, Zones, Respawn
// ============================================

import { WorldObject, WorldObjectType, TerrainZone, SafeZone, PowerUp, PowerUpType, NpcVehicle } from '../shared/types.js';
import {
    WORLD_SIZE, OBJECT_COUNTS, OBJECT_RESPAWN_TICKS,
    POWERUP_COUNT_MIN, POWERUP_COUNT_MAX, POWERUP_RESPAWN_TICKS,
    SAFE_ZONE_RADIUS,
    VEHICLE_COUNT, VEHICLE_SPEED_MIN, VEHICLE_SPEED_MAX, VEHICLE_RESPAWN_TICKS,
} from './constants.js';
import { OBJECT_SIZES } from '../shared/types.js';
import { mulberry32 } from './prng.js';

export class World {
    objects: WorldObject[] = [];
    objectsById: Map<number, WorldObject> = new Map();
    destroyedIds: Set<number> = new Set();
    /** IDs destroyed since the last call to flushNewlyDestroyed(). */
    newlyDestroyedThisTick: number[] = [];
    /** Cached array of all destroyed IDs — rebuilt only when the set changes. */
    private _destroyedArray: number[] = [];
    private _destroyedArrayDirty: boolean = true;
    /** Cached array of active (non-destroyed) objects — rebuilt only when dirty. */
    private _activeObjectsCache: WorldObject[] = [];
    private _activeObjectsDirty: boolean = true;
    zones: TerrainZone[] = [];
    safeZones: SafeZone[] = [];
    powerUps: PowerUp[] = [];
    vehicles: NpcVehicle[] = [];
    readonly seed: number;
    private rng: () => number;
    private nextId: number = 0;
    private nextPowerUpId: number = 0;
    private nextVehicleId: number = 0;

    constructor(seed: number) {
        this.seed = seed;
        this.rng = mulberry32(seed);
        this.generateZones();
        this.generateSafeZones();
        this.generateObjects();
        this.generatePowerUps();
        this.generateVehicles();
    }

    private generateZones(): void {
        // Create terrain zones
        const zoneCount = 8;

        for (let i = 0; i < zoneCount; i++) {
            const types: Array<'water' | 'mountain'> = ['water', 'mountain'];
            const type = types[Math.floor(this.rng() * types.length)];
            const size = 80 + this.rng() * 200;

            this.zones.push({
                x: this.rng() * WORLD_SIZE,
                y: this.rng() * WORLD_SIZE,
                width: size + this.rng() * 100,
                height: size + this.rng() * 100,
                type,
            });
        }
    }

    private generateSafeZones(): void {
        // Four fixed safe haven positions spread across the map quadrants with a
        // small seed-based offset to give each map a slightly unique feel while
        // keeping zones balanced at the quadrant corners.
        const basePositions = [
            { x: WORLD_SIZE * 0.20, y: WORLD_SIZE * 0.20 }, // NW quadrant
            { x: WORLD_SIZE * 0.80, y: WORLD_SIZE * 0.20 }, // NE quadrant
            { x: WORLD_SIZE * 0.20, y: WORLD_SIZE * 0.80 }, // SW quadrant
            { x: WORLD_SIZE * 0.80, y: WORLD_SIZE * 0.80 }, // SE quadrant
        ];

        // Maximum offset from the base position (10 % of world size)
        const maxOffset = WORLD_SIZE * 0.10;

        for (const pos of basePositions) {
            const ox = (this.rng() - 0.5) * 2 * maxOffset;
            const oy = (this.rng() - 0.5) * 2 * maxOffset;
            this.safeZones.push({
                x: pos.x + ox,
                y: pos.y + oy,
                radius: SAFE_ZONE_RADIUS,
            });
        }
    }

    /**
     * Returns true if the given point is inside any safe zone.
     * Uses circle-point distance check.
     */
    isInSafeZone(x: number, y: number): boolean {
        for (const zone of this.safeZones) {
            const dx = x - zone.x;
            const dy = y - zone.y;
            if (dx * dx + dy * dy <= zone.radius * zone.radius) {
                return true;
            }
        }
        return false;
    }

    /**
     * Returns true if (x, y) falls on one of the 8 roads (4 vertical + 4 horizontal).
     * Roads are placed at worldSize/5 intervals with a configurable half-width buffer.
     */
    private isOnRoad(x: number, y: number, halfWidth: number = 8): boolean {
        for (let i = 1; i <= 4; i++) {
            const roadPos = (WORLD_SIZE / 5) * i;
            // Vertical road: fixed X, spans full Y
            if (Math.abs(x - roadPos) < halfWidth) return true;
            // Horizontal road: fixed Y, spans full X
            if (Math.abs(y - roadPos) < halfWidth) return true;
        }
        return false;
    }

    private generateObjects(): void {
        const types = Object.keys(OBJECT_COUNTS) as WorldObjectType[];

        for (const type of types) {
            const count = OBJECT_COUNTS[type];

            // ---- Trailer parks: spawn in 5 clusters of 3 each ----
            if (type === 'trailer_park') {
                const numClusters = 5;
                const perCluster = Math.ceil(count / numClusters);
                for (let c = 0; c < numClusters; c++) {
                    const cx = this.rng() * WORLD_SIZE;
                    const cy = this.rng() * WORLD_SIZE;
                    let spawned = 0;
                    for (let attempt = 0; spawned < perCluster && attempt < perCluster * 5; attempt++) {
                        const angle = this.rng() * Math.PI * 2;
                        const dist  = this.rng() * 30; // tight cluster radius
                        const nx = Math.max(0, Math.min(WORLD_SIZE, cx + Math.cos(angle) * dist));
                        const ny = Math.max(0, Math.min(WORLD_SIZE, cy + Math.sin(angle) * dist));
                        if (!this.isOnRoad(nx, ny)) {
                            this.objects.push(this.createObjectAt(type, nx, ny));
                            spawned++;
                        }
                    }
                }
                continue;
            }

            // ---- Default: general scattered clustering ----
            const clusters: { x: number; y: number; radius: number }[] = [];

            // Determine cluster count based on type
            let numClusters = 1;
            if (type === 'tree') numClusters = 50;       // 50 forest clusters
            else numClusters = 10;                       // general scattered clusters

            for (let c = 0; c < numClusters; c++) {
                clusters.push({
                    x: this.rng() * WORLD_SIZE,
                    y: this.rng() * WORLD_SIZE,
                    radius: 50 + this.rng() * 150, // Cluster spread
                });
            }

            for (let i = 0; i < count; i++) {
                // Pick a random cluster
                const cluster = clusters[Math.floor(this.rng() * clusters.length)];

                // Try up to 5 times to find a position NOT on a road
                let nx = 0, ny = 0;
                let placed = false;
                for (let attempt = 0; attempt < 5; attempt++) {
                    const angle = this.rng() * Math.PI * 2;
                    const dist = this.rng() * cluster.radius;

                    nx = cluster.x + Math.cos(angle) * dist;
                    ny = cluster.y + Math.sin(angle) * dist;

                    // Clamp to world bounds
                    nx = Math.max(0, Math.min(WORLD_SIZE, nx));
                    ny = Math.max(0, Math.min(WORLD_SIZE, ny));

                    if (!this.isOnRoad(nx, ny)) {
                        placed = true;
                        break;
                    }
                }

                // If all attempts landed on a road, skip this object (roads stay clear)
                if (!placed) continue;

                this.objects.push(this.createObjectAt(type, nx, ny));
            }
        }
    }

    private createObjectAt(type: WorldObjectType, x: number, y: number): WorldObject {
        const size = OBJECT_SIZES[type];
        const obj: WorldObject = {
            id: this.nextId++,
            type,
            x,
            y,
            size,
            health: 1,
            destroyed: false,
            respawnTimer: 0,
        };
        this.objectsById.set(obj.id, obj);
        return obj;
    }

    private generatePowerUps(): void {
        const count = POWERUP_COUNT_MIN + Math.floor(this.rng() * (POWERUP_COUNT_MAX - POWERUP_COUNT_MIN + 1));
        const types: PowerUpType[] = ['speed', 'growth', 'shield'];
        const margin = WORLD_SIZE * 0.05;

        for (let i = 0; i < count; i++) {
            const type = types[i % types.length];
            const x = margin + this.rng() * (WORLD_SIZE - margin * 2);
            const y = margin + this.rng() * (WORLD_SIZE - margin * 2);
            this.powerUps.push({
                id: this.nextPowerUpId++,
                type,
                x,
                y,
                active: true,
                respawnTimer: 0,
            });
        }
    }

    collectPowerUp(powerUp: PowerUp): void {
        powerUp.active = false;
        powerUp.respawnTimer = POWERUP_RESPAWN_TICKS;
    }

    // ---- NPC Vehicles ----

    /**
     * Spawns VEHICLE_COUNT vehicles distributed across the 4 roads.
     * Roads are straight lines at (WORLD_SIZE / 5) * i for i = 1..4.
     * Even road indices travel along the X axis (horizontal roads, constant Y).
     * Odd road indices travel along the Y axis (vertical roads, constant X).
     */
    private generateVehicles(): void {
        for (let i = 0; i < VEHICLE_COUNT; i++) {
            const roadIndex = i % 4; // spread evenly across the 4 roads
            this.vehicles.push(this.createVehicleOnRoad(roadIndex));
        }
    }

    /**
     * Create a new NpcVehicle placed at a random position along the given road.
     * Road 0: horizontal — travels left/right, Y is fixed at roadPos
     * Road 1: vertical   — travels up/down, X is fixed at roadPos
     * Road 2: horizontal — travels left/right, Y is fixed at roadPos
     * Road 3: vertical   — travels up/down, X is fixed at roadPos
     * (pattern repeats: even = horizontal, odd = vertical)
     */
    createVehicleOnRoad(roadIndex: number): NpcVehicle {
        const roadPos = (WORLD_SIZE / 5) * (roadIndex + 1);
        const isHorizontal = roadIndex % 2 === 0;
        const speed = VEHICLE_SPEED_MIN + Math.random() * (VEHICLE_SPEED_MAX - VEHICLE_SPEED_MIN);
        const direction: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
        const pos = Math.random() * WORLD_SIZE; // position along the travel axis

        return {
            id: this.nextVehicleId++,
            x: isHorizontal ? pos : roadPos,
            y: isHorizontal ? roadPos : pos,
            speed,
            roadIndex,
            direction,
            destroyed: false,
            respawnTimer: 0,
        };
    }

    /** Called by Game.ts when a tornado destroys a vehicle. */
    destroyVehicle(vehicle: NpcVehicle): void {
        vehicle.destroyed = true;
        vehicle.respawnTimer = VEHICLE_RESPAWN_TICKS;
    }

    /** Move all alive vehicles along their road and bounce at world edges. */
    updateVehicles(): void {
        for (const v of this.vehicles) {
            if (v.destroyed) {
                v.respawnTimer--;
                if (v.respawnTimer <= 0) {
                    // Respawn at a random position on the same road
                    const isHorizontal = v.roadIndex % 2 === 0;
                    const roadPos = (WORLD_SIZE / 5) * (v.roadIndex + 1);
                    const pos = Math.random() * WORLD_SIZE;
                    v.x = isHorizontal ? pos : roadPos;
                    v.y = isHorizontal ? roadPos : pos;
                    v.direction = Math.random() < 0.5 ? 1 : -1;
                    v.destroyed = false;
                    v.respawnTimer = 0;
                }
                continue;
            }

            const isHorizontal = v.roadIndex % 2 === 0;
            if (isHorizontal) {
                // Move along X axis
                v.x += v.speed * v.direction;
                if (v.x >= WORLD_SIZE) {
                    v.x = WORLD_SIZE;
                    v.direction = -1;
                } else if (v.x <= 0) {
                    v.x = 0;
                    v.direction = 1;
                }
            } else {
                // Move along Y axis
                v.y += v.speed * v.direction;
                if (v.y >= WORLD_SIZE) {
                    v.y = WORLD_SIZE;
                    v.direction = -1;
                } else if (v.y <= 0) {
                    v.y = 0;
                    v.direction = 1;
                }
            }
        }
    }

    update(): void {
        // Handle world object respawns
        for (const obj of this.objects) {
            if (obj.destroyed) {
                obj.respawnTimer--;
                if (obj.respawnTimer <= 0) {
                    obj.destroyed = false;
                    obj.health = 1;
                    this.destroyedIds.delete(obj.id);
                    this._destroyedArrayDirty = true;
                    this._activeObjectsDirty = true;
                }
            }
        }

        // Handle power-up respawns
        // Power-ups respawn at a new random position using Math.random() so that
        // the runtime respawn positions are not seeded (they don't affect map layout).
        const margin = WORLD_SIZE * 0.05;
        for (const pu of this.powerUps) {
            if (!pu.active) {
                pu.respawnTimer--;
                if (pu.respawnTimer <= 0) {
                    // Respawn at a new random position
                    pu.x = margin + Math.random() * (WORLD_SIZE - margin * 2);
                    pu.y = margin + Math.random() * (WORLD_SIZE - margin * 2);
                    pu.active = true;
                }
            }
        }
    }

    destroyObject(obj: WorldObject): void {
        obj.destroyed = true;
        // Add ±20% random jitter to prevent all objects respawning simultaneously
        obj.respawnTimer = Math.round(OBJECT_RESPAWN_TICKS * (0.8 + Math.random() * 0.4));
        this.destroyedIds.add(obj.id);
        this.newlyDestroyedThisTick.push(obj.id);
        this._destroyedArrayDirty = true;
        this._activeObjectsDirty = true;
    }

    /** Get a cached array of all destroyed IDs (rebuilt only when dirty). */
    getDestroyedIdsArray(): number[] {
        if (this._destroyedArrayDirty) {
            this._destroyedArray = Array.from(this.destroyedIds);
            this._destroyedArrayDirty = false;
        }
        return this._destroyedArray;
    }

    /** Call at the end of each tick to reset the newly-destroyed tracker. */
    flushNewlyDestroyed(): void {
        this.newlyDestroyedThisTick.length = 0;
    }

    getActiveObjects(): WorldObject[] {
        if (this._activeObjectsDirty) {
            this._activeObjectsCache = this.objects.filter(o => !o.destroyed);
            this._activeObjectsDirty = false;
        }
        return this._activeObjectsCache;
    }

    /** Mark the active objects cache as dirty (call when objects are destroyed or respawned). */
    markActiveObjectsDirty(): void {
        this._activeObjectsDirty = true;
    }

    getZoneAt(x: number, y: number): 'plain' | 'water' | 'mountain' {
        for (const zone of this.zones) {
            if (
                x >= zone.x && x <= zone.x + zone.width &&
                y >= zone.y && y <= zone.y + zone.height
            ) {
                return zone.type;
            }
        }
        return 'plain';
    }
}
