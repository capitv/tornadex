// ============================================
// Replay Buffer — Fixed-size ring buffer
// ============================================
// Stores the last CAPACITY game-state snapshots with zero allocations
// after construction (all slots are pre-allocated at init time).

import type { PlayerState } from '../shared/types.js';
import { TICK_RATE } from './constants.js';

/** One snapshot stored per tick. */
export interface ReplaySnapshot {
    tick:               number;
    timestamp:          number;       // Date.now() at recording time
    players:            PlayerState[];
    destroyedThisTick:  number[];     // object IDs destroyed during this tick
}

/**
 * Circular (ring) buffer that holds the last CAPACITY snapshots.
 *
 * Memory layout:
 *   - `slots` is pre-allocated to CAPACITY entries.
 *   - `writePtr` walks 0 → CAPACITY-1 then wraps back to 0.
 *   - `count` tracks how many slots have been populated (saturates at CAPACITY).
 *
 * After initialisation no new arrays or objects are created by the buffer
 * itself — the PlayerState objects received from the game are stored by
 * reference (they are already freshly allocated per tick by Game.ts).
 */
export class ReplayBuffer {
    private readonly slots:    ReplaySnapshot[];
    private readonly capacity: number;
    private writePtr:          number = 0;
    private count:             number = 0;

    /**
     * @param capacityTicks  Number of ticks to retain.
     *                       Defaults to 30 seconds at the configured tick rate.
     */
    constructor(capacityTicks: number = TICK_RATE * 30) {
        this.capacity = capacityTicks;

        // Pre-allocate all slots so no array growth happens at runtime.
        this.slots = new Array<ReplaySnapshot>(capacityTicks);
        for (let i = 0; i < capacityTicks; i++) {
            this.slots[i] = {
                tick:              0,
                timestamp:         0,
                players:           [],
                destroyedThisTick: [],
            };
        }
    }

    // ---- Public API ----

    /**
     * Record a new game-state snapshot into the ring buffer.
     * This is the only hot-path call; called once per tick from Game.ts.
     */
    record(
        tick:              number,
        players:           PlayerState[],
        destroyedThisTick: number[],
    ): void {
        const slot       = this.slots[this.writePtr];
        slot.tick        = tick;
        slot.timestamp   = Date.now();
        slot.players     = players;          // reference; Game.ts allocates a new array each tick
        slot.destroyedThisTick = destroyedThisTick;

        this.writePtr = (this.writePtr + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
    }

    /**
     * Returns all stored snapshots whose tick falls within [startTick, endTick].
     * Returns snapshots in ascending tick order.
     */
    getRange(startTick: number, endTick: number): ReplaySnapshot[] {
        return this.orderedSlots().filter(
            s => s.tick >= startTick && s.tick <= endTick,
        );
    }

    /**
     * Returns up to the last `nTicks` stored snapshots, in ascending tick order.
     * If fewer snapshots are available they are all returned.
     */
    getLast(nTicks: number): ReplaySnapshot[] {
        const ordered = this.orderedSlots();
        return ordered.slice(Math.max(0, ordered.length - nTicks));
    }

    /** Total number of snapshots currently held in the buffer. */
    get size(): number {
        return this.count;
    }

    // ---- Internal helpers ----

    /**
     * Returns the populated slots in ascending tick order.
     * The ring starts writing at `writePtr` again after wrapping, so the
     * oldest entry lives at `writePtr` once the buffer is full.
     */
    private orderedSlots(): ReplaySnapshot[] {
        if (this.count === 0) return [];

        if (this.count < this.capacity) {
            // Buffer not yet full — slots 0 .. count-1 are valid and already in order.
            return this.slots.slice(0, this.count);
        }

        // Full ring: oldest is at writePtr, newest is at writePtr-1 (mod capacity).
        const result: ReplaySnapshot[] = new Array(this.capacity);
        for (let i = 0; i < this.capacity; i++) {
            result[i] = this.slots[(this.writePtr + i) % this.capacity];
        }
        return result;
    }
}
