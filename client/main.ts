// ============================================
// Main Entry Point — Wire Everything Together
// ============================================

import { loadGameSystems, type GameSystems, type TornadoMeshInstance } from './game/loadGameSystems.js';
import { NetworkManager } from './network/NetworkManager.js';
import { Interpolation } from './network/Interpolation.js';
import { InputHandler } from './input/InputHandler.js';
import { HUD } from './ui/HUD.js';
import { getGraphicsPreset, getGraphicsQuality, setGraphicsQuality } from './settings/GraphicsConfig.js';
import { SKIN_LIST } from './scene/TornadoSkins.js';
import { WORLD_SIZE } from '../shared/worldConfig.js';
import { generateStaticWorldLayout, type StaticWorldLayout } from '../shared/worldgen.js';
import type { GameState, WorldObject, WorldObjectType, TerrainZone, SafeZone, PowerUp, InputPayload, JoinedPayload } from '../shared/types.js';

// ---- DOM Elements ----
const canvas             = document.getElementById('game-canvas') as HTMLCanvasElement;
const mainMenu           = document.getElementById('main-menu')!;
const deathScreen        = document.getElementById('death-screen')!;
const deathVignette      = document.getElementById('death-vignette')!;
const reconnectOverlay   = document.getElementById('reconnect-overlay')!;
const hud                = document.getElementById('hud')!;
const playBtn            = document.getElementById('play-btn')!;
const respawnBtn         = document.getElementById('respawn-btn')!;
const nameInput          = document.getElementById('player-name') as HTMLInputElement;
const seedInput          = document.getElementById('seed-input') as HTMLInputElement;
const seedDisplay        = document.getElementById('seed-display')!;
const seedHud            = document.getElementById('seed-hud')!;
const PLAY_BUTTON_IDLE_LABEL = playBtn.textContent ?? 'PLAY';

// Death screen stat elements (new redesigned death screen)
const deathKillerName = document.getElementById('death-killer-name')!;
const dsScore         = document.getElementById('ds-score')!;
const dsDestroyed     = document.getElementById('ds-destroyed')!;
const dsTime          = document.getElementById('ds-time')!;
const dsCategory      = document.getElementById('ds-category')!;
const deathTip        = document.getElementById('death-tip')!;

// Death cam overlay elements
const deathCamOverlay    = document.getElementById('death-cam-overlay')!;
const deathCamKillerName = document.getElementById('death-cam-killer-name')!;
const deathCamSummary    = document.getElementById('death-cam-summary')!;

// Tutorial overlay elements
const tutorialOverlay    = document.getElementById('tutorial-overlay')!;
const tutorialDismissBtn = document.getElementById('tutorial-dismiss-btn')!;

// ---- Prevent default touch behaviors on the game canvas ----
canvas.addEventListener('touchstart', (e) => { if (isPlaying) e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchmove', (e) => { if (isPlaying) e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchend', (e) => { if (isPlaying) e.preventDefault(); }, { passive: false });

// ---- Mobile: default to low graphics quality ----
if (navigator.maxTouchPoints > 0) {
    const savedQuality = localStorage.getItem('tornado_io_graphics_quality');
    if (!savedQuality) {
        setGraphicsQuality('low');
    }
}

// ---- Core Systems ----
let gameSystems: GameSystems | null = null;
let gameSystemsPromise: Promise<GameSystems> | null = null;
let renderLoopStarted = false;
const network = new NetworkManager();
const interpolation = new Interpolation();
const input = new InputHandler(canvas);
const hudManager = new HUD();

// ============================================================
// Debug Overlay — toggled with F3 key
// Shows: FPS, ping, bandwidth, pending inputs, prediction error,
//        interpolation state, player count, and more.
// ============================================================
const debugOverlay = document.createElement('div');
debugOverlay.id = 'debug-overlay';
debugOverlay.style.cssText = `
    position: fixed; top: 8px; left: 8px; z-index: 9999;
    background: rgba(0,0,0,0.82); color: #0f0; font: 11px monospace;
    padding: 8px 10px 8px 10px; border-radius: 4px; pointer-events: auto;
    line-height: 1.5; white-space: pre; display: none; min-width: 300px;
    border: 1px solid rgba(0,255,0,0.2);
`;

// Copy button inside overlay
const debugCopyBtn = document.createElement('button');
debugCopyBtn.textContent = '📋 COPY';
debugCopyBtn.style.cssText = `
    position: absolute; top: 6px; right: 6px;
    background: rgba(0,255,0,0.15); color: #0f0; border: 1px solid rgba(0,255,0,0.4);
    font: 10px monospace; padding: 2px 7px; border-radius: 3px; cursor: pointer;
`;
debugCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(debugOverlay.dataset.debugText ?? '').then(() => {
        debugCopyBtn.textContent = '✓ COPIED';
        setTimeout(() => { debugCopyBtn.textContent = '📋 COPY'; }, 1500);
    });
});
debugOverlay.appendChild(debugCopyBtn);

// Text content area (below the copy button)
const debugText = document.createElement('div');
debugText.style.cssText = 'margin-top: 18px;';
debugOverlay.appendChild(debugText);

document.body.appendChild(debugOverlay);

// ---- Chat DOM elements (built early so startGame/onDeath can reference them) ----
const chatContainer = document.createElement('div');
chatContainer.id = 'chat-container';

const chatLog = document.createElement('div');
chatLog.id = 'chat-log';

const chatInputWrap = document.createElement('div');
chatInputWrap.id = 'chat-input-wrap';

const chatInput = document.createElement('input');
chatInput.id = 'chat-input';
chatInput.type = 'text';
chatInput.maxLength = 100;
chatInput.placeholder = 'Press Enter to chat...';
chatInput.autocomplete = 'off';

chatInputWrap.appendChild(chatInput);
chatContainer.appendChild(chatLog);
chatContainer.appendChild(chatInputWrap);
document.body.appendChild(chatContainer);

// Hidden until the game starts
chatContainer.style.display = 'none';

let debugVisible = false;
window.addEventListener('keydown', (e) => {
    if (e.key === 'F3') {
        e.preventDefault();
        debugVisible = !debugVisible;
        debugOverlay.style.display = debugVisible ? 'block' : 'none';
    }
});

// Debug metrics accumulated per frame
const debugMetrics = {
    fps: 0,
    frameTimes: new Float32Array(60),
    frameTimeIdx: 0,
    frameTimeFilled: 0,
    lastStateTime: 0,
    stateRate: 0,
    stateCount: 0,
    stateWindowStart: 0,
    predictionError: 0,
    pendingInputCount: 0,
    interpPlayerCount: 0,
    displayX: 0,
    displayY: 0,
    serverX: 0,
    serverY: 0,
    isDelta: false,
    deltaCount: 0,
    fullCount: 0,
    lastPacketType: 'none' as string,
    // Extra player info
    radius: 0,
    stamina: 0,
    category: 'F0',
    score: 0,
    activeEffects: '',
    // Memory
    jsHeapMB: 0,
};

// ---- Tornado Meshes (for all players) ----
const tornadoMeshes: Map<string, TornadoMeshInstance> = new Map();

// ---- Stamina history for remote boost inference ----
// Stores the stamina value from the previous frame for each player ID.
// A meaningful drop indicates the remote player is boosting.
const prevStamina: Map<string, number> = new Map();

// ---- State ----
let playerName = '';
let lastScore = 0;
let worldSize = WORLD_SIZE;
let previousObjectIds: Set<number> = new Set();
let isPlaying = false;
let worldReady = false;
let pendingStateBeforeWorldReady: GameState | null = null;
let isStartingGame = false;
let joinWorldLoadToken = 0;

// ---- Chat state (DOM created later, referenced early) ----
let chatOpen = false;
/** The seed the server confirmed for the current map. Set in onJoined(). */
let currentMapSeed: number | null = null;

// ---- Run stats (tracked per spawn) ----
let runStartTime: number      = 0;
let runDestroyedCount: number = 0;
let runMaxCategory: string    = 'F0';

// ---- Death cam state ----
let deathCamActive: boolean     = false;
let deathCamKiller: string      = '';  // killer's player name, used to track their position
let deathCamTimeout: ReturnType<typeof setTimeout> | null = null;

// ---- Play Again cooldown state ----
let respawnCooldownInterval: ReturnType<typeof setInterval> | null = null;

// ---- Death screen tips ----
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

