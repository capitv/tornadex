/// <reference lib="webworker" />

import { generateStaticWorldLayout } from '../../shared/worldgen.js';

interface WorldgenRequest {
    requestId: number;
    seed: number;
}

interface WorldgenResponse {
    requestId: number;
    layout: ReturnType<typeof generateStaticWorldLayout>;
}

self.onmessage = (event: MessageEvent<WorldgenRequest>) => {
    const { requestId, seed } = event.data;
    const response: WorldgenResponse = {
        requestId,
        layout: generateStaticWorldLayout(seed),
    };
    self.postMessage(response);
};
