/**
 * Auto-Scope V2 - Database-Driven Rules Engine
 * Fetches rules from siding_auto_scope_rules table and generates line items
 *
 * FIXED: Now correctly maps to actual database schema:
 * - rule_id (not id)
 * - material_sku (not sku)
 * - rule_name (not product_name)
 * - active (not is_active)
 * - trigger_condition (singular, JSONB object, not array)
 */

import { getSupabaseClient, isDatabaseConfigured } from '../../services/database';
import { getPricingBySkus, getPricingByIds, calculateTotalLabor } from '../../services/pricing';
import {
  MeasurementContext,
  AutoScopeLineItem,
  AutoScopeV2Result,
  AutoScopeV2Options,
  CadHoverMeasurements,
  ManufacturerGroups,
  ManufacturerMeasurements,
  AssignedMaterial
} from '../../types/autoscope';
import { PerMaterialMeasurements } from '../../types/webhook';
// PricingItem type used indirectly via getPricingByIds return type

// ============================================================================
// DATABASE RULE TYPE (matches actual siding_auto_scope_rules table)
// ============================================================================

interface DbAutoScopeRule {
  rule_id: number;
  rule_name: string;
  description: string | null;
  material_category: string;
  material_sku: string;
  quantity_formula: string;
  unit: string;
  output_unit: string | null;
  size_description: string | null;
  trigger_condition: DbTriggerCondition | null;
  presentation_group: string;
  group_order: number;
  item_order: number;
  priority: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  // Manufacturer filter for per-manufacturer rules
  // null = generic rule (applies to all manufacturers using total project area)
  // ['James Hardie'] = only applies to James Hardie products using Hardie SF
  // ['Nichiha'] = only applies to Nichiha products using Nichiha SF
  // ['Engage Building Products'] = only applies to FastPlank products
  manufacturer_filter: string[] | null;
}

// Database uses this format for trigger conditions:
// { "always": true } - always trigger
// { "min_corners": 1 } - min corners count
// { "min_openings": 1 } - min openings count
// { "min_net_area": 500 } - min net area sqft
// { "trim_total_lf_gt": 0 } - trigger when trim_total_lf > 0
// NEW: Material-based triggers for SKU pattern matching
// { "material_category": "board_batten" } - only when assigned material has this category
// { "sku_pattern": "16OC-CP" } - only when assigned material SKU contains this pattern
interface DbTriggerCondition {
  always?: boolean;
  min_corners?: number;
  min_openings?: number;
  min_net_area?: number;
  min_facade_area?: number;
  min_belly_band_lf?: number;  // Trigger when belly_band_lf >= this value
  // Trim triggers
  min_trim_total_lf?: number;  // Trigger when trim_total_lf >= this value
  min_trim_head_lf?: number;   // Trigger when trim_head_lf >= this value
  min_trim_jamb_lf?: number;   // Trigger when trim_jamb_lf >= this value
  min_trim_sill_lf?: number;   // Trigger when trim_sill_lf >= this value
  trim_total_lf_gt?: number;   // Trigger when trim_total_lf > this value (alternative syntax)
  trim_head_lf_gt?: number;    // Trigger when trim_head_lf > this value
  trim_jamb_lf_gt?: number;    // Trigger when trim_jamb_lf > this value
  trim_sill_lf_gt?: number;    // Trigger when trim_sill_lf > this value
  // NEW: Material-based triggers (match against assigned materials)
  material_category?: string;  // e.g., "board_batten" - matches pricing_items.category
  sku_pattern?: string;        // e.g., "16OC-CP" - substring match against pricing_items.sku
}

// NOTE: AssignedMaterial interface is imported from '../../types/autoscope'

// ============================================================================
// FETCH RULES FROM DATABASE
// ============================================================================

let rulesCache: DbAutoScopeRule[] | null = null;
let rulesCacheTimestamp: number = 0;
const RULES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function fetchAutoScopeRules(): Promise<DbAutoScopeRule[]> {
  // Check cache
  if (rulesCache && (Date.now() - rulesCacheTimestamp) < RULES_CACHE_TTL_MS) {
    console.log(`📋 Using cached auto-scope rules (${rulesCache.length} rules)`);
    return rulesCache;
  }

  if (!isDatabaseConfigured()) {
    console.warn('⚠️ Database not configured - using fallback auto-scope rules');
    return getFallbackRules();
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('siding_auto_scope_rules')
      .select('*')
      .eq('active', true)  // FIXED: was 'is_active'
      .order('group_order', { ascending: true })
      .order('item_order', { ascending: true });

    if (error) {
      console.error('❌ Error fetching auto-scope rules:', error.message);
      return getFallbackRules();
    }

    rulesCache = data as DbAutoScopeRule[];
    rulesCacheTimestamp = Date.now();
    console.log(`✅ Loaded ${rulesCache.length} auto-scope rules from database`);
    return rulesCache;
  } catch (err) {
    console.error('❌ Database error fetching auto-scope rules:', err);
    return getFallbackRules();
  }
}

export function clearAutoScopeRulesCache(): void {
  rulesCache = null;
  rulesCacheTimestamp = 0;
}

// ============================================================================
// FETCH MEASUREMENTS FROM DATABASE
// ============================================================================

export async function fetchMeasurementsFromDatabase(
  extractionId: string
): Promise<CadHoverMeasurements | null> {
  if (!isDatabaseConfigured()) {
    console.warn('⚠️ Database not configured - cannot fetch measurements');
    return null;
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('cad_hover_measurements')
      .select('*')
      .eq('extraction_id', extractionId)
      .single();

    if (error) {
      console.warn(`⚠️ No measurements found for extraction_id: ${extractionId}`, error.message);
      return null;
    }

    console.log(`✅ Loaded measurements from database for extraction_id: ${extractionId}`);
    return data as CadHoverMeasurements;
  } catch (err) {
    console.error('❌ Error fetching measurements from database:', err);
    return null;
  }
}

// ============================================================================
// BUILD MEASUREMENT CONTEXT
// ============================================================================