// ---- Fujita helpers (mirrors HUD.ts thresholds) ----
function getFujitaCategory(radius: number): string {
    if (radius < 1.0) return 'F0';
    if (radius < 2.0) return 'F1';
    if (radius < 3.0) return 'F2';
    if (radius < 4.0) return 'F3';
    if (radius < 5.0) return 'F4';
    return 'F5';
}

function compareCategoryGt(a: string, b: string): boolean {
    const order = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5'];
    return order.indexOf(a) > order.indexOf(b);
}

function formatRunTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
}

function resetRunStats(): void {
    runStartTime      = performance.now();
    runDestroyedCount = 0;
    runMaxCategory    = 'F0';
    lastScore         = 0;
}

// ---- Zone data (populated on join, used each frame for waterspout checks) ----
let waterZones: TerrainZone[] = [];

// ---- Safe zones (received once on join; never change at runtime) ----
// Kept here for potential future client-side querying (e.g. minimap icons).
let _safeZones: SafeZone[] = [];

// ---- Track which tornadoes are currently over water so we can clean up rings ----
const tornadoOverWater: Set<string> = new Set();

// ---- Reusable per-frame sets/arrays (avoid allocations in the render loop) ----
const _activeMeshIds = new Set<string>();
const _tornadoDeformPositions: { x: number; z: number; radius: number }[] = new Array(64);
for (let i = 0; i < 64; i++) _tornadoDeformPositions[i] = { x: 0, z: 0, radius: 0 };
const _minimapPlayers: import('../shared/types.js').PlayerState[] = [];
const _newlyDestroyed: number[] = [];

/**
 * Returns true when world-space point (x, y) lies inside any water zone.
 * The server uses a 2-D coordinate system where y maps to Three.js Z.
 */
function isOverWaterZone(x: number, y: number): boolean {
    for (const zone of waterZones) {
        if (
            x >= zone.x && x <= zone.x + zone.width &&
            y >= zone.y && y <= zone.y + zone.height
        ) {
            return true;
        }
    }
    return false;
}

// Send input at a fixed rate (20 times/sec to match server tick)
let inputInterval: ReturnType<typeof setInterval> | null = null;

// ---- Ping polling ----
// Probe every 2 000 ms; HUD is updated with the smoothed average after each reply.
let pingInterval: ReturnType<typeof setInterval> | null = null;

// ---- Input sequence numbering ----
// Each input sent to the server gets an incrementing sequence number.
// The server echoes back the last seq it processed (PlayerState.lastInputSeq).
// The client keeps a buffer of unacknowledged inputs and replays them on top of
// the authoritative server position to produce a corrected predicted position.
let inputSeq: number = 0;

interface BufferedInput {
    seq: number;
    angle: number;
    active: boolean;
    boost: boolean;
}

/** Inputs sent but not yet acknowledged by the server (lastInputSeq from PlayerState). */
const pendingInputs: BufferedInput[] = [];

/** Pre-allocated input object reused for network sends to avoid per-tick allocation.
 *  ONLY used for the sendInput() call — pendingInputs entries are separate objects. */
const _stampedInput: InputPayload & { seq: number } = { angle: 0, active: false, boost: false, seq: 0 };

/** The last input sent to the server — used in the render loop for extrapolation
 *  consistency so displayPos advances using the same input the server will process. */
let lastSentInput: { angle: number; active: boolean; boost: boolean } = { angle: 0, active: false, boost: false };

// ---- Client-side prediction state ----
// Locally predicted position applied on input so the player's tornado responds
// without waiting for the next server state packet (~50 ms round-trip).
// Proper reconciliation: when a new server state arrives the prediction is
// reset to the server-authoritative position, then unacknowledged inputs are
// replayed on top of it to keep the prediction ahead of the confirmed state.
interface PredictedState {
    x: number;
    y: number;
}
let predictedLocal: PredictedState | null = null;

/**
 * Render-loop extrapolation display position.
 * This is where the tornado is actually drawn. It starts from predictedLocal
 * (the reconciled position) and advances every frame using the current input.
 * It is NEVER written back to predictedLocal, so when onState arrives and
 * resets predictedLocal the transition is seamless — no flicker.
 */
let displayPos: PredictedState | null = null;


/** Cached radius from the latest server state — used for speed-size scaling
 *  in the render-loop extrapolation so it matches the server physics. */
let localPlayerRadius: number = 1;

/** Whether the local player has a speed power-up active — cached from latest
 *  server state so render-loop extrapolation matches server physics. */
let localHasSpeedPowerUp: boolean = false;

/**
 * Base move speed that mirrors the server constant (PLAYER_SPEED = 1.0 units/tick).
 * Server tick = 50 ms, so 1.0 / 50 = 0.02 units/ms.
 */
const BASE_SPEED_PER_MS = 1.0 / 50; // 0.02 units/ms
/** Boost multiplier: same as the server's canBoost multiplier (1.8). */
const BOOST_MULTIPLIER  = 1.8;
/** Size-based slowdown factor — mirrors server SPEED_SIZE_FACTOR (0.015). */
const SPEED_SIZE_FACTOR = 0.015;
/** Power-up speed boost multiplier — mirrors server SPEED_BOOST_MULTIPLIER (1.5). */
const POWERUP_SPEED_MULTIPLIER = 1.5;

// ---- Seed URL handling ----
// On page load, read ?seed= from the URL and pre-fill the seed input.
(function initSeedFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const urlSeed = params.get('seed');
    if (urlSeed) {
        const parsed = parseInt(urlSeed, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            seedInput.value = String(parsed);
        }
    }
})();

/**
 * Updates both the menu seed display and the in-HUD seed indicator
 * once we know the server-confirmed seed.
 */
function applySeed(seed: number): void {
    currentMapSeed = seed;

    // Menu label — clickable to copy link
    seedDisplay.textContent = `MAP SEED: ${seed}`;

    // HUD corner — tiny unobtrusive indicator
    seedHud.textContent = `SEED: ${seed}`;

    // Update the browser URL without a page reload so the link is shareable
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seed));
    history.replaceState(null, '', url.toString());
}

// Clicking the seed display copies the shareable URL to clipboard
seedDisplay.addEventListener('click', () => {
    if (currentMapSeed === null) return;
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(currentMapSeed));
    navigator.clipboard.writeText(url.toString()).then(() => {
        const prev = seedDisplay.textContent;
        seedDisplay.textContent = 'Link copied!';
        setTimeout(() => { seedDisplay.textContent = prev; }, 1500);
    }).catch(() => {
        // Fallback: select the text so the user can copy manually
        window.getSelection()?.selectAllChildren(seedDisplay);
    });
});

// Clicking the HUD seed also copies the URL
seedHud.addEventListener('click', () => {
    if (currentMapSeed === null) return;
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(currentMapSeed));
    navigator.clipboard.writeText(url.toString()).then(() => {
        const prev = seedHud.textContent;
        seedHud.textContent = 'Copied!';
        setTimeout(() => { seedHud.textContent = prev; }, 1500);
    }).catch(() => {});
});

// ---- Graphics Settings UI ----
(function initGraphicsUI() {
    const btnGroup = document.getElementById('graphics-btn-group');
    if (!btnGroup) return;

    const buttons = btnGroup.querySelectorAll<HTMLButtonElement>('.graphics-btn');

    /** Reflect the current quality level on the button group. */
    function syncButtons(quality: string): void {
        buttons.forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.quality === quality);
        });
    }

    // Set initial active state from saved preference
    syncButtons(getGraphicsQuality());

    // Wire click handlers
    buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const quality = btn.dataset.quality as 'low' | 'medium' | 'high';
            if (!quality) return;
            setGraphicsQuality(quality);
            syncButtons(quality);
        });
    });
})();

// ---- Tornado Skin Selector ----
/** Returns the currently selected skin ID from localStorage (defaults to 'classic'). */
function getSelectedSkin(): string {
    try {
        return localStorage.getItem('tornado-skin') || 'classic';
    } catch {
        return 'classic';
    }
}

