// ============================================
// HUD — Score, Leaderboard, Minimap, Stamina
// ============================================

import type { LeaderboardEntry, PlayerState, ActiveEffect, PowerUpType } from '../../shared/types.js';
import { FUJITA_BANDS, getFujitaCategory, getFujitaCategoryIndex } from '../../shared/fujita.js';
import { WORLD_SIZE } from '../../shared/worldConfig.js';


// Fujita category thresholds (radius values)
const FUJITA: { label: string; maxRadius: number; cssVar: string }[] = [
    { label: 'F0', maxRadius: FUJITA_BANDS[0].maxRadius, cssVar: '--f0' },
    { label: 'F1', maxRadius: FUJITA_BANDS[1].maxRadius, cssVar: '--f1' },
    { label: 'F2', maxRadius: FUJITA_BANDS[2].maxRadius, cssVar: '--f2' },
    { label: 'F3', maxRadius: FUJITA_BANDS[3].maxRadius, cssVar: '--f3' },
    { label: 'F4', maxRadius: FUJITA_BANDS[4].maxRadius, cssVar: '--f4' },
    { label: 'F5', maxRadius: FUJITA_BANDS[5].maxRadius, cssVar: '--f5' },
];

const CATEGORY_DOWNGRADE_HYSTERESIS = 0.12;

