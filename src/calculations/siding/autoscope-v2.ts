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

  // Helper to get value from db first, then webhook
  const get = (dbKey: string, whKey?: string, fallback: number = 0): number => {
    return Number(db[dbKey] || wh[whKey || dbKey] || fallback);
  };

  const ctx: MeasurementContext = {
    // Primary areas
    facade_sqft: get('facade_sqft', 'facade_sqft') || get('gross_wall_area_sqft', 'gross_wall_area_sqft'),
    gross_wall_area_sqft: get('gross_wall_area_sqft', 'gross_wall_area_sqft') || get('facade_sqft', 'facade_sqft'),
    net_siding_area_sqft: get('net_siding_area_sqft', 'net_siding_area_sqft') || get('net_wall_area_sqft', 'net_wall_area_sqft'),

    // Windows (db uses flat fields, webhook uses nested objects)
    window_count: get('window_count') || Number(wh.windows?.count || 0),
    window_area_sqft: get('window_total_area_sqft') || Number(wh.windows?.total_area_sqft || 0),
    window_perimeter_lf: get('window_perimeter_lf') || Number(wh.windows?.perimeter_lf || 0),
    window_head_lf: get('window_head_lf') || Number(wh.windows?.head_lf || 0),
    window_sill_lf: get('window_sill_lf') || Number(wh.windows?.sill_lf || 0),
    window_jamb_lf: get('window_jamb_lf') || Number(wh.windows?.jamb_lf || 0),

    // Doors
    door_count: get('door_count') || Number(wh.doors?.count || 0),
    door_area_sqft: get('door_total_area_sqft') || Number(wh.doors?.total_area_sqft || 0),
    door_perimeter_lf: get('door_perimeter_lf') || Number(wh.doors?.perimeter_lf || 0),
    door_head_lf: get('door_head_lf') || Number(wh.doors?.head_lf || 0),
    door_jamb_lf: get('door_jamb_lf') || Number(wh.doors?.jamb_lf || 0),

    // Garages
    garage_count: get('garage_count') || Number(wh.garages?.count || 0),
    garage_area_sqft: get('garage_total_area_sqft') || Number(wh.garages?.total_area_sqft || 0),
    garage_perimeter_lf: get('garage_perimeter_lf') || Number(wh.garages?.perimeter_lf || 0),

    // Corners
    outside_corner_count: get('outside_corner_count') || Number(wh.outside_corners?.count || 0),
    outside_corner_lf: get('outside_corner_lf') || Number(wh.outside_corners?.total_lf || 0),
    inside_corner_count: get('inside_corner_count') || Number(wh.inside_corners?.count || 0),
    inside_corner_lf: get('inside_corner_lf') || Number(wh.inside_corners?.total_lf || 0),

    // Gables
    gable_count: get('gable_count') || Number(wh.gables?.count || 0),
    gable_area_sqft: get('gable_area_sqft') || Number(wh.gables?.area_sqft || 0),
    gable_rake_lf: get('gable_rake_lf') || Number(wh.gables?.rake_lf || 0),

    // Other
    level_starter_lf: get('level_starter_lf'),
    avg_wall_height_ft: get('avg_wall_height_ft', 'avg_wall_height_ft', 10),

    // Computed helpers
    total_opening_perimeter_lf: 0,
    total_corner_lf: 0,
  };

  // Calculate computed fields
  ctx.total_opening_perimeter_lf =
    ctx.window_perimeter_lf + ctx.door_perimeter_lf + ctx.garage_perimeter_lf;
  ctx.total_corner_lf = ctx.outside_corner_lf + ctx.inside_corner_lf;

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