export function buildMeasurementContext(
  dbMeasurements?: CadHoverMeasurements | null,
  webhookMeasurements?: Record<string, any>
): MeasurementContext {
  // Cast to any for flexible property access
  const db: any = dbMeasurements || {};
  const wh: any = webhookMeasurements || {};

  // Helper to get value from db first, then webhook, with fallback
  const get = (keys: string[], fallback: number = 0): number => {
    for (const key of keys) {
      if (db[key] !== undefined && db[key] !== null) return Number(db[key]);
      if (wh[key] !== undefined && wh[key] !== null) return Number(wh[key]);
    }
    return fallback;
  };

  // =========================================================================
  // Map ACTUAL database column names from cad_hover_measurements
  // =========================================================================

  // Primary areas - DB uses facade_total_sqft, net_siding_sqft
  const facade_sqft = get(['facade_total_sqft', 'facade_sqft', 'gross_wall_area_sqft']);
  const net_siding_sqft = get(['net_siding_sqft', 'net_siding_area_sqft', 'net_wall_area_sqft']);

  // Openings - DB has pre-computed totals
  const openings_area_sqft = get(['openings_area_sqft']);
  const openings_count = get(['openings_count']);
  const openings_perimeter_lf = get(['openings_total_perimeter_lf', 'openings_perimeter_lf']);

  // Corners - DB uses corners_outside_count, corners_inside_count
  const outside_corners_count = get(['corners_outside_count', 'outside_corner_count', 'outside_corners_count']);
  const inside_corners_count = get(['corners_inside_count', 'inside_corner_count', 'inside_corners_count']);
  const outside_corner_lf = get(['corners_outside_lf', 'outside_corner_lf']);
  const inside_corner_lf = get(['corners_inside_lf', 'inside_corner_lf']);

  // Other
  const level_starter_lf = get(['level_starter_lf']);
  const avg_wall_height_ft = get(['avg_wall_height_ft'], 10); // Default 10ft if null

  // Windows/Doors/Garages for individual calculations
  const window_count = get(['windows_count', 'window_count']);
  const door_count = get(['doors_count', 'door_count']);
  const garage_count = get(['garages_count', 'garage_count']);

  // Compute facade_perimeter_lf from area and height
  const facade_perimeter_lf = avg_wall_height_ft > 0
    ? facade_sqft / avg_wall_height_ft
    : level_starter_lf || 0;

  // =========================================================================
  // TRIM TOTALS - Compute from payload or sum component parts
  // Payload sends: trim.total_head_lf, trim.total_jamb_lf, trim.total_sill_lf, trim.total_trim_lf
  // =========================================================================

  // Check if webhook has a nested 'trim' object (from DetectionEditor payload)
  const trimObj = wh.trim || {};

  // Get trim values: first check trim object, then check flat fields, then compute from components
  const trim_head_lf = Number(trimObj.total_head_lf) ||
    get(['trim_head_lf', 'total_head_lf']) ||
    (get(['windows_head_lf', 'window_head_lf']) + get(['doors_head_lf', 'door_head_lf']) + get(['garages_head_lf', 'garage_head_lf']));

  const trim_jamb_lf = Number(trimObj.total_jamb_lf) ||
    get(['trim_jamb_lf', 'total_jamb_lf']) ||
    (get(['windows_jamb_lf', 'window_jamb_lf']) + get(['doors_jamb_lf', 'door_jamb_lf']) + get(['garages_jamb_lf', 'garage_jamb_lf']));

  const trim_sill_lf = Number(trimObj.total_sill_lf) ||
    get(['trim_sill_lf', 'total_sill_lf']) ||
    get(['windows_sill_lf', 'window_sill_lf']);

  const trim_total_lf = Number(trimObj.total_trim_lf) ||
    get(['trim_total_lf', 'total_trim_lf']) ||
    (trim_head_lf + trim_jamb_lf + trim_sill_lf);

  console.log('[AutoScope] Trim totals:', { trim_total_lf, trim_head_lf, trim_jamb_lf, trim_sill_lf });

  const ctx: MeasurementContext = {
    // Primary areas
    facade_sqft,
    gross_wall_area_sqft: facade_sqft,
    net_siding_area_sqft: net_siding_sqft,

    // Windows
    window_count,
    window_area_sqft: get(['windows_area_sqft', 'window_area_sqft']),
    window_perimeter_lf: get(['windows_perimeter_lf', 'window_perimeter_lf']),
    window_head_lf: get(['windows_head_lf', 'window_head_lf']),
    window_sill_lf: get(['windows_sill_lf', 'window_sill_lf']),
    window_jamb_lf: get(['windows_jamb_lf', 'window_jamb_lf']),

    // Doors
    door_count,
    door_area_sqft: get(['doors_area_sqft', 'door_area_sqft']),
    door_perimeter_lf: get(['doors_perimeter_lf', 'door_perimeter_lf']),
    door_head_lf: get(['doors_head_lf', 'door_head_lf']),
    door_jamb_lf: get(['doors_jamb_lf', 'door_jamb_lf']),

    // Garages
    garage_count,
    garage_area_sqft: get(['garages_area_sqft', 'garage_area_sqft']),
    garage_perimeter_lf: get(['garages_perimeter_lf', 'garage_perimeter_lf']),

    // Corners
    outside_corner_count: outside_corners_count,
    outside_corner_lf,
    inside_corner_count: inside_corners_count,
    inside_corner_lf,

    // Gables
    gable_count: get(['gables_count', 'gable_count']),
    gable_area_sqft: get(['gables_area_sqft', 'gable_area_sqft']),
    gable_rake_lf: get(['gables_rake_lf', 'gable_rake_lf']),

    // Belly Band (from detection_counts in webhook)
    belly_band_count: get(['belly_band_count']),
    belly_band_lf: get(['belly_band_lf']),

    // Other
    level_starter_lf,
    avg_wall_height_ft,

    // Computed helpers
    total_opening_perimeter_lf: openings_perimeter_lf,
    total_corner_lf: outside_corner_lf + inside_corner_lf,
    total_openings_area_sqft: openings_area_sqft,
    total_openings_count: openings_count,

    // =========================================================================
    // TRIM TOTALS (computed from window + door + garage trim)
    // =========================================================================
    trim_total_lf,
    trim_head_lf,
    trim_jamb_lf,
    trim_sill_lf,

    // =========================================================================
    // ALIASES for database formula compatibility
    // These match the variable names used in quantity_formula
    // =========================================================================
    facade_area_sqft: facade_sqft,
    openings_area_sqft: openings_area_sqft,
    outside_corners_count: outside_corners_count,
    inside_corners_count: inside_corners_count,
    openings_perimeter_lf: openings_perimeter_lf,
    openings_count: openings_count,
    facade_perimeter_lf: facade_perimeter_lf,
    facade_height_ft: avg_wall_height_ft,
  };

  console.log(`📊 MeasurementContext built:`, {
    facade_area_sqft: ctx.facade_area_sqft,
    net_siding_area_sqft: ctx.net_siding_area_sqft,
    openings_area_sqft: ctx.openings_area_sqft,
    openings_count: ctx.openings_count,
    openings_perimeter_lf: ctx.openings_perimeter_lf,
    outside_corners_count: ctx.outside_corners_count,
    inside_corners_count: ctx.inside_corners_count,
    facade_perimeter_lf: ctx.facade_perimeter_lf,
    facade_height_ft: ctx.facade_height_ft,
    level_starter_lf: ctx.level_starter_lf,
  });

  return ctx;
}

// ============================================================================
// MANUFACTURER GROUPING - Group material assignments by manufacturer
// ============================================================================

/**
 * Material assignment structure for manufacturer grouping
 */
export interface MaterialAssignmentForGrouping {
  pricing_item_id?: string;
  assigned_material_id?: string;  // n8n workflow uses this field name
  quantity: number;
  unit: string;
  area_sqft?: number;
  perimeter_lf?: number;
  detection_id?: string;
}

/**
 * Group material assignments by manufacturer
 * Enriches assignments with manufacturer info from pricing_items table
 *
 * V8.0: Also merges per_material_measurements from spatial containment analysis
 * when provided, which adds per-material opening measurements (windows, doors, garages)
 *
 * @param materialAssignments - Array of material assignments from Detection Editor
 * @param organizationId - Optional org ID for pricing overrides
 * @param perMaterialMeasurements - V8.0: Per-material measurements from spatial containment
 * @returns ManufacturerGroups map with aggregated measurements per manufacturer
 */
