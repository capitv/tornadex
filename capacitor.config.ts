import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tornadex.app',
  appName: 'Tornadex',
  webDir: 'dist/client',

  // Point to your live server; the WebView loads the game from here at runtime.
  // Change to your production domain before release.
  server: {
    url: 'http://10.0.2.2:3001',   // Android emulator → host machine localhost
    cleartext: true,               // allow http during development (remove for prod)
  },

  android: {
    backgroundColor: '#0a0a1a',    // dark bg shown while WebView loads (matches game sky)
    allowMixedContent: true,       // needed while server is http
  },

  plugins: {
    // Keep status bar hidden for full-screen immersion
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a1a',
    },
  },
};

export default config;
