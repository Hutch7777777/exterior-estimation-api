/**
 * Canonical measurement field-alias resolution.
 *
 * The same measurement arrives under different field names depending on the
 * source (Detection Editor webhook, cad_hover_measurements columns, n8n
 * Transform CAD node). Before this module existed, buildMeasurementContext
 * (autoscope-v2.ts) and the labor calculations (orchestrator-v2.ts) each
 * hand-maintained their own fallback chains with DIFFERENT priority orders,
 * so the same request could price auto-scope and labor from different facade
 * areas. There is exactly ONE order now — change it here or nowhere.
 */

// facade_area_sqft (webhook, pre-deduplicated by Detection Editor)
//   > facade_total_sqft (cad_hover_measurements column)
//   > facade_sqft > gross_wall_area_sqft (legacy variants)
export const FACADE_SQFT_KEYS = [
  'facade_area_sqft',
  'facade_total_sqft',
  'facade_sqft',
  'gross_wall_area_sqft',
] as const;

export const NET_SIDING_SQFT_KEYS = [
  'net_siding_sqft',
  'net_siding_area_sqft',
  'net_wall_area_sqft',
] as const;

/**
 * Resolve a measurement across alias keys and prioritized sources.
 *
 * Iterates keys in canonical order; within each key, earlier sources win
 * (pass [db, wh] to keep the existing DB-over-webhook behavior of
 * buildMeasurementContext). A value only resolves if it parses to a FINITE,
 * POSITIVE number — zero-stuffed aliases (upstream `|| 0` habits) must not
 * mask a populated alias further down the chain.
 */
export function resolveAliasedNumber(
  keys: readonly string[],
  sources: Array<Record<string, unknown> | null | undefined>,
  fallback = 0
): number {
  for (const key of keys) {
    for (const source of sources) {
      const raw = source?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return fallback;
}
