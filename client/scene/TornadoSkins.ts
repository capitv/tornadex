// ============================================
// Tornado Skins — Visual style presets
// ============================================

export interface TornadoSkin {
    id: string;
    name: string;
    emoji: string;
    // Core funnel
    coreColor: number;
    coreEmissive: number;
    // Inner cones (3 levels, inside to outside)
    innerConeColors: { color: number; opacity: number }[];
    // Debris particle color ranges [r,g,b] (0-1 each)
    debrisColors: [number, number, number][];
    // Dust base brightness range [min, max] (0-1)
    dustBrightness: [number, number];
    dustTint: [number, number, number]; // RGB multiplier for dust
    // Cloud top brightness range [min, max]
    cloudBrightness: [number, number];
    cloudTint: [number, number, number]; // RGB multiplier
    // Flash light color
    flashColor: number;
    // Shadow colors (primary, outer)
    shadowColor: number;
    shadowOuterColor: number;
    // Boost trail color [r, g, b] base (0-1)
    trailColor: [number, number, number];
    // Shaped debris palettes
    boxPalette: number[];
    flatPalette: number[];
    chunkPalette: number[];
}

// ---- Classic (default) — the original grey/brown tornado ----
const CLASSIC: TornadoSkin = {
    id: 'classic',
    name: 'Classic',
    emoji: '\u{1F32A}\u{FE0F}',  // tornado emoji
    coreColor: 0x3d4b57,
    coreEmissive: 0x05070a,
    innerConeColors: [
        { color: 0x364855, opacity: 0.95 },
        { color: 0x273540, opacity: 0.97 },
        { color: 0x1a2530, opacity: 1.0  },
    ],
    debrisColors: [
        [0.15, 0.10, 0.05],  // dark wood/dirt
        [0.25, 0.25, 0.25],  // concrete
        [0.1, 0.2, 0.1],     // leaves
        [0.15, 0.15, 0.2],   // metal
    ],
    dustBrightness: [0.35, 0.55],
    dustTint: [1.0, 0.9, 0.8],
    cloudBrightness: [0.4, 0.7],
    cloudTint: [1.0, 0.95, 0.9],
    flashColor: 0xaad4ff,
    shadowColor: 0x0d1a0d,
    shadowOuterColor: 0x0a150a,
    trailColor: [0.85, 0.90, 1.0],
    boxPalette: [0x6b6b6b, 0x8b6b47, 0x4a3728, 0x7a7a6a, 0x8c7a5a],
    flatPalette: [0x3a5a3a, 0x8b2020, 0x1a2a8b, 0x9a9a9a, 0x4a3a1a, 0x7a7a7a],
    chunkPalette: [0x7a6a5a, 0x5a5040, 0x6b5a4a, 0x4a4a4a],
};

// ---- Inferno — Red/orange/black fire tornado ----
const INFERNO: TornadoSkin = {
    id: 'inferno',
    name: 'Inferno',
    emoji: '\u{1F525}',  // fire emoji
    coreColor: 0x5a1010,
    coreEmissive: 0x3a1800,
    innerConeColors: [
        { color: 0x6b1a0a, opacity: 0.95 },
        { color: 0x451005, opacity: 0.97 },
        { color: 0x200800, opacity: 1.0  },
    ],
    debrisColors: [
        [0.95, 0.45, 0.05],  // bright ember
        [1.0,  0.70, 0.10],  // yellow flame
        [0.80, 0.25, 0.02],  // deep ember
        [0.30, 0.08, 0.02],  // charcoal
    ],
    dustBrightness: [0.10, 0.25],
    dustTint: [1.2, 0.6, 0.3],   // warm ash tones
    cloudBrightness: [0.15, 0.35],
    cloudTint: [1.3, 0.5, 0.2],   // dark smoke with orange tint
    flashColor: 0xff6622,
    shadowColor: 0x1a0500,
    shadowOuterColor: 0x120300,
    trailColor: [1.0, 0.4, 0.05],
    boxPalette: [0x3a1508, 0x5a2010, 0x1a0a05, 0x4a2818, 0x2a1008],
    flatPalette: [0x6b2510, 0x8b3010, 0x2a0a00, 0x4a1a08, 0x1a0800],
    chunkPalette: [0x2a1510, 0x1a0a05, 0x3a2010, 0x100500],
};

