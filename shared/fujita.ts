export type FujitaCategory = 'F0' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5';

export const FUJITA_BANDS: ReadonlyArray<{ label: FujitaCategory; maxRadius: number }> = [
    { label: 'F0', maxRadius: 1.0 },
    { label: 'F1', maxRadius: 2.0 },
    { label: 'F2', maxRadius: 3.0 },
    { label: 'F3', maxRadius: 4.0 },
    { label: 'F4', maxRadius: 5.0 },
    { label: 'F5', maxRadius: Infinity },
];

export function getFujitaCategoryIndex(radius: number): number {
    for (let i = 0; i < FUJITA_BANDS.length; i++) {
        if (radius < FUJITA_BANDS[i].maxRadius) return i;
    }
    return FUJITA_BANDS.length - 1;
}

export function getFujitaCategory(radius: number): FujitaCategory {
    return FUJITA_BANDS[getFujitaCategoryIndex(radius)].label;
}
