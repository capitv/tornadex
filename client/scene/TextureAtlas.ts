// ============================================
// Texture Atlas — shared 512x512 canvas atlas
// ============================================
//
// Layout (each quadrant is 256x256 px):
//
//   +----------+----------+
//   |  smoke/  |  grass   |  top row
//   |   dust   |          |
//   +----------+----------+
//   |  dirt /  |  road /  |  bottom row
//   |   soil   |  asphalt |
//   +----------+----------+
//   U: 0..0.5 left, 0.5..1 right
//   V: 0..0.5 top,  0.5..1 bottom
//
// UV helpers are exported so any consumer can address the correct region
// without hard-coding raw numbers.

import * as THREE from 'three';

/** Axis-aligned UV region inside the atlas. Values are in [0, 1]. */
export interface AtlasRegion {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
}

// Named regions — one per 256x256 quadrant
export const AtlasRegions = {
    SMOKE_DUST: { u0: 0.0, v0: 0.0, u1: 0.5, v1: 0.5 } as AtlasRegion,
    GRASS:      { u0: 0.5, v0: 0.0, u1: 1.0, v1: 0.5 } as AtlasRegion,
    DIRT:       { u0: 0.0, v0: 0.5, u1: 0.5, v1: 1.0 } as AtlasRegion,
    ROAD:       { u0: 0.5, v0: 0.5, u1: 1.0, v1: 1.0 } as AtlasRegion,
} as const;

// ---- Singleton atlas texture ----
// Built once at module load, shared across all consumers to avoid redundant
// GPU texture uploads and to reduce texture-state changes per draw call.
let _atlasTexture: THREE.CanvasTexture | null = null;

export function getAtlasTexture(): THREE.CanvasTexture {
    if (_atlasTexture) return _atlasTexture;

    const SIZE      = 512; // total atlas size
    const HALF      = SIZE / 2; // 256 — one quadrant side

    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;

    // ------------------------------------------------------------------
    // Q1 (top-left, UV 0..0.5 / 0..0.5) — Smoke / Dust particle
    // ------------------------------------------------------------------
    drawSmokeDust(ctx, 0, 0, HALF);

    // ------------------------------------------------------------------
    // Q2 (top-right, UV 0.5..1 / 0..0.5) — Grass ground texture
    // ------------------------------------------------------------------
    drawGrass(ctx, HALF, 0, HALF);

    // ------------------------------------------------------------------
    // Q3 (bottom-left, UV 0..0.5 / 0.5..1) — Dirt / Soil texture
    // ------------------------------------------------------------------
    drawDirt(ctx, 0, HALF, HALF);

    // ------------------------------------------------------------------
    // Q4 (bottom-right, UV 0.5..1 / 0.5..1) — Road / Asphalt texture
    // ------------------------------------------------------------------
    drawRoad(ctx, HALF, HALF, HALF);

    _atlasTexture = new THREE.CanvasTexture(canvas);
    _atlasTexture.wrapS = THREE.RepeatWrapping;
    _atlasTexture.wrapT = THREE.RepeatWrapping;
    _atlasTexture.needsUpdate = true;

    return _atlasTexture;
}

// ---- Returns a CanvasTexture that covers ONLY the smoke/dust quadrant.
//      Used by TornadoMesh / ParticleSystem's PointsMaterial which expects
//      the texture to fill the whole UV space [0,1].
//      We achieve this by using a sub-canvas cropped to that quadrant.     ----
let _smokeTexture: THREE.CanvasTexture | null = null;

export function getSmokeTexture(): THREE.CanvasTexture {
    if (_smokeTexture) return _smokeTexture;

    const SIZE = 128;
    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    drawSmokeDust(ctx, 0, 0, SIZE);

    _smokeTexture = new THREE.CanvasTexture(canvas);
    _smokeTexture.needsUpdate = true;
    return _smokeTexture;
}

// ---- Returns a sub-texture covering a specific atlas region.
//      The sub-canvas is drawn by sampling only the relevant quadrant
//      so the THREE.js UV range [0,1] maps naturally to that region.     ----
export function getAtlasSubTexture(region: AtlasRegion): THREE.CanvasTexture {
    const SIZE    = 256;
    const canvas  = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx     = canvas.getContext('2d')!;

    // Draw whichever quadrant is requested
    const isRight  = region.u0 >= 0.5;
    const isBottom = region.v0 >= 0.5;

    if (!isRight && !isBottom) drawSmokeDust(ctx, 0, 0, SIZE);
    else if (isRight && !isBottom) drawGrass(ctx, 0, 0, SIZE);
    else if (!isRight && isBottom) drawDirt(ctx, 0, 0, SIZE);
    else drawRoad(ctx, 0, 0, SIZE);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
}

// ============================================================
// Private quadrant drawing helpers
// ============================================================

/** Radial-gradient soft smoke puff — identical to the original TornadoMesh texture. */
function drawSmokeDust(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number): void {
    const cx = ox + size / 2;
    const cy = oy + size / 2;
    const r  = size / 2;

    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    gradient.addColorStop(0,    'rgba(255,255,255,1)');
    gradient.addColorStop(0.30, 'rgba(255,255,255,0.7)');
    gradient.addColorStop(0.70, 'rgba(255,255,255,0.1)');
    gradient.addColorStop(1,    'rgba(255,255,255,0)');

    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(ox, oy, size, size);
    ctx.restore();
}

