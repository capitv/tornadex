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

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
        origin: '*',
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

    // angle must be a finite number in [0, 2π]
    if (typeof p.angle !== 'number' || !Number.isFinite(p.angle)) return false;
    if (p.angle < 0 || p.angle > TWO_PI) return false;

    // boost must be a boolean
    if (typeof p.boost !== 'boolean') return false;

    // active must be a boolean
    if (typeof p.active !== 'boolean') return false;

    return true;
}

// ============================================================
// Socket.IO Connection Handling
// ============================================================

io.on('connection', (socket) => {
    serverLogger.info(`Client connected: ${socket.id}`);

    socket.on('player:join', (data) => {
        const entry = roomManager.joinRoom(socket.id, data.name);

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
        }
    });

    socket.on('player:respawn', () => {
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

    socket.on('disconnect', () => {
        serverLogger.info(`Client disconnected: ${socket.id}`);
        roomManager.leaveRoom(socket.id);
        rateMap.delete(socket.id);
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

// GET /metrics
app.get('/metrics', (_req, res) => {
    const body: MetricsResponse = metrics.getSnapshot();
    res.json(body);
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
