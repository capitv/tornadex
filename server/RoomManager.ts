// ============================================
// RoomManager — Multi-Room System
// ============================================
// Manages a pool of Game instances ("rooms"). Each room holds up to MAX_ROOM_PLAYERS.
// When all rooms are full a new one is created automatically.
// When a room becomes empty it is destroyed after ROOM_EMPTY_TTL_MS milliseconds.

import { Game } from './Game.js';
import { Logger } from './Logger.js';
import { Metrics } from './Metrics.js';
import type { GameState } from '../shared/types.js';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/types.js';

const logger = new Logger('RoomManager');

/** Maximum real players per room (bots do not count toward this cap). */
export const MAX_ROOM_PLAYERS = 20;

/** After a room has been empty for this long (ms) it will be destroyed. */
const ROOM_EMPTY_TTL_MS = 30_000;

export interface RoomEntry {
    id: string;
    game: Game;
    seed: number;
    /** Timer that will destroy the room if it remains empty. null when occupied. */
    emptyTimer: ReturnType<typeof setTimeout> | null;
}

type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

export class RoomManager {
    private rooms: Map<string, RoomEntry> = new Map();
    private nextRoomId: number = 1;
    private io: IoServer;
    readonly metrics: Metrics;

    constructor(io: IoServer, metrics: Metrics) {
        this.io = io;
        this.metrics = metrics;
    }

    // ------------------------------------------------------------------ //
    //  Room lifecycle
    // ------------------------------------------------------------------ //

    private createRoom(): RoomEntry {
        const id = `room-${this.nextRoomId++}`;
        const seed = Math.floor(Math.random() * 0xFFFFFFFF) + 1;
        const game = new Game(seed);

        game.setCallbacks(
            // Per-player state update — scoped to Socket.IO room `id`
            (playerId: string, state: GameState) => {
                this.io.to(playerId).emit('game:state', state);
            },
            // Player death
            (playerId: string, killerName: string) => {
                this.io.to(playerId).emit('game:death', { killerName });
            },
            // Tick metrics hook
            (tickMs: number) => {
                this.metrics.recordTick(tickMs);
                this.metrics.update(this.getTotalPlayerCount(), this.rooms.size);
            },
        );

        game.start();

        const entry: RoomEntry = { id, game, seed, emptyTimer: null };
        this.rooms.set(id, entry);

        logger.info(`Room created: ${id}  seed=${seed}`);
        return entry;
    }

    private destroyRoom(id: string): void {
        const entry = this.rooms.get(id);
        if (!entry) return;

        if (entry.emptyTimer) {
            clearTimeout(entry.emptyTimer);
            entry.emptyTimer = null;
        }

        entry.game.stop();
        this.rooms.delete(id);
        logger.info(`Room destroyed: ${id}`);
        this.metrics.update(this.getTotalPlayerCount(), this.rooms.size);
    }

    /**
     * Schedule destruction of an empty room after ROOM_EMPTY_TTL_MS.
     * If the room gains a player before the timer fires, cancel via cancelEmptyTimer().
     */
    private scheduleEmptyDestroy(entry: RoomEntry): void {
        if (entry.emptyTimer) return; // already scheduled
        entry.emptyTimer = setTimeout(() => {
            logger.info(`Room ${entry.id} empty for ${ROOM_EMPTY_TTL_MS / 1000}s — destroying`);
            this.destroyRoom(entry.id);
        }, ROOM_EMPTY_TTL_MS);
    }

    private cancelEmptyTimer(entry: RoomEntry): void {
        if (entry.emptyTimer) {
            clearTimeout(entry.emptyTimer);
            entry.emptyTimer = null;
        }
    }

    // ------------------------------------------------------------------ //
    //  Player placement
    // ------------------------------------------------------------------ //

    /**
     * Find the room with the fewest real players that is not yet full.
     * If no such room exists, create a new one.
     */
    private getBestRoom(): RoomEntry {
        let best: RoomEntry | null = null;
        let bestCount = Infinity;

        for (const entry of this.rooms.values()) {
            const count = entry.game.getRealPlayerCount();
            if (count < MAX_ROOM_PLAYERS && count < bestCount) {
                best = entry;
                bestCount = count;
            }
        }

        if (!best) {
            best = this.createRoom();
        }

        return best;
    }

    /**
     * Assign a newly connected socket to a room.
     * Returns the room entry so the caller can emit `game:joined`.
     */
    joinRoom(socketId: string, playerName: string): RoomEntry {
        const entry = this.getBestRoom();

        // Cancel the empty-timer now that someone is joining
        this.cancelEmptyTimer(entry);

        const reconnected = entry.game.reconnectPlayer(playerName, socketId);
        if (!reconnected) {
            entry.game.addPlayer(socketId, playerName);
        }

        // Track which room this socket belongs to
        this.socketRoomMap.set(socketId, entry.id);

        logger.info(
            `Player ${playerName} (${socketId}) joined ${entry.id} ` +
            `[${entry.game.getRealPlayerCount()}/${MAX_ROOM_PLAYERS}]`,
        );

        return entry;
    }

    /** Remove a player from their room on disconnect. */
    leaveRoom(socketId: string): void {
        const roomId = this.socketRoomMap.get(socketId);
        if (!roomId) return;

        this.socketRoomMap.delete(socketId);

        const entry = this.rooms.get(roomId);
        if (!entry) return;

        entry.game.disconnectPlayer(socketId);

        // If the room now has no real players, schedule it for destruction.
        if (entry.game.getRealPlayerCount() === 0) {
            this.scheduleEmptyDestroy(entry);
        }
    }

    /** Look up the room a socket currently belongs to. */
    getRoomForSocket(socketId: string): RoomEntry | null {
        const roomId = this.socketRoomMap.get(socketId);
        if (!roomId) return null;
        return this.rooms.get(roomId) ?? null;
    }

    // ------------------------------------------------------------------ //
    //  Accessors
    // ------------------------------------------------------------------ //

    getTotalPlayerCount(): number {
        let total = 0;
        for (const entry of this.rooms.values()) {
            total += entry.game.getRealPlayerCount();
        }
        return total;
    }

    getRoomCount(): number {
        return this.rooms.size;
    }

    /** Ensure at least one room exists (call on server startup). */
    ensureDefaultRoom(): void {
        if (this.rooms.size === 0) {
            this.createRoom();
        }
    }

    /** Gracefully stop all rooms. */
    stopAll(): void {
        for (const entry of this.rooms.values()) {
            if (entry.emptyTimer) clearTimeout(entry.emptyTimer);
            entry.game.stop();
        }
        this.rooms.clear();
        this.socketRoomMap.clear();
    }

    // ------------------------------------------------------------------ //
    //  Internal socket→room index
    // ------------------------------------------------------------------ //
    private socketRoomMap: Map<string, string> = new Map();
}
