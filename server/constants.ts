// ============================================
// Server Constants
// ============================================

import { WorldObjectType } from '../shared/types.js';

export const TICK_RATE = 20;                    // Ticks per second
export const TICK_INTERVAL = 1000 / TICK_RATE;  // ms per tick (50ms)

export const WORLD_SIZE = 1000;                 // Small dense world
export const MAX_PLAYERS = 50;

export const PLAYER_SPEED = 1.0;                // Base movement speed (units/tick)
export const PLAYER_MIN_RADIUS = 0.8;           // Starting tornado radius
export const PLAYER_MAX_RADIUS = 25;            // Maximum tornado radius
export const PLAYER_SPAWN_RADIUS = 0.8;

// Growth amounts per absorbed object — tuned so early levels feel rewarding
// while late-game (F4/F5) requires real effort to grow further.
export const OBJECT_GROWTH: Record<WorldObjectType, number> = {
    'animal':       0.003,
    'tree':         0.007,
    'car':          0.015,
    'barn':         0.04,
    'trailer_park': 0.05,
    'stadium':      0.10,
};

// Tornado absorption: attacker must be X times bigger
export const ABSORB_RATIO = 1.1;

// Decay when idle (per tick)
export const IDLE_DECAY_RATE = 0.001;
export const IDLE_SCORE_DECAY = 0.5;

// Mountain zone penalty (per tick)
export const MOUNTAIN_DECAY_RATE = 0.0005;

// Water zone debuff (speed multiplier — less than 1.0 = slower)
export const WATER_SPEED_MULT = 0.6;
// Water zone radius decay per tick (tornados weaken over water)
export const WATER_DECAY_RATE = 0.003;

// Object respawn time (ticks)
export const OBJECT_RESPAWN_TICKS = TICK_RATE * 30; // 30 seconds

// World object counts
export const OBJECT_COUNTS = {
    tree:         8000,  // Dense forests
    barn:         3,     // Scattered barns
    car:          150,   // Some traffic
    animal:       200,   // Wildlife
    trailer_park: 15,    // Rare high-value clusters
    stadium:      5,     // Very rare arena structures
};

// Spatial grid cell size
export const GRID_CELL_SIZE = 50;

// Server port
export const SERVER_PORT = 3001;

// Attraction radius multiplier (how far tornado sucks objects visually)
export const ATTRACTION_RADIUS_MULT = 2.5;

// Speed scales with size (bigger = slightly slower)
export const SPEED_SIZE_FACTOR = 0.015;

// ---- Power-ups ----
export const POWERUP_COUNT_MIN = 10;
export const POWERUP_COUNT_MAX = 18;
export const POWERUP_RESPAWN_TICKS = TICK_RATE * 30;   // 30 seconds
export const POWERUP_COLLECT_RADIUS = 1;               // extra radius added to player radius for collection

// Effect durations in ticks
export const POWERUP_DURATION: Record<string, number> = {
    speed:  TICK_RATE * 8,   // 8 seconds
    growth: TICK_RATE * 10,  // 10 seconds
    shield: TICK_RATE * 6,   // 6 seconds
};

// Speed boost multiplier
export const SPEED_BOOST_MULTIPLIER = 1.5;
// Growth boost multiplier (applied to radiusGrowth)
export const GROWTH_BOOST_MULTIPLIER = 2.0;

// ---- NPC Vehicles ----
/** Total number of NPC vehicles distributed across the 4 roads. */
export const VEHICLE_COUNT = 12;
/** Minimum vehicle speed in world units per tick (~3 u/s at 20 ticks/s). */
export const VEHICLE_SPEED_MIN = 0.15;
/** Maximum vehicle speed in world units per tick (~8 u/s at 20 ticks/s). */
export const VEHICLE_SPEED_MAX = 0.40;
/** Ticks before a destroyed vehicle respawns (10 seconds). */
export const VEHICLE_RESPAWN_TICKS = TICK_RATE * 10;
/** Points awarded for destroying an NPC vehicle. */
export const VEHICLE_POINTS = 150;
/** Radius growth awarded for destroying an NPC vehicle. */
export const VEHICLE_GROWTH = 0.06;
/** Minimum tornado radius required to destroy a vehicle (same as a car). */
export const VEHICLE_SIZE = 0.8;
/** Collision radius of a vehicle for tornado interaction. */
export const VEHICLE_COLLISION_RADIUS = 1.5;

// ---- Spawn Protection ----
/** Duration of spawn invulnerability in milliseconds (1.5 seconds). */
export const SPAWN_PROTECTION_MS = 1500;

// ---- Safe Haven Zones ----
/** Tornadoes with radius strictly below this value are protected inside safe zones (F0/F1 only). */
export const SAFE_ZONE_MAX_RADIUS = 1.5;
/** Visual/collision radius of each safe zone circle (world units). */
export const SAFE_ZONE_RADIUS = 60;
