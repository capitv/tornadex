// ============================================
// Seeded PRNG — mulberry32
// ============================================
// Same seed always produces the same sequence of numbers, making maps
// fully reproducible and shareable via a URL query parameter.

/**
 * Creates a mulberry32 pseudo-random number generator seeded with `seed`.
 * Returns a function that, on each call, produces a float in [0, 1).
 *
 * Algorithm reference: https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */
export function mulberry32(seed: number): () => number {
    return function (): number {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