// ---- Frost — Ice blue/white tornado ----
const FROST: TornadoSkin = {
    id: 'frost',
    name: 'Frost',
    emoji: '\u{2744}\u{FE0F}',  // snowflake emoji
    coreColor: 0x4a8aaa,
    coreEmissive: 0x0a2040,
    innerConeColors: [
        { color: 0x5a9abb, opacity: 0.93 },
        { color: 0x3a7a9a, opacity: 0.95 },
        { color: 0x2a6a8a, opacity: 1.0  },
    ],
    debrisColors: [
        [0.70, 0.90, 1.00],  // ice crystal
        [0.85, 0.95, 1.00],  // bright ice
        [0.50, 0.75, 0.95],  // deep ice blue
        [0.95, 0.98, 1.00],  // near-white snow
    ],
    dustBrightness: [0.70, 0.95],
    dustTint: [0.85, 0.92, 1.0],  // white-blue snow
    cloudBrightness: [0.65, 0.90],
    cloudTint: [0.80, 0.90, 1.0],
    flashColor: 0x88ccff,
    shadowColor: 0x0a1520,
    shadowOuterColor: 0x081018,
    trailColor: [0.75, 0.92, 1.0],
    boxPalette: [0x6a9ab0, 0x88aabb, 0x4a7a90, 0x9abaca, 0x5a8aa0],
    flatPalette: [0x7aaabb, 0x5a8a9a, 0xaaccdd, 0x88bbcc, 0x4a7a8a],
    chunkPalette: [0x5a8a9a, 0x7aaaba, 0x4a7a8a, 0x88aabb],
};

// ---- Void — Deep purple/black void tornado ----
const VOID: TornadoSkin = {
    id: 'void',
    name: 'Void',
    emoji: '\u{1F30C}',  // milky way / galaxy emoji
    coreColor: 0x2a0a3a,
    coreEmissive: 0x150520,
    innerConeColors: [
        { color: 0x35104a, opacity: 0.96 },
        { color: 0x200838, opacity: 0.98 },
        { color: 0x100420, opacity: 1.0  },
    ],
    debrisColors: [
        [0.60, 0.15, 0.80],  // bright purple spark
        [0.90, 0.20, 0.60],  // magenta spark
        [0.35, 0.05, 0.55],  // deep violet
        [0.20, 0.02, 0.30],  // near-black purple
    ],
    dustBrightness: [0.12, 0.28],
    dustTint: [0.8, 0.4, 1.2],   // violet dust
    cloudBrightness: [0.15, 0.30],
    cloudTint: [0.7, 0.3, 1.1],   // dark purple clouds
    flashColor: 0x9944ff,
    shadowColor: 0x0a0515,
    shadowOuterColor: 0x080310,
    trailColor: [0.6, 0.15, 0.9],
    boxPalette: [0x2a0a3a, 0x3a1050, 0x180530, 0x401060, 0x200840],
    flatPalette: [0x351050, 0x4a1568, 0x1a0830, 0x280a40, 0x3a1058],
    chunkPalette: [0x200838, 0x2a0a42, 0x180530, 0x100420],
};