export async function buildManufacturerGroups(
  materialAssignments: MaterialAssignmentForGrouping[],
  organizationId?: string,
  perMaterialMeasurements?: PerMaterialMeasurements
): Promise<ManufacturerGroups> {
  const groups: ManufacturerGroups = {};

  if (!materialAssignments || materialAssignments.length === 0) {
    console.log('[AutoScope] No material assignments to group by manufacturer');
    return groups;
  }

  // Debug: Log incoming assignments to verify field names
  console.log('[AutoScope] Material assignments received:', materialAssignments.map(a => ({
    pricing_item_id: a.pricing_item_id,
    assigned_material_id: a.assigned_material_id,
    quantity: a.quantity,
    unit: a.unit
  })));

  // Get unique pricing item IDs (accept both field names)
  const pricingItemIds = [...new Set(
    materialAssignments
      .map(a => a.pricing_item_id || a.assigned_material_id)
      .filter((id): id is string => Boolean(id && id.trim() !== ''))
  )];

  console.log('[AutoScope] Extracted pricing item IDs:', pricingItemIds);

  if (pricingItemIds.length === 0) {
    console.log('[AutoScope] No valid pricing item IDs in assignments');
    return groups;
  }

  // Fetch pricing with manufacturer info
  const pricingMap = await getPricingByIds(pricingItemIds, organizationId);

  console.log(`[AutoScope] Fetched pricing for ${pricingMap.size}/${pricingItemIds.length} items`);

  // Debug: Log manufacturers found
  const manufacturers = [...new Set([...pricingMap.values()].map(p => p.manufacturer).filter(Boolean))];
  console.log('[AutoScope] Manufacturers found:', manufacturers);

  // Group assignments by manufacturer
  // FIX: Ensure each area is only counted ONCE to prevent 3x inflation bug
  for (const assignment of materialAssignments) {
    const itemId = assignment.pricing_item_id || assignment.assigned_material_id;
    const pricing = itemId ? pricingMap.get(itemId) : undefined;

    if (!pricing) {
      console.warn(`[AutoScope] No pricing found for ID: ${itemId}`);
      continue;
    }

    const manufacturer = pricing.manufacturer;
    if (!manufacturer || manufacturer.trim() === '') {
      console.warn(`[AutoScope] No manufacturer for SKU: ${pricing.sku}`);
      continue;
    }

    // Initialize group if needed
    if (!groups[manufacturer]) {
      groups[manufacturer] = {
        manufacturer,
        area_sqft: 0,
        linear_ft: 0,
        piece_count: 0,
        detection_ids: [],
      };
    }

    // Aggregate based on unit type
    // FIX: Use mutually exclusive logic to prevent double-counting
    const unit = assignment.unit?.toUpperCase() || '';
    const quantity = Number(assignment.quantity) || 0;

    if (unit === 'SF' || unit === 'SQFT' || unit === 'SQ FT') {
      // Unit is SF - use quantity as area
      groups[manufacturer].area_sqft += quantity;
      console.log(`   📐 [${manufacturer}] +${quantity.toFixed(1)} SF from quantity (unit=${unit})`);
    } else if (unit === 'LF' || unit === 'LINEAR FT' || unit === 'LINFT') {
      // Unit is LF - use quantity as linear feet
      groups[manufacturer].linear_ft += quantity;
      console.log(`   📏 [${manufacturer}] +${quantity.toFixed(1)} LF from quantity (unit=${unit})`);
    } else if (unit === 'EA' || unit === 'EACH' || unit === 'PC' || unit === 'PIECE' || unit === 'PCS') {
      // Unit is pieces - use quantity as count
      groups[manufacturer].piece_count += quantity;
      console.log(`   🔢 [${manufacturer}] +${quantity} EA from quantity (unit=${unit})`);
    } else if (assignment.area_sqft && assignment.area_sqft > 0) {
      // Unknown unit but area_sqft is provided - use area_sqft ONLY (not quantity)
      groups[manufacturer].area_sqft += assignment.area_sqft;
      console.log(`   📐 [${manufacturer}] +${assignment.area_sqft.toFixed(1)} SF from area_sqft (unknown unit='${unit}')`);
    } else {
      // Unknown unit, no area_sqft - assume quantity is area (fallback)
      groups[manufacturer].area_sqft += quantity;
      console.log(`   📐 [${manufacturer}] +${quantity.toFixed(1)} SF from quantity (fallback, unit='${unit}')`);
    }

    // FIX: REMOVED the old double-counting code that added area_sqft again:
    // OLD CODE (was causing double-counting):
    // if (assignment.area_sqft && unit !== 'SF') {
    //   groups[manufacturer].area_sqft += assignment.area_sqft;
    // }

    // Add perimeter_lf only if unit is NOT already LF (prevent double-counting)
    if (assignment.perimeter_lf && unit !== 'LF' && unit !== 'LINEAR FT' && unit !== 'LINFT') {
      groups[manufacturer].linear_ft += assignment.perimeter_lf;
      console.log(`   📏 [${manufacturer}] +${assignment.perimeter_lf.toFixed(1)} LF from perimeter_lf`);
    }

    // Track detection IDs for provenance
    if (assignment.detection_id) {
      groups[manufacturer].detection_ids.push(assignment.detection_id);
    }
  }

  // =========================================================================
  // V8.0: SPATIAL CONTAINMENT - Merge per-material opening measurements
  // FIX: Do NOT add facade_sqft if manufacturer already exists from material_assignments
  // This was causing 3x inflation: 1) quantity, 2) area_sqft, 3) facade_sqft
  // =========================================================================
  if (perMaterialMeasurements && Object.keys(perMaterialMeasurements).length > 0) {
    console.log(`[AutoScope V8.0] Merging per-material measurements from spatial containment`);

    for (const [materialId, perMatMeasures] of Object.entries(perMaterialMeasurements)) {
      // Skip 'unassigned' bucket if it has no meaningful data
      if (materialId === 'unassigned' && perMatMeasures.window_count === 0 && perMatMeasures.door_count === 0) {
        console.log(`[AutoScope V8.0] Skipping 'unassigned' bucket (no openings)`);
        continue;
      }

      const manufacturer = perMatMeasures.manufacturer;
      if (!manufacturer || manufacturer.trim() === '') {
        console.warn(`[AutoScope V8.0] No manufacturer for material ID: ${materialId}`);
        continue;
      }

      // If this manufacturer doesn't exist in groups yet, create it
      // (this can happen if spatial containment data includes manufacturers not in material_assignments)
      if (!groups[manufacturer]) {
        groups[manufacturer] = {
          manufacturer,
          area_sqft: perMatMeasures.facade_sqft || 0,
          linear_ft: 0,
          piece_count: 0,
          detection_ids: perMatMeasures.facades || [],
        };
        console.log(`   📐 [${manufacturer}] Created from per_material: ${(perMatMeasures.facade_sqft || 0).toFixed(1)} SF`);
      } else {
        // FIX: Manufacturer already exists from material_assignments
        // DO NOT add facade_sqft - this would cause double/triple counting!
        // Only merge detection_ids for provenance tracking
        console.log(`   ⏭️ [${manufacturer}] Already has ${groups[manufacturer].area_sqft.toFixed(1)} SF from assignments, skipping per_material facade_sqft (${(perMatMeasures.facade_sqft || 0).toFixed(1)} SF)`);

        if (perMatMeasures.facades && perMatMeasures.facades.length > 0) {
          groups[manufacturer].detection_ids = [
            ...(groups[manufacturer].detection_ids || []),
            ...perMatMeasures.facades
          ];
        }
      }

      const group = groups[manufacturer];

      // Merge opening measurements into the manufacturer group
      // These are the key values for spatial containment - per-material opening measurements
      group.window_perimeter_lf = (group.window_perimeter_lf || 0) + (perMatMeasures.window_perimeter_lf || 0);
      group.door_perimeter_lf = (group.door_perimeter_lf || 0) + (perMatMeasures.door_perimeter_lf || 0);
      group.garage_perimeter_lf = (group.garage_perimeter_lf || 0) + (perMatMeasures.garage_perimeter_lf || 0);
      group.window_count = (group.window_count || 0) + (perMatMeasures.window_count || 0);
      group.door_count = (group.door_count || 0) + (perMatMeasures.door_count || 0);
      group.garage_count = (group.garage_count || 0) + (perMatMeasures.garage_count || 0);
      group.openings_area_sqft = (group.openings_area_sqft || 0) + (perMatMeasures.openings_area_sqft || 0);

      // Compute total openings perimeter
      group.total_openings_perimeter_lf =
        (group.window_perimeter_lf || 0) +
        (group.door_perimeter_lf || 0) +
        (group.garage_perimeter_lf || 0);

      // =========================================================================
      // V8.1: Merge perimeter, corners, trim, belly band, architectural
      // =========================================================================

      // V8.1: Perimeter (for starter strips, Z-flashing)
      if (perMatMeasures.facade_perimeter_lf !== undefined) {
        group.facade_perimeter_lf = (group.facade_perimeter_lf || 0) + perMatMeasures.facade_perimeter_lf;
      }

      // V8.1: Corners
      if (perMatMeasures.outside_corner_count !== undefined) {
        group.outside_corner_count = (group.outside_corner_count || 0) + perMatMeasures.outside_corner_count;
      }
      if (perMatMeasures.outside_corner_lf !== undefined) {
        group.outside_corner_lf = (group.outside_corner_lf || 0) + perMatMeasures.outside_corner_lf;
      }
      if (perMatMeasures.inside_corner_count !== undefined) {
        group.inside_corner_count = (group.inside_corner_count || 0) + perMatMeasures.inside_corner_count;
      }
      if (perMatMeasures.inside_corner_lf !== undefined) {
        group.inside_corner_lf = (group.inside_corner_lf || 0) + perMatMeasures.inside_corner_lf;
      }
      // Compute total corner LF
      group.total_corner_lf = (group.outside_corner_lf || 0) + (group.inside_corner_lf || 0);

      // V8.1: Trim
      if (perMatMeasures.trim_head_lf !== undefined) {
        group.trim_head_lf = (group.trim_head_lf || 0) + perMatMeasures.trim_head_lf;
      }
      if (perMatMeasures.trim_jamb_lf !== undefined) {
        group.trim_jamb_lf = (group.trim_jamb_lf || 0) + perMatMeasures.trim_jamb_lf;
      }
      if (perMatMeasures.trim_sill_lf !== undefined) {
        group.trim_sill_lf = (group.trim_sill_lf || 0) + perMatMeasures.trim_sill_lf;
      }
      if (perMatMeasures.trim_total_lf !== undefined) {
        group.trim_total_lf = (group.trim_total_lf || 0) + perMatMeasures.trim_total_lf;
      } else {
        // Compute total trim LF if not provided
        group.trim_total_lf = (group.trim_head_lf || 0) + (group.trim_jamb_lf || 0) + (group.trim_sill_lf || 0);
      }

      // V8.1: Belly band
      if (perMatMeasures.belly_band_lf !== undefined) {
        group.belly_band_lf = (group.belly_band_lf || 0) + perMatMeasures.belly_band_lf;
      }

      // V8.1: Architectural elements
      if (perMatMeasures.architectural_count !== undefined) {
        group.architectural_count = (group.architectural_count || 0) + perMatMeasures.architectural_count;
      }

      console.log(`[AutoScope V8.0] ${manufacturer}: ${group.window_count} windows (${group.window_perimeter_lf?.toFixed(1)} LF), ${group.door_count} doors (${group.door_perimeter_lf?.toFixed(1)} LF), ${group.garage_count} garages (${group.garage_perimeter_lf?.toFixed(1)} LF)`);
    }

    // Log spatial containment summary (V8.0 + V8.1)
    console.log(`[AutoScope V8.1] ═══════════════════════════════════════════`);
    console.log(`[AutoScope V8.1] SPATIAL CONTAINMENT SUMMARY:`);
    for (const [mfr, group] of Object.entries(groups)) {
      const openingLF = group.total_openings_perimeter_lf || 0;
      const windowCount = group.window_count || 0;
      const doorCount = group.door_count || 0;
      const garageCount = group.garage_count || 0;
      console.log(`[AutoScope V8.1]   ${mfr}:`);
      console.log(`[AutoScope V8.1]     Facade: ${group.area_sqft.toFixed(1)} SF, Perimeter: ${(group.facade_perimeter_lf || 0).toFixed(1)} LF`);
      console.log(`[AutoScope V8.1]     Openings: ${windowCount} windows + ${doorCount} doors + ${garageCount} garages = ${openingLF.toFixed(1)} LF`);
      // V8.1 fields
      if (group.total_corner_lf !== undefined || group.outside_corner_count !== undefined) {
        console.log(`[AutoScope V8.1]     Corners: ${group.outside_corner_count || 0} outside (${(group.outside_corner_lf || 0).toFixed(1)} LF) + ${group.inside_corner_count || 0} inside (${(group.inside_corner_lf || 0).toFixed(1)} LF) = ${(group.total_corner_lf || 0).toFixed(1)} LF`);
      }
      if (group.trim_total_lf !== undefined) {
        console.log(`[AutoScope V8.1]     Trim: head=${(group.trim_head_lf || 0).toFixed(1)} + jamb=${(group.trim_jamb_lf || 0).toFixed(1)} + sill=${(group.trim_sill_lf || 0).toFixed(1)} = ${(group.trim_total_lf || 0).toFixed(1)} LF`);
      }
      if (group.belly_band_lf !== undefined) {
        console.log(`[AutoScope V8.1]     Belly Band: ${group.belly_band_lf.toFixed(1)} LF`);
      }
      if (group.architectural_count !== undefined) {
        console.log(`[AutoScope V8.1]     Architectural: ${group.architectural_count} EA`);
      }
    }
    console.log(`[AutoScope V8.1] ═══════════════════════════════════════════`);
  }

  // Log results
  console.log(`[AutoScope] Built ${Object.keys(groups).length} manufacturer groups:`);
  for (const [mfr, data] of Object.entries(groups)) {
    console.log(`  ${mfr}:`);
    console.log(`    - Area: ${data.area_sqft.toFixed(2)} SF`);
    console.log(`    - Linear: ${data.linear_ft.toFixed(2)} LF`);
    console.log(`    - Pieces: ${data.piece_count}`);
    console.log(`    - Detections: ${data.detection_ids.length}`);
    if (data.total_openings_perimeter_lf !== undefined) {
      console.log(`    - Openings Perimeter: ${data.total_openings_perimeter_lf.toFixed(2)} LF (V8.0 spatial)`);
    }
    // V8.1 fields summary
    if (data.total_corner_lf !== undefined) {
      console.log(`    - Corners: ${data.total_corner_lf.toFixed(2)} LF (V8.1 spatial)`);
    }
    if (data.trim_total_lf !== undefined) {
      console.log(`    - Trim: ${data.trim_total_lf.toFixed(2)} LF (V8.1 spatial)`);
    }
  }

  // =========================================================================
  // VALIDATION SUMMARY - Check for potential inflation issues
  // =========================================================================
  const totalArea = Object.values(groups).reduce((sum, g) => sum + (g.area_sqft || 0), 0);
  const totalLinear = Object.values(groups).reduce((sum, g) => sum + (g.linear_ft || 0), 0);
  const totalPieces = Object.values(groups).reduce((sum, g) => sum + (g.piece_count || 0), 0);

  console.log(`\n🔍 MANUFACTURER GROUPS VALIDATION SUMMARY:`);
  console.log(`   Manufacturers: ${Object.keys(groups).length}`);
  console.log(`   Total Area: ${totalArea.toFixed(2)} SF (${(totalArea / 100).toFixed(2)} squares)`);
  console.log(`   Total Linear: ${totalLinear.toFixed(2)} LF`);
  console.log(`   Total Pieces: ${totalPieces}`);

  return groups;
}