(function initSkinSelector() {
    const container = document.createElement('div');
    container.className = 'skin-selector';

    const label = document.createElement('span');
    label.className = 'skin-selector-label';
    label.textContent = 'SKIN';
    container.appendChild(label);

    const row = document.createElement('div');
    row.className = 'skin-selector-row';

    const currentSkin = getSelectedSkin();

    for (const skin of SKIN_LIST) {
        const btn = document.createElement('button');
        btn.className = 'skin-btn';
        if (skin.id === currentSkin) btn.classList.add('active');
        btn.dataset.skinId = skin.id;
        btn.title = skin.name;
        btn.textContent = skin.emoji;

        btn.addEventListener('click', () => {
            try { localStorage.setItem('tornado-skin', skin.id); } catch { /* storage full or blocked */ }
            // Update active state on all buttons
            row.querySelectorAll('.skin-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });

        row.appendChild(btn);
    }

    container.appendChild(row);

    // Insert the selector into the menu container, after the input-group (play button row)
    const menuContainer = document.querySelector('.menu-container');
    const inputGroup = document.querySelector('.input-group');
    if (menuContainer && inputGroup) {
        inputGroup.insertAdjacentElement('afterend', container);
    }
})();

let worldgenWorker: Worker | null = null;
let worldgenRequestId = 0;
const pendingWorldgenRequests = new Map<number, {
    resolve: (layout: StaticWorldLayout) => void;
    reject: (reason?: unknown) => void;
}>();

function setPlayButtonBusy(busy: boolean): void {
    if (busy) {
        playBtn.setAttribute('disabled', 'true');
        playBtn.textContent = 'LOADING...';
    } else {
        playBtn.removeAttribute('disabled');
        playBtn.textContent = PLAY_BUTTON_IDLE_LABEL;
    }
}

function beginRenderLoop(): void {
    if (renderLoopStarted) return;
    renderLoopStarted = true;
    lastTime = performance.now();
    requestAnimationFrame(animate);
}

async function ensureGameSystems(): Promise<GameSystems> {
    if (gameSystems) return gameSystems;
    if (!gameSystemsPromise) {
        gameSystemsPromise = loadGameSystems(canvas).then((systems) => {
            gameSystems = systems;
            beginRenderLoop();
            return systems;
        }).catch((err) => {
            gameSystemsPromise = null;
            throw err;
        });
    }
    return gameSystemsPromise;
}

function getWorldgenWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (worldgenWorker) return worldgenWorker;

    worldgenWorker = new Worker(new URL('./workers/worldgen.worker.ts', import.meta.url), { type: 'module' });
    worldgenWorker.onmessage = (event: MessageEvent<{ requestId: number; layout: StaticWorldLayout }>) => {
        const pending = pendingWorldgenRequests.get(event.data.requestId);
        if (!pending) return;
        pendingWorldgenRequests.delete(event.data.requestId);
        pending.resolve(event.data.layout);
    };
    worldgenWorker.onerror = (event) => {
        console.error('[Worldgen] Worker failed, falling back to main thread:', event.message);
        const pending = Array.from(pendingWorldgenRequests.values());
        pendingWorldgenRequests.clear();
        worldgenWorker?.terminate();
        worldgenWorker = null;
        for (const req of pending) req.reject(event.error ?? new Error(event.message));
    };
    return worldgenWorker;
}

function generateStaticWorldLayoutAsync(seed: number): Promise<StaticWorldLayout> {
    const worker = getWorldgenWorker();
    if (!worker) {
        return Promise.resolve(generateStaticWorldLayout(seed));
    }

    const requestId = ++worldgenRequestId;
    return new Promise<StaticWorldLayout>((resolve, reject) => {
        pendingWorldgenRequests.set(requestId, { resolve, reject });
        worker.postMessage({ requestId, seed });
    }).catch(() => generateStaticWorldLayout(seed));
}

// ---- Event Handlers ----
playBtn.addEventListener('click', () => {
    void startGame().catch((err) => {
        console.error('[Game] Failed to start:', err);
    });
});
respawnBtn.addEventListener('click', () => {
    if (respawnBtn.hasAttribute('disabled')) return;
    respawnGame();
});
nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        void startGame().catch((err) => {
            console.error('[Game] Failed to start:', err);
        });
    }
});

// ---- Tutorial: show on page load (first visit only), dismiss before playing ----
tutorialDismissBtn.addEventListener('click', () => {
    tutorialOverlay.classList.add('hidden');
    localStorage.setItem('tutorialSeen', '1');
});
try {
    if (!localStorage.getItem('tutorialSeen')) {
        tutorialOverlay.classList.remove('hidden');
    }
} catch { /* localStorage unavailable */ }

function requestFullscreen(): void {
    // On mobile, request fullscreen to hide URL bar
    if (navigator.maxTouchPoints > 0) {
        const el = document.documentElement as any;
        const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
        if (req) req.call(el).catch(() => { /* user denied or not supported */ });
    }
}

async function startGame(): Promise<void> {
    if (isStartingGame) return;
    isStartingGame = true;
    setPlayButtonBusy(true);
    requestFullscreen();

    try {
    await ensureGameSystems();

    playerName = nameInput.value.trim() || 'Tornado';
    mainMenu.classList.add('hidden');
    deathScreen.classList.add('hidden');
    deathVignette.classList.remove('active');
    // Cancel death cam if still active
    if (deathCamTimeout) { clearTimeout(deathCamTimeout); deathCamTimeout = null; }
    deathCamActive = false;
    deathCamOverlay.classList.add('hidden');
    hud.classList.remove('hidden');

    // Read the optional seed preference from the input field
    const rawSeed = seedInput.value.trim();
    const preferredSeed = rawSeed ? parseInt(rawSeed, 10) : undefined;
    const validSeed = (preferredSeed !== undefined && Number.isFinite(preferredSeed) && preferredSeed > 0)
        ? preferredSeed
        : undefined;
    network.join(playerName, validSeed);
    isPlaying = true;
    worldReady = false;
    pendingStateBeforeWorldReady = null;
    input.showControls();
    predictedLocal = null;
    displayPos = null;

    localPlayerRadius = 1;
    localHasSpeedPowerUp = false;
    pendingInputs.length = 0; // fresh session — clear any stale inputs
    inputSeq = 0;
    resetRunStats();

    // Show chat
    chatContainer.style.display = '';

    // Start sending inputs at 20 Hz (matches server tick rate)
    if (inputInterval) clearInterval(inputInterval);
    inputInterval = setInterval(() => {
        if (isPlaying) {
            // Suppress game input while typing in chat
            const raw = chatOpen
                ? { angle: lastSentInput.angle, active: false, boost: false, adminGrow: false, adminShrink: false, seq: 0 }
                : input.getInput();
            // Stamp this input with the next monotonic sequence number
            inputSeq++;
            _stampedInput.angle  = raw.angle;
            _stampedInput.active = raw.active;
            _stampedInput.boost  = raw.boost;
            _stampedInput.seq    = inputSeq;
            network.sendInput(_stampedInput);

            // Cache the sent input so the render loop uses the same values
            lastSentInput.angle  = raw.angle;
            lastSentInput.active = raw.active;
            lastSentInput.boost  = raw.boost;

            // Buffer the input for reconciliation replay
            pendingInputs.push({
                seq:    inputSeq,
                angle:  raw.angle,
                active: raw.active,
                boost:  raw.boost,
            });

            // Keep the buffer bounded (at most 40 entries ≈ 2 seconds of history)
            if (pendingInputs.length > 40) pendingInputs.shift();
        }
    }, 50);

    // Start ping polling: probe immediately, then every 2 seconds
    if (pingInterval) clearInterval(pingInterval);
    network.measurePing();
    pingInterval = setInterval(() => {
        network.measurePing();
        hudManager.updatePing(network.getPing());
    }, 2000);
    } finally {
        isStartingGame = false;
        setPlayButtonBusy(false);
    }
}

function respawnGame(): void {
    requestFullscreen();
    // Cancel death cam if still active
    if (deathCamTimeout) { clearTimeout(deathCamTimeout); deathCamTimeout = null; }
    deathCamActive = false;
    deathCamOverlay.classList.add('hidden');
    // Cancel respawn cooldown if any
    if (respawnCooldownInterval) { clearInterval(respawnCooldownInterval); respawnCooldownInterval = null; }
    respawnBtn.removeAttribute('disabled');
    respawnBtn.querySelector('span:last-child')!.textContent = 'PLAY AGAIN';

    deathScreen.classList.add('hidden');
    deathVignette.classList.remove('active');
    hud.classList.remove('hidden');
    input.showControls();
    network.respawn();
    interpolation.clear();
    isPlaying = true;
    chatContainer.style.display = '';
    predictedLocal = null;
    displayPos = null;

    localPlayerRadius = 1;
    localHasSpeedPowerUp = false;
    pendingInputs.length = 0; // discard stale inputs from the previous life
    inputSeq = 0;
    resetRunStats();
}

