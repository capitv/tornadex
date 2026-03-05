// ============================================
// Server Entry Point - Express + Socket.IO
// ============================================

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { RoomManager } from './RoomManager.js';
import { Metrics } from './Metrics.js';
import { Logger } from './Logger.js';
import { SERVER_PORT, TICK_RATE } from './constants.js';
import { leaderboard as persistentLeaderboard } from './Leaderboard.js';
import type {
    ClientToServerEvents,
    ServerToClientEvents,
    InputPayload,
    HealthResponse,
    MetricsResponse,
} from '../shared/types.js';

const serverLogger = new Logger('Server');

const app = express();
const httpServer = createServer(app);

// ============================================================
// CORS Origin Whitelist (Task 4)
// ============================================================

const DEFAULT_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:3001',
    'https://tornadex.com',
    'https://www.tornadex.com',
];

const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
    },
    pingTimeout: 10000,
    pingInterval: 5000,
});

app.use(express.json());

// ---- Metrics ----
const metrics = new Metrics();

// ---- Room Manager ----
const roomManager = new RoomManager(io, metrics);
roomManager.ensureDefaultRoom();

// ============================================================
// Rate Limiting
// ============================================================
// Sliding-window counter (reset every second) per socket.
// Max 30 player:input events/sec. Three warnings → disconnect.

interface RateEntry {
    count: number;
    resetAt: number;   // Unix ms when the current window expires
    warnings: number;
}

const rateMap = new Map<string, RateEntry>();

// ============================================================
// Chat Rate Limiting
// ============================================================
// Max 3 messages per 5 seconds per player (sliding window).

interface ChatRateEntry {
    timestamps: number[];
}

const chatRateMap = new Map<string, ChatRateEntry>();

/**
 * Returns true if the chat message should be allowed through.
 * Enforces max 3 messages per 5-second window.
 */
function checkChatRate(socketId: string): boolean {
    const now = Date.now();
    let entry = chatRateMap.get(socketId);

    if (!entry) {
        entry = { timestamps: [] };
        chatRateMap.set(socketId, entry);
    }

    // Remove timestamps older than 5 seconds
    entry.timestamps = entry.timestamps.filter(t => now - t < 5000);

    if (entry.timestamps.length >= 3) {
        return false;
    }

    entry.timestamps.push(now);
    return true;
}

/**
 * Sanitize a chat message: strip HTML tags, trim whitespace, max 100 chars.
 * Returns null if the message is empty after sanitization.
 */
function sanitizeChatMessage(msg: unknown): string | null {
    if (typeof msg !== 'string') return null;
    // Strip HTML tags
    const stripped = msg.replace(/<[^>]*>/g, '');
    // Trim and cap at 100 characters
    const trimmed = stripped.trim().slice(0, 100);
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns true if the event should be allowed through.
 * Emits 'server:warning' and eventually disconnects abusers.
 */
function checkInputRate(socketId: string): boolean {
    const now = Date.now();
    let entry = rateMap.get(socketId);

    if (!entry || now >= entry.resetAt) {
        // Fresh window
        entry = { count: 1, resetAt: now + 1000, warnings: entry?.warnings ?? 0 };
        rateMap.set(socketId, entry);
        return true;
    }

    entry.count++;

    if (entry.count > 30) {
        entry.warnings++;
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.emit('server:warning', {
                message: `Rate limit exceeded (${entry.count} inputs/sec, max 30)`,
                warningCount: entry.warnings,
            });
        }

        if (entry.warnings >= 3) {
            serverLogger.warn(`Disconnecting ${socketId} for rate limit abuse (${entry.warnings} warnings)`);
            io.sockets.sockets.get(socketId)?.disconnect(true);
        }
        return false;
    }

    return true;
}

// ============================================================
// Input Validation
// ============================================================

const TWO_PI = Math.PI * 2;

function isValidInput(input: unknown): input is InputPayload {
    if (!input || typeof input !== 'object') return false;
    const p = input as Record<string, unknown>;

    // angle must be a finite number in [-π, π] or [0, 2π] (atan2 returns [-π, π])
    if (typeof p.angle !== 'number' || !Number.isFinite(p.angle)) return false;
    if (p.angle < -Math.PI || p.angle > TWO_PI) return false;

    // boost must be a boolean
    if (typeof p.boost !== 'boolean') return false;

    // active must be a boolean
    if (typeof p.active !== 'boolean') return false;

    return true;
}

// ============================================================
// Name Validation & Sanitization (Task 1)
// ============================================================

