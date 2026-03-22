/**
 * detectionCountPricing.ts
 *
 * Replaces the hardcoded `bluebeamPricing` map and inline unit costs
 * (belly band, Z-flashing, corbels, etc.) in orchestrator-v2.ts with
 * live database lookups.
 *
 * Resolution path:
 *   detection_class_material_mapping.class_name  (or bluebeam display_name)
 *     → detection_class_material_mapping.default_product_sku
 *     → pricing_items.sku  (via the shared fetchPricingData() 5-min cache)
 *
 * Fallback: if no DB row or no pricing found, returns null so callers can
 * emit a $0 "⚠️ VERIFY PRICING" line item instead of silently dropping.
 */

import { getSupabaseClient, isDatabaseConfigured } from './database';
import { fetchPricingData, PricingItem } from './pricing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectionCountPricing {
  /** Normalised class_name key (e.g. 'corbel', 'belly_band') */
  class_name: string;
  /** Human-readable label from detection_class_material_mapping.display_name */
  display_name: string;
  /** SKU from pricing_items */
  sku: string;
  /** Product name from pricing_items */
  description: string;
  /** Material unit cost (dollars) */
  material_cost: number;
  /** Base labour cost (dollars) */
  labor_cost: number;
  /** Unit string from pricing_items (e.g. 'ea', 'lf') */
  unit: string;
  /** Presentation group for the line item */
  presentation_group: string;
  /** measurement_type from detection_class_material_mapping */
  measurement_type: 'count' | 'area' | 'linear';
}

// ---------------------------------------------------------------------------
// Cache (same TTL as pricing.ts)
// ---------------------------------------------------------------------------

let detectionPricingCache: Map<string, DetectionCountPricing> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearDetectionCountPricingCache(): void {
  detectionPricingCache = null;
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Presentation group fallback table (mirrors getPresentationGroup() in orchestrator)
// ---------------------------------------------------------------------------

const PRESENTATION_GROUP_DEFAULTS: Record<string, string> = {
  corbel: 'Architectural Details',
  bracket: 'Architectural Details',
  shutter: 'Architectural Details',
  post: 'Architectural Details',
  column: 'Architectural Details',
  belly_band: 'Belly Band',
  belly_band_trim: 'Belly Band',
  belly_band_flashing: 'Belly Band',
  soffit: 'Soffit & Fascia',
  fascia: 'Soffit & Fascia',
  vent: 'Other Materials',
  gable_vent: 'Other Materials',
  foundation_vent: 'Other Materials',
  flashing: 'Flashing & Weatherproofing',
};

function resolvePresentationGroup(className: string, dbValue?: string | null): string {
  if (dbValue) return dbValue;
  return PRESENTATION_GROUP_DEFAULTS[className.toLowerCase()] ?? 'Other Materials';
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/**
 * Load detection-count pricing from the database.
 *
 * Returns a map keyed by detection class_name (e.g. 'corbel', 'belly_band').
 * Also indexes by Bluebeam display_name for backward compat with the old
 * bluebeamPricing map keys (e.g. 'Corbel Count', '1" x 6" WW Trim Count').
 *
 * Results are cached for 5 minutes (same TTL as fetchPricingData).
 */
export async function loadDetectionCountPricing(): Promise<Map<string, DetectionCountPricing>> {
  if (detectionPricingCache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return detectionPricingCache;
  }

  if (!isDatabaseConfigured()) {
    console.warn('⚠️ [detectionCountPricing] Database not configured — returning empty map');
    return new Map();
  }

  try {
    const client = getSupabaseClient();

    // Fetch all active detection class mappings that have a default SKU
    const { data: mappings, error: mappingError } = await client
      .from('detection_class_material_mapping')
      .select('class_name, display_name, measurement_type, unit_of_measure, default_product_sku, presentation_group')
      .eq('active', true)
      .not('default_product_sku', 'is', null);

    if (mappingError) {
      console.error('❌ [detectionCountPricing] Failed to fetch mappings:', mappingError.message);
      return detectionPricingCache ?? new Map();
    }

    if (!mappings || mappings.length === 0) {
      console.log('ℹ️ [detectionCountPricing] No active mappings with default_product_sku found');
      detectionPricingCache = new Map();
      cacheTimestamp = Date.now();
      return detectionPricingCache;
    }

    // Reuse the shared pricing cache (already warm from main calculation flow)
    const pricingBySkus = await fetchPricingData();

    const result = new Map<string, DetectionCountPricing>();

    for (const mapping of mappings) {
      const sku = mapping.default_product_sku as string;
      const pricing: PricingItem | undefined = pricingBySkus.get(sku);

      if (!pricing) {
        console.warn(
          `⚠️ [detectionCountPricing] SKU "${sku}" not found in pricing_items for class "${mapping.class_name}" — skipping`
        );
        continue;
      }

      const entry: DetectionCountPricing = {
        class_name: mapping.class_name as string,
        display_name: (mapping.display_name as string) ?? mapping.class_name,
        sku: pricing.sku,
        description: pricing.product_name,
        material_cost: parseFloat(String(pricing.material_cost ?? 0)),
        labor_cost: parseFloat(String(pricing.base_labor_cost ?? 0)),
        unit: pricing.unit ?? 'ea',
        presentation_group: resolvePresentationGroup(
          mapping.class_name as string,
          mapping.presentation_group as string | null
        ),
        measurement_type: (mapping.measurement_type as 'count' | 'area' | 'linear') ?? 'count',
      };

      // Index by class_name (primary key for code-driven lookups like 'corbel')
      result.set(mapping.class_name as string, entry);

      // Also index by display_name for Bluebeam subject label lookups
      // e.g. 'Corbel Count', '1" x 6" WW Trim Count'
      if (mapping.display_name && mapping.display_name !== mapping.class_name) {
        result.set(mapping.display_name as string, entry);
      }
    }

    detectionPricingCache = result;
    cacheTimestamp = Date.now();
    console.log(`✅ [detectionCountPricing] Loaded ${result.size} detection count pricing entries`);
    return result;
  } catch (err: any) {
    console.error('❌ [detectionCountPricing] Exception loading pricing:', err.message);
    return detectionPricingCache ?? new Map();
  }
}

/**
 * Look up pricing for a single detection key (class_name or display_name).
 * Returns null if not found — callers should emit a $0 VERIFY PRICING line item.
 */
export async function getDetectionCountPricing(key: string): Promise<DetectionCountPricing | null> {
  const map = await loadDetectionCountPricing();
  return map.get(key) ?? null;
}