/**
 * Build a manufacturer-specific MeasurementContext
 * Replaces facade_area_sqft with the manufacturer's specific area
 * Used for evaluating manufacturer-specific auto-scope rules
 *
 * V8.0: If per-material opening measurements are available (from spatial containment),
 * use them instead of scaling from total project measurements. This enables accurate
 * per-manufacturer calculations for accessories like J-channel and caulk.
 *
 * V8.1: Added support for per-material perimeter, corners, trim, and belly band.
 * These enable manufacturer-specific calculations for corner posts, trim boards,
 * starter strips, and belly band accessories.
 */
export function buildManufacturerContext(
  baseContext: MeasurementContext,
  manufacturerData: ManufacturerMeasurements
): MeasurementContext {
  // Create a copy of the base context
  const mfrContext: MeasurementContext = { ...baseContext };

  // Override area-based measurements with manufacturer-specific values
  mfrContext.facade_sqft = manufacturerData.area_sqft;
  mfrContext.facade_area_sqft = manufacturerData.area_sqft;
  mfrContext.gross_wall_area_sqft = manufacturerData.area_sqft;

  // For net siding area, scale proportionally based on total area ratio
  const areaRatio = baseContext.facade_sqft > 0
    ? manufacturerData.area_sqft / baseContext.facade_sqft
    : 1;
  mfrContext.net_siding_area_sqft = baseContext.net_siding_area_sqft * areaRatio;

  // Override linear measurements if manufacturer has them
  if (manufacturerData.linear_ft > 0) {
    mfrContext.level_starter_lf = manufacturerData.linear_ft;
  }

  // Scale perimeter proportionally based on area ratio
  // Or use linear_ft if provided
  mfrContext.facade_perimeter_lf = manufacturerData.linear_ft > 0
    ? manufacturerData.linear_ft
    : baseContext.facade_perimeter_lf * areaRatio;

  // =========================================================================
  // V8.0: SPATIAL CONTAINMENT - Use per-material opening measurements
  // If spatial containment data is available, use manufacturer-specific
  // opening measurements instead of scaling from total project measurements
  // =========================================================================

  const hasSpatialData = manufacturerData.window_perimeter_lf !== undefined ||
                         manufacturerData.door_perimeter_lf !== undefined ||
                         manufacturerData.garage_perimeter_lf !== undefined;

  if (hasSpatialData) {
    // Window measurements
    if (manufacturerData.window_perimeter_lf !== undefined) {
      mfrContext.window_perimeter_lf = manufacturerData.window_perimeter_lf;
      mfrContext.window_count = manufacturerData.window_count || 0;
      // Scale other window measurements proportionally based on window count ratio
      const windowRatio = baseContext.window_count > 0
        ? (manufacturerData.window_count || 0) / baseContext.window_count
        : 0;
      mfrContext.window_area_sqft = baseContext.window_area_sqft * windowRatio;
      mfrContext.window_head_lf = baseContext.window_head_lf * windowRatio;
      mfrContext.window_sill_lf = baseContext.window_sill_lf * windowRatio;
      mfrContext.window_jamb_lf = baseContext.window_jamb_lf * windowRatio;
    }

    // Door measurements
    if (manufacturerData.door_perimeter_lf !== undefined) {
      mfrContext.door_perimeter_lf = manufacturerData.door_perimeter_lf;
      mfrContext.door_count = manufacturerData.door_count || 0;
      // Scale other door measurements proportionally
      const doorRatio = baseContext.door_count > 0
        ? (manufacturerData.door_count || 0) / baseContext.door_count
        : 0;
      mfrContext.door_area_sqft = baseContext.door_area_sqft * doorRatio;
      mfrContext.door_head_lf = baseContext.door_head_lf * doorRatio;
      mfrContext.door_jamb_lf = baseContext.door_jamb_lf * doorRatio;
    }

    // Garage measurements
    if (manufacturerData.garage_perimeter_lf !== undefined) {
      mfrContext.garage_perimeter_lf = manufacturerData.garage_perimeter_lf;
      mfrContext.garage_count = manufacturerData.garage_count || 0;
      // Scale other garage measurements proportionally
      const garageRatio = baseContext.garage_count > 0
        ? (manufacturerData.garage_count || 0) / baseContext.garage_count
        : 0;
      mfrContext.garage_area_sqft = baseContext.garage_area_sqft * garageRatio;
    }

    // Openings area
    if (manufacturerData.openings_area_sqft !== undefined) {
      mfrContext.openings_area_sqft = manufacturerData.openings_area_sqft;
      mfrContext.total_openings_area_sqft = manufacturerData.openings_area_sqft;
    }

    // Recompute total openings perimeter from spatial containment data
    if (manufacturerData.total_openings_perimeter_lf !== undefined) {
      mfrContext.total_opening_perimeter_lf = manufacturerData.total_openings_perimeter_lf;
      mfrContext.openings_perimeter_lf = manufacturerData.total_openings_perimeter_lf;
    } else {
      // Compute from individual components
      const totalPerim =
        (manufacturerData.window_perimeter_lf || 0) +
        (manufacturerData.door_perimeter_lf || 0) +
        (manufacturerData.garage_perimeter_lf || 0);
      mfrContext.total_opening_perimeter_lf = totalPerim;
      mfrContext.openings_perimeter_lf = totalPerim;
    }

    // Recompute total openings count
    const totalCount =
      (manufacturerData.window_count || 0) +
      (manufacturerData.door_count || 0) +
      (manufacturerData.garage_count || 0);
    mfrContext.total_openings_count = totalCount;
    mfrContext.openings_count = totalCount;

    console.log(`[AutoScope V8.0] ${manufacturerData.manufacturer} context using spatial containment:`);
    console.log(`[AutoScope V8.0]   openings_perimeter_lf = ${mfrContext.openings_perimeter_lf.toFixed(1)}`);
    console.log(`[AutoScope V8.0]   openings_count = ${mfrContext.openings_count}`);
  }

  // =========================================================================
  // V8.1: SPATIAL CONTAINMENT - Use per-material perimeter, corners, trim, belly band
  // =========================================================================

  const hasV81Data = manufacturerData.facade_perimeter_lf !== undefined ||
                     manufacturerData.outside_corner_lf !== undefined ||
                     manufacturerData.trim_total_lf !== undefined ||
                     manufacturerData.belly_band_lf !== undefined;

  if (hasV81Data) {
    // V8.1: Perimeter (for starter strips, Z-flashing)
    if (manufacturerData.facade_perimeter_lf !== undefined) {
      mfrContext.facade_perimeter_lf = manufacturerData.facade_perimeter_lf;
      // Also update level_starter_lf to match facade perimeter
      mfrContext.level_starter_lf = manufacturerData.facade_perimeter_lf;
    }

    // V8.1: Corners
    if (manufacturerData.outside_corner_count !== undefined) {
      mfrContext.outside_corner_count = manufacturerData.outside_corner_count;
      mfrContext.outside_corners_count = manufacturerData.outside_corner_count; // alias
    }
    if (manufacturerData.outside_corner_lf !== undefined) {
      mfrContext.outside_corner_lf = manufacturerData.outside_corner_lf;
    }
    if (manufacturerData.inside_corner_count !== undefined) {
      mfrContext.inside_corner_count = manufacturerData.inside_corner_count;
      mfrContext.inside_corners_count = manufacturerData.inside_corner_count; // alias
    }
    if (manufacturerData.inside_corner_lf !== undefined) {
      mfrContext.inside_corner_lf = manufacturerData.inside_corner_lf;
    }
    // Compute total corner LF
    if (manufacturerData.total_corner_lf !== undefined) {
      mfrContext.total_corner_lf = manufacturerData.total_corner_lf;
    } else if (manufacturerData.outside_corner_lf !== undefined || manufacturerData.inside_corner_lf !== undefined) {
      mfrContext.total_corner_lf = (manufacturerData.outside_corner_lf || 0) + (manufacturerData.inside_corner_lf || 0);
    }

    // V8.1: Trim
    if (manufacturerData.trim_head_lf !== undefined) {
      mfrContext.trim_head_lf = manufacturerData.trim_head_lf;
    }
    if (manufacturerData.trim_jamb_lf !== undefined) {
      mfrContext.trim_jamb_lf = manufacturerData.trim_jamb_lf;
    }
    if (manufacturerData.trim_sill_lf !== undefined) {
      mfrContext.trim_sill_lf = manufacturerData.trim_sill_lf;
    }
    if (manufacturerData.trim_total_lf !== undefined) {
      mfrContext.trim_total_lf = manufacturerData.trim_total_lf;
    } else if (manufacturerData.trim_head_lf !== undefined || manufacturerData.trim_jamb_lf !== undefined || manufacturerData.trim_sill_lf !== undefined) {
      mfrContext.trim_total_lf = (manufacturerData.trim_head_lf || 0) + (manufacturerData.trim_jamb_lf || 0) + (manufacturerData.trim_sill_lf || 0);
    }

    // V8.1: Belly band
    if (manufacturerData.belly_band_lf !== undefined) {
      mfrContext.belly_band_lf = manufacturerData.belly_band_lf;
    }

    console.log(`[AutoScope V8.1] ${manufacturerData.manufacturer} context using spatial containment V8.1:`);
    if (manufacturerData.facade_perimeter_lf !== undefined) {
      console.log(`[AutoScope V8.1]   facade_perimeter_lf = ${mfrContext.facade_perimeter_lf.toFixed(1)}`);
    }
    if (mfrContext.total_corner_lf !== undefined) {
      console.log(`[AutoScope V8.1]   total_corner_lf = ${mfrContext.total_corner_lf.toFixed(1)} (${mfrContext.outside_corner_count || 0} outside + ${mfrContext.inside_corner_count || 0} inside)`);
    }
    if (mfrContext.trim_total_lf !== undefined) {
      console.log(`[AutoScope V8.1]   trim_total_lf = ${mfrContext.trim_total_lf.toFixed(1)}`);
    }
    if (mfrContext.belly_band_lf !== undefined) {
      console.log(`[AutoScope V8.1]   belly_band_lf = ${mfrContext.belly_band_lf.toFixed(1)}`);
    }
  }

  return mfrContext;
}

