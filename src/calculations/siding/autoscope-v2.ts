/**
 * Auto-Scope V2 - Database-Driven Rules Engine
 * Fetches rules from siding_auto_scope_rules table and generates line items
 */

import { getSupabaseClient, isDatabaseConfigured } from '../../services/database';
import { getPricingBySkus, calculateTotalLabor } from '../../services/pricing';
import {
  AutoScopeRule,
  MeasurementContext,
  AutoScopeLineItem,
  AutoScopeV2Result,
  TriggerCondition,
  CadHoverMeasurements
} from '../../types/autoscope';

// ============================================================================
// FETCH RULES FROM DATABASE
// ============================================================================

let rulesCache: AutoScopeRule[] | null = null;
let rulesCacheTimestamp: number = 0;
const RULES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function fetchAutoScopeRules(): Promise<AutoScopeRule[]> {
  // Check cache
  if (rulesCache && (Date.now() - rulesCacheTimestamp) < RULES_CACHE_TTL_MS) {
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
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('❌ Error fetching auto-scope rules:', error.message);
      return getFallbackRules();
    }

    rulesCache = data as AutoScopeRule[];
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
  // Cast to any for flexible property access from both sources
  const db: any = dbMeasurements || {};
  const wh: any = webhookMeasurements || {};

  // Helper to safely get numeric value
  const num = (val: any, fallback: number = 0): number => {
    const n = Number(val);
    return isNaN(n) ? fallback : n;
  };

  // ==========================================================================
  // ACTUAL DATABASE COLUMN NAMES (from cad_hover_measurements table):
  // - facade_total_sqft
  // - net_siding_sqft
  // - openings_area_sqft (pre-computed total)
  // - openings_count (pre-computed total)
  // - openings_total_perimeter_lf (pre-computed total)
  // - corners_outside_count
  // - corners_inside_count
  // - level_starter_lf
  // - avg_wall_height_ft
  // ==========================================================================

  // Primary areas - map actual DB column names
  const facade_sqft = num(db.facade_total_sqft) || num(db.facade_sqft) ||
                      num(wh.facade_sqft) || num(wh.gross_wall_area_sqft) || 0;

  const net_siding_area_sqft = num(db.net_siding_sqft) || num(db.net_siding_area_sqft) ||
                               num(wh.net_siding_area_sqft) || num(wh.net_wall_area_sqft) || 0;

  // Openings - DB has pre-computed totals, webhook has nested objects
  const openings_area_sqft = num(db.openings_area_sqft) ||
    (num(wh.windows?.total_area_sqft) + num(wh.doors?.total_area_sqft) + num(wh.garages?.total_area_sqft));

  const openings_count = num(db.openings_count) ||
    (num(wh.windows?.count) + num(wh.doors?.count) + num(wh.garages?.count));

  const openings_perimeter_lf = num(db.openings_total_perimeter_lf) ||
    (num(wh.windows?.perimeter_lf) + num(wh.doors?.perimeter_lf) + num(wh.garages?.perimeter_lf));

  // Corners - map actual DB column names (corners_outside_count, not outside_corner_count)
  const outside_corner_count = num(db.corners_outside_count) || num(db.outside_corner_count) ||
                               num(wh.outside_corners?.count) || 0;

  const inside_corner_count = num(db.corners_inside_count) || num(db.inside_corner_count) ||
                              num(wh.inside_corners?.count) || 0;

  // Other measurements
  const level_starter_lf = num(db.level_starter_lf) || num(wh.level_starter_lf) || 0;
  const avg_wall_height_ft = num(db.avg_wall_height_ft) || num(wh.avg_wall_height_ft) || 10;

  // Individual opening breakdowns (from webhook nested objects)
  const window_count = num(db.window_count) || num(wh.windows?.count) || 0;
  const window_area_sqft = num(db.window_total_area_sqft) || num(wh.windows?.total_area_sqft) || 0;
  const window_perimeter_lf = num(db.window_perimeter_lf) || num(wh.windows?.perimeter_lf) || 0;
  const window_head_lf = num(db.window_head_lf) || num(wh.windows?.head_lf) || 0;
  const window_sill_lf = num(db.window_sill_lf) || num(wh.windows?.sill_lf) || 0;
  const window_jamb_lf = num(db.window_jamb_lf) || num(wh.windows?.jamb_lf) || 0;

  const door_count = num(db.door_count) || num(wh.doors?.count) || 0;
  const door_area_sqft = num(db.door_total_area_sqft) || num(wh.doors?.total_area_sqft) || 0;
  const door_perimeter_lf = num(db.door_perimeter_lf) || num(wh.doors?.perimeter_lf) || 0;
  const door_head_lf = num(db.door_head_lf) || num(wh.doors?.head_lf) || 0;
  const door_jamb_lf = num(db.door_jamb_lf) || num(wh.doors?.jamb_lf) || 0;

  const garage_count = num(db.garage_count) || num(wh.garages?.count) || 0;
  const garage_area_sqft = num(db.garage_total_area_sqft) || num(wh.garages?.total_area_sqft) || 0;
  const garage_perimeter_lf = num(db.garage_perimeter_lf) || num(wh.garages?.perimeter_lf) || 0;

  // Corner LF (not always available)
  const outside_corner_lf = num(db.outside_corner_lf) || num(wh.outside_corners?.total_lf) || 0;
  const inside_corner_lf = num(db.inside_corner_lf) || num(wh.inside_corners?.total_lf) || 0;

  // Gables
  const gable_count = num(db.gable_count) || num(wh.gables?.count) || 0;
  const gable_area_sqft = num(db.gable_area_sqft) || num(wh.gables?.area_sqft) || 0;
  const gable_rake_lf = num(db.gable_rake_lf) || num(wh.gables?.rake_lf) || 0;

  // Compute facade perimeter (area / height)
  const facade_perimeter_lf = avg_wall_height_ft > 0 ? facade_sqft / avg_wall_height_ft : 0;

  const ctx: MeasurementContext = {
    // Primary areas
    facade_sqft,
    gross_wall_area_sqft: facade_sqft,
    net_siding_area_sqft,

    // Windows
    window_count,
    window_area_sqft,
    window_perimeter_lf,
    window_head_lf,
    window_sill_lf,
    window_jamb_lf,

    // Doors
    door_count,
    door_area_sqft,
    door_perimeter_lf,
    door_head_lf,
    door_jamb_lf,

    // Garages
    garage_count,
    garage_area_sqft,
    garage_perimeter_lf,

    // Corners
    outside_corner_count,
    outside_corner_lf,
    inside_corner_count,
    inside_corner_lf,

    // Gables
    gable_count,
    gable_area_sqft,
    gable_rake_lf,

    // Other
    level_starter_lf,
    avg_wall_height_ft,

    // Computed helpers
    total_opening_perimeter_lf: openings_perimeter_lf,
    total_corner_lf: outside_corner_lf + inside_corner_lf,
    total_openings_area_sqft: openings_area_sqft,
    total_openings_count: openings_count,

    // =======================================================================
    // ALIASES for database formula compatibility
    // These match the variable names used in siding_auto_scope_rules formulas
    // =======================================================================
    facade_area_sqft: facade_sqft,
    openings_area_sqft: openings_area_sqft,
    outside_corners_count: outside_corner_count,
    inside_corners_count: inside_corner_count,
    openings_perimeter_lf: openings_perimeter_lf,
    openings_count: openings_count,
    facade_perimeter_lf: facade_perimeter_lf,
    facade_height_ft: avg_wall_height_ft,
  };

  // Debug logging
  console.log(`📊 MeasurementContext built:`, {
    facade_area_sqft: ctx.facade_area_sqft,
    net_siding_area_sqft: ctx.net_siding_area_sqft,
    openings_area_sqft: ctx.openings_area_sqft,
    openings_count: ctx.openings_count,
    openings_perimeter_lf: ctx.openings_perimeter_lf,
    outside_corners_count: ctx.outside_corners_count,
    inside_corners_count: ctx.inside_corners_count,
    level_starter_lf: ctx.level_starter_lf,
    facade_height_ft: ctx.facade_height_ft,
    facade_perimeter_lf: ctx.facade_perimeter_lf,
  });

  return ctx;
}

