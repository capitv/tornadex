import type { WorldObjectType } from './types.js';

export const WORLD_SIZE = 1500;
export const SAFE_ZONE_RADIUS = 60;
export const WORLD_ZONE_COUNT = 8;
export const ROAD_HALF_WIDTH = 8;
export const TRAILER_PARK_CLUSTER_COUNT = 5;
export const TREE_CLUSTER_COUNT = 50;
export const DEFAULT_OBJECT_CLUSTER_COUNT = 10;

export const OBJECT_COUNTS: Record<WorldObjectType, number> = {
    tree: 8000,
    barn: 0,
    car: 0,
    animal: 0,
    trailer_park: 0,
    stadium: 0,
};
