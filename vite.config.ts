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
    },
});