// ============================================================================
// EVALUATE TRIGGER CONDITIONS
// ============================================================================

export function evaluateTriggerCondition(
  condition: TriggerCondition,
  context: MeasurementContext
): boolean {
  const fieldValue = (context as Record<string, any>)[condition.field];

  switch (condition.operator) {
    case 'gt':
      return Number(fieldValue) > Number(condition.value);
    case 'gte':
      return Number(fieldValue) >= Number(condition.value);
    case 'lt':
      return Number(fieldValue) < Number(condition.value);
    case 'lte':
      return Number(fieldValue) <= Number(condition.value);
    case 'eq':
      return fieldValue === condition.value;
    case 'neq':
      return fieldValue !== condition.value;
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== 0;
    case 'not_exists':
      return fieldValue === undefined || fieldValue === null || fieldValue === 0;
    default:
      return true;
  }
}

export function shouldApplyRule(
  rule: AutoScopeRule,
  context: MeasurementContext
): boolean {
  // If no trigger conditions, always apply
  if (!rule.trigger_conditions || rule.trigger_conditions.length === 0) {
    return true;
  }

  // All conditions must be true (AND logic)
  return rule.trigger_conditions.every(condition =>
    evaluateTriggerCondition(condition, context)
  );
}

// ============================================================================
// EVALUATE FORMULA
// ============================================================================

