import {
  resolveDetectionWasteMultiplier,
  resolveMaterialWasteMultiplier,
  resolveWasteFactor,
} from '../../src/calculations/siding/waste';

describe('waste factor resolution', () => {
  it('prefers project settings over organization settings', () => {
    expect(resolveWasteFactor(8, 12)).toEqual({
      percent: 8,
      multiplier: 1.08,
      source: 'project',
    });
  });

  it('uses the organization setting and rejects malformed values', () => {
    expect(resolveWasteFactor(undefined, '12')).toEqual({
      percent: 12,
      multiplier: 1.12,
      source: 'organization',
    });
    expect(resolveWasteFactor(-1, 101)).toEqual({
      percent: 10,
      multiplier: 1.1,
      source: 'default',
    });
  });

  it('uses SKU overrides before deliberate category overrides', () => {
    expect(resolveMaterialWasteMultiplier(
      { category: 'shingle', waste_factor: 1.18 },
      1.12,
    )).toBe(1.18);
    expect(resolveMaterialWasteMultiplier({ category: 'shingle' }, 1.12)).toBe(1.15);
  });

  it('uses the resolved org factor for ordinary material categories', () => {
    expect(resolveMaterialWasteMultiplier({ category: 'lap_siding' }, 1.12)).toBe(1.12);
    expect(resolveMaterialWasteMultiplier({ category: 'trim' }, 1.08)).toBe(1.08);
  });

  it('does not add waste to count detections unless explicitly configured', () => {
    expect(resolveDetectionWasteMultiplier(undefined, 1.12, 'count')).toBe(1);
    expect(resolveDetectionWasteMultiplier(undefined, 1.12, 'linear')).toBe(1.12);
    expect(resolveDetectionWasteMultiplier(1.05, 1.12, 'count')).toBe(1.05);
  });
});
