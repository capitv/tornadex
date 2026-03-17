// ============================================
// Server Constants
// ============================================

import { WorldObjectType } from '../shared/types.js';
import { WORLD_SIZE, OBJECT_COUNTS, SAFE_ZONE_RADIUS } from '../shared/worldConfig.js';

export { WORLD_SIZE, OBJECT_COUNTS, SAFE_ZONE_RADIUS };

export const TICK_RATE = 20;                    // Ticks per second
export const TICK_INTERVAL = 1000 / TICK_RATE;  // ms per tick (50ms)

export const MAX_PLAYERS = 50;

export const PLAYER_SPEED = 1.0;                // Base movement speed (units/tick)
export const PLAYER_MIN_RADIUS = 0.8;           // Starting tornado radius
export const PLAYER_MAX_RADIUS = 33;            // Maximum tornado radius (+30% for F5 — was 25)
export const PLAYER_SPAWN_RADIUS = 0.8;

// Growth amounts per absorbed object.
// Tree reduced 0.0028→0.0018 to slow F0→F3 tree-farming progression.
export const OBJECT_GROWTH: Record<WorldObjectType, number> = {
    'animal':       0.0012,
    'tree':         0.0018, // was 0.0028 — slower early farming so F0-F2 stages last longer
    'car':          0.006,
    'barn':         0.016,
    'trailer_park': 0.02,
    'stadium':      0.04,
};

// Tornado absorption: attacker must be X times bigger
export const ABSORB_RATIO = 1.1;

// Decay when idle (per tick).
// IDLE_DECAY_RATE raised 0.001→0.0012 to add a slightly stronger penalty for standing still.
export const IDLE_DECAY_RATE = 0.0012;
export const IDLE_SCORE_DECAY = 0.5;

// Mountain zone penalty (per tick)
export const MOUNTAIN_DECAY_RATE = 0.0005;

// Water zone debuff (speed multiplier — less than 1.0 = slower)
export const WATER_SPEED_MULT = 0.6;
// Water zone radius decay per tick (tornados weaken over water)
export const WATER_DECAY_RATE = 0.003;

// Object respawn time (ticks)
export const OBJECT_RESPAWN_TICKS = TICK_RATE * 30; // 30 seconds

// World object counts (only trees — other types removed)
// Spatial grid cell size
export const GRID_CELL_SIZE = 50;

// Server port
export const SERVER_PORT = 3001;

// Attraction radius multiplier (how far tornado sucks objects visually)
export const ATTRACTION_RADIUS_MULT = 2.5;

// Speed scales with size (bigger = slower — large tornados are powerful but sluggish)
export const SPEED_SIZE_FACTOR = 0.025;

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
/** Radius growth awarded for destroying an NPC vehicle (halved). */
export const VEHICLE_GROWTH = 0.024;
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

// ---- Supercell Global Event ----
// Schedule: starts fast and short, then becomes rarer and longer
// Cooldowns: 5s, 60s (1m), 120s (2m), 180s (3m, repeats)
export const SUPERCELL_COOLDOWN_SCHEDULE_TICKS = [
    TICK_RATE * 5,
    TICK_RATE * 60,
    TICK_RATE * 120,
    TICK_RATE * 180,
];

// Durations: 5s first, then 10s (repeats)
export const SUPERCELL_DURATION_SCHEDULE_TICKS = [
    TICK_RATE * 5,
    TICK_RATE * 10,
];

export const SUPERCELL_RADIUS = 150; // Concentrated zone in the center
export const SUPERCELL_GROWTH_MULT = 2.0;

// ---- Split Ability ----
/** Minimum radius (F5 threshold) to activate split. */
export const SPLIT_MIN_RADIUS = 5.5;
/** How long the satellite persists before auto-merging (30 seconds). */
export const SPLIT_DURATION_TICKS = TICK_RATE * 30;