async function handleJoined(data: JoinedPayload): Promise<void> {
    const systems = await ensureGameSystems();
    const { sceneManager, worldRenderer, powerUpRenderer, particleSystem } = systems;
    const worldLoadToken = ++joinWorldLoadToken;

    worldReady = false;
    interpolation.clear();
    previousObjectIds.clear();
    pendingStateBeforeWorldReady = null;
    waterZones = [];
    _safeZones = [];

    for (const [id, mesh] of tornadoMeshes) {
        sceneManager.scene.remove(mesh.group);
        mesh.dispose();
        if (tornadoOverWater.has(id)) {
            particleSystem.removeSplashRing(id);
        }
    }
    tornadoMeshes.clear();
    tornadoOverWater.clear();
    prevStamina.clear();
    powerUpRenderer.dispose();
    worldRenderer.resetWorld();

    const worldLayout = await generateStaticWorldLayoutAsync(data.seed);
    if (worldLoadToken !== joinWorldLoadToken) return;

    worldSize = data.worldSize;
    hudManager.setWorldSize(worldSize);
    worldRenderer.createGround(worldSize);
    worldRenderer.createZones(worldLayout.zones);
    worldRenderer.createInitialObjects(worldLayout.objects);

    if (worldLayout.safeZones.length > 0) {
        _safeZones = worldLayout.safeZones;
        worldRenderer.createSafeZones(worldLayout.safeZones);
    }

    waterZones = worldLayout.zones.filter(z => z.type === 'water');
    sceneManager.skybox.setWorldBounds(worldSize / 2, worldSize / 2, worldSize / 2);

    if (data.seed) {
        applySeed(data.seed);
    }

    worldReady = true;
    if (import.meta.env.DEV) {
        console.log(`[Game] Joined! World size: ${worldSize}, Seed: ${data.seed}, Objects: ${worldLayout.objects.length}, Water zones: ${waterZones.length}`);
    }

    if (pendingStateBeforeWorldReady) {
        const queuedState = pendingStateBeforeWorldReady;
        pendingStateBeforeWorldReady = null;
        processGameState(queuedState);
    }
}

function processGameState(state: GameState): void {
    const systems = gameSystems;
    if (!systems) return;
    const { worldRenderer, powerUpRenderer, particleSystem, fragmentSystem } = systems;

    // Debug: track packet type
    debugMetrics.lastPacketType = (state as any)._isDelta ? 'delta' : 'full';
    if ((state as any)._isDelta) debugMetrics.deltaCount++; else debugMetrics.fullCount++;

    interpolation.updateState(state.players, state.serverTime);

    let localState: import('../shared/types.js').PlayerState | undefined;
    for (let i = 0; i < state.players.length; i++) {
        if (state.players[i].id === network.id) { localState = state.players[i]; break; }
    }
    if (localState) {
        const ackedSeq = localState.lastInputSeq;
        let removeCount = 0;
        for (let i = 0; i < pendingInputs.length; i++) {
            if (pendingInputs[i].seq <= ackedSeq) removeCount = i + 1;
            else break;
        }
        if (removeCount > 0) {
            const remaining = pendingInputs.length - removeCount;
            for (let i = 0; i < remaining; i++) {
                pendingInputs[i] = pendingInputs[i + removeCount];
            }
            pendingInputs.length = remaining;
        }

        localPlayerRadius = localState.radius;
        const hasSpeedPowerUp = Array.isArray(localState.activeEffects) &&
            localState.activeEffects.some((e: { type: string }) => e.type === 'speed');
        localHasSpeedPowerUp = hasSpeedPowerUp;
        const powerUpSpeedMult = hasSpeedPowerUp ? POWERUP_SPEED_MULTIPLIER : 1.0;
        if (localState.alive && pendingInputs.length > 0) {
            let rx = localState.x;
            let ry = localState.y;

            const halfPendingTicks = pendingInputs.length * 0.5;
            rx += localState.velocityX * halfPendingTicks;
            ry += localState.velocityY * halfPendingTicks;

            const INPUT_TICK_MS = 50;
            for (const inp of pendingInputs) {
                if (!inp.active) continue;
                const boostMult = inp.boost ? BOOST_MULTIPLIER : 1.0;
                const rawSpeed = BASE_SPEED_PER_MS * (1 - localState.radius * SPEED_SIZE_FACTOR) * boostMult * powerUpSpeedMult;
                const minSpeed = BASE_SPEED_PER_MS * 0.3 * boostMult * powerUpSpeedMult;
                const speed = Math.max(rawSpeed, minSpeed) * INPUT_TICK_MS;
                rx += Math.cos(inp.angle) * speed;
                ry += Math.sin(inp.angle) * speed;
            }
            const r = localState.radius;
            rx = Math.max(r, Math.min(worldSize - r, rx));
            ry = Math.max(r, Math.min(worldSize - r, ry));
            predictedLocal = { x: rx, y: ry };
        } else if (localState.alive) {
            const vExtraTicks = 0.5;
            predictedLocal = {
                x: localState.x + localState.velocityX * vExtraTicks,
                y: localState.y + localState.velocityY * vExtraTicks,
            };
        } else {
            predictedLocal = null;
        }

        if (predictedLocal && !displayPos) {
            displayPos = { x: predictedLocal.x, y: predictedLocal.y };
        } else if (!predictedLocal) {
            displayPos = null;
        }
    }

    _newlyDestroyed.length = 0;
    for (const id of state.destroyedObjectIds) {
        if (!previousObjectIds.has(id)) {
            previousObjectIds.add(id);
            _newlyDestroyed.push(id);

            const pos = worldRenderer.getObjectPosition(id);
            if (pos) {
                const type = worldRenderer.getObjectType(id) as WorldObjectType | null;
                const elevation = worldRenderer.getElevation(pos.x, pos.y);
                particleSystem.emitDestruction(pos.x, pos.y, type ?? 'unknown');
                if (type) {
                    fragmentSystem.spawnFragments(pos.x, pos.y, elevation, type);
                }
            }
            if (isPlaying) runDestroyedCount++;
        }
    }

    if (_newlyDestroyed.length > 0) {
        worldRenderer.hideNewlyDestroyedObjects(_newlyDestroyed);
    }

    if (previousObjectIds.size > state.destroyedObjectIds.length + 500) {
        previousObjectIds.clear();
        for (const id of state.destroyedObjectIds) {
            previousObjectIds.add(id);
        }
    }

    if (state.powerUps) {
        powerUpRenderer.update(state.powerUps);
    }

    hudManager.updateLeaderboard(state.leaderboard, playerName);

    if (state.kills && state.kills.length > 0) {
        for (const kill of state.kills) {
            hudManager.addKill(kill.killer, kill.victim, kill.killerRadius, playerName);
        }
    }
}

// ---- Network Callbacks ----
network.onJoined((data) => {
    void handleJoined(data).catch((err) => {
        console.error('[Game] Failed to build joined world:', err);
    });
    return;
    /*
    interpolation.clear();
    previousObjectIds.clear();
    waterZones = [];
    _safeZones = [];

    for (const [id, mesh] of tornadoMeshes) {
        sceneManager.scene.remove(mesh.group);
        mesh.dispose();
        if (tornadoOverWater.has(id)) {
            particleSystem.removeSplashRing(id);
        }
    }
    tornadoMeshes.clear();
    tornadoOverWater.clear();
    prevStamina.clear();
    powerUpRenderer.dispose();
    worldRenderer.resetWorld();

    const worldLayout = generateStaticWorldLayout(data.seed);
    worldSize = data.worldSize;
    hudManager.setWorldSize(worldSize);
    worldRenderer.createGround(worldSize);
    worldRenderer.createZones(worldLayout.zones);
    // Cloud ceiling removed — sky gradient handles the atmosphere
    worldRenderer.createInitialObjects(worldLayout.objects);

    // Render safe haven zone circles on the ground
    if (worldLayout.safeZones.length > 0) {
        _safeZones = worldLayout.safeZones;
        worldRenderer.createSafeZones(worldLayout.safeZones);
    }

    // Cache water zones for per-frame waterspout checks
    waterZones = worldLayout.zones.filter(z => z.type === 'water');

    // Tell the skybox where the world is so lightning bolts land inside the map
    sceneManager.skybox.setWorldBounds(worldSize / 2, worldSize / 2, worldSize / 2);

    // Show the server-confirmed seed in the UI and update the URL
    if (data.seed) {
        applySeed(data.seed);
    }

    if (import.meta.env.DEV) console.log(`[Game] Joined! World size: ${worldSize}, Seed: ${data.seed}, Objects: ${worldLayout.objects.length}, Water zones: ${waterZones.length}`);
    */
});

