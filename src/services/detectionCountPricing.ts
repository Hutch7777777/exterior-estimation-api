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

import { isDatabaseConfigured } from './database';
import { fetchPricingData, PricingItem } from './pricing';

// ---------------------------------------------------------------------------
// Direct REST helper — reads key at call time, bypasses singleton cache issue
// ---------------------------------------------------------------------------
// detection_class_material_mapping has RLS that blocks the anon key.
// We use a direct fetch() with the service role key read fresh from env at call time
// (not at module load time like the singleton does), so Railway env var changes take effect.
async function serviceRoleFetch<T>(
  path: string
): Promise<{ data: T[] | null; error: string | null }> {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

  console.log(`[serviceRoleFetch] key=${key ? key.slice(0,20) + '...' : 'MISSING'} url=${url ? 'ok' : 'MISSING'}`);

  if (!url || !key) return { data: null, error: 'Missing SUPABASE_URL or key' };

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return { data: null, error: `HTTP ${res.status}: ${body}` };
    }
    return { data: await res.json() as T[], error: null };
  } catch (err: any) {
    return { data: null, error: err.message };
  }
}

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

/**
 * Derive a presentation group for a bluebeam_subject_mappings entry based on
 * material_category, sub_category, and the subject string itself.
 * Used only when detection_class_material_mapping has no matching entry.
 */
function deriveBluebeamPresentationGroup(
  materialCategory: string,
  subCategory: string,
  subject: string
): string {
  const cat = materialCategory.toLowerCase();
  const sub = subCategory.toLowerCase();
  const subj = subject.toLowerCase();

  if (cat === 'soffit' || subj.includes('soffit') || subj.includes('fascia')) return 'Soffit & Fascia';
  if (cat === 'accessories' && (sub === 'flashing' || subj.includes('flashing'))) return 'Flashing & Weatherproofing';
  if (cat === 'accessories' && (sub === 'vent' || subj.includes('vent'))) return 'Other Materials';
  if (cat === 'accessories' && sub === 'wrb') return 'Flashing & Weatherproofing';
  if (cat === 'trim' || cat === 'lap_siding' || cat === 'panel_siding') {
    if (subj.includes('window') || subj.includes('head') || subj.includes('sill') || subj.includes('jamb')) {
      return 'Window Trims';
    }
    if (subj.includes('corner')) return 'Trim & Corners';
    if (subj.includes('belly') || subj.includes('band')) return 'Horizontal Trims';
    return 'Trim & Corners';
  }
  if (subj.includes('corbel') || subj.includes('bracket') || subj.includes('shutter')) return 'Architectural Details';
  if (subj.includes('gutter') || subj.includes('downspout')) return 'Gutters & Drainage';
  return 'Other Materials';
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

  console.log(`SERVICE KEY EXISTS: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}`);
  console.log(`🔍 [detectionCountPricing] load called, isDatabaseConfigured=${isDatabaseConfigured()}`);

  if (!isDatabaseConfigured()) {
    console.warn('⚠️ [detectionCountPricing] Database not configured — returning empty map');
    return new Map();
  }

  try {
    // Direct REST fetch with key read fresh from env — bypasses singleton/module-load issues
    const { data: mappings, error: mappingError } = await serviceRoleFetch<any>(
      'detection_class_material_mapping?select=class_name,display_name,measurement_type,unit_of_measure,default_product_sku,presentation_group&active=eq.true&default_product_sku=not.is.null'
    );

    if (mappingError) {
      console.error('❌ [detectionCountPricing] Failed to fetch mappings:', mappingError);
      return detectionPricingCache ?? new Map();
    }

    console.log(`🔍 [detectionCountPricing] mappings query returned ${mappings?.length ?? 0} rows`);

    if (!mappings || mappings.length === 0) {
      console.log('ℹ️ [detectionCountPricing] No active mappings with default_product_sku found — NOT caching empty result');
      return new Map(); // Do NOT cache empty — retry on next request in case of transient failure
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

    // -------------------------------------------------------------------------
    // SECOND PASS: bluebeam_subject_mappings (count-type entries with a suggested_sku)
    //
    // Detection count keys from Bluebeam imports arrive as the raw annotation
    // subject string (e.g. '1" x 6" WW Trim Count', 'Decorative Corbel Count').
    // These won't match detection_class_material_mapping class_names, so we load
    // bluebeam_subject_mappings as a second source, keyed by bluebeam_subject.
    //
    // Priority: detection_class_material_mapping wins — we skip any bluebeam_subject
    // that is already in the map (already covered by class_name or display_name).
    //
    // Both active snapshots (ABC Supply + MASTER) are already in the shared
    // fetchPricingData() cache, so getPricingBySku() resolves across both.
    // -------------------------------------------------------------------------
    const { data: bluebeamMappings, error: bluebeamError } = await serviceRoleFetch<any>(
      'bluebeam_subject_mappings?select=bluebeam_subject,suggested_sku,material_category,sub_category&measurement_type=eq.count&active=eq.true&suggested_sku=not.is.null'
    );

    if (bluebeamError) {
      console.warn('⚠️ [detectionCountPricing] Failed to fetch bluebeam_subject_mappings:', bluebeamError);
      // Non-fatal — continue with what we have from detection_class_material_mapping
    } else {
      let bluebeamAdded = 0;
      let bluebeamSkipped = 0;
      let bluebeamMissing = 0;

      for (const mapping of bluebeamMappings ?? []) {
        const subject = mapping.bluebeam_subject as string;
        const sku = mapping.suggested_sku as string;

        // detection_class_material_mapping takes priority
        if (result.has(subject)) {
          bluebeamSkipped++;
          continue;
        }

        // Reuse shared pricing cache — covers both active snapshots
        const pricing = pricingBySkus.get(sku);
        if (!pricing) {
          console.warn(
            `⚠️ [detectionCountPricing] bluebeam_subject "${subject}" → SKU "${sku}" not found in pricing_items`
          );
          bluebeamMissing++;
          continue;
        }

        // Derive presentation group from material_category / sub_category
        const rawCategory = (mapping.material_category as string | null) ?? '';
        const rawSub = (mapping.sub_category as string | null) ?? '';
        const derivedGroup = deriveBluebeamPresentationGroup(rawCategory, rawSub, subject);

        result.set(subject, {
          class_name: subject,
          display_name: subject,
          sku: pricing.sku,
          description: pricing.product_name,
          material_cost: parseFloat(String(pricing.material_cost ?? 0)),
          labor_cost: parseFloat(String(pricing.base_labor_cost ?? 0)),
          unit: pricing.unit ?? 'ea',
          presentation_group: derivedGroup,
          measurement_type: 'count',
        });
        bluebeamAdded++;
      }

      console.log(
        `✅ [detectionCountPricing] Bluebeam subjects: ${bluebeamAdded} added, ${bluebeamSkipped} skipped (already mapped), ${bluebeamMissing} missing SKU`
      );
    }

    detectionPricingCache = result;
    cacheTimestamp = Date.now();
    console.log(`✅ [detectionCountPricing] Loaded ${result.size} total entries (class + bluebeam subjects)`);
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
