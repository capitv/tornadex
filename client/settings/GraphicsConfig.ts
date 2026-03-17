// ============================================
// Graphics Config — Quality Presets & Live Settings
// ============================================
// This is the single source of truth for all graphics-quality knobs.
// Every other module imports from here so changing the level propagates
// everywhere without each module needing its own localStorage logic.

export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface GraphicsPreset {
    // Renderer
    pixelRatio: number;
    antialias: boolean;

    // Fog / draw distance
    fogFar: number;

    // Tornado per-mesh particles
    debrisCount: number;
    dustCount: number;
    cloudCount: number;

    // Tornado core geometry
    radialSegments: number;

    // Global particle budget
    maxParticles: number;

    // World object render-distance culling (units). Infinity = no culling.
    worldCullDistance: number;

    // Shadow quality
    shadows: boolean;

    // Expensive atmospheric deformation effects
    cloudDeformation: boolean;
    suctionEffect: boolean;

    // Per-frame cosmetic emission probabilities
    localDustChance: number;
    waterspoutChance: number;
}

// Helper: read devicePixelRatio each time a preset is accessed so the value
// is always current (e.g. if the user moves the window to a different display).
function dpr(): number {
    return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

/**
 * Returns true when running on a touch/mobile device (Capacitor WebView or browser).
 * On mobile we cap pixel ratio to 1.5 and never enable shadows — the GPU budget
 * on even flagship phones can't sustain them at 60 FPS alongside WebGL game content.
 */
function isMobileDevice(): boolean {
    if (typeof window === 'undefined') return false;
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** Mobile-safe pixel ratio: never above 1.5. Prevents thermal throttle on high-DPI phones. */
function mobileDpr(max: number): number {
    return isMobileDevice() ? Math.min(dpr(), 1.5) : Math.min(dpr(), max);
}

const PRESETS: Record<GraphicsQuality, () => GraphicsPreset> = {
    low: () => ({
        pixelRatio: 1,
        antialias: false,
        fogFar: 500,
        debrisCount: 50,
        dustCount: 60,
        cloudCount: 100,
        radialSegments: 16,
        maxParticles: 250,
        worldCullDistance: 400,
        shadows: false,
        cloudDeformation: false,
        suctionEffect: false,
        localDustChance: 0.12,
        waterspoutChance: 0.25,
    }),
    medium: () => ({
        pixelRatio: mobileDpr(2),
        antialias: !isMobileDevice(), // antialias too expensive on mobile
        fogFar: 1000,
        debrisCount: 80,
        dustCount: 100,
        cloudCount: 160,
        radialSegments: 24,
        maxParticles: 500,
        worldCullDistance: Infinity,
        shadows: false, // never shadows on mobile; desktop keeps false too (cost vs gain)
        cloudDeformation: true,
        suctionEffect: true,
        localDustChance: 0.3,
        waterspoutChance: 0.85,
    }),
    high: () => ({
        pixelRatio: mobileDpr(3), // mobile capped at 1.5, desktop allows up to 3
        antialias: true,
        fogFar: 1500,
        debrisCount: 120,
        dustCount: 150,
        cloudCount: 220,
        radialSegments: isMobileDevice() ? 24 : 32, // fewer segments on mobile GPU
        maxParticles: isMobileDevice() ? 500 : 1000,
        worldCullDistance: Infinity,
        shadows: !isMobileDevice(), // shadows only on desktop — too expensive for mobile GPU
        cloudDeformation: true,
        suctionEffect: true,
        localDustChance: 0.45,
        waterspoutChance: 0.92,
    }),
};

// ---- Storage key ----
const STORAGE_KEY = 'tornado_io_graphics_quality';

// ---- Listeners for when the quality level changes ----
type ChangeListener = (preset: GraphicsPreset, quality: GraphicsQuality) => void;
const listeners: ChangeListener[] = [];

// ---- Active state ----
function loadSavedQuality(): GraphicsQuality {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'low' || saved === 'medium' || saved === 'high') return saved;
    } catch {
        // localStorage unavailable — fall through to default
    }
    return 'medium'; // default
}

let _currentQuality: GraphicsQuality = loadSavedQuality();

// ---- Public API ----

/** Returns the currently active preset values (freshly computed each call). */
export function getGraphicsPreset(): GraphicsPreset {
    return PRESETS[_currentQuality]();
}

/** Returns the currently active quality level label. */
export function getGraphicsQuality(): GraphicsQuality {
    return _currentQuality;
}

/**
 * Change the quality level.  Persists to localStorage and fires all
 * registered change listeners so subsystems can react immediately.
 */
export function setGraphicsQuality(quality: GraphicsQuality): void {
    _currentQuality = quality;
    try { localStorage.setItem(STORAGE_KEY, quality); } catch { /* storage full or blocked */ }

    const preset = PRESETS[quality]();
    for (const fn of listeners) {
        fn(preset, quality);
    }
}

/**
 * Register a callback that is called whenever the quality changes.
 * The callback receives the new preset and the quality label.
 * Returns an unsubscribe function.
 */
export function onGraphicsChange(fn: ChangeListener): () => void {
    listeners.push(fn);
    return () => {
        const idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
    };
}
