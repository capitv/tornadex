// ============================================
// Spatial Grid for O(1) Collision Detection
// ============================================

export interface SpatialEntity {
    id: string | number;
    x: number;
    y: number;
    radius?: number;
    size?: number;
    /** Internal generation stamp used for dedup in query(). Managed by SpatialGrid. */
    _queryGen?: number;
}

export class SpatialGrid {
    private cells: Map<number, SpatialEntity[]> = new Map();
    private cellSize: number;

    // ---- Static / dynamic split ----
    private staticCells: Map<number, SpatialEntity[]> = new Map();
    private staticDirty: boolean = true;
    private staticEntities: SpatialEntity[] = [];

    // ---- Generation counter for allocation-free dedup in query() ----
    private _queryGeneration: number = 0;
    /** Reusable result array — returned from query(). Callers must consume before next query(). */
    private _queryResults: SpatialEntity[] = [];

    constructor(cellSize: number) {
        this.cellSize = cellSize;
    }

    private getKey(cx: number, cy: number): number {
        return cx * 100003 + cy;
    }

    /** Mark the static grid as needing a rebuild (call when world objects change). */
    markStaticDirty(): void {
        this.staticDirty = true;
    }

    /** Replace all static entities. Only marks dirty if the reference actually changed. */
    setStaticEntities(entities: SpatialEntity[]): void {
        if (entities !== this.staticEntities) {
            this.staticEntities = entities;
            this.staticDirty = true;
        }
    }

    private rebuildStatic(): void {
        this.staticCells.clear();
        for (const entity of this.staticEntities) {
            this.insertInto(this.staticCells, entity);
        }
        this.staticDirty = false;
    }

    /** Clear only the dynamic cells (called every tick). */
    clear(): void {
        this.cells.clear();
    }

    /** Insert a dynamic entity (players — rebuilt every tick). */
    insert(entity: SpatialEntity): void {
        this.insertInto(this.cells, entity);
    }

    private insertInto(target: Map<number, SpatialEntity[]>, entity: SpatialEntity): void {
        const r = entity.radius ?? entity.size ?? 0;
        const cs = this.cellSize;
        const minX = Math.floor((entity.x - r) / cs);
        const maxX = Math.floor((entity.x + r) / cs);
        const minY = Math.floor((entity.y - r) / cs);
        const maxY = Math.floor((entity.y + r) / cs);

        for (let cx = minX; cx <= maxX; cx++) {
            for (let cy = minY; cy <= maxY; cy++) {
                const key = this.getKey(cx, cy);
                let cell = target.get(key);
                if (!cell) {
                    cell = [];
                    target.set(key, cell);
                }
                cell.push(entity);
            }
        }
    }

    query(x: number, y: number, radius: number): SpatialEntity[] {
        // Ensure static grid is up to date
        if (this.staticDirty) {
            this.rebuildStatic();
        }

        // Advance generation for dedup
        const gen = ++this._queryGeneration;
        const results = this._queryResults;
        results.length = 0;

        const cs = this.cellSize;
        const minX = Math.floor((x - radius) / cs);
        const maxX = Math.floor((x + radius) / cs);
        const minY = Math.floor((y - radius) / cs);
        const maxY = Math.floor((y + radius) / cs);

        for (let cx = minX; cx <= maxX; cx++) {
            for (let cy = minY; cy <= maxY; cy++) {
                const key = this.getKey(cx, cy);

                // Dynamic cells
                const dynCell = this.cells.get(key);
                if (dynCell) {
                    for (const entity of dynCell) {
                        if (entity._queryGen !== gen) {
                            entity._queryGen = gen;
                            results.push(entity);
                        }
                    }
                }

                // Static cells
                const statCell = this.staticCells.get(key);
                if (statCell) {
                    for (const entity of statCell) {
                        if (entity._queryGen !== gen) {
                            entity._queryGen = gen;
                            results.push(entity);
                        }
                    }
                }
            }
        }

        return results;
    }
}
