// ============================================
// MobileServices — Capacitor plugin wrappers
// ============================================
// All functions are no-ops on web / desktop so the same code runs everywhere.
// Capacitor plugins are dynamically imported to avoid breaking the web build.

import { Capacitor } from '@capacitor/core';

const IS_NATIVE = Capacitor.isNativePlatform();

// ---- Haptics ----

export async function hapticLight(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await Haptics.impact({ style: ImpactStyle.Light });
    } catch { /* plugin unavailable */ }
}

export async function hapticMedium(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await Haptics.impact({ style: ImpactStyle.Medium });
    } catch { /* plugin unavailable */ }
}

export async function hapticHeavy(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await Haptics.impact({ style: ImpactStyle.Heavy });
    } catch { /* plugin unavailable */ }
}

/** Short buzz — good for collecting a power-up or absorbing a small object */
export async function hapticSuccess(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { Haptics, NotificationType } = await import('@capacitor/haptics');
        await Haptics.notification({ type: NotificationType.Success });
    } catch { /* plugin unavailable */ }
}

// ---- Screen Orientation ----

export async function lockLandscape(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { ScreenOrientation } = await import('@capacitor/screen-orientation');
        await ScreenOrientation.lock({ orientation: 'landscape' });
    } catch { /* plugin unavailable */ }
}

export async function unlockOrientation(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { ScreenOrientation } = await import('@capacitor/screen-orientation');
        await ScreenOrientation.unlock();
    } catch { /* plugin unavailable */ }
}

// ---- Status Bar ----

export async function hideStatusBar(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { StatusBar } = await import('@capacitor/status-bar');
        await StatusBar.hide();
    } catch { /* plugin unavailable */ }
}

export async function showStatusBar(): Promise<void> {
    if (!IS_NATIVE) return;
    try {
        const { StatusBar } = await import('@capacitor/status-bar');
        await StatusBar.show();
    } catch { /* plugin unavailable */ }
}

// ---- Network ----

/**
 * Watch for network connectivity changes.
 * Calls callback(true) when connection is restored, callback(false) on loss.
 * Returns a cleanup function to remove the listener.
 */
export async function watchNetwork(
    callback: (connected: boolean) => void
): Promise<() => void> {
    if (!IS_NATIVE) return () => {};
    try {
        const { Network } = await import('@capacitor/network');
        const handle = await Network.addListener('networkStatusChange', (status) => {
            callback(status.connected);
        });
        return () => handle.remove();
    } catch {
        return () => {};
    }
}