// ============================================================================
// BUILD ASSIGNED MATERIALS FROM PRICING (for material-based triggers)
// ============================================================================

/**
 * Build AssignedMaterial array from material assignments and pricing data
 * This enables material_category and sku_pattern trigger conditions
 *
 * @param materialAssignments - Material assignments from Detection Editor
 * @param pricingMap - Map of pricing item ID to PricingItem (from getPricingByIds)
 * @returns Array of AssignedMaterial for trigger condition evaluation
 */
export function buildAssignedMaterialsFromPricing(
  materialAssignments: MaterialAssignmentForGrouping[],
  pricingMap: Map<string, { sku: string; category?: string; manufacturer?: string }>
): AssignedMaterial[] {
  const materials: AssignedMaterial[] = [];
  const seenSkus = new Set<string>();

  for (const assignment of materialAssignments) {
    const itemId = assignment.pricing_item_id || assignment.assigned_material_id;
    if (!itemId) continue;

    const pricing = pricingMap.get(itemId);
    if (!pricing || !pricing.sku) continue;

    // Deduplicate by SKU - we only need one entry per SKU for trigger matching
    if (seenSkus.has(pricing.sku)) continue;
    seenSkus.add(pricing.sku);

    materials.push({
      sku: pricing.sku,
      category: pricing.category || 'unknown',
      manufacturer: pricing.manufacturer || 'Unknown',
      pricing_item_id: itemId,
    });
  }

  if (materials.length > 0) {
    console.log(`[AutoScope] Built ${materials.length} unique assigned materials for trigger evaluation:`);
    for (const m of materials) {
      console.log(`  - ${m.sku} (${m.category}) [${m.manufacturer}]`);
    }
  }

  return materials;
}