network.onState((state: GameState) => {
    if (!worldReady) {
        pendingStateBeforeWorldReady = state;
        return;
    }
    processGameState(state);
    return;
    /*
    // Debug: track packet type
    debugMetrics.lastPacketType = (state as any)._isDelta ? 'delta' : 'full';
    if ((state as any)._isDelta) debugMetrics.deltaCount++; else debugMetrics.fullCount++;

    // Feed the new snapshot into the interpolation ring buffer together with
    // the server's wall-clock time so timestamp-based interpolation works.
    interpolation.updateState(state.players, state.serverTime);

    // ---- Input prediction reconciliation ----
    // Drop all inputs that the server has already acknowledged.
    // Fast lookup — avoid .find() linear scan on every tick
    let localState: import('../shared/types.js').PlayerState | undefined;
    for (let i = 0; i < state.players.length; i++) {
        if (state.players[i].id === network.id) { localState = state.players[i]; break; }
    }
    if (localState) {
        const ackedSeq = localState.lastInputSeq;
        // Remove inputs with seq <= ackedSeq from the pending buffer
        let removeCount = 0;
        for (let i = 0; i < pendingInputs.length; i++) {
            if (pendingInputs[i].seq <= ackedSeq) removeCount = i + 1;
            else break;
        }
        if (removeCount > 0) {
            // Shift remaining inputs down instead of splice (avoids internal array realloc)
            const remaining = pendingInputs.length - removeCount;
            for (let i = 0; i < remaining; i++) {
                pendingInputs[i] = pendingInputs[i + removeCount];
            }
            pendingInputs.length = remaining;
        }

        // Replay unacknowledged inputs on top of the server-confirmed position
        // to re-derive where the client should be right now.
        // Each input represents one 50 ms server tick interval, so we replay
        // with a fixed dt of 50 ms per input rather than using wall-clock age
        // (which would compound movement incorrectly across multiple inputs).
        //
        // The speed calculation mirrors the server: it applies the
        // SPEED_SIZE_FACTOR radius-based slowdown, clamps to 30% minimum,
        // and accounts for the "speed" power-up multiplier (1.5x).
        localPlayerRadius = localState.radius;
        // Check if the local player has a speed power-up active
        const hasSpeedPowerUp = Array.isArray(localState.activeEffects) &&
            localState.activeEffects.some((e: { type: string }) => e.type === 'speed');
        localHasSpeedPowerUp = hasSpeedPowerUp;
        const powerUpSpeedMult = hasSpeedPowerUp ? POWERUP_SPEED_MULTIPLIER : 1.0;
        if (localState.alive && pendingInputs.length > 0) {
            // Start from the server-confirmed position, then use server velocity
            // to extrapolate forward by half the pending input window. This
            // accounts for any server-side forces (suction, collisions) that
            // the client can't replicate, reducing baseline prediction error.
            let rx = localState.x;
            let ry = localState.y;

            // Velocity-aware base: apply server velocity for the time gap
            // between the server state and the oldest pending input.
            // velocityX/Y are in units/tick (50ms). We extrapolate for
            // half the pending window to split the difference between
            // "server was here" and "server will be here after processing".
            const halfPendingTicks = pendingInputs.length * 0.5;
            rx += localState.velocityX * halfPendingTicks;
            ry += localState.velocityY * halfPendingTicks;

            const INPUT_TICK_MS = 50; // matches the sendInput setInterval
            for (const inp of pendingInputs) {
                if (!inp.active) continue;
                const boostMult = inp.boost ? BOOST_MULTIPLIER : 1.0;
                const rawSpeed = BASE_SPEED_PER_MS * (1 - localState.radius * SPEED_SIZE_FACTOR) * boostMult * powerUpSpeedMult;
                const minSpeed = BASE_SPEED_PER_MS * 0.3 * boostMult * powerUpSpeedMult;
                const speed = Math.max(rawSpeed, minSpeed) * INPUT_TICK_MS;
                rx += Math.cos(inp.angle) * speed;
                ry += Math.sin(inp.angle) * speed;
            }
            // Clamp to world bounds (mirrors server-side clamping)
            const r = localState.radius;
            rx = Math.max(r, Math.min(worldSize - r, rx));
            ry = Math.max(r, Math.min(worldSize - r, ry));
            predictedLocal = { x: rx, y: ry };
        } else if (localState.alive) {
            // No pending inputs — use server position with a small velocity
            // extrapolation to stay ahead of latency
            const vExtraTicks = 0.5; // half a tick of velocity to reduce lag feel
            predictedLocal = {
                x: localState.x + localState.velocityX * vExtraTicks,
                y: localState.y + localState.velocityY * vExtraTicks,
            };
        } else {
            predictedLocal = null;
        }

        // Don't snap displayPos — let the render loop lerp toward predictedLocal.
        // This avoids the freeze→jump→backward pattern caused by snapping + capped extrapolation.
        if (predictedLocal && !displayPos) {
            // First time: bootstrap displayPos
            displayPos = { x: predictedLocal.x, y: predictedLocal.y };
        } else if (!predictedLocal) {
            displayPos = null;
        }
    }

    // Update world objects and detect destructions.
    // Only process IDs that are new since the last tick (avoid re-creating a Set
    // from the entire destroyedObjectIds array every tick — that was O(n) per frame).
    _newlyDestroyed.length = 0;
    for (const id of state.destroyedObjectIds) {
        if (!previousObjectIds.has(id)) {
            previousObjectIds.add(id);
            _newlyDestroyed.push(id);

            // Object was JUST destroyed — trigger particles + breaking fragments
            const pos = worldRenderer.getObjectPosition(id);
            if (pos) {
                const type = worldRenderer.getObjectType(id) as WorldObjectType | null;
                const elevation = worldRenderer.getElevation(pos.x, pos.y);
                particleSystem.emitDestruction(pos.x, pos.y, type ?? 'unknown');
                if (type) {
                    fragmentSystem.spawnFragments(pos.x, pos.y, elevation, type);
                }
            }
            if (isPlaying) runDestroyedCount++;
        }
    }

    if (_newlyDestroyed.length > 0) {
        worldRenderer.hideNewlyDestroyedObjects(_newlyDestroyed);
    }

    // Prevent previousObjectIds from growing without bound.
    // When our set is much larger than the server's list, rebuild from server data.
    // Use a larger threshold (500) so this runs rarely, and rebuild in-place.
    if (previousObjectIds.size > state.destroyedObjectIds.length + 500) {
        previousObjectIds.clear();
        for (const id of state.destroyedObjectIds) {
            previousObjectIds.add(id);
        }
    }

    // Update power-up orbs in the 3D scene
    if (state.powerUps) {
        powerUpRenderer.update(state.powerUps);
    }

    // Update leaderboard
    hudManager.updateLeaderboard(state.leaderboard, playerName);

    // Minimap is now updated in the render loop using interpolated (complete) player list
    // to avoid flickering caused by network throttle omitting distant players.

    // Display kill feed notifications
    if (state.kills && state.kills.length > 0) {
        for (const kill of state.kills) {
            hudManager.addKill(kill.killer, kill.victim, kill.killerRadius, playerName);
        }
    }
    */
});

