// ============================================
// Interpolation — Timestamp-Based Smooth State
// ============================================
//
// Design overview:
//   - Each player keeps a ring buffer of 3 snapshots.  When a new server
//     state arrives the oldest slot is overwritten (no allocation).
//   - The render time is: renderTime = Date.now() - INTERP_DELAY_MS
//     This places the client 100 ms behind the server so it always has
//     at least two bracketing snapshots to interpolate between.
//   - The interpolation factor t is calculated as:
//       t = (renderTime - snap[a].time) / (snap[b].time - snap[a].time)
//     and clamped to [0, 1].
//   - All pre-allocation and zero-copy patterns from the previous system
//     are preserved:  copyPlayerState, makePlayerState, stable outputMap.

import type { PlayerState } from '../../shared/types.js';

/** How many milliseconds behind the server the client renders. */
export const INTERP_DELAY_MS = 100;

/** Number of snapshot slots in the per-player ring buffer. */
const SNAPSHOT_COUNT = 3;

interface Snapshot {
    state: PlayerState;
    /** Server wall-clock time (Date.now()) when this snapshot was taken. */
    time: number;
}

/** Per-player interpolation data using a fixed-size ring buffer. */
interface InterpolatedPlayer {
    /** Pre-allocated snapshot ring buffer. */
    snapshots: [Snapshot, Snapshot, Snapshot];
    /** Index into snapshots[] of the OLDEST slot (next to be overwritten). */
    oldestIdx: number;
    /** How many snapshots have been filled (0-3). Reaches 3 and stays there. */
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
                const snap0 = makeSnapshot();
                const snap1 = makeSnapshot();
                const snap2 = makeSnapshot();
                copyPlayerState(snap0.state, p); snap0.time = serverTime;
                copyPlayerState(snap1.state, p); snap1.time = serverTime;
                copyPlayerState(snap2.state, p); snap2.time = serverTime;

                const entry: InterpolatedPlayer = {
                    snapshots:          [snap0, snap1, snap2],
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
            // The ring buffer holds up to 3 entries; we need the newest pair
            // where snap[a].time <= renderTime <= snap[b].time.
            //
            // Order the slots from oldest to newest:
            //   oldestIdx   → the slot about to be overwritten next
            //   oldestIdx+1 → middle
            //   oldestIdx+2 → newest  (= (oldestIdx + SNAPSHOT_COUNT - 1) % SNAPSHOT_COUNT)
            const i0 = data.oldestIdx % SNAPSHOT_COUNT;
            const i1 = (data.oldestIdx + 1) % SNAPSHOT_COUNT;
            const i2 = (data.oldestIdx + 2) % SNAPSHOT_COUNT;
            const s0 = data.snapshots[i0]; // oldest
            const s1 = data.snapshots[i1]; // middle
            const s2 = data.snapshots[i2]; // newest

            let snapA: Snapshot;
            let snapB: Snapshot;

            if (renderTime >= s1.time) {
                // renderTime is between middle and newest (normal case)
                snapA = s1;
                snapB = s2;
            } else if (renderTime >= s0.time) {
                // renderTime is between oldest and middle (extra buffering)
                snapA = s0;
                snapB = s1;
            } else {
                // renderTime is before all snapshots — extrapolate using oldest pair
                snapA = s0;
                snapB = s1;
            }

            const dt = snapB.time - snapA.time;
            let t: number;
            if (dt <= 0) {
                t = 1; // identical timestamps — show the newer state
            } else {
                t = (renderTime - snapA.time) / dt;
                // Clamp to [0, 1]
                if (t < 0) t = 0;
                if (t > 1) t = 1;
            }

            // Interpolate spatial fields
            out.x      = lerp(snapA.state.x,      snapB.state.x,      t);
            out.y      = lerp(snapA.state.y,       snapB.state.y,      t);
            out.radius = lerp(snapA.state.radius,  snapB.state.radius, t);

            // Non-interpolated fields: take from the newer snapshot
            out.id            = snapB.state.id;
            out.name          = snapB.state.name;
            out.rotation      = snapB.state.rotation;
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
