// ============================================
// Metrics / Telemetry
// ============================================
// Rolling window of the last WINDOW_SIZE tick durations.
// Uses a ring buffer to avoid array shift() overhead.
// Thread-safe for single-threaded Node.js.

import type { MetricsResponse } from '../shared/types.js';

const WINDOW_SIZE = 100;

export class Metrics {
    private tickDurations: number[] = new Array(WINDOW_SIZE).fill(0);
    private ringIndex: number = 0;
    private ringCount: number = 0;
    private _playerCount: number = 0;
    private _roomsActive: number = 0;

    /** Record a single tick's wall-clock duration in milliseconds. */
    recordTick(durationMs: number): void {
        this.tickDurations[this.ringIndex] = durationMs;
        this.ringIndex = (this.ringIndex + 1) % WINDOW_SIZE;
        if (this.ringCount < WINDOW_SIZE) this.ringCount++;
    }

    /** Update the live player/room counters (called after every tick or connection event). */
    update(playerCount: number, roomsActive: number): void {
        this._playerCount = playerCount;
        this._roomsActive = roomsActive;
    }

    getSnapshot(): MetricsResponse {
        const count = this.ringCount;

        if (count === 0) {
            return {
                tickDurationAvgMs: 0,
                tickDurationMaxMs: 0,
                playerCount: this._playerCount,
                roomsActive: this._roomsActive,
                sampleCount: 0,
            };
        }

        let sum = 0;
        let max = 0;
        for (let i = 0; i < count; i++) {
            const d = this.tickDurations[i];
            sum += d;
            if (d > max) max = d;
        }

        return {
            tickDurationAvgMs: Math.round((sum / count) * 100) / 100,
            tickDurationMaxMs: Math.round(max * 100) / 100,
            playerCount: this._playerCount,
            roomsActive: this._roomsActive,
            sampleCount: count,
        };
    }
}