// ============================================================================
// EVALUATE TRIGGER CONDITIONS (FIXED for actual DB format)
// ============================================================================

/**
 * Check if a rule should be applied based on its trigger condition
 * Database format:
 * - { "always": true } → always trigger
 * - { "min_corners": 1 } → trigger if corners >= 1
 * - { "min_openings": 1 } → trigger if openings >= 1
 * - { "min_net_area": 500 } → trigger if net_siding_area >= 500
 * - { "material_category": "board_batten" } → only if assigned material has this category
 * - { "sku_pattern": "16OC-CP" } → only if assigned material SKU contains this pattern
 *
 * Multiple conditions use AND logic - all must match for rule to apply.
 */
export function shouldApplyRule(
  rule: DbAutoScopeRule,
  context: MeasurementContext,
  assignedMaterials?: AssignedMaterial[]
): { applies: boolean; reason: string } {
  const tc = rule.trigger_condition;
  const materials = assignedMaterials || [];

  // No trigger condition = always apply
  if (!tc) {
    return { applies: true, reason: 'no condition' };
  }

  // { "always": true }
  if (tc.always === true) {
    return { applies: true, reason: 'always=true' };
  }

  // Track matched conditions for reason string
  const matchedConditions: string[] = [];

  // =========================================================================
  // MATERIAL-BASED TRIGGERS (NEW) - Check first, fail fast if no match
  // =========================================================================

  // { "material_category": "board_batten" } - check if any assigned material has this category
  if (tc.material_category !== undefined) {
    const requiredCategory = tc.material_category.toLowerCase();
    const hasMatchingCategory = materials.some(
      m => m.category?.toLowerCase() === requiredCategory
    );

    if (!hasMatchingCategory) {
      return {
        applies: false,
        reason: `no material with category '${tc.material_category}'`
      };
    }
    matchedConditions.push(`category=${tc.material_category}`);
  }

  // { "sku_pattern": "16OC-CP" } - check if any assigned material SKU contains this pattern
  if (tc.sku_pattern !== undefined) {
    const pattern = tc.sku_pattern.toLowerCase();
    const hasMatchingSku = materials.some(
      m => m.sku?.toLowerCase().includes(pattern)
    );

    if (!hasMatchingSku) {
      return {
        applies: false,
        reason: `no material SKU matching pattern '${tc.sku_pattern}'`
      };
    }
    matchedConditions.push(`sku~${tc.sku_pattern}`);
  }

  // =========================================================================
  // MEASUREMENT-BASED TRIGGERS (existing logic)
  // =========================================================================

  // { "min_corners": N } - check total corners
  if (tc.min_corners !== undefined) {
    const totalCorners = context.outside_corners_count + context.inside_corners_count;
    if (totalCorners < tc.min_corners) {
      return { applies: false, reason: `corners=${totalCorners} < ${tc.min_corners}` };
    }
    matchedConditions.push(`corners>=${tc.min_corners}`);
  }

  // { "min_openings": N } - check total openings
  if (tc.min_openings !== undefined) {
    if (context.openings_count < tc.min_openings) {
      return { applies: false, reason: `openings=${context.openings_count} < ${tc.min_openings}` };
    }
    matchedConditions.push(`openings>=${tc.min_openings}`);
  }

  // { "min_net_area": N } - check net siding area
  if (tc.min_net_area !== undefined) {
    if (context.net_siding_area_sqft < tc.min_net_area) {
      return { applies: false, reason: `net_area=${context.net_siding_area_sqft} < ${tc.min_net_area}` };
    }
    matchedConditions.push(`net_area>=${tc.min_net_area}`);
  }

  // { "min_facade_area": N } - check facade area
  if (tc.min_facade_area !== undefined) {
    if (context.facade_area_sqft < tc.min_facade_area) {
      return { applies: false, reason: `facade_area=${context.facade_area_sqft} < ${tc.min_facade_area}` };
    }
    matchedConditions.push(`facade_area>=${tc.min_facade_area}`);
  }

  // { "min_belly_band_lf": N } - check belly band linear feet
  if (tc.min_belly_band_lf !== undefined) {
    if (context.belly_band_lf < tc.min_belly_band_lf) {
      return { applies: false, reason: `belly_band_lf=${context.belly_band_lf} < ${tc.min_belly_band_lf}` };
    }
    matchedConditions.push(`belly_band>=${tc.min_belly_band_lf}`);
  }

  // =========================================================================
  // TRIM TRIGGERS - Check trim linear feet conditions
  // =========================================================================

  // { "min_trim_total_lf": N } - check total trim linear feet (>= comparison)
  if (tc.min_trim_total_lf !== undefined) {
    if (context.trim_total_lf < tc.min_trim_total_lf) {
      return { applies: false, reason: `trim_total_lf=${context.trim_total_lf} < ${tc.min_trim_total_lf}` };
    }
    matchedConditions.push(`trim_total>=${tc.min_trim_total_lf}`);
  }

  // { "trim_total_lf_gt": N } - check total trim linear feet (> comparison, alternative syntax)
  if (tc.trim_total_lf_gt !== undefined) {
    if (context.trim_total_lf <= tc.trim_total_lf_gt) {
      return { applies: false, reason: `trim_total_lf=${context.trim_total_lf} <= ${tc.trim_total_lf_gt}` };
    }
    matchedConditions.push(`trim_total>${tc.trim_total_lf_gt}`);
  }

  // { "min_trim_head_lf": N } - check head trim linear feet
  if (tc.min_trim_head_lf !== undefined) {
    if (context.trim_head_lf < tc.min_trim_head_lf) {
      return { applies: false, reason: `trim_head_lf=${context.trim_head_lf} < ${tc.min_trim_head_lf}` };
    }
    matchedConditions.push(`trim_head>=${tc.min_trim_head_lf}`);
  }

  // { "trim_head_lf_gt": N } - check head trim linear feet (> comparison)
  if (tc.trim_head_lf_gt !== undefined) {
    if (context.trim_head_lf <= tc.trim_head_lf_gt) {
      return { applies: false, reason: `trim_head_lf=${context.trim_head_lf} <= ${tc.trim_head_lf_gt}` };
    }
    matchedConditions.push(`trim_head>${tc.trim_head_lf_gt}`);
  }

  // { "min_trim_jamb_lf": N } - check jamb trim linear feet
  if (tc.min_trim_jamb_lf !== undefined) {
    if (context.trim_jamb_lf < tc.min_trim_jamb_lf) {
      return { applies: false, reason: `trim_jamb_lf=${context.trim_jamb_lf} < ${tc.min_trim_jamb_lf}` };
    }
    matchedConditions.push(`trim_jamb>=${tc.min_trim_jamb_lf}`);
  }

  // { "trim_jamb_lf_gt": N } - check jamb trim linear feet (> comparison)
  if (tc.trim_jamb_lf_gt !== undefined) {
    if (context.trim_jamb_lf <= tc.trim_jamb_lf_gt) {
      return { applies: false, reason: `trim_jamb_lf=${context.trim_jamb_lf} <= ${tc.trim_jamb_lf_gt}` };
    }
    matchedConditions.push(`trim_jamb>${tc.trim_jamb_lf_gt}`);
  }

  // { "min_trim_sill_lf": N } - check sill trim linear feet
  if (tc.min_trim_sill_lf !== undefined) {
    if (context.trim_sill_lf < tc.min_trim_sill_lf) {
      return { applies: false, reason: `trim_sill_lf=${context.trim_sill_lf} < ${tc.min_trim_sill_lf}` };
    }
    matchedConditions.push(`trim_sill>=${tc.min_trim_sill_lf}`);
  }

  // { "trim_sill_lf_gt": N } - check sill trim linear feet (> comparison)
  if (tc.trim_sill_lf_gt !== undefined) {
    if (context.trim_sill_lf <= tc.trim_sill_lf_gt) {
      return { applies: false, reason: `trim_sill_lf=${context.trim_sill_lf} <= ${tc.trim_sill_lf_gt}` };
    }
    matchedConditions.push(`trim_sill>${tc.trim_sill_lf_gt}`);
  }

  // =========================================================================
  // All conditions passed - return with reason string
  // =========================================================================

  if (matchedConditions.length > 0) {
    return { applies: true, reason: matchedConditions.join(', ') };
  }

  // Unknown trigger condition format - log and apply by default
  console.warn(`⚠️ Unknown trigger condition format for rule ${rule.rule_id}:`, tc);
  return { applies: true, reason: 'unknown format - defaulting to apply' };
}

