// ============================================
// Input Handler — Mouse / Touch Controls
// ============================================

import type { InputPayload } from '../../shared/types.js';

// ---- Virtual Joystick (mobile only) ----
interface JoystickState {
    active: boolean;
    angle: number;
    magnitude: number; // 0..1 normalised distance from center
    touchId: number | null;
    originX: number;
    originY: number;
}

export class InputHandler {
    private mouseX: number = 0;
    private mouseY: number = 0;
    private active: boolean = false;
    private boosting: boolean = false;
    private adminGrow: boolean = false;
    private adminShrink: boolean = false;
    private canvas: HTMLCanvasElement;

    // Mobile joystick
    private isMobile: boolean = false;
    private joystickOuter: HTMLElement | null = null;
    private joystickThumb: HTMLElement | null = null;
    private boostBtn: HTMLElement | null = null;

    private joystick: JoystickState = {
        active: false,
        angle: 0,
        magnitude: 0,
        touchId: null,
        originX: 0,
        originY: 0,
    };

    // Track boost button touch separately
    private boostTouchId: number | null = null;

    // Joystick geometry constants
    private readonly OUTER_RADIUS = 60;  // half of 120px outer ring
    private readonly THUMB_RADIUS = 25;  // half of 50px thumb

    // When false, touch events pass through to the page (home screen buttons work)
    private gameActive: boolean = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;

        // Detect touch capability
        this.isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

        if (this.isMobile) {
            this.buildJoystickUI();
            this.bindJoystickEvents();
        } else {
            this.bindMouseEvents();
        }

