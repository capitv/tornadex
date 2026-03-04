// ============================================
// HUD — Score, Leaderboard, Minimap, Stamina
// ============================================

import type { LeaderboardEntry, PlayerState, ActiveEffect, PowerUpType } from '../../shared/types.js';
import { INTERP_DELAY_MS } from '../network/Interpolation.js';

// Fujita category thresholds (radius values)
const FUJITA: { label: string; maxRadius: number; cssVar: string }[] = [
    { label: 'F0', maxRadius: 1.0,  cssVar: '--f0' },
    { label: 'F1', maxRadius: 2.0,  cssVar: '--f1' },
    { label: 'F2', maxRadius: 3.0,  cssVar: '--f2' },
    { label: 'F3', maxRadius: 4.0,  cssVar: '--f3' },
    { label: 'F4', maxRadius: 5.0,  cssVar: '--f4' },
    { label: 'F5', maxRadius: Infinity, cssVar: '--f5' },
];

// Death screen tips shown at random
const DEATH_TIPS: string[] = [
    'Tip: Boost into smaller tornados to absorb them instantly!',
    'Tip: Destroy buildings for the most score and growth.',
    'Tip: Stay near town centers — more objects means more food.',
    'Tip: Watch the minimap to spot incoming rivals.',
    'Tip: Higher category tornados can absorb you regardless of direction.',
    'Tip: Conserve your boost for chasing or escaping players.',
    'Tip: F5 tornados destroy everything — reach it to dominate the map.',
    'Tip: Animals and trees are easy early-game score. Start with those.',
];

export class HUD {
    private scoreEl: HTMLElement;
    private categoryName: HTMLElement;
    private categoryBadge: HTMLElement;
    private sizeDisplay: HTMLElement;
    private sizeFill: HTMLElement;
    private sizeLabel: HTMLElement;
    private leaderboardList: HTMLElement;
    private minimapCanvas: HTMLCanvasElement;
    private minimapCtx: CanvasRenderingContext2D;
    private staminaFill: HTMLElement;
    private boostKey: HTMLElement;
    private worldSize: number = 2000;

    private killFeedEl: HTMLElement;
    private killEntries: HTMLElement[] = [];
    private readonly KILL_FEED_MAX = 5;
    private readonly KILL_FEED_LIFETIME_MS = 5000;
    private readonly KILL_FEED_FADE_MS = 600;

    // Power-up effect display
    private powerupEffectsEl: HTMLElement;
    // Track rendered effect elements by type for delta updates
    private powerupEls: Map<PowerUpType, HTMLElement> = new Map();
    // Server tick rate used to convert ticks → seconds
    private readonly SERVER_TICK_RATE = 20;

    // Ping indicator
    private pingDot: HTMLElement;
    private pingValue: HTMLElement;

    private currentScore: number = 0;
    private displayScore: number = 0;
    private scoreRafId: number | null = null;
    private currentCategory: string = 'F0';

    // Local player pulse animation state
    private minimapPulse: number = 0;

    // ---- Debug overlay (F3) ----
    private debugOverlay: HTMLElement;
    private debugVisible: boolean = false;
    private debugBytesEl: HTMLElement;
    private debugPacketsEl: HTMLElement;
    private debugDelayEl: HTMLElement;

