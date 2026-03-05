// ============================================
// Interpolation — Timestamp-Based Smooth State
// ============================================
//
// Design overview:
//   - Each player keeps a ring buffer of 5 snapshots.  When a new server
//     state arrives the oldest slot is overwritten (no allocation).
//   - The render time is: renderTime = Date.now() - INTERP_DELAY_MS
//     This places the client 70 ms behind the server so it always has
//     at least two bracketing snapshots to interpolate between.
//   - The interpolation factor t is calculated as:
//       t = (renderTime - snap[a].time) / (snap[b].time - snap[a].time)
//     and clamped to [0, 1].
//   - All pre-allocation and zero-copy patterns from the previous system
//     are preserved:  copyPlayerState, makePlayerState, stable outputMap.

import type { PlayerState } from '../../shared/types.js';

/** How many milliseconds behind the server the client renders. */
export const INTERP_DELAY_MS = 70;

/** Number of snapshot slots in the per-player ring buffer. */
const SNAPSHOT_COUNT = 5;

interface Snapshot {
    state: PlayerState;
    /** Server wall-clock time (Date.now()) when this snapshot was taken. */
    time: number;
}

/** Per-player interpolation data using a fixed-size ring buffer. */
interface InterpolatedPlayer {
    /** Pre-allocated snapshot ring buffer. */
    snapshots: Snapshot[];
    /** Index into snapshots[] of the OLDEST slot (next to be overwritten). */
    oldestIdx: number;
    /** How many snapshots have been filled (0-5). Reaches SNAPSHOT_COUNT and stays there. */
    filledCount: number;
    /** Ticks since this player was last included in a server update.
     *  Used to tolerate network-throttled gaps without removing the player. */
    ticksSinceLastSeen: number;
}

/** Copy every field of `source` into `target` in-place, avoiding allocation. */
function copyPlayerState(target: PlayerState, source: PlayerState): void {
    target.id            = source.id;
    target.name          = source.name;
    target.x             = source.x;
    target.y             = source.y;
    target.radius        = source.radius;
    target.rotation      = source.rotation;
    target.score         = source.score;
    target.velocityX     = source.velocityX;
    target.velocityY     = source.velocityY;
    target.alive         = source.alive;
    target.stamina       = source.stamina;
    target.activeEffects = source.activeEffects;
    target.protected     = source.protected;
    target.afk           = source.afk;
    target.lastInputSeq  = source.lastInputSeq;
}

/** Create a zeroed-out PlayerState used for pre-allocation. */
function makePlayerState(): PlayerState {
    return {
        id: '', name: '',
        x: 0, y: 0,
        radius: 0, rotation: 0,
        score: 0,
        velocityX: 0, velocityY: 0,
        alive: false,
        stamina: 0,
        activeEffects: [],
        protected: false,
        afk: false,
        lastInputSeq: 0,
    };
}

/** Create one pre-allocated Snapshot slot. */
function makeSnapshot(): Snapshot {
    return { state: makePlayerState(), time: 0 };
}

