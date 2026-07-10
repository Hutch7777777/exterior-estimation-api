/**
 * Waste-factor resolution shared by material assignments, dynamic detections,
 * and database-driven auto-scope formulas.
 */

export const DEFAULT_WASTE_PERCENT = 10;

export type WasteFactorSource = 'project' | 'organization' | 'default';

export interface ResolvedWasteFactor {
  percent: number;
  multiplier: number;
  source: WasteFactorSource;
}

/**
 * Categories whose installation pattern deliberately needs a different waste
 * allowance than the organization default. SKU-level pricing overrides still
 * take precedence over these values.
 */
const CATEGORY_WASTE_OVERRIDES: Readonly<Record<string, number>> = {
  shingle: 1.15,
  shingle_siding: 1.15,
  shake: 1.15,
  corners: 1.12,
};

export function parseWastePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? percent
    : null;
}

export function resolveWasteFactor(
  projectPercent: unknown,
  organizationPercent: unknown,
  fallbackPercent: number = DEFAULT_WASTE_PERCENT,
): ResolvedWasteFactor {
  const project = parseWastePercent(projectPercent);
  if (project !== null) {
    return { percent: project, multiplier: 1 + project / 100, source: 'project' };
  }

  const organization = parseWastePercent(organizationPercent);
  if (organization !== null) {
    return {
      percent: organization,
      multiplier: 1 + organization / 100,
      source: 'organization',
    };
  }

  const fallback = parseWastePercent(fallbackPercent) ?? DEFAULT_WASTE_PERCENT;
  return { percent: fallback, multiplier: 1 + fallback / 100, source: 'default' };
}

function parseWasteMultiplier(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const multiplier = Number(value);
  return Number.isFinite(multiplier) && multiplier >= 1 && multiplier <= 2
    ? multiplier
    : null;
}

export function resolveMaterialWasteMultiplier(
  pricing: { category?: string | null; waste_factor?: number | null },
  resolvedOrganizationMultiplier: number,
): number {
  const explicit = parseWasteMultiplier(pricing.waste_factor);
  if (explicit !== null) return explicit;

  const category = pricing.category?.toLowerCase() || '';
  return CATEGORY_WASTE_OVERRIDES[category]
    ?? parseWasteMultiplier(resolvedOrganizationMultiplier)
    ?? 1 + DEFAULT_WASTE_PERCENT / 100;
}

export function resolveDetectionWasteMultiplier(
  explicitMultiplier: unknown,
  resolvedOrganizationMultiplier: number,
  measurementType: 'count' | 'linear' | 'area',
): number {
  const explicit = parseWasteMultiplier(explicitMultiplier);
  if (explicit !== null) return explicit;

  if (measurementType === 'count') return 1;
  return parseWasteMultiplier(resolvedOrganizationMultiplier)
    ?? 1 + DEFAULT_WASTE_PERCENT / 100;
}
