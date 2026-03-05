// ============================================
// Shared Types for Tornado.IO
// ============================================

export interface Vec2 {
    x: number;
    y: number;
}

export type PowerUpType = 'speed' | 'growth' | 'shield';

export interface PowerUp {
    id: number;
    type: PowerUpType;
    x: number;
    y: number;
    active: boolean;           // false = collected, waiting to respawn
    respawnTimer: number;      // ticks remaining until respawn
}

export interface ActiveEffect {
    type: PowerUpType;
    expiresAt: number;         // server tick count when effect expires
}

export interface PlayerState {
    id: string;
    name: string;
    x: number;
    y: number;
    radius: number;
    rotation: number;
    score: number;
    velocityX: number;
    velocityY: number;
    alive: boolean;
    stamina: number;           // 0-100, used for boost
    activeEffects: ActiveEffect[];
    protected: boolean;        // true when spawn protection or safe-zone shield is active
    afk: boolean;              // true when idle > 60 ticks (~3 seconds), triggers visual fade
    lastInputSeq: number;      // last input sequence number processed by the server
}

export type WorldObjectType = 'tree' | 'barn' | 'car' | 'animal' | 'trailer_park' | 'stadium';

export interface WorldObject {
    id: number;
    type: WorldObjectType;
    x: number;
    y: number;
    size: number;
    health: number;
    destroyed: boolean;
    respawnTimer: number;
}

export interface TerrainZone {
    x: number;
    y: number;
    width: number;
    height: number;
    type: 'plain' | 'water' | 'mountain';
}

/** A circular area where small tornadoes (radius < SAFE_ZONE_MAX_RADIUS) cannot be absorbed. */
export interface SafeZone {
    x: number;
    y: number;
    radius: number;
}

export interface KillEvent {
    killer: string;
    victim: string;
    killerRadius: number;
}

/**
 * NPC Vehicle — moves back and forth along one of the 4 road axes.
 * Roads are placed at worldSize/5 intervals (i = 1..4).
 *
 * The 4 roads are indexed 0–3:
 *   0–3: all are straight lines across the full map.
 *   Roads 0–3 alternate between vertical (constant X) and horizontal (constant Y)
 *   based on how World.ts generates them. Use `roadIndex` together with the seed
 *   to reconstruct the axis client-side, or simply use x/y positions directly.
 *
 * `direction`: +1 = increasing position along the road axis, -1 = decreasing.
 *
 * Client rendering: render as a small coloured box (~1×2 world-units) using
 * the existing instanced mesh infrastructure. Destroyed vehicles should be
 * hidden until respawn (respawnTimer > 0 means currently destroyed).
 */
export interface NpcVehicle {
    id: number;
    x: number;
    y: number;
    speed: number;          // world units per tick
    roadIndex: number;      // 0-based index (0–3)
    direction: 1 | -1;     // travel direction along the road axis
    destroyed: boolean;
    respawnTimer: number;   // ticks remaining until respawn
}

export interface GameState {
    players: PlayerState[];
    destroyedObjectIds: number[];
    leaderboard: LeaderboardEntry[];
    powerUps: PowerUp[];
    vehicles: NpcVehicle[];  // NPC vehicles driving on roads
    kills?: KillEvent[];
    serverTime: number;        // Date.now() on the server when this tick was processed
}

/**
 * Delta player state: id/x/y/rotation are always present (change every tick),
 * everything else is omitted when unchanged from the previous tick.
 */
export interface DeltaPlayerState {
    id: string;
    x: number;
    y: number;
    rotation: number;
    // Conditionally included fields
    name?: string;
    radius?: number;
    score?: number;
    velocityX?: number;
    velocityY?: number;
    alive?: boolean;
    stamina?: number;
    activeEffects?: ActiveEffect[];
    protected?: boolean;
    afk?: boolean;
    lastInputSeq?: number;
}

/**
 * Delta game state: only fields that changed since the last tick are included.
 * The client merges this onto a cached full GameState to reconstruct the current state.
 */
export interface DeltaGameState {
    players: DeltaPlayerState[];                // Always present; contains at least id/x/y/rotation
    serverTime: number;                         // Always present: server wall-clock time for this tick
    newDestroyedObjectIds?: number[];            // Only newly destroyed IDs since the last tick
    leaderboard?: LeaderboardEntry[];            // Only present when it changed
    powerUps?: PowerUp[];                        // Only present when it changed
    vehicles?: NpcVehicle[];                    // Only present when any vehicle state changed
    kills?: KillEvent[];                         // Only present when non-empty
}

export interface LeaderboardEntry {
    name: string;
    score: number;
    radius: number;
}

export interface InputPayload {
    angle: number;       // Direction angle in radians
    active: boolean;     // Whether player is providing input (moving)
    boost: boolean;      // Whether E key is held for speed boost
    adminGrow?: boolean; // Up arrow to grow (testing)
    adminShrink?: boolean; // Down arrow to shrink (testing)
    seq?: number;        // Monotonically increasing sequence number for reconciliation
}

// Socket.IO event types
export interface ServerToClientEvents {
    'game:state': (state: GameState) => void;
    'game:delta': (delta: DeltaGameState) => void;
    'game:death': (data: { killerName: string }) => void;
    'game:joined': (data: { id: string; worldSize: number; seed: number; zones: TerrainZone[]; safeZones: SafeZone[]; objects: WorldObject[] }) => void;
    'ping:reply': (data: { clientTime: number }) => void;
    /** Server-initiated RTT probe — client must echo the timestamp back. */
    'server:rtt_ping': (data: { t: number }) => void;
    /** Emitted to all clients before the server shuts down. countdownMs = ms until disconnect. */
    'server:shutdown': (data: { countdownMs: number; reason: string }) => void;
    /** Emitted to a player when they exceed rate limits. */
    'server:warning': (data: { message: string; warningCount: number }) => void;
}

export interface ClientToServerEvents {
    'player:join': (data: { name: string; seed?: number }) => void;
    'player:input': (input: InputPayload) => void;
    'player:respawn': () => void;
    'ping:check': (data: { clientTime: number }) => void;
    /** Response to server-initiated RTT probe. */
    'server:rtt_pong': (data: { t: number }) => void;
}

// ---- Health / Metrics ----

export interface HealthResponse {
    status: 'ok';
    uptime: number;
    rooms: number;
    totalPlayers: number;
    tickRate: number;
}

export interface MetricsResponse {
    tickDurationAvgMs: number;
    tickDurationMaxMs: number;
    playerCount: number;
    roomsActive: number;
    sampleCount: number;
}

// ---- Room info ----

export interface RoomInfo {
    id: string;
    playerCount: number;
    seed: number;
}

// Object points and growth values
export const OBJECT_VALUES: Record<WorldObjectType, { points: number; growth: number }> = {
    tree:         { points: 5,   growth: 0.02  },
    barn:         { points: 30,  growth: 0.06  },
    car:          { points: 15,  growth: 0.04  },
    animal:       { points: 10,  growth: 0.03  },
    trailer_park: { points: 100, growth: 0.08  },
    stadium:      { points: 200, growth: 0.15  },
};

// Object sizes (minimum tornado radius to destroy)
export const OBJECT_SIZES: Record<WorldObjectType, number> = {
    tree:         0.3,
    animal:       0.4,
    car:          0.8,
    barn:         1.0,
    trailer_park: 3.0,
    stadium:      4.0,
};
