// ============================================
// Main Entry Point — Wire Everything Together
// ============================================

import { SceneManager } from './scene/SceneManager.js';
import { TornadoMesh } from './scene/TornadoMesh.js';
import { WorldRenderer } from './scene/WorldRenderer.js';
import { PowerUpRenderer } from './scene/PowerUpRenderer.js';
import { ParticleSystem } from './scene/ParticleSystem.js';
import { DestructionTrail } from './scene/DestructionTrail.js';
import { FragmentSystem } from './scene/FragmentSystem.js';
import { NetworkManager } from './network/NetworkManager.js';
import { Interpolation } from './network/Interpolation.js';
import { InputHandler } from './input/InputHandler.js';
import { HUD } from './ui/HUD.js';
import { getGraphicsQuality, setGraphicsQuality } from './settings/GraphicsConfig.js';
import type { GameState, WorldObject, WorldObjectType, TerrainZone, SafeZone, PowerUp } from '../shared/types.js';

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

// Death screen stat elements (new redesigned death screen)
const deathKillerName = document.getElementById('death-killer-name')!;
const dsScore         = document.getElementById('ds-score')!;
const dsDestroyed     = document.getElementById('ds-destroyed')!;
const dsTime          = document.getElementById('ds-time')!;
const dsCategory      = document.getElementById('ds-category')!;
const deathTip        = document.getElementById('death-tip')!;

// ---- Core Systems ----
const sceneManager = new SceneManager(canvas);
const worldRenderer = new WorldRenderer(sceneManager.scene);
const powerUpRenderer = new PowerUpRenderer(sceneManager.scene);
const particleSystem = new ParticleSystem(sceneManager.scene);
const destructionTrail = new DestructionTrail(sceneManager.scene);
const fragmentSystem = new FragmentSystem(sceneManager.scene);
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
    background: rgba(0,0,0,0.75); color: #0f0; font: 11px monospace;
    padding: 8px 10px; border-radius: 4px; pointer-events: none;
    line-height: 1.5; white-space: pre; display: none; min-width: 280px;