// ============================================================================
// EVALUATE FORMULA
// ============================================================================

export function evaluateFormula(
  formula: string,
  context: MeasurementContext
): { result: number; error?: string } {
  try {
    // Create a function that has access to all context variables
    const contextKeys = Object.keys(context);
    const contextValues = Object.values(context);

    // Safe formula evaluation using Function constructor
    const fn = new Function(...contextKeys, `return ${formula};`);
    const result = fn(...contextValues);

    // Ensure we return a valid number
    const numResult = Number(result);
    if (isNaN(numResult) || !isFinite(numResult)) {
      return { result: 0, error: `Invalid result: ${result}` };
    }

    return { result: Math.max(0, numResult) }; // Never return negative quantities
  } catch (err) {
    return { result: 0, error: String(err) };
  }
}

// ============================================================================
// MAIN: GENERATE AUTO-SCOPE ITEMS V2
// ============================================================================

/**
 * Generate auto-scope line items with manufacturer-aware rule application
 *
 * Rules with manufacturer_filter = null (generic rules):
 *   → Use total project measurements (e.g., WRB for entire facade)
 *
 * Rules with manufacturer_filter = ['James Hardie']:
 *   → Only apply to James Hardie products, using Hardie's SF only
 *
 * Rules with manufacturer_filter = ['Engage Building Products']:
 *   → Only apply to FastPlank products, using FastPlank's SF only
 */
