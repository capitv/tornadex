// ============================================
// Persistent Leaderboard — JSON file-backed
// ============================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Resolve the data directory relative to this file's location (dist-safe)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dirname, '..', 'data');
const LB_FILE   = path.join(DATA_DIR, 'leaderboard.json');
const LB_TMP    = path.join(DATA_DIR, 'leaderboard.json.tmp');

const MAX_ENTRIES   = 100;
const DEBOUNCE_MS   = 5_000; // max one write per 5 s

export interface LeaderboardRecord {
    name:        string;
    score:       number;
    maxCategory: string;  // e.g. "F3"
    kills:       number;
    duration:    number;  // seconds survived
    date:        string;  // ISO date string (YYYY-MM-DD)
}

// ---- Helpers ----

function todayISODate(): string {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function ensureDataDir(): void {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            console.log(`[Leaderboard] Created data directory: ${DATA_DIR}`);
        }
    } catch (err) {
        console.error('[Leaderboard] Could not create data directory:', err);
    }
}

// ---- Leaderboard class ----

export class Leaderboard {
    private entries: LeaderboardRecord[] = [];
    private dirty: boolean = false;
    private writeTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        ensureDataDir();
        this.load();
    }

    // ---- Public API ----

    /**
     * Add a new score entry.  Only kept if it ranks within the top MAX_ENTRIES.
     * Returns true when the entry made it onto the board.
     */
    addEntry(entry: Omit<LeaderboardRecord, 'date'> & { date?: string }): boolean {
        const record: LeaderboardRecord = {
            ...entry,
            date: entry.date ?? todayISODate(),
        };

        // Always add first, then sort+trim so we keep the best scores.
        this.entries.push(record);
        this.entries.sort((a, b) => b.score - a.score);

        if (this.entries.length > MAX_ENTRIES) {
            this.entries = this.entries.slice(0, MAX_ENTRIES);
        }

        // Check if our record survived the trim (it may have been sliced off)
        const survived = this.entries.includes(record);

        if (survived) {
            this.dirty = true;
            this.scheduleWrite();
        }

        return survived;
    }

    /** Returns the top n all-time entries (sorted by score desc). */
    getTop(n: number = 20): LeaderboardRecord[] {
        return this.entries.slice(0, Math.min(n, this.entries.length));
    }

    /** Returns the top n entries for today only. */
    getDaily(n: number = 20): LeaderboardRecord[] {
        const today = todayISODate();
        return this.entries
            .filter(e => e.date === today)
            .slice(0, n);
    }

    // ---- Persistence ----

    private load(): void {
        try {
            if (!fs.existsSync(LB_FILE)) {
                console.log('[Leaderboard] No existing leaderboard file; starting fresh.');
                this.entries = [];
                return;
            }
            const raw = fs.readFileSync(LB_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.entries = parsed as LeaderboardRecord[];
                console.log(`[Leaderboard] Loaded ${this.entries.length} entries from ${LB_FILE}`);
            } else {
                console.warn('[Leaderboard] Unexpected file format; starting fresh.');
                this.entries = [];
            }
        } catch (err) {
            console.error('[Leaderboard] Error reading leaderboard file (starting fresh):', err);
            this.entries = [];
        }
    }

    /**
     * Debounced write: coalesces rapid successive saves into one disk write
     * that fires at most once per DEBOUNCE_MS milliseconds.
     */
    private scheduleWrite(): void {
        if (this.writeTimer !== null) return; // already pending
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            if (this.dirty) {
                this.flush();
            }
        }, DEBOUNCE_MS);
    }

    /**
     * Write to a temp file then rename — atomic on POSIX; best-effort on Windows.
     * Errors are caught and logged; they never crash the server.
     */
    private flush(): void {
        try {
            ensureDataDir();
            const json = JSON.stringify(this.entries, null, 2);
            fs.writeFileSync(LB_TMP, json, 'utf-8');
            fs.renameSync(LB_TMP, LB_FILE);
            this.dirty = false;
            console.log(`[Leaderboard] Saved ${this.entries.length} entries to ${LB_FILE}`);
        } catch (err) {
            console.error('[Leaderboard] Error writing leaderboard file:', err);
        }
    }

    /** Force an immediate write (call on server shutdown if desired). */
    flushSync(): void {
        if (this.writeTimer !== null) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        if (this.dirty) {
            this.flush();
        }
    }
}

// Singleton instance shared across the server
export const leaderboard = new Leaderboard();
