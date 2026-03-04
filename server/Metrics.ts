// ============================================
// Metrics / Telemetry
// ============================================
// Rolling window of the last WINDOW_SIZE tick durations.
// Thread-safe for single-threaded Node.js.

import type { MetricsResponse } from '../shared/types.js';

const WINDOW_SIZE = 100;

export class Metrics {
    private tickDurations: number[] = [];
    private _playerCount: number = 0;
    private _roomsActive: number = 0;

    /** Record a single tick's wall-clock duration in milliseconds. */
    recordTick(durationMs: number): void {
        this.tickDurations.push(durationMs);
        if (this.tickDurations.length > WINDOW_SIZE) {
            this.tickDurations.shift();
        }
    }

    /** Update the live player/room counters (called after every tick or connection event). */
    update(playerCount: number, roomsActive: number): void {
        this._playerCount = playerCount;
        this._roomsActive = roomsActive;
    }

    getSnapshot(): MetricsResponse {
        const samples = this.tickDurations;
        const count = samples.length;

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
        for (const d of samples) {
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