/** Linear interpolation between two numbers. */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export class Interpolation {
    private players: Map<string, InterpolatedPlayer> = new Map();

    /** Persistent output map — entries are updated in-place each frame. */
    private outputMap: Map<string, PlayerState> = new Map();

    /**
     * Ingest a new server state snapshot.
     *
     * @param players     The player array from the latest GameState.
     * @param serverTime  The server's Date.now() timestamp for this tick
     *                    (GameState.serverTime).
     */
    updateState(players: PlayerState[], serverTime: number): void {
        const currentIds = new Set<string>();

        for (const p of players) {
            currentIds.add(p.id);

            const existing = this.players.get(p.id);
            if (existing) {
                // Write into the oldest slot and advance the ring index
                const slot = existing.snapshots[existing.oldestIdx];
                copyPlayerState(slot.state, p);
                slot.time = serverTime;
                existing.oldestIdx = (existing.oldestIdx + 1) % SNAPSHOT_COUNT;
                if (existing.filledCount < SNAPSHOT_COUNT) existing.filledCount++;
                existing.ticksSinceLastSeen = 0;
            } else {
                // New player — pre-allocate all slots and fill them with the
                // initial state so interpolation starts with valid data.
                const snaps: Snapshot[] = [];
                for (let i = 0; i < SNAPSHOT_COUNT; i++) {
                    const s = makeSnapshot();
                    copyPlayerState(s.state, p);
                    s.time = serverTime;
                    snaps.push(s);
                }

                const entry: InterpolatedPlayer = {
                    snapshots:          snaps,
                    oldestIdx:          1, // slot 0 is the "latest", 1 is next to overwrite
                    filledCount:        SNAPSHOT_COUNT,
                    ticksSinceLastSeen: 0,
                };
                this.players.set(p.id, entry);

                // Pre-allocate the corresponding output slot
                const out = makePlayerState();
                copyPlayerState(out, p);
                this.outputMap.set(p.id, out);
            }
        }

        // Only remove players that haven't been seen for a while (>40 ticks ≈ 2 seconds).
        // The network throttle omits distant players on most ticks, so a missing player
        // does NOT mean they disconnected — they may just be far away.
        for (const [id, data] of this.players) {
            if (!currentIds.has(id)) {
                data.ticksSinceLastSeen++;
                if (data.ticksSinceLastSeen > 40) {
                    this.players.delete(id);
                    this.outputMap.delete(id);
                }
            }
        }
    }

    /**
     * Produce interpolated PlayerState for every tracked player.
     *
     * For each player the method finds the two snapshots that bracket
     * `renderTime = Date.now() - INTERP_DELAY_MS`, computes t in [0,1]
     * and linearly interpolates x, y, radius.  Non-positional fields are
     * copied directly from the newer snapshot.
     *
     * The local player identified by `localId` is exempt from delay —
     * its latest snapshot is used verbatim so client-side prediction
     * in main.ts is not fighting interpolation lag.
     *
     * @returns The persistent outputMap (entries mutated in-place).
     */
    interpolate(localId: string): Map<string, PlayerState> {
        const renderTime = Date.now() - INTERP_DELAY_MS;

        for (const [id, data] of this.players) {
            const out = this.outputMap.get(id)!;

            if (data.filledCount < 2) {
                // Only one snapshot available — nothing to interpolate yet.
                copyPlayerState(out, data.snapshots[0].state);
                continue;
            }

            if (id === localId) {
                // Local player: use the most-recently-received server state
                // directly so it can be blended with client prediction in main.ts
                // without fighting the interpolation delay.
                const latestIdx = (data.oldestIdx + SNAPSHOT_COUNT - 1) % SNAPSHOT_COUNT;
                copyPlayerState(out, data.snapshots[latestIdx].state);
                continue;
            }

            // Find the two snapshots that bracket renderTime.
            // The ring buffer holds up to SNAPSHOT_COUNT entries ordered
            // oldest to newest starting at oldestIdx.
            // We walk from oldest to newest to find the pair where
            // snap[a].time <= renderTime <= snap[b].time.
            const filled = Math.min(data.filledCount, SNAPSHOT_COUNT);

            // Build ordered indices from oldest to newest
            let snapA: Snapshot = data.snapshots[data.oldestIdx % SNAPSHOT_COUNT];
            let snapB: Snapshot = snapA;
            let foundPair = false;

            for (let k = 0; k < filled - 1; k++) {
                const idxA = (data.oldestIdx + k) % SNAPSHOT_COUNT;
                const idxB = (data.oldestIdx + k + 1) % SNAPSHOT_COUNT;
                const sA = data.snapshots[idxA];
                const sB = data.snapshots[idxB];
                if (renderTime <= sB.time) {
                    snapA = sA;
                    snapB = sB;
                    foundPair = true;
                    break;
                }
                // Keep tracking the latest pair in case renderTime is beyond all snapshots
                snapA = sA;
                snapB = sB;
            }

            if (!foundPair) {
                // renderTime is beyond the newest snapshot — use the two most recent
                const newestIdx = (data.oldestIdx + filled - 1) % SNAPSHOT_COUNT;
                const prevIdx   = (data.oldestIdx + filled - 2) % SNAPSHOT_COUNT;
                snapA = data.snapshots[prevIdx];
                snapB = data.snapshots[newestIdx];
            }

            const snapDt = snapB.time - snapA.time;
            let t: number;
            if (snapDt <= 0) {
                t = 1; // identical timestamps — show the newer state
            } else {
                t = (renderTime - snapA.time) / snapDt;
                // Clamp to [0, 1] for normal interpolation
                if (t < 0) t = 0;
                if (t > 1) t = 1;
            }

            // Interpolate spatial fields
            out.x      = lerp(snapA.state.x,      snapB.state.x,      t);
            out.y      = lerp(snapA.state.y,       snapB.state.y,      t);
            out.radius = lerp(snapA.state.radius,  snapB.state.radius, t);

            // Interpolate rotation (continuous spin value — simple lerp works)
            out.rotation = snapA.state.rotation + (snapB.state.rotation - snapA.state.rotation) * t;

            // Velocity-based extrapolation for remote players when data runs out
            // (t reached 1.0 meaning renderTime is at or past the newest snapshot).
            // Cap extrapolation to 100ms to prevent wild predictions.
            if (t >= 1.0 && snapDt > 0) {
                const overshootMs = renderTime - snapB.time;
                const extraMs = Math.min(overshootMs, 100); // cap at 100ms
                if (extraMs > 0) {
                    // velocityX/Y are in units/tick (50ms), convert to units/ms
                    const vxPerMs = snapB.state.velocityX / 50;
                    const vyPerMs = snapB.state.velocityY / 50;
                    out.x += vxPerMs * extraMs;
                    out.y += vyPerMs * extraMs;
                }
            }

            // Non-interpolated fields: take from the newer snapshot
            out.id            = snapB.state.id;
            out.name          = snapB.state.name;
            out.score         = snapB.state.score;
            out.velocityX     = snapB.state.velocityX;
            out.velocityY     = snapB.state.velocityY;
            out.alive         = snapB.state.alive;
            out.stamina       = snapB.state.stamina;
            out.activeEffects = snapB.state.activeEffects;
            out.protected     = snapB.state.protected;
            out.afk           = snapB.state.afk;
            out.lastInputSeq  = snapB.state.lastInputSeq;
        }

        return this.outputMap;
    }

    /**
     * Return the raw (non-interpolated) current state for a player.
     * Uses the most recently received snapshot.
     */
    getPlayer(id: string): PlayerState | undefined {
        const data = this.players.get(id);
        if (!data) return undefined;
        const latestIdx = (data.oldestIdx + SNAPSHOT_COUNT - 1) % SNAPSHOT_COUNT;
        return data.snapshots[latestIdx].state;
    }

    clear(): void {
        this.players.clear();
        this.outputMap.clear();
    }
}