        // Keyboard controls always available (desktop boost, admin keys)
        this.bindKeyboardEvents();
    }

    // ------------------------------------------------------------------
    // DOM construction
    // ------------------------------------------------------------------

    private buildJoystickUI(): void {
        // ---- Outer ring ----
        const outer = document.createElement('div');
        outer.id = 'joystick-outer';

        // ---- Thumb / knob ----
        const thumb = document.createElement('div');
        thumb.id = 'joystick-thumb';
        outer.appendChild(thumb);

        // ---- Boost button ----
        const boost = document.createElement('div');
        boost.id = 'boost-btn-mobile';
        boost.textContent = 'BOOST';

        document.body.appendChild(outer);
        document.body.appendChild(boost);

        this.joystickOuter = outer;
        this.joystickThumb = thumb;
        this.boostBtn = boost;

        // Hide until the game actually starts (prevents overlap with home screen)
        this.hideControls();
    }

    /** Show mobile joystick + boost button (call when game starts). */
    showControls(): void {
        this.gameActive = true;
        if (this.joystickOuter) this.joystickOuter.style.display = '';
        if (this.boostBtn) this.boostBtn.style.display = '';
    }

    /** Hide mobile joystick + boost button (call on home/death screen). */
    hideControls(): void {
        this.gameActive = false;
        if (this.joystickOuter) this.joystickOuter.style.display = 'none';
        if (this.boostBtn) this.boostBtn.style.display = 'none';
    }

    // ------------------------------------------------------------------
    // Event binding
    // ------------------------------------------------------------------

    private bindMouseEvents(): void {
        window.addEventListener('mousemove', (e) => {
            this.mouseX = e.clientX;
            this.mouseY = e.clientY;
            this.active = true;
        });

        window.addEventListener('mousedown', () => {
            this.active = true;
        });

        window.addEventListener('mouseleave', () => {
            this.active = false;
        });

        window.addEventListener('mouseenter', () => {
            this.active = true;
        });
    }

    private bindKeyboardEvents(): void {
        window.addEventListener('keydown', (e) => {
            if (e.key === 'e' || e.key === 'E') this.boosting = true;
            if (e.key === 'ArrowUp') this.adminGrow = true;
            if (e.key === 'ArrowDown') this.adminShrink = true;
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === 'e' || e.key === 'E') this.boosting = false;
            if (e.key === 'ArrowUp') this.adminGrow = false;
            if (e.key === 'ArrowDown') this.adminShrink = false;
        });
    }

    private bindJoystickEvents(): void {
        if (!this.joystickOuter || !this.joystickThumb || !this.boostBtn) return;

        // Use window-level touch handlers so we capture moves that slide
        // outside the joystick outer ring.
        window.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        window.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        window.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: false });
        window.addEventListener('touchcancel', this.onTouchEnd.bind(this), { passive: false });
    }

    // ------------------------------------------------------------------
    // Touch handlers
    // ------------------------------------------------------------------

    private onTouchStart(e: TouchEvent): void {
        // When game is not active, let touches pass through to page UI (play button, inputs)
        if (!this.gameActive) return;
        e.preventDefault();

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];

            // Check if this touch is on the boost button
            if (this.boostBtn && this.isTouchOnElement(touch, this.boostBtn)) {
                if (this.boostTouchId === null) {
                    this.boostTouchId = touch.identifier;
                    this.boosting = true;
                    this.boostBtn.classList.add('pressed');
                }
                continue;
            }

            // Otherwise treat it as a joystick touch (only grab first)
            if (this.joystick.touchId === null) {
                // Determine joystick origin: wherever the finger lands in the
                // left half of the screen (or directly on the outer ring).
                const ox = this.getJoystickOriginX();
                const oy = this.getJoystickOriginY();

                this.joystick.touchId = touch.identifier;
                this.joystick.originX = ox;
                this.joystick.originY = oy;
                this.joystick.active = true;

                // Show / reposition the outer ring at the touch origin
                this.positionJoystickOuter(ox, oy);

                // Update thumb immediately
                this.updateJoystickFromTouch(touch);
            }
        }
    }

    private onTouchMove(e: TouchEvent): void {
        if (!this.gameActive) return;
        e.preventDefault();

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];

            if (touch.identifier === this.joystick.touchId) {
                this.updateJoystickFromTouch(touch);
            }
        }
    }

    private onTouchEnd(e: TouchEvent): void {
        if (!this.gameActive) return;
        e.preventDefault();

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];

            if (touch.identifier === this.joystick.touchId) {
                this.resetJoystick();
            }

            if (touch.identifier === this.boostTouchId) {
                this.boostTouchId = null;
                this.boosting = false;
                this.boostBtn?.classList.remove('pressed');
            }
        }
    }

    // ------------------------------------------------------------------
    // Joystick helpers
    // ------------------------------------------------------------------

    private updateJoystickFromTouch(touch: Touch): void {
        const dx = touch.clientX - this.joystick.originX;
        const dy = touch.clientY - this.joystick.originY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Clamp thumb within the outer ring
        const maxDist = this.OUTER_RADIUS - this.THUMB_RADIUS;
        const clampedDist = Math.min(dist, maxDist);
        const angle = Math.atan2(dy, dx);

        // Normalised magnitude (0 = center, 1 = edge)
        this.joystick.magnitude = clampedDist / maxDist;
        this.joystick.angle = angle;

        // Move thumb visually
        if (this.joystickThumb) {
            const thumbX = Math.cos(angle) * clampedDist;
            const thumbY = Math.sin(angle) * clampedDist;
            this.joystickThumb.style.transform = `translate(calc(-50% + ${thumbX}px), calc(-50% + ${thumbY}px))`;
        }
    }

    private resetJoystick(): void {
        this.joystick.active = false;
        this.joystick.touchId = null;
        this.joystick.magnitude = 0;

        // Re-center thumb
        if (this.joystickThumb) {
            this.joystickThumb.style.transform = 'translate(-50%, -50%)';
        }
    }

    private positionJoystickOuter(cx: number, cy: number): void {
        if (!this.joystickOuter) return;
        this.joystickOuter.style.left = `${cx - this.OUTER_RADIUS}px`;
        this.joystickOuter.style.top = `${cy - this.OUTER_RADIUS}px`;
    }

    /** Fixed origin for the joystick outer ring (bottom-left anchor). */
    private getJoystickOriginX(): number {
        // Centre of the 120px outer ring: 24px margin + 60px radius
        return 24 + this.OUTER_RADIUS;
    }

    private getJoystickOriginY(): number {
        return window.innerHeight - 24 - this.OUTER_RADIUS;
    }

    private isTouchOnElement(touch: Touch, el: HTMLElement): boolean {
        const rect = el.getBoundingClientRect();
        return (
            touch.clientX >= rect.left &&
            touch.clientX <= rect.right &&
            touch.clientY >= rect.top &&
            touch.clientY <= rect.bottom
        );
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    getInput(): InputPayload {
        if (this.isMobile) {
            // Joystick controls direction + active state
            const isActive = this.joystick.active && this.joystick.magnitude > 0.1;

            return {
                angle: this.joystick.angle,
                active: isActive,
                boost: this.boosting,
                adminGrow: this.adminGrow,
                adminShrink: this.adminShrink,
                seq: 0, // placeholder — overwritten by main.ts before sending
            };
        }

        // Desktop: derive angle from cursor position relative to canvas center.
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        const dx = this.mouseX - centerX;
        const dy = this.mouseY - centerY;
        const angle = Math.atan2(dy, dx);

        const dist = Math.sqrt(dx * dx + dy * dy);
        const isActive = this.active && dist > 20;

        return {
            angle,
            active: isActive,
            boost: this.boosting,
            adminGrow: this.adminGrow,
            adminShrink: this.adminShrink,
            seq: 0, // placeholder — overwritten by main.ts before sending
        };
    }
}