// Death screen tips shown at random
const DEATH_TIPS: string[] = [
    'Tip: Boost into smaller tornados to absorb them instantly!',
    'Tip: Destroy stadiums and trailer parks for the most score and growth.',
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
    private worldSize: number = WORLD_SIZE;

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

    // Stamina cooldown state
    private staminaCooldownEl: HTMLElement;
    private staminaCooldownTimer: ReturnType<typeof setTimeout> | null = null;
    private prevStaminaValue: number = 100;
    private isShowingCooldown: boolean = false;

    // Max size indicator
    private maxSizeEl: HTMLElement;
    private isShowingMaxSize: boolean = false;

    private currentScore: number = 0;
    private displayScore: number = 0;
    private scoreRafId: number | null = null;
    private currentCategory: string = 'F0';
    private currentCategoryIndex: number = 0;

    // Local player pulse animation state
    private minimapPulse: number = 0;

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

        // Stamina cooldown overlay text
        this.staminaCooldownEl = document.createElement('span');
        this.staminaCooldownEl.id = 'stamina-cooldown-text';
        this.staminaCooldownEl.className = 'stamina-cooldown-text';
        this.staminaCooldownEl.textContent = '';
        const staminaBarWrap = document.getElementById('stamina-bar-wrap');
        if (staminaBarWrap) {
            staminaBarWrap.style.position = 'relative';
            staminaBarWrap.appendChild(this.staminaCooldownEl);
        }

        // Supercell global event banner
        this.supercellBanner = document.createElement('div');
        this.supercellBanner.id = 'supercell-banner';
        this.supercellBanner.className = 'supercell-banner';
        this.supercellBanner.innerHTML = `
            <div class="supercell-title">⚠️ SUPERCELL WARNING ⚠️</div>
            <div class="supercell-sub">A massive storm is forming at the center!<br>2x Growth & Infinite Stamina inside!</div>
        `;
        document.body.appendChild(this.supercellBanner);

        // Max size indicator near the growth bar
        this.maxSizeEl = document.createElement('div');
        this.maxSizeEl.id = 'max-size-msg';
        this.maxSizeEl.className = 'max-size-msg';
        this.maxSizeEl.textContent = 'MAX SIZE!';
        this.sizeDisplay.appendChild(this.maxSizeEl);
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
        let catIdx = getFujitaCategoryIndex(radius);
        if (catIdx < this.currentCategoryIndex) {
            const previousMin = this.currentCategoryIndex === 0 ? 0 : FUJITA[this.currentCategoryIndex - 1].maxRadius;
            if (radius > previousMin - CATEGORY_DOWNGRADE_HYSTERESIS) {
                catIdx = this.currentCategoryIndex;
            }
        }
        this.currentCategoryIndex = catIdx;

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

        // Max size reached indicator (PLAYER_MAX_RADIUS = 25)
        if (radius >= 25 && !this.isShowingMaxSize) {
            this.isShowingMaxSize = true;
            this.maxSizeEl.classList.add('active');
        } else if (radius < 25 && this.isShowingMaxSize) {
            this.isShowingMaxSize = false;
            this.maxSizeEl.classList.remove('active');
        }
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

        // Cooldown visual: stamina just hit 0 after boosting — show "COOLDOWN" briefly
        if (stamina <= 0 && this.prevStaminaValue > 0 && !this.isShowingCooldown) {
            this.isShowingCooldown = true;
            this.staminaCooldownEl.textContent = 'COOLDOWN';
            this.staminaCooldownEl.classList.add('active', 'cooldown-flash');
            this.staminaCooldownEl.classList.remove('recharging');

            if (this.staminaCooldownTimer !== null) clearTimeout(this.staminaCooldownTimer);
            this.staminaCooldownTimer = setTimeout(() => {
                this.isShowingCooldown = false;
                // Switch to RECHARGING if still recharging
                if (stamina < 100) {
                    this.staminaCooldownEl.textContent = 'RECHARGING';
                    this.staminaCooldownEl.classList.remove('cooldown-flash');
                    this.staminaCooldownEl.classList.add('recharging');
                } else {
                    this.staminaCooldownEl.classList.remove('active', 'cooldown-flash');
                }
            }, 1000);
        }
        // Recharging state: not boosting, stamina < 100, and not showing the COOLDOWN flash
        else if (!isBoosting && stamina > 0 && stamina < 100 && !this.isShowingCooldown) {
            this.staminaCooldownEl.textContent = 'RECHARGING';
            this.staminaCooldownEl.classList.add('active', 'recharging');
            this.staminaCooldownEl.classList.remove('cooldown-flash');
        }
        // Stamina is full or actively boosting — hide the text
        else if (stamina >= 100 || isBoosting) {
            if (!this.isShowingCooldown) {
                this.staminaCooldownEl.classList.remove('active', 'recharging', 'cooldown-flash');
                this.staminaCooldownEl.textContent = '';
            }
        }

        this.prevStaminaValue = stamina;
    }

    // ---- Ping indicator ----
    /**
     * Update the ping display. Called every 2 seconds from main.ts.
     * @param ms  Smoothed round-trip time in milliseconds.
     */
    updatePing(ms: number): void {
        this.pingValue.textContent = ms > 0 ? `${ms}ms` : '--';

        // Colour-coded dot: green < 80ms, yellow 80-150ms, red > 150ms
        if (ms <= 0) {
            this.pingDot.dataset.quality = 'unknown';
        } else if (ms < 80) {
            this.pingDot.dataset.quality = 'good';
        } else if (ms <= 150) {
            this.pingDot.dataset.quality = 'warning';
        } else {
            this.pingDot.dataset.quality = 'bad';
        }
    }

    // Debug overlay is handled entirely by main.ts (F3 key)

    // ---- Leaderboard ----
    updateLeaderboard(entries: LeaderboardEntry[], localName: string): void {
        let html = '';
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const cat = this.getCategoryForRadius(entry.radius);
            const catColor = this.getCategoryColor(cat);
            const meClass = entry.name === localName ? ' is-me' : '';
            html += `<li class="${meClass}">
                <span class="lb-rank">${i + 1}</span>
                <span class="lb-name">${this.escapeHtml(entry.name)}</span>
                <span class="lb-cat" style="background:${catColor}22;color:${catColor}">${cat}</span>
                <span class="lb-score">${Math.floor(entry.score)}</span>
            </li>`;
        }
        this.leaderboardList.innerHTML = html;
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

        // Draw Supercell region if active
        // Only drawn when the state indicates it's active
        if (this.currentSupercellState?.active) {
            const sc = this.currentSupercellState;
            const sx = sc.x * scale;
            const sy = sc.y * scale;
            const sr = sc.radius * scale;

            ctx.fillStyle = 'rgba(255, 0, 85, 0.15)'; // transparent red
            ctx.shadowColor = 'rgba(255, 0, 85, 0.5)';
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(sx, sy, sr, 0, Math.PI * 2);
            ctx.fill();

            // Supercell border pulse (faster than player pulse)
            const scPulseAlpha = 0.5 + 0.5 * Math.sin(this.minimapPulse * 2.0);
            ctx.strokeStyle = `rgba(255, 0, 85, ${0.4 + 0.4 * scPulseAlpha})`;
            ctx.lineWidth = 1 + scPulseAlpha;
            ctx.stroke();
            
            ctx.shadowBlur = 0; // reset
        }

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

    // ---- Supercell Event ----
    private currentSupercellState: import('../../shared/types.js').SupercellState | null = null;
    private supercellBanner: HTMLElement;
    private supercellBannerTimer: ReturnType<typeof setTimeout> | null = null;

    updateSupercell(state: import('../../shared/types.js').SupercellState | undefined): void {
        if (!state) return;

        // Detect transition from inactive -> active
        if (!this.currentSupercellState?.active && state.active) {
            // Show banner
            this.supercellBanner.classList.add('active');
            
            // Auto hide after 5 seconds
            if (this.supercellBannerTimer !== null) clearTimeout(this.supercellBannerTimer);
            this.supercellBannerTimer = setTimeout(() => {
                this.supercellBanner.classList.remove('active');
            }, 6000);
        }

        // Cache state for minimap rendering
        this.currentSupercellState = state;
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
        // Remove effect UI elements that are no longer active
        for (const [type, el] of this.powerupEls) {
            let stillActive = false;
            for (const e of effects) {
                if (e.type === type) { stillActive = true; break; }
            }
            if (!stillActive) {
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
        return getFujitaCategory(radius);
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