    constructor() {
        this.scoreEl        = document.getElementById('score-value')!;
        this.categoryName   = document.getElementById('category-name')!;
        this.categoryBadge  = document.getElementById('category-badge')!;
        this.sizeDisplay    = document.getElementById('size-display')!;
        this.sizeFill       = document.getElementById('size-fill')!;
        this.sizeLabel      = document.getElementById('size-label')!;
        this.leaderboardList = document.getElementById('leaderboard-list')!;
        this.minimapCanvas  = document.getElementById('minimap') as HTMLCanvasElement;
        this.minimapCtx     = this.minimapCanvas.getContext('2d')!;
        this.staminaFill    = document.getElementById('stamina-fill')!;
        this.boostKey       = document.getElementById('boost-key')!;
        this.killFeedEl       = document.getElementById('kill-feed')!;
        this.powerupEffectsEl = document.getElementById('powerup-effects')!;
        this.pingDot          = document.getElementById('ping-dot')!;
        this.pingValue        = document.getElementById('ping-value')!;

        // Initialise data attribute for CSS-driven category colours
        this.sizeDisplay.dataset.cat = 'F0';

        // ---- Debug overlay (F3) ----
        this.debugOverlay  = document.createElement('div');
        this.debugOverlay.id = 'debug-overlay';
        // Inline styles — no CSS file change required; keeps styling self-contained.
        Object.assign(this.debugOverlay.style, {
            position:        'fixed',
            top:             '8px',
            left:            '8px',
            padding:         '6px 10px',
            background:      'rgba(0,0,0,0.72)',
            color:           '#00ff88',
            fontFamily:      'monospace',
            fontSize:        '12px',
            lineHeight:      '1.6',
            borderRadius:    '4px',
            pointerEvents:   'none',
            zIndex:          '9999',
            display:         'none',
            whiteSpace:      'pre',
            border:          '1px solid rgba(0,255,136,0.25)',
            userSelect:      'none',
        } as CSSStyleDeclaration);

        this.debugBytesEl   = document.createElement('div');
        this.debugPacketsEl = document.createElement('div');
        this.debugDelayEl   = document.createElement('div');

        this.debugOverlay.appendChild(this.debugBytesEl);
        this.debugOverlay.appendChild(this.debugPacketsEl);
        this.debugOverlay.appendChild(this.debugDelayEl);
        document.body.appendChild(this.debugOverlay);

        // F3 toggles the debug overlay
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'F3') {
                e.preventDefault();
                this.debugVisible = !this.debugVisible;
                this.debugOverlay.style.display = this.debugVisible ? 'block' : 'none';
            }
        });
    }

    setWorldSize(size: number): void {
        this.worldSize = size;
    }

    // ---- Score (animated rolling counter) ----
    updateScore(score: number): void {
        if (score === this.currentScore) return;
        const prevScore = this.currentScore;
        this.currentScore = score;

        // Trigger bump animation
        this.scoreEl.classList.remove('score-bump');
        // Force reflow so the animation restarts even if triggered rapidly
        void (this.scoreEl as HTMLElement).offsetWidth;
        this.scoreEl.classList.add('score-bump');

        // Animate the number rolling up
        if (this.scoreRafId !== null) cancelAnimationFrame(this.scoreRafId);
        const duration = 300; // ms
        const startTime = performance.now();
        const from = this.displayScore;
        const to   = score;

        const tick = (now: number) => {
            const t = Math.min(1, (now - startTime) / duration);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - t, 3);
            this.displayScore = Math.round(from + (to - from) * eased);
            this.scoreEl.textContent = this.displayScore.toString();
            if (t < 1) {
                this.scoreRafId = requestAnimationFrame(tick);
            } else {
                this.displayScore = to;
                this.scoreEl.textContent = to.toString();
                this.scoreRafId = null;
            }
        };
        this.scoreRafId = requestAnimationFrame(tick);
    }

    // ---- Size / Category ----
    updateSize(radius: number, maxRadius: number): void {
        // Map the bar to category segments so the fill aligns with the tick marks.
        // Each category occupies 1/6 of the bar. Within a category the fill progresses
        // linearly from its start boundary to its end boundary.
        let catIdx = 0;
        for (let i = 0; i < FUJITA.length; i++) {
            if (radius < FUJITA[i].maxRadius) { catIdx = i; break; }
            catIdx = i;
        }

        const catStart = catIdx === 0 ? 0 : FUJITA[catIdx - 1].maxRadius;
        const catEnd   = FUJITA[catIdx].maxRadius === Infinity ? catStart + 2 : FUJITA[catIdx].maxRadius;
        const withinCat = catEnd > catStart ? Math.min(1, (radius - catStart) / (catEnd - catStart)) : 1;
        const totalPct = Math.min(100, ((catIdx + withinCat) / FUJITA.length) * 100);
        this.sizeFill.style.width = `${totalPct}%`;

        const cat = FUJITA[catIdx];

        if (cat.label !== this.currentCategory) {
            this.currentCategory = cat.label;
            this.categoryName.textContent = cat.label;
            this.sizeDisplay.dataset.cat  = cat.label;

            // Trigger level-up animation on the badge
            this.categoryBadge.classList.remove('category-up');
            void (this.categoryBadge as HTMLElement).offsetWidth;
            this.categoryBadge.classList.add('category-up');
        }

        this.sizeLabel.textContent = `SIZE: ${radius.toFixed(1)}`;
    }

    // ---- Stamina ----
    updateStamina(stamina: number, isBoosting: boolean): void {
        this.staminaFill.style.width = `${stamina}%`;

        // Warning state when below 25 %
        if (stamina < 25) {
            this.staminaFill.classList.add('stamina-low');
        } else {
            this.staminaFill.classList.remove('stamina-low');
        }

        if (isBoosting && stamina > 0) {
            this.boostKey.classList.add('active');
        } else {
            this.boostKey.classList.remove('active');
        }
    }

    // ---- Ping indicator ----
    /**
     * Update the ping display. Called every 2 seconds from main.ts.
     * @param ms  Smoothed round-trip time in milliseconds.
     */
    updatePing(ms: number): void {
        this.pingValue.textContent = ms > 0 ? `${ms}ms` : '--';

        // Colour-coded dot: green < 60ms, yellow 60-120ms, red > 120ms
        if (ms <= 0) {
            this.pingDot.dataset.quality = 'unknown';
        } else if (ms < 60) {
            this.pingDot.dataset.quality = 'good';
        } else if (ms < 120) {
            this.pingDot.dataset.quality = 'medium';
        } else {
            this.pingDot.dataset.quality = 'bad';
        }
    }

    // ---- Debug overlay ----
    /**
     * Refresh the F3 debug overlay with the latest network stats.
     * No-ops when the overlay is hidden to avoid unnecessary string allocation.
     *
     * @param bytesPerSec    Estimated bytes received per second.
     * @param packetsPerSec  Game-state packets received per second.
     */
    updateDebug(bytesPerSec: number, packetsPerSec: number): void {
        if (!this.debugVisible) return;
        const kbps = (bytesPerSec / 1024).toFixed(1);
        this.debugBytesEl.textContent   = `Bandwidth:  ${kbps} KB/s  (${bytesPerSec} B/s)`;
        this.debugPacketsEl.textContent = `Packets:    ${packetsPerSec} pkt/s`;
        this.debugDelayEl.textContent   = `Interp lag: ${INTERP_DELAY_MS} ms`;
    }

    // ---- Leaderboard ----
    updateLeaderboard(entries: LeaderboardEntry[], localName: string): void {
        this.leaderboardList.innerHTML = '';

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const li = document.createElement('li');
            if (entry.name === localName) li.className = 'is-me';

            const cat = this.getCategoryForRadius(entry.radius);
            const catColor = this.getCategoryColor(cat);

            li.innerHTML = `
                <span class="lb-rank">${i + 1}</span>
                <span class="lb-name">${this.escapeHtml(entry.name)}</span>
                <span class="lb-cat" style="background:${catColor}22;color:${catColor}">${cat}</span>
                <span class="lb-score">${Math.floor(entry.score)}</span>
            `;
            this.leaderboardList.appendChild(li);
        }
    }

    // ---- Minimap ----
    updateMinimap(players: PlayerState[], localId: string): void {
        const ctx   = this.minimapCtx;
        const w     = this.minimapCanvas.width;
        const h     = this.minimapCanvas.height;
        const scale = w / this.worldSize;

        this.minimapPulse = (this.minimapPulse + 0.05) % (Math.PI * 2);
        const pulseAlpha = 0.55 + 0.45 * Math.sin(this.minimapPulse);

        // Clear + background
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(8, 8, 18, 0.82)';
        ctx.fillRect(0, 0, w, h);

        // Grid lines (subtle)
        ctx.strokeStyle = 'rgba(108, 99, 255, 0.08)';
        ctx.lineWidth = 0.5;
        for (let gx = 0; gx < w; gx += w / 4) {
            ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
        }
        for (let gy = 0; gy < h; gy += h / 4) {
            ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
        }

        // Border
        ctx.strokeStyle = 'rgba(108, 99, 255, 0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, w, h);

        // Draw other players first (so local is always on top)
        const others: PlayerState[] = [];
        let local: PlayerState | null = null;
        for (const p of players) {
            if (!p.alive) continue;
            if (p.id === localId) local = p;
            else others.push(p);
        }

        for (const p of others) {
            const px = p.x * scale;
            const py = p.y * scale;
            const pr = Math.max(3, p.radius * scale * 2.5);
            const cat = this.getCategoryForRadius(p.radius);
            const col = this.getCategoryColor(cat);

            ctx.fillStyle = col;
            ctx.shadowColor = col;
            ctx.shadowBlur = 5;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.arc(px, py, pr, 0, Math.PI * 2);
            ctx.fill();
        }

        // Local player — pulsing teal dot with outer ring
        if (local) {
            const px = local.x * scale;
            const py = local.y * scale;
            const pr = Math.max(4, local.radius * scale * 2.8);

            ctx.globalAlpha = 1;
            ctx.shadowColor = '#00d4aa';
            ctx.shadowBlur  = 12;

            // Outer pulse ring
            ctx.strokeStyle = `rgba(0, 212, 170, ${0.3 * pulseAlpha})`;
            ctx.lineWidth   = 2;
            ctx.beginPath();
            ctx.arc(px, py, pr + 4 * pulseAlpha, 0, Math.PI * 2);
            ctx.stroke();

            // Solid dot
            ctx.fillStyle = '#00d4aa';
            ctx.globalAlpha = pulseAlpha;
            ctx.beginPath();
            ctx.arc(px, py, pr, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalAlpha = 1;
        ctx.shadowBlur  = 0;
    }

    // ---- Power-up Effects ----
    /**
     * Synchronise the active power-up effect display with the player's current effects.
     * Called every frame from main.ts with the local player's activeEffects array.
     *
     * @param effects  Array of active effects from the server PlayerState.
     *                 expiresAt is repurposed here to carry ticks-remaining (server converts).
     */
    updatePowerUps(effects: ActiveEffect[]): void {
        const activeTypes = new Set<PowerUpType>(effects.map(e => e.type));

        // Remove effect UI elements that are no longer active
        for (const [type, el] of this.powerupEls) {
            if (!activeTypes.has(type)) {
                el.remove();
                this.powerupEls.delete(type);
            }
        }

        // Add or update each active effect
        for (const effect of effects) {
            const secondsLeft = Math.max(0, Math.ceil(effect.expiresAt / this.SERVER_TICK_RATE));
            const expiring = secondsLeft <= 2;

            let el = this.powerupEls.get(effect.type);

            if (!el) {
                // Create a new effect pill
                el = document.createElement('div');
                el.className = 'powerup-effect';
                el.dataset.type = effect.type;
                el.innerHTML = `
                    <span class="powerup-icon">${this.getPowerUpIcon(effect.type)}</span>
                    <span class="powerup-label">${this.getPowerUpLabel(effect.type)}</span>
                    <span class="powerup-timer">${secondsLeft}s</span>
                `;
                this.powerupEffectsEl.appendChild(el);
                this.powerupEls.set(effect.type, el);
            } else {
                // Update the timer
                const timerEl = el.querySelector('.powerup-timer') as HTMLElement;
                if (timerEl) timerEl.textContent = `${secondsLeft}s`;
            }

            // Toggle flashing class when almost expired
            if (expiring) {
                el.classList.add('expiring');
            } else {
                el.classList.remove('expiring');
            }
        }
    }

    private getPowerUpIcon(type: PowerUpType): string {
        switch (type) {
            case 'speed':  return '⚡';
            case 'growth': return '🌱';
            case 'shield': return '🛡️';
        }
    }

    private getPowerUpLabel(type: PowerUpType): string {
        switch (type) {
            case 'speed':  return 'SPEED';
            case 'growth': return 'GROWTH';
            case 'shield': return 'SHIELD';
        }
    }

    // ---- Kill Feed ----
    /**
     * Display a kill notification in the feed.
     * @param killer     Name of the absorbing player
     * @param victim     Name of the absorbed player
     * @param killerRadius Radius of the killer (used to determine category badge)
     * @param localName  The local player's name, used to highlight relevant entries
     */
    addKill(killer: string, victim: string, killerRadius: number, localName: string): void {
        // Determine Fujita category and CSS class from killer's radius
        const cat = this.getCategoryForRadius(killerRadius);
        const catClass = `cat-${cat.toLowerCase()}`;

        // Build the entry element
        const entry = document.createElement('div');
        entry.className = 'kill-entry';
        if (killer === localName || victim === localName) {
            entry.classList.add('is-local');
        }

        entry.innerHTML = `
            <span class="kill-cat ${catClass}">${this.escapeHtml(cat)}</span>
            <span class="kill-text">
                <span class="kill-killer">${this.escapeHtml(killer)}</span>
                <span class="kill-verb"> absorbed </span>
                <span class="kill-victim">${this.escapeHtml(victim)}</span>
            </span>
        `;

        // Prepend so newest is at the top
        this.killFeedEl.prepend(entry);
        this.killEntries.unshift(entry);

        // Trim to max entries (remove from tail)
        while (this.killEntries.length > this.KILL_FEED_MAX) {
            const oldest = this.killEntries.pop();
            if (oldest) this.removeKillEntry(oldest);
        }

        // Schedule fade-out and removal
        const fadeDelay = this.KILL_FEED_LIFETIME_MS - this.KILL_FEED_FADE_MS;
        const fadeTimer = window.setTimeout(() => {
            entry.classList.add('fading');
        }, fadeDelay);

        const removeTimer = window.setTimeout(() => {
            this.removeKillEntry(entry);
        }, this.KILL_FEED_LIFETIME_MS);

        // Store timers on the element so we can cancel them if pruned early
        (entry as any)._fadeTimer   = fadeTimer;
        (entry as any)._removeTimer = removeTimer;
    }

    private removeKillEntry(entry: HTMLElement): void {
        // Cancel any pending timers
        if ((entry as any)._fadeTimer   !== undefined) clearTimeout((entry as any)._fadeTimer);
        if ((entry as any)._removeTimer !== undefined) clearTimeout((entry as any)._removeTimer);

        if (entry.parentNode === this.killFeedEl) {
            this.killFeedEl.removeChild(entry);
        }
        const idx = this.killEntries.indexOf(entry);
        if (idx !== -1) this.killEntries.splice(idx, 1);
    }

    // ---- Helpers ----
    private getCategoryForRadius(radius: number): string {
        for (const cat of FUJITA) {
            if (radius < cat.maxRadius) return cat.label;
        }
        return 'F5';
    }

    private getCategoryColor(cat: string): string {
        const map: Record<string, string> = {
            F0: '#00e676',
            F1: '#c6ff00',
            F2: '#ffab00',
            F3: '#ff6d00',
            F4: '#d50000',
            F5: '#aa00ff',
        };
        return map[cat] ?? '#ffffff';
    }

    private escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
