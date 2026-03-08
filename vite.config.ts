import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    root: 'client',
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, 'shared'),
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/socket.io': {
                target: 'http://localhost:3001',
                ws: true,
            },
        },
    },
    build: {
        outDir: '../dist/client',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('node_modules/three')) {
                        return 'three-vendor';
                    }
                    if (
                        id.includes('node_modules/socket.io-client') ||
                        id.includes('node_modules/engine.io-client') ||
                        id.includes('node_modules/socket.io-parser')
                    ) {
                        return 'socket-vendor';
                    }
                    if (id.includes('node_modules')) {
                        return 'vendor';
                    }
                    return undefined;
                },
            },
        },
    },
});