export function evaluateFormula(
  formula: string,
  context: MeasurementContext
): number {
  try {
    // Create a function that has access to all context variables
    const contextKeys = Object.keys(context);
    const contextValues = Object.values(context);

    // Safe formula evaluation using Function constructor
    // This is safer than eval() as it creates a sandboxed scope
    const fn = new Function(...contextKeys, `return ${formula};`);
    const result = fn(...contextValues);

    // Ensure we return a valid number
    const numResult = Number(result);
    if (isNaN(numResult) || !isFinite(numResult)) {
      console.warn(`⚠️ Formula "${formula}" returned invalid result: ${result}`);
      return 0;
    }

    return Math.max(0, numResult); // Never return negative quantities
  } catch (err) {
    console.error(`❌ Error evaluating formula "${formula}":`, err);
    return 0;
  }
}

// ============================================================================
// MAIN: GENERATE AUTO-SCOPE ITEMS V2
// ============================================================================

export async function generateAutoScopeItemsV2(
  extractionId?: string,
  webhookMeasurements?: Record<string, any>,
  organizationId?: string
): Promise<AutoScopeV2Result> {
  const result: AutoScopeV2Result = {
    line_items: [],
    rules_evaluated: 0,
    rules_triggered: 0,
    rules_skipped: [],
    measurement_source: 'fallback',
  };

  // 1. Build measurement context
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

  const context = buildMeasurementContext(dbMeasurements, webhookMeasurements);

  // 2. Fetch auto-scope rules
  const rules = await fetchAutoScopeRules();
  result.rules_evaluated = rules.length;

  // 3. Evaluate each rule
  const triggeredRules: Array<{ rule: AutoScopeRule; quantity: number }> = [];

  for (const rule of rules) {
    if (shouldApplyRule(rule, context)) {
      const quantity = evaluateFormula(rule.quantity_formula, context);

      if (quantity > 0) {
        triggeredRules.push({ rule, quantity });
        result.rules_triggered++;
      } else {
        result.rules_skipped.push(`${rule.sku}: quantity=0`);
      }
    } else {
      result.rules_skipped.push(`${rule.sku}: trigger not met`);
    }
  }

  // 4. Fetch pricing for triggered SKUs
  const skus = triggeredRules.map(tr => tr.rule.sku);
  const pricingMap = await getPricingBySkus(skus, organizationId);

  // 5. Build line items with pricing
  for (const { rule, quantity } of triggeredRules) {
    const pricing = pricingMap.get(rule.sku);

    const materialUnitCost = Number(pricing?.material_cost || 0);
    const laborUnitCost = Number(pricing?.base_labor_cost || 0);
    const totalLaborRate = pricing?.total_labor_cost || calculateTotalLabor(laborUnitCost);

    const lineItem: AutoScopeLineItem = {
      description: rule.product_name,
      sku: rule.sku,
      quantity: Math.ceil(quantity), // Round up to whole units
      unit: rule.unit,
      category: rule.category,
      presentation_group: rule.presentation_group,

      material_unit_cost: materialUnitCost,
      material_extended: Math.round(Math.ceil(quantity) * materialUnitCost * 100) / 100,
      labor_unit_cost: laborUnitCost,
      labor_extended: Math.round(Math.ceil(quantity) * totalLaborRate * 100) / 100,

      calculation_source: 'auto-scope',
      rule_id: rule.id,
      formula_used: rule.quantity_formula,
      notes: rule.notes,
    };

    result.line_items.push(lineItem);
  }

  console.log(`✅ Auto-scope V2: ${result.rules_triggered}/${result.rules_evaluated} rules triggered, ${result.line_items.length} line items generated`);

  return result;
}

