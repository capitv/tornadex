// ============================================
// Anti-Cheat — Position & Growth Validation
// ============================================
// Runs every tick inside Game.ts. Does NOT kick players — logs warnings only.
// Rate-limited to avoid console flooding.

import { Logger } from './Logger.js';
import { PLAYER_SPEED, SPEED_BOOST_MULTIPLIER } from './constants.js';

const logger = new Logger('AntiCheat');

/** Per-player snapshot recorded at the end of each tick. */
interface PlayerSnapshot {
    x: number;
    y: number;
    radius: number;
}

/**
 * Maximum distance a player should be able to travel in one tick,
 * accounting for the worst-case speed boost + a 1.5x network-tolerance margin.
 */
const MAX_SPEED_TOLERANCE = PLAYER_SPEED * SPEED_BOOST_MULTIPLIER * 1.8 * 1.5;

/**
 * Minimum radius growth per tick to even consider suspicious.
 * Normal object destruction gives 0.02–0.15, admin grow gives 0.05.
 * We only flag growth > 0.20 which is beyond any single legitimate action.
 */
const RADIUS_GROWTH_THRESHOLD = 0.20;

/** Minimum ticks between consecutive warnings for the same player. */
const WARN_COOLDOWN_TICKS = 100; // ~5 seconds at 20 tick/s

export class AntiCheat {
    /** Previous-tick snapshots, keyed by player socket ID. */
    private snapshots: Map<string, PlayerSnapshot> = new Map();
    /** Tick of last warning per player, to rate-limit log spam. */
    private lastWarnTick: Map<string, number> = new Map();
    /** Global tick counter. */
    private tick: number = 0;

    /**
     * Call once per tick AFTER physics have been applied.
     *
     * @param players  Iterable of objects with id, x, y, radius.
     * @param absorbedIds  Set of player IDs that were absorbed/killed this tick.
     * @param playerHadLegitGrowth  Returns true if the player had a legitimate
     *   reason to grow this tick (destroyed objects, absorbed a player, etc.).
     */
    check(
        players: Iterable<{ id: string; x: number; y: number; radius: number; alive: boolean }>,
        absorbedIds: Set<string>,
        playerHadLegitGrowth: (id: string) => boolean,
    ): void {
        this.tick++;

        for (const player of players) {
            if (!player.alive) {
                this.snapshots.delete(player.id);
                continue;
            }

            const prev = this.snapshots.get(player.id);

            if (prev) {
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
    }
}