`;
document.body.appendChild(debugOverlay);

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
};

// ---- Tornado Meshes (for all players) ----
const tornadoMeshes: Map<string, TornadoMesh> = new Map();

// ---- Stamina history for remote boost inference ----
// Stores the stamina value from the previous frame for each player ID.
// A meaningful drop indicates the remote player is boosting.
const prevStamina: Map<string, number> = new Map();

// ---- State ----
let playerName = '';
let lastScore = 0;
let worldSize = 2000;
let previousObjectIds: Set<number> = new Set();
let isPlaying = false;
/** The seed the server confirmed for the current map. Set in onJoined(). */
let currentMapSeed: number | null = null;

// ---- Run stats (tracked per spawn) ----
let runStartTime: number      = 0;
let runDestroyedCount: number = 0;
let runMaxCategory: string    = 'F0';

// ---- Death screen tips ----
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
const _tornadoDeformPositions: { x: number; z: number; radius: number }[] = [];
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

/**
 * Base move speed that mirrors the server constant (PLAYER_SPEED = 1.0 units/tick).
 * Server tick = 50 ms, so 1.0 / 50 = 0.02 units/ms.
 */
const BASE_SPEED_PER_MS = 1.0 / 50; // 0.02 units/ms
/** Boost multiplier: same as the server's canBoost multiplier (1.8). */
const BOOST_MULTIPLIER  = 1.8;
/** Size-based slowdown factor — mirrors server SPEED_SIZE_FACTOR (0.015). */
const SPEED_SIZE_FACTOR = 0.015;

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

// ---- Event Handlers ----
playBtn.addEventListener('click', () => startGame());
respawnBtn.addEventListener('click', () => respawnGame());
nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startGame();
});

function startGame(): void {
    playerName = nameInput.value.trim() || 'Tornado';
    mainMenu.classList.add('hidden');
    deathScreen.classList.add('hidden');
    deathVignette.classList.remove('active');
    hud.classList.remove('hidden');

    // Read the optional seed preference from the input field
    const rawSeed = seedInput.value.trim();
    const preferredSeed = rawSeed ? parseInt(rawSeed, 10) : undefined;
    const validSeed = (preferredSeed !== undefined && Number.isFinite(preferredSeed) && preferredSeed > 0)
        ? preferredSeed
        : undefined;
    network.join(playerName, validSeed);
    isPlaying = true;
    predictedLocal = null;
    displayPos = null;

    localPlayerRadius = 1;
    pendingInputs.length = 0; // fresh session — clear any stale inputs
    inputSeq = 0;
    resetRunStats();

    // Start sending inputs at 20 Hz (matches server tick rate)
    if (inputInterval) clearInterval(inputInterval);
    inputInterval = setInterval(() => {
        if (isPlaying) {
            const raw = input.getInput();
            // Stamp this input with the next monotonic sequence number
            inputSeq++;
            const stamped = { ...raw, seq: inputSeq };
            network.sendInput(stamped);

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
        // Refresh the F3 debug overlay on the same cadence as ping updates
        hudManager.updateDebug(network.getBytesPerSec(), network.getPacketsPerSec());
    }, 2000);
}

function respawnGame(): void {
    deathScreen.classList.add('hidden');
    deathVignette.classList.remove('active');
    hud.classList.remove('hidden');
    network.respawn();
    interpolation.clear();
    isPlaying = true;
    predictedLocal = null;
    displayPos = null;

    localPlayerRadius = 1;
    pendingInputs.length = 0; // discard stale inputs from the previous life
    inputSeq = 0;
    resetRunStats();
}

// ---- Network Callbacks ----
network.onJoined((data) => {
    worldSize = data.worldSize;
    hudManager.setWorldSize(worldSize);
    worldRenderer.createGround(worldSize);
    worldRenderer.createZones(data.zones);
    worldRenderer.createCloudCeiling(worldSize);
    worldRenderer.createInitialObjects(data.objects);

    // Render safe haven zone circles on the ground
    if (data.safeZones && data.safeZones.length > 0) {
        _safeZones = data.safeZones;
        worldRenderer.createSafeZones(data.safeZones);
    }

    // Cache water zones for per-frame waterspout checks
    waterZones = (data.zones ?? []).filter(z => z.type === 'water');

    // Tell the skybox where the world is so lightning bolts land inside the map
    sceneManager.skybox.setWorldBounds(worldSize / 2, worldSize / 2, worldSize / 2);

    // Show the server-confirmed seed in the UI and update the URL
    if (data.seed) {
        applySeed(data.seed);
    }

    console.log(`[Game] Joined! World size: ${worldSize}, Seed: ${data.seed}, Objects: ${data.objects.length}, Water zones: ${waterZones.length}`);
});

network.onState((state: GameState) => {
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
        // The speed calculation now mirrors the server: it applies the
        // SPEED_SIZE_FACTOR radius-based slowdown and clamps to 30% minimum,
        // so the client prediction stays in sync with the server physics.
        localPlayerRadius = localState.radius;
        if (localState.alive && pendingInputs.length > 0) {
            let rx = localState.x;
            let ry = localState.y;
            const INPUT_TICK_MS = 50; // matches the sendInput setInterval
            for (const inp of pendingInputs) {
                if (!inp.active) continue;
                const boostMult = inp.boost ? BOOST_MULTIPLIER : 1.0;
                const rawSpeed = BASE_SPEED_PER_MS * (1 - localState.radius * SPEED_SIZE_FACTOR) * boostMult;
                const minSpeed = BASE_SPEED_PER_MS * 0.3 * boostMult;
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
            // No pending inputs — snap prediction to server position
            predictedLocal = { x: localState.x, y: localState.y };
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
});

network.onDeath((killerName: string) => {
    isPlaying = false;

    // Trigger dramatic vignette effect first
    deathVignette.classList.add('active');

    // Delay the full death screen slightly for dramatic effect
    setTimeout(() => {
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
    }, 450);

    // Clear tornado meshes and any associated waterspout rings
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
});

// ---- Render Loop ----
let lastTime = performance.now();
let frameCount = 0;

function animate(time: number): void {
    requestAnimationFrame(animate);

    const dt = Math.min(time - lastTime, 100); // cap delta
    lastTime = time;
    frameCount++;

    // Always update the skybox — clouds + lightning animate even on the menu screen
    sceneManager.update(dt);

    if (!isPlaying) {
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
            const rawSpeed = BASE_SPEED_PER_MS * (1 - localPlayerRadius * SPEED_SIZE_FACTOR) * boostMult;
            const minSpeed = BASE_SPEED_PER_MS * 0.3 * boostMult;
            const speed = Math.max(rawSpeed, minSpeed);
            displayPos.x += Math.cos(lastSentInput.angle) * speed * dt;
            displayPos.y += Math.sin(lastSentInput.angle) * speed * dt;
        }

        // 2. Smooth correction toward reconciled prediction
        // At 60fps (dt≈16.7ms), corrFactor ≈ 0.18 → ~45% corrected per tick (50ms).
        // Gentle enough to avoid oscillation while still converging within ~150ms.
        const errX = predictedLocal.x - displayPos.x;
        const errY = predictedLocal.y - displayPos.y;
        const errDist = errX * errX + errY * errY;
        if (errDist > 100) {
            // Very large error (>10 units): snap immediately
            displayPos.x = predictedLocal.x;
            displayPos.y = predictedLocal.y;
        } else if (errDist > 0.0001) {
            const corrFactor = 1 - Math.exp(-dt * 0.012);
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
            mesh = new TornadoMesh(isLocal);
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
            if (Math.random() < 0.85) {
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
            hudManager.updateSize(state.radius, 7);
            hudManager.updateStamina(state.stamina, currentInput.boost);
            hudManager.updatePowerUps(state.activeEffects ?? []);
            lastScore = state.score;

            // Track max category reached this run for death screen stats
            const currentCat = getFujitaCategory(state.radius);
            if (compareCategoryGt(currentCat, runMaxCategory)) {
                runMaxCategory = currentCat;
            }

            // Keep cloud ceiling above tornado AND camera so player never sees through it
            if (worldRenderer.cloudCeiling) {
                const clampedR = Math.min(state.radius, 25);
                const camHeight = 9 + Math.log2(1 + clampedR) * 6 + (clampedR > 2 ? (clampedR - 2) * 12 : 0);
                const tornadoTop = state.radius * 10;
                worldRenderer.cloudCeiling.position.y = Math.max(45, tornadoTop, camHeight + 20);
            }

            // Emit dust particles around local tornado (use predicted pos for immediacy)
            if (Math.random() < 0.3) {
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
    worldRenderer.updateCloudDeformation(_tornadoDeformPositions);
    worldRenderer.updateSuctionEffect(_tornadoDeformPositions);

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

        debugOverlay.textContent =
            `=== DEBUG (F3) ===\n` +
            `FPS:        ${debugMetrics.fps} (${avgDt.toFixed(1)}ms)\n` +
            `Ping:       ${ping}ms\n` +
            `Bandwidth:  ${(bps / 1024).toFixed(1)} KB/s (${pps} pkt/s)\n` +
            `Packets:    full=${debugMetrics.fullCount} delta=${debugMetrics.deltaCount}\n` +
            `Last pkt:   ${debugMetrics.lastPacketType}\n` +
            `---\n` +
            `Pending:    ${debugMetrics.pendingInputCount} inputs\n` +
            `Pred Error: ${debugMetrics.predictionError.toFixed(2)} units\n` +
            `Display:    (${debugMetrics.displayX.toFixed(1)}, ${debugMetrics.displayY.toFixed(1)})\n` +
            `Server:     (${debugMetrics.serverX.toFixed(1)}, ${debugMetrics.serverY.toFixed(1)})\n` +
            `Players:    ${debugMetrics.interpPlayerCount}\n` +
            `---\n` +
            `Draw calls: ${drawCalls}\n` +
            `Triangles:  ${triangles}\n` +
            `Textures:   ${textures}\n` +
            `Geometries: ${geometries}`;
    }

    // Render
    sceneManager.render();
}

requestAnimationFrame(animate);

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

function renderLbRows(entries: LeaderboardRecord[]): void {
    lbTbody.innerHTML = '';

    if (entries.length === 0) {
        const empty = document.createElement('tr');
        empty.innerHTML = `<td colspan="5" class="lb-empty">No entries yet — be the first!</td>`;
        lbTbody.appendChild(empty);
        return;
    }

    entries.forEach((e, i) => {
        const rank   = i + 1;
        const tr     = document.createElement('tr');
        if (rank <= 3) tr.classList.add('lb-row-top3');

        const rc     = rank === 1 ? 'lb-rank-gold' : rank === 2 ? 'lb-rank-silver' : rank === 3 ? 'lb-rank-bronze' : '';
        const cc     = `lb-cat-${e.maxCategory.toLowerCase()}`;
        const medals = ['🥇', '🥈', '🥉'];
        const medal  = rank <= 3 ? medals[rank - 1] : String(rank);

        tr.innerHTML = `
            <td class="${rc}">${medal}</td>
            <td>${escapeHtml(e.name)}</td>
            <td>${e.score.toLocaleString()}</td>
            <td class="${cc}">${escapeHtml(e.maxCategory)}</td>
            <td>${escapeHtml(e.date)}</td>
        `;
        lbTbody.appendChild(tr);
    });
}

async function fetchAndShowLeaderboard(tab: 'alltime' | 'daily'): Promise<void> {
    lbLoading.classList.remove('hidden');
    lbError.classList.add('hidden');
    lbTable.classList.add('hidden');

    const url = tab === 'daily' ? '/api/leaderboard/daily' : '/api/leaderboard';

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: LeaderboardRecord[] = await res.json();
        lbLoading.classList.add('hidden');
        lbTable.classList.remove('hidden');
        renderLbRows(data);
    } catch (err) {
        console.error('[Leaderboard] Fetch failed:', err);
        lbLoading.classList.add('hidden');
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