/** Strip HTML tags, trim, enforce length, and escape special characters. */
function sanitizeName(raw: unknown): string {
    if (typeof raw !== 'string') return 'Tornado';

    // Strip HTML tags
    let name = raw.replace(/<[^>]*>/g, '');

    // Trim whitespace
    name = name.trim();

    // Enforce length
    if (name.length < 1 || name.length > 16) {
        if (name.length > 16) {
            name = name.slice(0, 16);
        } else {
            return 'Tornado';
        }
    }

    // Sanitize: replace special characters with HTML entities
    name = name
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    // After sanitization, re-check that we still have content
    if (name.length < 1) return 'Tornado';

    return name;
}

// ============================================================
// Respawn Rate Limit (Task 5)
// ============================================================

/** Map of socketId → last respawn timestamp (Date.now()). */
const respawnCooldowns = new Map<string, number>();
const RESPAWN_COOLDOWN_MS = 2000;

// ============================================================
// Leaderboard API Rate Limit (Task 9)
// ============================================================

interface ApiRateEntry {
    count: number;
    resetTime: number; // epoch ms when the current minute window resets
}

const apiRateMap = new Map<string, ApiRateEntry>();
const API_RATE_MAX = 30;       // max requests per window
const API_RATE_WINDOW_MS = 60_000; // 1 minute

function checkApiRate(ip: string): boolean {
    const now = Date.now();
    let entry = apiRateMap.get(ip);

    if (!entry || now >= entry.resetTime) {
        entry = { count: 1, resetTime: now + API_RATE_WINDOW_MS };
        apiRateMap.set(ip, entry);
        return true;
    }

    entry.count++;
    return entry.count <= API_RATE_MAX;
}

// ============================================================
// Socket.IO Connection Handling
// ============================================================

io.on('connection', (socket) => {
    serverLogger.info(`Client connected: ${socket.id}`);

    socket.on('player:join', (data) => {
        // Validate and sanitize name (Task 1)
        const name = sanitizeName(data.name);

        const entry = roomManager.joinRoom(socket.id, name);

        // If room join was rejected (max rooms cap reached - Task 8)
        if (!entry) {
            socket.emit('game:error', { message: 'Server is full. Please try again later.' });
            return;
        }

        // Send join confirmation with this room's world state
        socket.emit('game:joined', {
            id: socket.id,
            worldSize: 2000,
            seed: entry.seed,
            zones: entry.game.world.zones,
            safeZones: entry.game.world.safeZones,
            objects: entry.game.world.objects,
        });
    });

    socket.on('player:input', (input) => {
        // Rate limit check
        if (!checkInputRate(socket.id)) return;

        // Input validation
        if (!isValidInput(input)) return;

        const entry = roomManager.getRoomForSocket(socket.id);
        if (!entry) return;

        const player = entry.game.players.get(socket.id);
        if (player) {
            player.setInput(input);
            // Record input for AFK tracking (Task 7)
            entry.game.recordInput(socket.id);
        }
    });

    socket.on('player:respawn', () => {
        // Respawn rate limit (Task 5)
        const now = Date.now();
        const lastRespawn = respawnCooldowns.get(socket.id);
        if (lastRespawn && (now - lastRespawn) < RESPAWN_COOLDOWN_MS) {
            return; // Silently ignore — cooldown not elapsed
        }
        respawnCooldowns.set(socket.id, now);

        const entry = roomManager.getRoomForSocket(socket.id);
        if (!entry) return;

        const player = entry.game.players.get(socket.id);
        if (player) {
            player.respawn();
        }
    });

    // Ping measurement: echo the client's timestamp straight back
    socket.on('ping:check', (data) => {
        socket.emit('ping:reply', { clientTime: data.clientTime });
    });

    // ---- Server-initiated RTT measurement for lag compensation ----
    // Send a ping every 2 seconds; client echoes it back immediately.
    // RTT is stored on the Player object for use in lag-compensated collisions.
    const rttInterval = setInterval(() => {
        socket.emit('server:rtt_ping', { t: Date.now() });
    }, 2000);

    socket.on('server:rtt_pong', (data) => {
        if (typeof data?.t !== 'number') return;
        const rtt = Date.now() - data.t;
        if (rtt < 0 || rtt > 5000) return; // sanity check
        // Update RTT on the player object (find across all rooms)
        const entry = roomManager.getRoomForSocket(socket.id);
        if (entry) {
            const player = entry.game.players.get(socket.id);
            if (player) {
                // Exponential moving average for smoothness (alpha = 0.3)
                player.rtt = player.rtt === 0 ? rtt : player.rtt * 0.7 + rtt * 0.3;
            }
        }
    });

    // ---- Chat ----
    socket.on('chat:send', (msg) => {
        // Rate limit: max 3 messages per 5 seconds
        if (!checkChatRate(socket.id)) return;

        // Sanitize the message
        const sanitized = sanitizeChatMessage(msg);
        if (!sanitized) return;

        // Find the player's name and room
        const entry = roomManager.getRoomForSocket(socket.id);
        if (!entry) return;

        const player = entry.game.players.get(socket.id);
        if (!player) return;

        // Broadcast to all players in the same room
        const roomSocketIds = entry.game.players.keys();
        const chatData = { name: player.name, msg: sanitized, timestamp: Date.now() };
        for (const sid of roomSocketIds) {
            const s = io.sockets.sockets.get(sid);
            if (s) s.emit('chat:message', chatData);
        }
    });

    socket.on('disconnect', () => {
        serverLogger.info(`Client disconnected: ${socket.id}`);
        clearInterval(rttInterval);
        roomManager.leaveRoom(socket.id);
        rateMap.delete(socket.id);
        respawnCooldowns.delete(socket.id);
        chatRateMap.delete(socket.id);
    });
});