// ---- Thunder — Electric yellow/white ----
const THUNDER: TornadoSkin = {
    id: 'thunder',
    name: 'Thunder',
    emoji: '\u{26A1}',  // lightning bolt emoji
    coreColor: 0x6080aa,
    coreEmissive: 0x102050,
    innerConeColors: [
        { color: 0x5570a0, opacity: 0.93 },
        { color: 0x405888, opacity: 0.95 },
        { color: 0x2a4070, opacity: 1.0  },
    ],
    debrisColors: [
        [1.00, 1.00, 0.40],  // electric yellow
        [0.95, 0.95, 0.70],  // bright spark
        [0.80, 0.90, 1.00],  // white-blue arc
        [1.00, 0.85, 0.20],  // gold spark
    ],
    dustBrightness: [0.45, 0.70],
    dustTint: [0.95, 0.95, 1.0],   // light grey
    cloudBrightness: [0.50, 0.80],
    cloudTint: [0.90, 0.92, 1.0],
    flashColor: 0xeeeeff,
    shadowColor: 0x0a0a18,
    shadowOuterColor: 0x080812,
    trailColor: [0.95, 0.95, 1.0],
    boxPalette: [0x5a5a6a, 0x6a6a7a, 0x4a4a5a, 0x7a7a8a, 0x505060],
    flatPalette: [0x6a6a7a, 0x5a5a68, 0x8a8a9a, 0x4a4a58, 0x7a7a88],
    chunkPalette: [0x5a5a68, 0x6a6a78, 0x4a4a58, 0x3a3a48],
};

// ---- Toxic — Green/acid tornado ----
const TOXIC: TornadoSkin = {
    id: 'toxic',
    name: 'Toxic',
    emoji: '\u{2622}\u{FE0F}',  // radioactive emoji
    coreColor: 0x1a4a1a,
    coreEmissive: 0x0a3008,
    innerConeColors: [
        { color: 0x1e5520, opacity: 0.95 },
        { color: 0x143a15, opacity: 0.97 },
        { color: 0x0a2a0a, opacity: 1.0  },
    ],
    debrisColors: [
        [0.30, 0.95, 0.15],  // neon green
        [0.60, 1.00, 0.10],  // bright lime
        [0.20, 0.70, 0.05],  // dark green
        [0.80, 0.95, 0.20],  // yellow-green
    ],
    dustBrightness: [0.18, 0.38],
    dustTint: [0.5, 1.2, 0.3],   // green dust
    cloudBrightness: [0.20, 0.40],
    cloudTint: [0.4, 1.1, 0.3],   // green-tinted clouds
    flashColor: 0x44ff44,
    shadowColor: 0x051a05,
    shadowOuterColor: 0x031203,
    trailColor: [0.3, 1.0, 0.2],
    boxPalette: [0x1a4a1a, 0x2a5a2a, 0x0a3a0a, 0x3a5a1a, 0x1a3a10],
    flatPalette: [0x2a5a20, 0x1a4a18, 0x3a6a2a, 0x0a3a08, 0x2a4a10],
    chunkPalette: [0x1a3a18, 0x2a4a20, 0x0a2a08, 0x1a4a1a],
};

/** All available skins, keyed by ID for quick lookup. */
export const TORNADO_SKINS: Record<string, TornadoSkin> = {
    classic: CLASSIC,
    inferno: INFERNO,
    frost: FROST,
    void: VOID,
    thunder: THUNDER,
    toxic: TOXIC,
};

/** Ordered list for the UI selector — only Classic is available for now. */
export const SKIN_LIST: TornadoSkin[] = [
    CLASSIC,
];

/** Returns the skin matching the given ID, or Classic as fallback. */
export function getSkinById(id: string): TornadoSkin {
    return TORNADO_SKINS[id] ?? CLASSIC;
}

/**
 * Brighten a hex color by a factor (e.g. 1.1 = 10% brighter).
 * Clamps each channel to 0xFF.
 */
export function brightenColor(hex: number, factor: number): number {
    const r = Math.min(0xff, Math.round(((hex >> 16) & 0xff) * factor));
    const g = Math.min(0xff, Math.round(((hex >> 8) & 0xff) * factor));
    const b = Math.min(0xff, Math.round((hex & 0xff) * factor));
    return (r << 16) | (g << 8) | b;
}
