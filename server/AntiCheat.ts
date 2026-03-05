// ============================================
// Anti-Cheat — Position & Growth Validation
// ============================================
// Runs every tick inside Game.ts. Tracks violations per player and
// returns IDs of players that should be kicked after 3 violations
// within a 60-second window.

import { Logger } from './Logger.js';
import { PLAYER_SPEED, SPEED_BOOST_MULTIPLIER } from './constants.js';

const logger = new Logger('AntiCheat');

/** Per-player snapshot recorded at the end of each tick. */
interface PlayerSnapshot {
    x: number;
    y: number;
    radius: number;
}

/** Violation tracking entry. */
interface ViolationEntry {
    count: number;
    firstTime: number; // Date.now() epoch ms when the first violation in this window occurred
}

/**
 * Maximum distance a player should be able to travel in one tick,
 * accounting for the worst-case speed boost + a 1.5x network-tolerance margin.
 */
const MAX_SPEED_TOLERANCE = PLAYER_SPEED * SPEED_BOOST_MULTIPLIER * 1.8 * 1.5;

/**
 * Minimum radius growth per tick to even consider suspicious.
 * Normal object destruction gives 0.02–0.15.
 * We only flag growth > 0.20 which is beyond any single legitimate action.
 */
const RADIUS_GROWTH_THRESHOLD = 0.20;

/** Minimum ticks between consecutive warnings for the same player. */
const WARN_COOLDOWN_TICKS = 100; // ~5 seconds at 20 tick/s

/** Violation window in ms — violations older than this are reset. */
const VIOLATION_WINDOW_MS = 60_000;

/** Number of violations within the window before a kick is issued. */
const MAX_VIOLATIONS = 3;

export class AntiCheat {
    /** Previous-tick snapshots, keyed by player socket ID. */
    private snapshots: Map<string, PlayerSnapshot> = new Map();
    /** Tick of last warning per player, to rate-limit log spam. */
    private lastWarnTick: Map<string, number> = new Map();
    /** Global tick counter. */
    private tick: number = 0;
    /** Violation tracker keyed by player socket ID. */
    private violations: Map<string, ViolationEntry> = new Map();

    /**
     * Call once per tick AFTER physics have been applied.
     *
     * @param players  Iterable of objects with id, x, y, radius.
     * @param absorbedIds  Set of player IDs that were absorbed/killed this tick.
     * @param playerHadLegitGrowth  Returns true if the player had a legitimate
     *   reason to grow this tick (destroyed objects, absorbed a player, etc.).
     * @returns Array of player IDs that should be kicked (3+ violations in 60s).
     */
    check(
        players: Iterable<{ id: string; x: number; y: number; radius: number; alive: boolean }>,
        absorbedIds: Set<string>,
        playerHadLegitGrowth: (id: string) => boolean,
    ): string[] {
        this.tick++;
        const toKick: string[] = [];

        for (const player of players) {
            if (!player.alive) {
                this.snapshots.delete(player.id);
                continue;
            }

            const prev = this.snapshots.get(player.id);

            if (prev) {
                let violated = false;

                // --- Position check ---
                const dx = player.x - prev.x;
                const dy = player.y - prev.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > MAX_SPEED_TOLERANCE) {
                    this._warnThrottled(
                        player.id,
                        `Player ${player.id} moved ${dist.toFixed(2)} units in one tick ` +
                        `(max allowed: ${MAX_SPEED_TOLERANCE.toFixed(2)}) — possible teleport/speed hack`,
                    );
                    violated = true;
                }

                // --- Radius growth check ---
                const radiusDelta = player.radius - prev.radius;
                if (radiusDelta > RADIUS_GROWTH_THRESHOLD) {
                    const legit = playerHadLegitGrowth(player.id);
                    if (!legit) {
                        this._warnThrottled(
                            player.id,
                            `Player ${player.id} radius grew by ${radiusDelta.toFixed(4)} ` +
                            `without legitimate cause — suspicious`,
                        );
                        violated = true;
                    }
                }

                // --- Violation tracking ---
                if (violated) {
                    const shouldKick = this._recordViolation(player.id);
                    if (shouldKick) {
                        toKick.push(player.id);
                    }
                }
            }

            // Record snapshot for next tick
            this.snapshots.set(player.id, {
                x: player.x,
                y: player.y,
                radius: player.radius,
            });
        }

        return toKick;
    }

    /**
     * Record a violation for a player. Returns true if the player should be kicked.
     */
    private _recordViolation(playerId: string): boolean {
        const now = Date.now();
        let entry = this.violations.get(playerId);

        if (!entry || (now - entry.firstTime) > VIOLATION_WINDOW_MS) {
            // Start a new window
            entry = { count: 1, firstTime: now };
            this.violations.set(playerId, entry);
            return false;
        }

        entry.count++;

        if (entry.count >= MAX_VIOLATIONS) {
            logger.warn(`Kicking player ${playerId} for ${entry.count} anti-cheat violations within 60s`);
            return true;
        }

        return false;
    }

    /** Rate-limited warning: at most one log per player per WARN_COOLDOWN_TICKS. */
    private _warnThrottled(playerId: string, message: string): void {
        const lastTick = this.lastWarnTick.get(playerId) ?? -Infinity;
        if (this.tick - lastTick < WARN_COOLDOWN_TICKS) return;
        this.lastWarnTick.set(playerId, this.tick);
        logger.warn(message);
    }

    /** Remove tracking data when a player fully leaves the game. */
    removePlayer(id: string): void {
        this.snapshots.delete(id);
        this.lastWarnTick.delete(id);
        this.violations.delete(id);
    }
}