network.onDeath((killerName: string) => {
    const systems = gameSystems;
    isPlaying = false;
    input.hideControls();

    // Close chat if open
    chatOpen = false;
    chatInputWrap.classList.remove('active');
    chatInput.blur();
    chatContainer.style.display = 'none';

    // Trigger dramatic vignette effect first
    deathVignette.classList.add('active');

    // ---- Death cam: keep camera active for 5 seconds following killer ----
    deathCamActive = true;
    deathCamKiller = killerName;

    // Show death cam overlay with killer info
    deathCamKillerName.textContent = killerName;
    deathCamSummary.textContent = `${runMaxCategory} \u2014 ${Math.floor(lastScore).toLocaleString()} points`;
    deathCamOverlay.classList.remove('hidden');

    // After 5 seconds, transition to the full death screen
    if (deathCamTimeout) clearTimeout(deathCamTimeout);
    deathCamTimeout = setTimeout(() => {
        deathCamActive = false;
        deathCamOverlay.classList.add('hidden');
        hud.classList.add('hidden');
        deathScreen.classList.remove('hidden');

        // Populate death stats panel
        deathKillerName.textContent = killerName;
        dsScore.textContent         = Math.floor(lastScore).toLocaleString();
        dsDestroyed.textContent     = runDestroyedCount.toString();
        dsTime.textContent          = formatRunTime(performance.now() - runStartTime);
        dsCategory.textContent      = runMaxCategory;

        // Show a random tip
        const tip = DEATH_TIPS[Math.floor(Math.random() * DEATH_TIPS.length)];
        deathTip.textContent = tip;

        // ---- Play Again cooldown (Task 8) ----
        respawnBtn.setAttribute('disabled', 'true');
        let cooldown = 2;
        respawnBtn.querySelector('span:last-child')!.textContent = `PLAY AGAIN (${cooldown}s)`;
        if (respawnCooldownInterval) clearInterval(respawnCooldownInterval);
        respawnCooldownInterval = setInterval(() => {
            cooldown--;
            if (cooldown > 0) {
                respawnBtn.querySelector('span:last-child')!.textContent = `PLAY AGAIN (${cooldown}s)`;
            } else {
                respawnBtn.querySelector('span:last-child')!.textContent = 'PLAY AGAIN';
                respawnBtn.removeAttribute('disabled');
                if (respawnCooldownInterval) clearInterval(respawnCooldownInterval);
                respawnCooldownInterval = null;
            }
        }, 1000);

        // Clear tornado meshes and any associated waterspout rings
        if (systems) {
            for (const [id, mesh] of tornadoMeshes) {
                systems.sceneManager.scene.remove(mesh.group);
                mesh.dispose();
                if (tornadoOverWater.has(id)) {
                    systems.particleSystem.removeSplashRing(id);
                }
            }
        }
        tornadoMeshes.clear();
        tornadoOverWater.clear();
        prevStamina.clear();
    }, 5000);
});

network.onDisconnect(() => {
    // Only show the reconnecting overlay while the player is actively in-game.
    // If they haven't joined yet (main menu) or they're on the death screen,
    // the overlay isn't needed because they have nothing to lose.
    if (isPlaying) {
        reconnectOverlay.classList.remove('hidden');
    }
});

network.onReconnect(() => {
    // Socket.IO reconnected and we've already re-sent player:join.
    // Hide the overlay — the server's game:joined response will refresh the world.
    reconnectOverlay.classList.add('hidden');
    // Resume the input loop in case it stalled
    isPlaying = true;
    worldReady = false;
});

// ---- Render Loop ----
let lastTime = performance.now();
let frameCount = 0;