export async function generateAutoScopeItemsV2(
  extractionId?: string,
  webhookMeasurements?: Record<string, any>,
  organizationId?: string,
  options?: AutoScopeV2Options
): Promise<AutoScopeV2Result> {
  const result: AutoScopeV2Result = {
    line_items: [],
    rules_evaluated: 0,
    rules_triggered: 0,
    rules_skipped: [],
    measurement_source: 'fallback',
  };

  const manufacturerGroups = options?.manufacturerGroups || {};
  const manufacturerNames = Object.keys(manufacturerGroups);
  const assignedMaterials = options?.assignedMaterials || [];

  // 1. Build measurement context (total project measurements)
  let dbMeasurements: CadHoverMeasurements | null = null;

  if (extractionId) {
    dbMeasurements = await fetchMeasurementsFromDatabase(extractionId);
    if (dbMeasurements) {
      result.measurement_source = 'database';
    }
  }

  if (!dbMeasurements && webhookMeasurements) {
    result.measurement_source = 'webhook';
  }

  const totalContext = buildMeasurementContext(dbMeasurements, webhookMeasurements);

  // 2. Fetch auto-scope rules
  const rules = await fetchAutoScopeRules();
  result.rules_evaluated = rules.length;

  console.log(`📋 Evaluating ${rules.length} auto-scope rules...`);
  console.log(`   Total project area: ${totalContext.facade_area_sqft.toFixed(2)} SF`);
  if (manufacturerNames.length > 0) {
    console.log(`   Manufacturer groups: ${manufacturerNames.join(', ')}`);
  } else {
    console.log(`   No manufacturer groups - only generic rules will apply`);
  }
  if (assignedMaterials.length > 0) {
    console.log(`   Assigned materials: ${assignedMaterials.map(m => m.sku).join(', ')}`);
  }

  // V8.0: Log spatial containment status
  if (options?.spatialContainment?.enabled) {
    console.log(`[AutoScope V8.0] Spatial containment ENABLED`);
    console.log(`[AutoScope V8.0] Matched ${options.spatialContainment.matched_openings}/${options.spatialContainment.total_openings} openings`);
    if (options.spatialContainment.unmatched_openings && options.spatialContainment.unmatched_openings > 0) {
      console.warn(`[AutoScope V8.0] ⚠️ ${options.spatialContainment.unmatched_openings} unmatched openings (will use project-wide measurements)`);
    }
  }

  // 3. Evaluate each rule
  // Store triggered rules with their context info for line item generation
  const triggeredRules: Array<{
    rule: DbAutoScopeRule;
    quantity: number;
    manufacturer?: string;  // Which manufacturer this applies to (undefined = generic)
  }> = [];

  // Siding-related material categories to skip when user has siding assignments
  const SIDING_MATERIAL_CATEGORIES = ['siding', 'siding_panels', 'lap_siding', 'shingle_siding', 'panel_siding', 'vertical_siding'];

  for (const rule of rules) {
    // Skip siding panel rules if material_assignments already cover siding
    const isSidingCategory = SIDING_MATERIAL_CATEGORIES.includes(rule.material_category?.toLowerCase() || '');
    if (options?.skipSidingPanels && isSidingCategory) {
      console.log(`  ⏭️ Rule ${rule.rule_id}: ${rule.rule_name} → SKIPPED (user has siding assignments)`);
      result.rules_skipped.push(`${rule.material_sku}: skipped - user has siding assignments`);
      continue;
    }

    // =========================================================================
    // MANUFACTURER-AWARE RULE APPLICATION
    // =========================================================================

    const hasManufacturerFilter = rule.manufacturer_filter && rule.manufacturer_filter.length > 0;

    if (!hasManufacturerFilter) {
      // =====================================================================
      // GENERIC RULE: Apply to total project measurements
      // =====================================================================
      const { applies, reason } = shouldApplyRule(rule, totalContext, assignedMaterials);

      if (applies) {
        const { result: quantity, error } = evaluateFormula(rule.quantity_formula, totalContext);

        if (error) {
          console.warn(`⚠️ Rule ${rule.rule_id} (${rule.rule_name}): Formula error - ${error}`);
          result.rules_skipped.push(`${rule.material_sku}: formula error - ${error}`);
          continue;
        }

        if (quantity > 0) {
          triggeredRules.push({ rule, quantity, manufacturer: undefined });
          result.rules_triggered++;
          console.log(`  ✓ Rule ${rule.rule_id}: ${rule.rule_name} [GENERIC: ${totalContext.facade_area_sqft.toFixed(0)} SF] → ${Math.ceil(quantity)} ${rule.unit} (${reason})`);
        } else {
          result.rules_skipped.push(`${rule.material_sku}: quantity=0`);
          console.log(`  ○ Rule ${rule.rule_id}: ${rule.rule_name} → 0 (formula returned 0)`);
        }
      } else {
        result.rules_skipped.push(`${rule.material_sku}: ${reason}`);
        console.log(`  ✗ Rule ${rule.rule_id}: ${rule.rule_name} → skipped (${reason})`);
      }
    } else {
      // =====================================================================
      // MANUFACTURER-SPECIFIC RULE: Apply only to matching manufacturers
      // =====================================================================

      // Find matching manufacturer groups
      const matchingManufacturers = rule.manufacturer_filter!.filter(
        mfr => manufacturerGroups[mfr] !== undefined
      );

      if (matchingManufacturers.length === 0) {
        // No matching manufacturers in the project
        result.rules_skipped.push(`${rule.material_sku}: no matching manufacturer groups`);
        console.log(`  ✗ Rule ${rule.rule_id}: ${rule.rule_name} → skipped (no matching manufacturers: ${rule.manufacturer_filter!.join(', ')})`);
        continue;
      }

      // Apply rule to each matching manufacturer's measurements
      for (const mfrName of matchingManufacturers) {
        const mfrData = manufacturerGroups[mfrName];

        // Skip if manufacturer has no area (nothing to calculate)
        if (mfrData.area_sqft <= 0 && mfrData.linear_ft <= 0) {
          console.log(`  ○ Rule ${rule.rule_id}: ${rule.rule_name} [${mfrName}] → skipped (no area/linear)`);
          continue;
        }

        // Build manufacturer-specific context
        const mfrContext = buildManufacturerContext(totalContext, mfrData);

        const { applies, reason } = shouldApplyRule(rule, mfrContext, assignedMaterials);

        if (applies) {
          const { result: quantity, error } = evaluateFormula(rule.quantity_formula, mfrContext);

          if (error) {
            console.warn(`⚠️ Rule ${rule.rule_id} (${rule.rule_name}) [${mfrName}]: Formula error - ${error}`);
            result.rules_skipped.push(`${rule.material_sku} [${mfrName}]: formula error - ${error}`);
            continue;
          }

          if (quantity > 0) {
            triggeredRules.push({ rule, quantity, manufacturer: mfrName });
            result.rules_triggered++;
            console.log(`  ✓ Rule ${rule.rule_id}: ${rule.rule_name} [${mfrName}: ${mfrData.area_sqft.toFixed(0)} SF] → ${Math.ceil(quantity)} ${rule.unit} (${reason})`);
          } else {
            result.rules_skipped.push(`${rule.material_sku} [${mfrName}]: quantity=0`);
            console.log(`  ○ Rule ${rule.rule_id}: ${rule.rule_name} [${mfrName}] → 0 (formula returned 0)`);
          }
        } else {
          result.rules_skipped.push(`${rule.material_sku} [${mfrName}]: ${reason}`);
          console.log(`  ✗ Rule ${rule.rule_id}: ${rule.rule_name} [${mfrName}] → skipped (${reason})`);
        }
      }
    }
  }

  // 4. Fetch pricing for triggered SKUs
  const skus = [...new Set(triggeredRules.map(tr => tr.rule.material_sku))];
  const pricingMap = await getPricingBySkus(skus, organizationId);

  // 5. Build line items with pricing
  for (const { rule, quantity, manufacturer } of triggeredRules) {
    const pricing = pricingMap.get(rule.material_sku);

    const materialUnitCost = Number(pricing?.material_cost || 0);
    const laborUnitCost = Number(pricing?.base_labor_cost || 0);
    const totalLaborRate = pricing?.total_labor_cost || calculateTotalLabor(laborUnitCost);
    const finalQuantity = Math.ceil(quantity);

    // For manufacturer-specific rules, include manufacturer in description
    const description = manufacturer
      ? `${rule.rule_name} (${manufacturer})`
      : rule.rule_name;

    const lineItem: AutoScopeLineItem = {
      description,
      sku: rule.material_sku,
      quantity: finalQuantity,
      unit: rule.output_unit || rule.unit,
      category: rule.material_category,
      presentation_group: rule.presentation_group,

      material_unit_cost: materialUnitCost,
      material_extended: Math.round(finalQuantity * materialUnitCost * 100) / 100,
      labor_unit_cost: laborUnitCost,
      labor_extended: Math.round(finalQuantity * totalLaborRate * 100) / 100,

      calculation_source: 'auto-scope',
      rule_id: String(rule.rule_id),
      formula_used: rule.quantity_formula,
      notes: manufacturer
        ? `${rule.description || ''} [Applied to ${manufacturer} products]`.trim()
        : rule.description || undefined,
    };

    result.line_items.push(lineItem);
  }

  console.log(`✅ Auto-scope V2 complete: ${result.rules_triggered}/${result.rules_evaluated} rules triggered, ${result.line_items.length} line items`);

  return result;
}

// ============================================================================
// FALLBACK RULES (when database unavailable)
// ============================================================================

function getFallbackRules(): DbAutoScopeRule[] {
  const now = new Date().toISOString();
  return [
    {
      rule_id: 1,
      rule_name: 'Tyvek House Wrap (Fallback)',
      description: 'Fallback rule - 1350 SF coverage per roll',
      material_category: 'water_barrier',
      material_sku: 'TYVEK-HW-9X150',
      quantity_formula: 'Math.ceil(facade_area_sqft / 1350)',
      unit: 'ROLL',
      output_unit: 'ROLL',
      size_description: null,
      trigger_condition: { always: true },
      presentation_group: 'siding',
      group_order: 1,
      item_order: 1,
      priority: 1,
      active: true,
      created_at: now,
      updated_at: now,
      manufacturer_filter: null, // Generic rule - applies to all
    },
    {
      rule_id: 2,
      rule_name: 'Siding Nails (Fallback)',
      description: 'Fallback rule - 1 box per 100 SF',
      material_category: 'fasteners',
      material_sku: 'MAZE-SIDING-2.5',
      quantity_formula: 'Math.ceil((facade_area_sqft - openings_area_sqft) / 100)',
      unit: 'BOX',
      output_unit: 'BOX',
      size_description: null,
      trigger_condition: { always: true },
      presentation_group: 'fasteners',
      group_order: 5,
      item_order: 1,
      priority: 1,
      active: true,
      created_at: now,
      updated_at: now,
      manufacturer_filter: null, // Generic rule - applies to all
    },
    {
      rule_id: 3,
      rule_name: 'Caulk (Fallback)',
      description: 'Fallback rule - 1 tube per 25 LF',
      material_category: 'accessories',
      material_sku: 'OSI-QUAD-10OZ',
      quantity_formula: 'Math.ceil(openings_perimeter_lf / 25)',
      unit: 'TUBE',
      output_unit: 'TUBE',
      size_description: null,
      trigger_condition: { min_openings: 1 },
      presentation_group: 'fasteners',
      group_order: 5,
      item_order: 2,
      priority: 1,
      active: true,
      created_at: now,
      updated_at: now,
      manufacturer_filter: null, // Generic rule - applies to all
    },
  ];
}
