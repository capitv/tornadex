// ============================================
// Spatial Grid for O(1) Collision Detection
// ============================================

interface SpatialEntity {
    id: string | number;
    x: number;
    y: number;
    radius?: number;
    size?: number;
}

export class SpatialGrid {
    private cells: Map<number, SpatialEntity[]> = new Map();
    private cellSize: number;

    constructor(cellSize: number) {
        this.cellSize = cellSize;
    }

    private getKey(cx: number, cy: number): number {
        return cx * 100003 + cy;
    }

    private getCellCoords(x: number, y: number): [number, number] {
        return [
            Math.floor(x / this.cellSize),
            Math.floor(y / this.cellSize),
        ];
    }

    clear(): void {
        this.cells.clear();
    }

    insert(entity: SpatialEntity): void {
        const r = entity.radius ?? entity.size ?? 0;
        const minX = Math.floor((entity.x - r) / this.cellSize);
        const maxX = Math.floor((entity.x + r) / this.cellSize);
        const minY = Math.floor((entity.y - r) / this.cellSize);
        const maxY = Math.floor((entity.y + r) / this.cellSize);

        for (let cx = minX; cx <= maxX; cx++) {
            for (let cy = minY; cy <= maxY; cy++) {
                const key = this.getKey(cx, cy);
                let cell = this.cells.get(key);
                if (!cell) {
                    cell = [];
                    this.cells.set(key, cell);
                }
                cell.push(entity);
            }
        }
    }

    query(x: number, y: number, radius: number): SpatialEntity[] {
        const results: Set<SpatialEntity> = new Set();
        const minX = Math.floor((x - radius) / this.cellSize);
        const maxX = Math.floor((x + radius) / this.cellSize);
        const minY = Math.floor((y - radius) / this.cellSize);
        const maxY = Math.floor((y + radius) / this.cellSize);

        for (let cx = minX; cx <= maxX; cx++) {
            for (let cy = minY; cy <= maxY; cy++) {
                const key = this.getKey(cx, cy);
                const cell = this.cells.get(key);
                if (cell) {
                    for (const entity of cell) {
                        results.add(entity);
                    }
                }
            }
        }

        return Array.from(results);
    }
}