// ============================================================================
// FALLBACK RULES (when database unavailable)
// ============================================================================

function getFallbackRules(): AutoScopeRule[] {
  return [
    {
      id: 'fallback-housewrap',
      sku: 'TYVEK-HW-9X150',
      product_name: 'Tyvek HomeWrap 9\' x 150\'',
      category: 'water_barrier',
      presentation_group: 'House Wrap & Accessories',
      unit: 'ROLL',
      quantity_formula: 'Math.ceil(facade_sqft / 1350)',
      trigger_conditions: [{ field: 'facade_sqft', operator: 'gt', value: 0 }],
      display_order: 1,
      is_active: true,
      notes: 'Fallback rule - 1350 SF coverage per roll',
    },
    {
      id: 'fallback-staples',
      sku: 'ARROW-T50-3/8',
      product_name: 'Arrow T50 Staples 3/8"',
      category: 'fasteners',
      presentation_group: 'Fasteners',
      unit: 'BOX',
      quantity_formula: 'Math.ceil(facade_sqft / 500)',
      trigger_conditions: [{ field: 'facade_sqft', operator: 'gt', value: 0 }],
      display_order: 2,
      is_active: true,
      notes: 'Fallback rule - 1 box per 500 SF',
    },
    {
      id: 'fallback-caulk',
      sku: 'OSI-QUAD-10OZ',
      product_name: 'OSI Quad Caulk 10oz',
      category: 'accessories',
      presentation_group: 'Caulk & Sealants',
      unit: 'TUBE',
      quantity_formula: 'Math.ceil(total_opening_perimeter_lf / 25)',
      trigger_conditions: [{ field: 'total_opening_perimeter_lf', operator: 'gt', value: 0 }],
      display_order: 3,
      is_active: true,
      notes: 'Fallback rule - 1 tube per 25 LF',
    },
    {
      id: 'fallback-nails',
      sku: 'MAZE-SIDING-2.5',
      product_name: 'Maze Siding Nails 2.5"',
      category: 'fasteners',
      presentation_group: 'Fasteners',
      unit: 'BOX',
      quantity_formula: 'Math.ceil(net_siding_area_sqft / 100)',
      trigger_conditions: [{ field: 'net_siding_area_sqft', operator: 'gt', value: 0 }],
      display_order: 4,
      is_active: true,
      notes: 'Fallback rule - 1 lb box per 100 SF',
    },
    {
      id: 'fallback-flashing',
      sku: 'JH-HEAD-FLASH-10',
      product_name: 'HardiFlashing 10\'',
      category: 'flashing',
      presentation_group: 'Flashing',
      unit: 'PC',
      quantity_formula: 'Math.ceil((window_head_lf + door_head_lf) / 10)',
      trigger_conditions: [
        { field: 'window_count', operator: 'gt', value: 0 }
      ],
      display_order: 5,
      is_active: true,
      notes: 'Fallback rule - head flashing for windows and doors',
    },
    {
      id: 'fallback-primer',
      sku: 'SW-PRIMER-GAL',
      product_name: 'Sherwin-Williams Primer Gallon',
      category: 'accessories',
      presentation_group: 'Paint & Primer',
      unit: 'GAL',
      quantity_formula: 'Math.ceil(total_corner_lf / 100)',
      trigger_conditions: [{ field: 'total_corner_lf', operator: 'gt', value: 0 }],
      display_order: 6,
      is_active: true,
      notes: 'Fallback rule - touch-up primer for cut ends',
    },
  ];
}