function animate(time: number): void {
    requestAnimationFrame(animate);

    const systems = gameSystems;
    if (!systems) return;
    const { sceneManager, worldRenderer, powerUpRenderer, particleSystem, destructionTrail, fragmentSystem } = systems;
    const graphicsPreset = getGraphicsPreset();

    const dt = Math.min(time - lastTime, 100); // cap delta
    lastTime = time;
    frameCount++;

    // Always update the skybox — clouds + lightning animate even on the menu screen
    sceneManager.update(dt);

    if (!isPlaying && !deathCamActive) {
        sceneManager.render();
        return;
    }

    // ---- Death cam: follow the killer's position ----
    if (deathCamActive && !isPlaying) {
        const deathPlayers = interpolation.interpolate(network.id);
        // Find the killer by name in current player list
        let killerState: { x: number; y: number; radius: number } | null = null;
        for (const [, ps] of deathPlayers) {
            if (ps.name === deathCamKiller && ps.alive) {
                killerState = ps;
                break;
            }
        }
        if (killerState) {
            sceneManager.setCameraOffset(killerState.x, killerState.y, killerState.radius);
        }
        sceneManager.render();
        return;
    }

    // Get interpolated player states
    const players = interpolation.interpolate(network.id);

    // ---- Client-side prediction for local player ----
    // predictedLocal is set by reconciliation in onState (server pos + replayed
    // unacked inputs).  displayPos is set to predictedLocal each time onState
    // fires, then extrapolated forward here every render frame so the tornado
    // moves smoothly between server ticks.
    //
    // Because displayPos is reset to predictedLocal on every onState (not
    // accumulated across reconciliations), there is no drift or flicker — the
    // extrapolation just fills the ~50 ms gap between ticks.
    const currentInput = input.getInput();
    const localServerState = players.get(network.id);
    if (localServerState && !localServerState.alive) {
        predictedLocal = null;
        displayPos = null;
    } else if (!predictedLocal && localServerState) {
        // Bootstrap: if we don't have a prediction yet, use interpolated state
        predictedLocal = { x: localServerState.x, y: localServerState.y };
        displayPos = { x: localServerState.x, y: localServerState.y };

        localPlayerRadius = localServerState.radius;
    }

    // ---- Render-loop movement with smooth server correction ----
    // displayPos advances directly by current input every frame (60fps feel).
    // predictedLocal is ONLY set by onState reconciliation — never mutated here.
    // A gentle correction pull keeps displayPos in sync with the server.
    if (displayPos && predictedLocal && dt > 0) {
        // 1. Advance displayPos using the LAST SENT input for consistency
        //    with what the server will process (prevents extrapolation divergence).
        if (lastSentInput.active) {
            const boostMult = lastSentInput.boost ? BOOST_MULTIPLIER : 1.0;
            const puSpeedMult = localHasSpeedPowerUp ? POWERUP_SPEED_MULTIPLIER : 1.0;
            const rawSpeed = BASE_SPEED_PER_MS * (1 - localPlayerRadius * SPEED_SIZE_FACTOR) * boostMult * puSpeedMult;
            const minSpeed = BASE_SPEED_PER_MS * 0.3 * boostMult * puSpeedMult;
            const speed = Math.max(rawSpeed, minSpeed);
            displayPos.x += Math.cos(lastSentInput.angle) * speed * dt;
            displayPos.y += Math.sin(lastSentInput.angle) * speed * dt;
        }

        // 2. Adaptive correction toward reconciled prediction
        // Uses tiered lerp rates based on error magnitude:
        //   - Small  (< 1 unit):  very gentle (0.003/ms) — prevents micro-jitter
        //   - Medium (1–5 units): moderate    (0.012/ms) — smooth convergence
        //   - Large  (> 5 units): aggressive  (0.04/ms)  — fast catch-up
        //   - Huge   (> 10 units): snap immediately
        const errX = predictedLocal.x - displayPos.x;
        const errY = predictedLocal.y - displayPos.y;
        const errDistSq = errX * errX + errY * errY;
        if (errDistSq > 100) {
            // Very large error (>10 units): snap immediately
            displayPos.x = predictedLocal.x;
            displayPos.y = predictedLocal.y;
        } else if (errDistSq > 0.0001) {
            // Pick rate constant based on error distance
            let rate: number;
            if (errDistSq < 1) {
                // < 1 unit: very slow correction to avoid micro-jitter
                rate = 0.003;
            } else if (errDistSq < 25) {
                // 1–5 units: moderate correction
                rate = 0.012;
            } else {
                // 5–10 units: aggressive correction
                rate = 0.04;
            }
            const corrFactor = 1 - Math.exp(-dt * rate);
            displayPos.x += errX * corrFactor;
            displayPos.y += errY * corrFactor;
        }

        // 3. Clamp to world bounds
        const r = localPlayerRadius;
        displayPos.x = Math.max(r, Math.min(worldSize - r, displayPos.x));
        displayPos.y = Math.max(r, Math.min(worldSize - r, displayPos.y));
    }

    // Update tornado meshes
    _activeMeshIds.clear();
    const activeMeshIds = _activeMeshIds;
    let maxTornadoRadius = 1; // Tracks largest live tornado; drives lightning frequency

    for (const [id, state] of players) {
        if (!state.alive) continue;
        activeMeshIds.add(id);

        // Feed the skybox with the biggest tornado radius for lightning scaling
        if (state.radius > maxTornadoRadius) maxTornadoRadius = state.radius;

        let mesh = tornadoMeshes.get(id);
        if (!mesh) {
            // Create new tornado mesh
            const isLocal = id === network.id;
            const skinId = isLocal ? getSelectedSkin() : 'classic';
            mesh = systems.createTornadoMesh(isLocal, skinId);
            tornadoMeshes.set(id, mesh);
            sceneManager.scene.add(mesh.group);
        }

        mesh.setRadius(state.radius);

        // For the local player use the extrapolated display position so the
        // tornado reacts to input instantly and moves smoothly between server ticks.
        if (id === network.id && displayPos) {
            mesh.setPosition(displayPos.x, displayPos.y);
        } else {
            mesh.setPosition(state.x, state.y);
        }

        mesh.update(dt, state.rotation);

        // ---- Boost visual: set boosting state on the mesh ----
        if (id === network.id) {
            // Local player: use the actual key-press state from InputHandler
            mesh.setBoosting(currentInput.boost);
        } else {
            // Remote player: infer boosting from a meaningful stamina drop.
            // Stamina drains at 4 units/tick when boosting; we consider any
            // drop >= 1 unit since last frame a reliable boosting signal.
            const prev = prevStamina.get(id) ?? state.stamina;
            const isBoosting = (prev - state.stamina) >= 1.0;
            mesh.setBoosting(isBoosting);
        }
        prevStamina.set(id, state.stamina);

        // Sync spawn-protection / safe-zone shield visual
        mesh.setProtected(state.protected ?? false);

        // Sync AFK fade — semi-transparent when server flags player as idle
        mesh.setAfk(state.afk ?? false);

        // ---- Waterspout effect — fire for every visible tornado over water ----
        if (isOverWaterZone(state.x, state.y)) {
            tornadoOverWater.add(id);
            // Throttle slightly so the water pool never gets exhausted in one frame
            if (Math.random() < graphicsPreset.waterspoutChance) {
                particleSystem.emitWaterspout(id, state.x, state.y, state.radius);
            }
        } else if (tornadoOverWater.has(id)) {
            // Tornado just left the water zone — remove its splash ring
            tornadoOverWater.delete(id);
            particleSystem.removeSplashRing(id);
        }

        // Update camera to follow local player
        if (id === network.id) {
            // Use the extrapolated display position for camera so it follows the
            // player's input immediately and smoothly between server ticks.
            const camX = (displayPos ? displayPos.x : state.x);
            const camY = (displayPos ? displayPos.y : state.y);
            sceneManager.setCameraOffset(camX, camY, state.radius);
            hudManager.updateScore(state.score);
            if (frameCount % 3 === 0) {
                hudManager.updateSize(state.radius, 7);
                hudManager.updateStamina(state.stamina, currentInput.boost);
                hudManager.updatePowerUps(state.activeEffects ?? []);
            }
            lastScore = state.score;

            // Track max category reached this run for death screen stats
            const currentCat = getFujitaCategory(state.radius);
            if (compareCategoryGt(currentCat, runMaxCategory)) {
                runMaxCategory = currentCat;
            }

            // Cloud ceiling removed — sky gradient handles atmosphere

            // Emit dust particles around local tornado (use predicted pos for immediacy)
            if (Math.random() < graphicsPreset.localDustChance) {
                particleSystem.emitDust(camX, camY, state.radius);
            }

            // Destruction trail — dark ground marks under the local tornado
            const trailElevation = worldRenderer.getElevation(camX, camY);
            destructionTrail.tick(dt, camX, camY, trailElevation);
        }
    }

    // Pass the largest tornado radius to the skybox lightning system each frame
    sceneManager.skybox.setMaxTornadoRadius(maxTornadoRadius);

    // ---- Wall cloud deformation ----
    // Collect world-space positions for every alive tornado and ask the
    // WorldRenderer to depress the cloud ceiling above each one.
    // state.y from the server maps to Three.js Z (the game uses a top-down
    // 2-D coordinate system where server Y == world Z).
    let _deformCount = 0;
    for (const [, state] of players) {
        if (!state.alive) continue;
        if (_deformCount < _tornadoDeformPositions.length) {
            _tornadoDeformPositions[_deformCount].x = state.x;
            _tornadoDeformPositions[_deformCount].z = state.y;
            _tornadoDeformPositions[_deformCount].radius = state.radius;
        } else {
            _tornadoDeformPositions.push({ x: state.x, z: state.y, radius: state.radius });
        }
        _deformCount++;
    }
    _tornadoDeformPositions.length = _deformCount;
    if (graphicsPreset.cloudDeformation) {
        worldRenderer.updateCloudDeformation(_tornadoDeformPositions);
    }
    if (graphicsPreset.suctionEffect) {
        worldRenderer.updateSuctionEffect(_tornadoDeformPositions);
    }

    // Update minimap using the full interpolated player list (not the throttled server list)
    // This prevents distant players from flickering on/off the minimap.
    // Throttled to every 5 frames to reduce overhead (~12 Hz at 60fps is plenty for minimap).
    if (frameCount % 5 === 0) {
        _minimapPlayers.length = 0;
        for (const p of players.values()) _minimapPlayers.push(p);
        hudManager.updateMinimap(_minimapPlayers, network.id);
    }

    // Remove meshes for disconnected/dead players
    for (const [id, mesh] of tornadoMeshes) {
        if (!activeMeshIds.has(id)) {
            sceneManager.scene.remove(mesh.group);
            mesh.dispose();
            tornadoMeshes.delete(id);
            prevStamina.delete(id);

            // Clean up any waterspout splash ring for this tornado
            if (tornadoOverWater.has(id)) {
                tornadoOverWater.delete(id);
                particleSystem.removeSplashRing(id);
            }
        }
    }

    // Animate safe zone ground rings (gentle pulse)
    worldRenderer.updateSafeZones(time / 1000);

    // Animate floating power-up orbs (bob + rotate)
    powerUpRenderer.animate(time / 1000);

    // LOD + Frustum culling update (throttled internally to every 15 frames)
    worldRenderer.updateLOD(sceneManager.camera);

    // Update particles and fragment animations
    particleSystem.update(dt);
    fragmentSystem.update(dt);

    // ---- Debug overlay update (throttled to every 10 frames) ----
    if (debugVisible && frameCount % 10 === 0) {
        // FPS calculation
        debugMetrics.frameTimes[debugMetrics.frameTimeIdx] = dt;
        debugMetrics.frameTimeIdx = (debugMetrics.frameTimeIdx + 1) % 60;
        if (debugMetrics.frameTimeFilled < 60) debugMetrics.frameTimeFilled++;
        let _dtSum = 0;
        for (let i = 0; i < debugMetrics.frameTimeFilled; i++) _dtSum += debugMetrics.frameTimes[i];
        const avgDt = _dtSum / debugMetrics.frameTimeFilled;
        debugMetrics.fps = avgDt > 0 ? Math.round(1000 / avgDt) : 0;

        // Prediction error
        if (displayPos && predictedLocal) {
            const ex = displayPos.x - predictedLocal.x;
            const ey = displayPos.y - predictedLocal.y;
            debugMetrics.predictionError = Math.sqrt(ex * ex + ey * ey);
        }
        debugMetrics.pendingInputCount = pendingInputs.length;
        debugMetrics.interpPlayerCount = players.size;
        if (displayPos) {
            debugMetrics.displayX = displayPos.x;
            debugMetrics.displayY = displayPos.y;
        }
        const localS = players.get(network.id);
        if (localS) {
            debugMetrics.serverX = localS.x;
            debugMetrics.serverY = localS.y;
        }

        const ping = network.getPing();
        const bps = network.getBytesPerSec();
        const pps = network.getPacketsPerSec();
        const drawCalls = sceneManager.renderer.info.render.calls;
        const triangles = sceneManager.renderer.info.render.triangles;
        const textures = sceneManager.renderer.info.memory.textures;
        const geometries = sceneManager.renderer.info.memory.geometries;

        // Player state extras from server snapshot
        const localSnap = players.get(network.id);
        debugMetrics.radius   = localPlayerRadius;
        debugMetrics.score    = lastScore;
        if (localSnap) {
            debugMetrics.stamina = (localSnap as unknown as { stamina?: number }).stamina ?? 0;
            const fx = (localSnap as unknown as { activeEffects?: Record<string,number> }).activeEffects;
            debugMetrics.activeEffects = fx ? (Object.keys(fx).join(', ') || 'none') : 'none';
        }
        // Derive category from radius
        const r = localPlayerRadius;
        debugMetrics.category = r < 1.5 ? 'F0' : r < 3 ? 'F1' : r < 6 ? 'F2' : r < 10 ? 'F3' : r < 16 ? 'F4' : 'F5';

        // JS heap (Chrome only)
        const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
        debugMetrics.jsHeapMB = perf.memory ? Math.round(perf.memory.usedJSHeapSize / 1048576) : -1;

        const heapStr = debugMetrics.jsHeapMB >= 0 ? `${debugMetrics.jsHeapMB} MB` : 'n/a';

        const lines =
            `=== DEBUG (F3) — ${new Date().toLocaleTimeString()} ===\n` +
            `FPS:        ${debugMetrics.fps} (${avgDt.toFixed(1)}ms/frame)\n` +
            `Ping:       ${ping}ms\n` +
            `Bandwidth:  ${(bps / 1024).toFixed(1)} KB/s  (${pps} pkt/s)\n` +
            `Packets:    full=${debugMetrics.fullCount}  delta=${debugMetrics.deltaCount}\n` +
            `Last pkt:   ${debugMetrics.lastPacketType}\n` +
            `---\n` +
            `Category:   ${debugMetrics.category}  radius=${debugMetrics.radius.toFixed(2)}\n` +
            `Score:      ${Math.floor(debugMetrics.score)}\n` +
            `Stamina:    ${debugMetrics.stamina.toFixed(0)}%\n` +
            `Effects:    ${debugMetrics.activeEffects}\n` +
            `---\n` +
            `Players:    ${debugMetrics.interpPlayerCount}\n` +
            `Pending:    ${debugMetrics.pendingInputCount} inputs\n` +
            `Pred Error: ${debugMetrics.predictionError.toFixed(2)} units\n` +
            `Pos (disp): (${debugMetrics.displayX.toFixed(1)}, ${debugMetrics.displayY.toFixed(1)})\n` +
            `Pos (srv):  (${debugMetrics.serverX.toFixed(1)}, ${debugMetrics.serverY.toFixed(1)})\n` +
            `---\n` +
            `Draw calls: ${drawCalls}\n` +
            `Triangles:  ${triangles.toLocaleString()}\n` +
            `Textures:   ${textures}  Geo: ${geometries}\n` +
            `JS Heap:    ${heapStr}`;

        debugText.textContent = lines;
        // Keep textContent (used by copy) in sync
        debugOverlay.dataset.debugText = lines;
    }

    // Render
    sceneManager.render();
}