/** Procedural grass texture — green base with subtle noise blades. */
function drawGrass(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number): void {
    ctx.save();

    // Base colour
    ctx.fillStyle = '#3a5a40';
    ctx.fillRect(ox, oy, size, size);

    // Variation patches — lighter and darker greens
    const patches: [string, number, number, number][] = [
        ['#2e4d35', 0.05, 0.10, 0.40],
        ['#4a7050', 0.20, 0.05, 0.35],
        ['#3d6445', 0.45, 0.35, 0.30],
        ['#2a4830', 0.60, 0.60, 0.45],
        ['#527a58', 0.10, 0.65, 0.28],
        ['#476d4d', 0.70, 0.15, 0.38],
    ];
    for (const [color, rx, ry, rr] of patches) {
        const gx = ox + rx * size;
        const gy = oy + ry * size;
        const gr  = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr * size);
        gr.addColorStop(0,   color + 'cc');
        gr.addColorStop(1,   color + '00');
        ctx.fillStyle = gr;
        ctx.fillRect(ox, oy, size, size);
    }

    // Short vertical blade strokes for detail
    ctx.strokeStyle = 'rgba(60,90,50,0.35)';
    ctx.lineWidth   = 1;
    const bladeCount = Math.floor(size * 0.6);
    for (let i = 0; i < bladeCount; i++) {
        const bx = ox + Math.random() * size;
        const by = oy + Math.random() * size;
        const bh = 3 + Math.random() * 5;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + (Math.random() - 0.5) * 2, by - bh);
        ctx.stroke();
    }

    ctx.restore();
}

/** Procedural dirt / soil texture — earthy browns with coarse grain. */
function drawDirt(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number): void {
    ctx.save();

    // Base colour — mid brown
    ctx.fillStyle = '#6b4c2a';
    ctx.fillRect(ox, oy, size, size);

    // Large colour variation blobs
    const blobs: [string, number, number, number][] = [
        ['#7a5533', 0.15, 0.10, 0.35],
        ['#5a3e1f', 0.55, 0.25, 0.30],
        ['#8a6040', 0.30, 0.60, 0.40],
        ['#503820', 0.70, 0.65, 0.28],
        ['#7d5630', 0.05, 0.70, 0.25],
    ];
    for (const [color, rx, ry, rr] of blobs) {
        const bx  = ox + rx * size;
        const by  = oy + ry * size;
        const br  = ctx.createRadialGradient(bx, by, 0, bx, by, rr * size);
        br.addColorStop(0,   color + 'bb');
        br.addColorStop(1,   color + '00');
        ctx.fillStyle = br;
        ctx.fillRect(ox, oy, size, size);
    }

    // Fine grain — tiny dark speckles
    ctx.fillStyle = 'rgba(40,25,10,0.18)';
    const speckleCount = Math.floor(size * 1.5);
    for (let i = 0; i < speckleCount; i++) {
        const sx = ox + Math.random() * size;
        const sy = oy + Math.random() * size;
        const sr = 0.5 + Math.random() * 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}

/** Procedural road / asphalt texture — dark grey with lane markings. */
function drawRoad(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number): void {
    ctx.save();

    // Base — dark asphalt
    ctx.fillStyle = '#1f2326';
    ctx.fillRect(ox, oy, size, size);

    // Subtle aggregate variation
    const aggBlobs: [string, number, number, number][] = [
        ['#272c30', 0.20, 0.15, 0.40],
        ['#1a1e22', 0.60, 0.50, 0.35],
        ['#24292d', 0.05, 0.65, 0.30],
        ['#2a3035', 0.70, 0.20, 0.25],
    ];
    for (const [color, rx, ry, rr] of aggBlobs) {
        const ax  = ox + rx * size;
        const ay  = oy + ry * size;
        const ag  = ctx.createRadialGradient(ax, ay, 0, ax, ay, rr * size);
        ag.addColorStop(0,   color + 'aa');
        ag.addColorStop(1,   color + '00');
        ctx.fillStyle = ag;
        ctx.fillRect(ox, oy, size, size);
    }

    // Dashed centre line — white/yellow
    ctx.strokeStyle = 'rgba(240,220,80,0.55)';
    ctx.lineWidth   = Math.max(1, size * 0.025);
    ctx.setLineDash([size * 0.10, size * 0.08]);
    const cx = ox + size / 2;
    ctx.beginPath();
    ctx.moveTo(cx, oy);
    ctx.lineTo(cx, oy + size);
    ctx.stroke();

    // Edge lines — white
    ctx.strokeStyle = 'rgba(220,220,220,0.30)';
    ctx.lineWidth   = Math.max(1, size * 0.015);
    ctx.setLineDash([]);
    const margin = size * 0.08;
    ctx.beginPath();
    ctx.moveTo(ox + margin, oy);
    ctx.lineTo(ox + margin, oy + size);
    ctx.moveTo(ox + size - margin, oy);
    ctx.lineTo(ox + size - margin, oy + size);
    ctx.stroke();

    // Fine surface grain
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    const grainCount = Math.floor(size * 1.2);
    for (let i = 0; i < grainCount; i++) {
        const gx = ox + Math.random() * size;
        const gy = oy + Math.random() * size;
        ctx.fillRect(gx, gy, 1, 1);
    }

    ctx.restore();
}