// ============================================================
// REST API — Health, Metrics, Leaderboard, Replay
// ============================================================

// GET /health
app.get('/health', (_req, res) => {
    const body: HealthResponse = {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        rooms: roomManager.getRoomCount(),
        totalPlayers: roomManager.getTotalPlayerCount(),
        tickRate: TICK_RATE,
    };
    res.json(body);
});

// GET /metrics (Task 6 — protected endpoint)
app.get('/metrics', (req, res) => {
    // Allow from localhost or with valid bearer token
    const remoteAddr = req.ip || req.socket.remoteAddress || '';
    const isLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);

    const metricsToken = process.env.METRICS_TOKEN;
    let hasValidToken = false;
    if (metricsToken) {
        const authHeader = req.headers.authorization;
        hasValidToken = authHeader === `Bearer ${metricsToken}`;
    }

    if (!isLocalhost && !hasValidToken) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }

    const body: MetricsResponse = metrics.getSnapshot();
    res.json(body);
});

// ---- Leaderboard API rate limit middleware (Task 9) ----
app.use('/api', (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkApiRate(ip)) {
        res.status(429).json({ error: 'Too many requests. Max 30 per minute.' });
        return;
    }
    next();
});

// GET /api/leaderboard — top 20 all-time entries
app.get('/api/leaderboard', (_req, res) => {
    try {
        res.json(persistentLeaderboard.getTop(20));
    } catch (err) {
        serverLogger.error('/api/leaderboard error', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/leaderboard/daily — top 20 entries for today
app.get('/api/leaderboard/daily', (_req, res) => {
    try {
        res.json(persistentLeaderboard.getDaily(20));
    } catch (err) {
        serverLogger.error('/api/leaderboard/daily error', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/replay/:roomId/last/:seconds
app.get('/api/replay/:roomId/last/:seconds', (req, res) => {
    try {
        const seconds = Math.min(Math.max(parseInt(req.params.seconds, 10) || 5, 1), 30);
        const nTicks   = seconds * TICK_RATE;
        // Find the room by ID, or fall back to first available room for backwards compat
        const rm = roomManager as unknown as { rooms: Map<string, { id: string; game: import('./Game.js').Game }> };
        const allRooms = [...rm.rooms.values()];
        const targetRoom = allRooms.find(r => r.id === req.params.roomId) ?? allRooms[0];

        if (!targetRoom) {
            res.status(404).json({ error: 'No rooms available' });
            return;
        }

        const snapshots = targetRoom.game.replayBuffer.getLast(nTicks);
        res.json({
            roomId:    targetRoom.id,
            seconds,
            ticks:     snapshots.length,
            snapshots,
        });
    } catch (err) {
        serverLogger.error('/api/replay error', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// Graceful Shutdown
// ============================================================

const SHUTDOWN_COUNTDOWN_MS = 10_000;
let shuttingDown = false;

function gracefulShutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    serverLogger.info(`Received ${signal} — initiating graceful shutdown (${SHUTDOWN_COUNTDOWN_MS / 1000}s)`);

    // Notify all connected clients with a countdown
    io.emit('server:shutdown', {
        countdownMs: SHUTDOWN_COUNTDOWN_MS,
        reason: `Server is shutting down (${signal})`,
    });

    // After countdown: close connections and exit
    setTimeout(() => {
        serverLogger.info('Shutdown countdown complete — closing server');
        roomManager.stopAll();
        io.close(() => {
            httpServer.close(() => {
                serverLogger.info('HTTP server closed — exiting');
                process.exit(0);
            });
        });
        // Force exit fallback in case some connections stay open
        setTimeout(() => process.exit(0), 3000);
    }, SHUTDOWN_COUNTDOWN_MS);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ============================================================
// Start HTTP server
// ============================================================

httpServer.listen(SERVER_PORT, () => {
    serverLogger.info(`Tornado.IO Server running on http://localhost:${SERVER_PORT}`);
    serverLogger.info(`Health: http://localhost:${SERVER_PORT}/health`);
    serverLogger.info(`Metrics: http://localhost:${SERVER_PORT}/metrics`);
});