// ============================================================
// Chat System
// ============================================================

/** Chat message buffer — keep last 15 messages. */
interface ChatEntry {
    el: HTMLElement;
    timestamp: number;
}
const chatMessages: ChatEntry[] = [];
const MAX_CHAT_MESSAGES = 15;
const CHAT_FADE_MS = 10000; // fade messages after 10 seconds

function addChatMessage(name: string, msg: string): void {
    const el = document.createElement('div');
    el.className = 'chat-msg';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = name + ':';

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = ' ' + msg;

    el.appendChild(nameSpan);
    el.appendChild(textSpan);
    chatLog.appendChild(el);

    const entry: ChatEntry = { el, timestamp: performance.now() };
    chatMessages.push(entry);

    // Trim to max 15 messages
    while (chatMessages.length > MAX_CHAT_MESSAGES) {
        const old = chatMessages.shift();
        if (old && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }

    // Auto-scroll
    chatLog.scrollTop = chatLog.scrollHeight;
}

// Fade old messages periodically
setInterval(() => {
    const now = performance.now();
    for (const entry of chatMessages) {
        if (now - entry.timestamp > CHAT_FADE_MS) {
            entry.el.classList.add('faded');
        }
    }
}, 1000);

// Listen for incoming chat messages
network.onChatMessage((data) => {
    addChatMessage(data.name, data.msg);
});

// Chat input handling — Enter to open/send, Escape to cancel
window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && isPlaying) {
        if (!chatOpen) {
            // Open chat input
            chatOpen = true;
            chatInputWrap.classList.add('active');
            chatInput.value = '';
            chatInput.focus();
            e.preventDefault();
        } else {
            // Send message
            const msg = chatInput.value.trim();
            if (msg.length > 0) {
                network.sendChat(msg);
            }
            chatOpen = false;
            chatInputWrap.classList.remove('active');
            chatInput.blur();
            e.preventDefault();
        }
    } else if (e.key === 'Escape' && chatOpen) {
        chatOpen = false;
        chatInputWrap.classList.remove('active');
        chatInput.blur();
        e.preventDefault();
    }
});

// Prevent game input events from propagating while chat is focused
chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
});
chatInput.addEventListener('keyup', (e) => {
    e.stopPropagation();
});

// ============================================================
// Persistent Leaderboard UI
// ============================================================

interface LeaderboardRecord {
    name:        string;
    score:       number;
    maxCategory: string;
    kills:       number;
    duration:    number;
    date:        string;
}

const lbModal    = document.getElementById('leaderboard-modal')!;
const lbTable    = document.getElementById('lb-table')!;
const lbTbody    = document.getElementById('lb-tbody')!;
const lbLoading  = document.getElementById('lb-loading')!;
const lbError    = document.getElementById('lb-error')!;
const lbCloseBtn = document.getElementById('lb-close-btn')!;
const lbBtn      = document.getElementById('leaderboard-btn')!;
const lbTabs     = lbModal.querySelectorAll<HTMLButtonElement>('.lb-tab');

let currentLbTab: 'alltime' | 'daily' = 'alltime';

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatRelativeDate(isoDate: string): string {
    const date = new Date(isoDate);
    const now = new Date();

    // Strip time for day comparison
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) {
        return date.toLocaleDateString('en-US', { weekday: 'long' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderLbRows(entries: LeaderboardRecord[]): void {
    if (entries.length === 0) {
        lbTbody.innerHTML = `<tr><td colspan="5" class="lb-empty">No entries yet — be the first!</td></tr>`;
        return;
    }

    let html = '';
    entries.forEach((e, i) => {
        const rank   = i + 1;
        const topClass = rank <= 3 ? ' lb-row-top3' : '';
        const rc     = rank === 1 ? 'lb-rank-gold' : rank === 2 ? 'lb-rank-silver' : rank === 3 ? 'lb-rank-bronze' : '';
        const cc     = `lb-cat-${e.maxCategory.toLowerCase()}`;
        const medals = ['🥇', '🥈', '🥉'];
        const medal  = rank <= 3 ? medals[rank - 1] : String(rank);

        html += `<tr class="${topClass}">
            <td class="${rc}">${medal}</td>
            <td>${escapeHtml(e.name)}</td>
            <td>${e.score.toLocaleString()}</td>
            <td class="${cc}">${escapeHtml(e.maxCategory)}</td>
            <td>${escapeHtml(formatRelativeDate(e.date))}</td>
        </tr>`;
    });
    lbTbody.innerHTML = html;
}

async function fetchAndShowLeaderboard(tab: 'alltime' | 'daily'): Promise<void> {
    lbLoading.classList.remove('hidden');
    lbError.classList.add('hidden');
    lbTable.classList.add('hidden');

    const url = tab === 'daily' ? '/api/leaderboard/daily' : '/api/leaderboard';

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: LeaderboardRecord[] = await res.json();
        lbLoading.classList.add('hidden');
        lbTable.classList.remove('hidden');
        renderLbRows(data);
    } catch (err) {
        console.error('[Leaderboard] Fetch failed:', err);
        lbLoading.classList.add('hidden');
        lbError.textContent = (err instanceof DOMException && err.name === 'AbortError')
            ? 'Could not load leaderboard'
            : 'Failed to load leaderboard.';
        lbError.classList.remove('hidden');
    }
}

function openLeaderboard(): void {
    lbModal.classList.remove('hidden');
    lbTabs.forEach(t => t.classList.toggle('active', t.dataset['tab'] === currentLbTab));
    fetchAndShowLeaderboard(currentLbTab);
}

function closeLeaderboard(): void {
    lbModal.classList.add('hidden');
}

lbBtn.addEventListener('click', () => openLeaderboard());
lbCloseBtn.addEventListener('click', () => closeLeaderboard());

lbModal.addEventListener('click', (e) => {
    if (e.target === lbModal) closeLeaderboard();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lbModal.classList.contains('hidden')) {
        closeLeaderboard();
    }
});

lbTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const t = (tab.dataset['tab'] ?? 'alltime') as 'alltime' | 'daily';
        if (t === currentLbTab) return;
        currentLbTab = t;
        lbTabs.forEach(bt => bt.classList.toggle('active', bt.dataset['tab'] === t));
        fetchAndShowLeaderboard(t);
    });
});
