/**
 * Orchestrator V2 - Combines Material Assignments with Auto-Scope
 * Uses database-driven auto-scope rules for complete takeoff generation
 */

import { MaterialAssignment, WebhookMeasurements, PerMaterialMeasurements } from '../../types/webhook';
import {
  getPricingByIds,
  PricingItem
} from '../../services/pricing';
import {
  generateAutoScopeItemsV2,
  buildMeasurementContext,
  buildManufacturerGroups,
  buildAssignedMaterialsFromPricing,
} from './autoscope-v2';
import { AutoScopeLineItem } from '../../types/autoscope';
import { getSupabaseClient, isDatabaseConfigured } from '../../services/database';

// ============================================================================
// TYPES
// ============================================================================

// Labor rate from database
interface LaborRate {
  id: string;
  rate_name: string;
  description: string;
  trade: string;
  presentation_group: string;
  unit: string;
  base_rate: string;
  difficulty_multiplier: string;
  min_charge: string | null;
  notes: string;
}

// Overhead cost from database
interface OverheadCost {
  id: string;
  cost_name: string;
  description: string;
  category: string;
  cost_type: string;
  unit: string | null;
  base_rate: string | null;
  calculation_formula: string | null;
  default_quantity: string;
  applies_to_trade: string[] | null;
  required: boolean;
  display_order: number;
  notes: string;
}

// Labor auto-scope rule from database
interface LaborAutoScopeRule {
  id: number;
  rule_id: string;
  rule_name: string;
  description: string | null;
  trade: string;
  trigger_type: 'always' | 'material_category' | 'material_sku_pattern' | 'detection_class';
  trigger_value: string | null;
  trigger_condition: Record<string, any> | null;
  labor_rate_id: number | null;
  quantity_source: 'facade_sqft' | 'material_sqft' | 'material_count' | 'detection_count' | 'material_lf';
  quantity_formula: string | null;
  quantity_unit: string;
  priority: number;
  active: boolean;
  // Joined labor_rates data
  labor_rates?: LaborRate;
}

// Labor line item for output
interface LaborLineItem {
  rate_id: string;
  rate_name: string;
  description: string;
  quantity: number;
  unit: string;
  unit_cost: number;
  total_cost: number;
  notes?: string;
}

// Overhead line item for output
interface OverheadLineItem {
  cost_id: string;
  cost_name: string;
  description: string;
  category: string;
  quantity?: number;
  unit?: string;
  rate?: number;
  amount: number;
  calculation_type: string;
  notes?: string;
}

// Project totals
interface ProjectTotals {
  material_cost: number;
  material_markup_rate: number;
  material_markup_amount: number;
  material_total: number;

  installation_labor_subtotal: number;
  overhead_subtotal: number;
  overhead_total: number;  // For display: overhead_subtotal + project_insurance
  labor_cost_before_markup: number;
  labor_markup_rate: number;
  labor_markup_amount: number;
  labor_total: number;

  subtotal: number;
  project_insurance: number;
  grand_total: number;
}

// ============================================================================
// MIKE SKJEI CALCULATION CONSTANTS
// ============================================================================

const MARKUP_RATE = 0.26;
const SOC_UNEMPLOYMENT_RATE = 0.1265;
const LI_HOURLY_RATE = 3.56;
const INSURANCE_RATE_PER_THOUSAND = 24.38;
const DEFAULT_CREW_SIZE = 4;
const DEFAULT_ESTIMATED_WEEKS = 2;

export interface CombinedLineItem {
  description: string;
  sku: string;
  quantity: number;
  unit: string;
  category: string;
  presentation_group: string;
  item_order?: number;  // Display order within presentation group (higher = bottom)

  // Pricing
  material_unit_cost: number;
  material_extended: number;
  labor_unit_cost: number;
  labor_extended: number;
  total_extended: number;

  // Labor calculation
  squares_for_labor?: number;
  labor_class?: string;  // Links to labor_rates.rate_name (e.g., "Lap Siding Installation")
  is_colorplus?: boolean;  // Flag for ColorPlus premium labor

  // Metadata
  calculation_source: 'assigned_material' | 'auto-scope';
  pricing_item_id?: string;
  detection_id?: string;
  detection_ids?: string[];
  detection_count?: number;
  rule_id?: string;
  formula_used?: string;
  notes?: string;
}

export interface V2CalculationResult {
  success: boolean;
  line_items: CombinedLineItem[];
  labor: {
    installation_items: LaborLineItem[];
    installation_subtotal: number;
  };
  overhead: {
    items: OverheadLineItem[];
    subtotal: number;
  };
  totals: {
    material_cost: number;
    labor_cost: number;
    overhead: number;
    subtotal: number;
    markup_percent: number;
    markup_amount: number;
    total: number;
  };
  project_totals: ProjectTotals;
  metadata: {
    pricing_method: 'hybrid-v2';
    calculation_method: string;
    assigned_items_count: number;
    auto_scope_items_count: number;
    items_priced: number;
    items_missing: string[];
    items_before_consolidation: number;
    items_after_consolidation: number;
    measurement_source: 'database' | 'webhook' | 'fallback';
    rules_evaluated: number;
    rules_triggered: number;
    markup_rate: number;
    crew_size: number;
    estimated_weeks: number;
    warnings: Array<{ code: string; message: string }>;
  };
}

// ============================================================================
// INSTALLATION LABOR CALCULATION
// ============================================================================

/**
 * Calculate installation labor using labor_auto_scope_rules
 * Groups materials by labor_class for separate labor line items per siding type.
 * Also adds ColorPlus premium labor for ColorPlus materials.
 *
 * Dynamically generates labor items based on:
 * - labor_class from pricing_items (e.g., "Lap Siding Installation", "Panel Siding Installation")
 * - ColorPlus premium (additional labor for ColorPlus products)
 * - Detection counts for specialty items
 * - Facade area for universal items (WRB, demo)
 */
function calculateInstallationLaborFromRules(
  materials: CombinedLineItem[],
  laborAutoScopeRules: LaborAutoScopeRule[],
  detectionCounts: Record<string, { count: number; total_lf?: number; total_sf?: number }> | undefined,
  facadeAreaSqft: number,
  laborRates: LaborRate[] = []
): { laborItems: LaborLineItem[], subtotal: number } {

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('👷 calculateInstallationLaborFromRules FUNCTION ENTERED');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`   Facade area: ${facadeAreaSqft} SF (${(facadeAreaSqft / 100).toFixed(2)} SQ)`);
  console.log(`   Rules to evaluate: ${laborAutoScopeRules.length}`);
  console.log(`   Materials: ${materials.length}`);
  console.log(`   Labor rates: ${laborRates.length}`);

  const laborItems: LaborLineItem[] = [];

  // =========================================================================
  // STEP 1: Group materials by labor_class for installation labor
  // This creates separate labor lines for lap siding, panel siding, etc.
  // =========================================================================
  interface LaborClassAccumulator {
    squares: number;       // Total squares for labor
    sqft: number;          // Total square feet
    count: number;         // Count of items
    lf: number;            // Linear feet
    colorplusSquares: number;  // Squares of ColorPlus materials
  }

  const materialsByLaborClass: Record<string, LaborClassAccumulator> = {};

  // Also track by category for legacy rule support
  const materialsByCategory: Record<string, { sqft: number; count: number; lf: number }> = {};

  for (const item of materials) {
    // Group by labor_class (new approach)
    const laborClass = item.labor_class || 'Lap Siding Installation';  // Default to lap siding
    if (!materialsByLaborClass[laborClass]) {
      materialsByLaborClass[laborClass] = { squares: 0, sqft: 0, count: 0, lf: 0, colorplusSquares: 0 };
    }

    // Accumulate squares for labor from the item
    if (item.squares_for_labor) {
      materialsByLaborClass[laborClass].squares += item.squares_for_labor;

      // Track ColorPlus separately
      if (item.is_colorplus) {
        materialsByLaborClass[laborClass].colorplusSquares += item.squares_for_labor;
      }
    }

    // Also accumulate by unit for other calculations
    if (item.unit === 'SF' || item.unit === 'sf') {
      materialsByLaborClass[laborClass].sqft += item.quantity;
    } else if (item.unit === 'LF' || item.unit === 'lf') {
      materialsByLaborClass[laborClass].lf += item.quantity;
    } else {
      materialsByLaborClass[laborClass].count += item.quantity;
    }

    // Legacy: also group by category for rule evaluation
    const category = (item.category || 'other').toLowerCase();
    if (!materialsByCategory[category]) {
      materialsByCategory[category] = { sqft: 0, count: 0, lf: 0 };
    }

    if (item.unit === 'SF' || item.unit === 'sf') {
      materialsByCategory[category].sqft += item.quantity;
    } else if (item.unit === 'LF' || item.unit === 'lf') {
      materialsByCategory[category].lf += item.quantity;
    } else {
      if (item.squares_for_labor) {
        materialsByCategory[category].sqft += item.squares_for_labor * 100;
      }
      materialsByCategory[category].count += item.quantity;
    }
  }

  console.log('   Labor classes found:', Object.keys(materialsByLaborClass).join(', '));
  console.log('   Material categories found:', Object.keys(materialsByCategory).join(', '));

  // =========================================================================
  // STEP 2: Generate labor items by labor_class
  // Creates separate lines like "Install fiber cement lap siding" and "Install panel siding"
  // =========================================================================
  for (const [laborClassName, data] of Object.entries(materialsByLaborClass)) {
    if (data.squares <= 0) continue;

    // Find the matching labor rate by rate_name
    const matchingRate = laborRates.find(r =>
      r.rate_name.toLowerCase() === laborClassName.toLowerCase()
    );

    if (matchingRate) {
      const unitCost = parseFloat(matchingRate.base_rate) || 0;
      const multiplier = parseFloat(matchingRate.difficulty_multiplier) || 1.0;
      const minCharge = parseFloat(matchingRate.min_charge || '0');

      const baseCost = data.squares * unitCost * multiplier;
      const totalCost = Math.max(baseCost, minCharge);

      console.log(`   ✅ ${laborClassName}: ${data.squares.toFixed(2)} SQ × $${unitCost}/SQ = $${totalCost.toFixed(2)}`);

      laborItems.push({
        rate_id: matchingRate.id,
        rate_name: matchingRate.rate_name,
        description: matchingRate.description,
        quantity: Math.round(data.squares * 100) / 100,
        unit: matchingRate.unit || 'SQ',
        unit_cost: unitCost,
        total_cost: Math.round(totalCost * 100) / 100,
        notes: `Grouped by labor_class from pricing_items`
      });

      // =========================================================================
      // STEP 3: Add ColorPlus Premium if applicable
      // This is an ADDITIONAL line for the extra labor on ColorPlus materials
      // =========================================================================
      if (data.colorplusSquares > 0) {
        const colorplusPremiumRate = laborRates.find(r =>
          r.rate_name.toLowerCase().includes('colorplus') ||
          r.rate_name.toLowerCase().includes('color plus') ||
          r.rate_name.toLowerCase().includes('premium')
        );

        if (colorplusPremiumRate) {
          const premiumUnitCost = parseFloat(colorplusPremiumRate.base_rate) || 0;
          const premiumMultiplier = parseFloat(colorplusPremiumRate.difficulty_multiplier) || 1.0;
          const premiumMinCharge = parseFloat(colorplusPremiumRate.min_charge || '0');

          const premiumBaseCost = data.colorplusSquares * premiumUnitCost * premiumMultiplier;
          const premiumTotalCost = Math.max(premiumBaseCost, premiumMinCharge);

          console.log(`   ✅ ColorPlus Premium (${laborClassName}): ${data.colorplusSquares.toFixed(2)} SQ × $${premiumUnitCost}/SQ = $${premiumTotalCost.toFixed(2)}`);

          laborItems.push({
            rate_id: colorplusPremiumRate.id,
            rate_name: colorplusPremiumRate.rate_name,
            description: `ColorPlus premium labor for ${laborClassName}`,
            quantity: Math.round(data.colorplusSquares * 100) / 100,
            unit: colorplusPremiumRate.unit || 'SQ',
            unit_cost: premiumUnitCost,
            total_cost: Math.round(premiumTotalCost * 100) / 100,
            notes: `ColorPlus premium for ${laborClassName}`
          });
        } else {
          console.log(`   ⚠️ No ColorPlus premium rate found for ${data.colorplusSquares.toFixed(2)} SQ of ColorPlus material`);
        }
      }
    } else {
      console.log(`   ⚠️ No labor rate found for labor_class: ${laborClassName}`);
    }
  }

  // =========================================================================
  // STEP 4: Evaluate auto-scope rules for non-siding labor (WRB, demo, specialty items)
  // These rules handle things like facade-based items and detection-based items
  // =========================================================================
  console.log(`\n🔍 [LaborAutoScope] Evaluating ${laborAutoScopeRules.length} labor auto-scope rules...`);
  console.log(`   facadeAreaSqft passed to function: ${facadeAreaSqft}`);

  for (const rule of laborAutoScopeRules) {
    console.log(`\n   📋 Rule: ${rule.rule_id} (${rule.rule_name})`);
    console.log(`      trigger_type: ${rule.trigger_type}`);
    console.log(`      quantity_source: ${rule.quantity_source}`);
    console.log(`      labor_rate_id: ${rule.labor_rate_id}`);
    console.log(`      labor_rates joined: ${rule.labor_rates ? JSON.stringify(rule.labor_rates) : 'NULL'}`);

    let quantity = 0;
    let shouldApply = false;
    const rate = rule.labor_rates;

    if (!rate) {
      console.log(`   ⚠️ Rule ${rule.rule_id} has no linked labor rate - skipping`);
      continue;
    }

    // Skip material_category rules for siding - we handle those via labor_class above
    if (rule.trigger_type === 'material_category') {
      const categories = (rule.trigger_value || '').split(',').map(c => c.trim().toLowerCase());
      const isSidingCategory = categories.some(c =>
        c.includes('siding') || c === 'lap_siding' || c === 'panel_siding' || c === 'shingle_siding'
      );
      if (isSidingCategory) {
        console.log(`   ⏭️ Skipping rule ${rule.rule_id} (siding category handled by labor_class)`);
        continue;
      }
    }

    // Evaluate trigger condition
    if (rule.trigger_type === 'always') {
      // Always apply (e.g., WRB, demo/cleanup)
      shouldApply = true;
      console.log(`      ✓ trigger_type='always' - shouldApply=true`);

      if (rule.quantity_source === 'facade_sqft') {
        quantity = facadeAreaSqft / 100; // Convert to squares
        console.log(`      ✓ quantity_source='facade_sqft' - quantity=${quantity.toFixed(2)} SQ (from ${facadeAreaSqft} SF)`);
      } else {
        console.log(`      ⚠️ quantity_source='${rule.quantity_source}' not handled for 'always' trigger`);
      }

    } else if (rule.trigger_type === 'material_category') {
      // Check if any of the trigger categories have materials (non-siding items)
      const categories = (rule.trigger_value || '').split(',').map(c => c.trim().toLowerCase());

      for (const cat of categories) {
        const catData = materialsByCategory[cat];
        if (catData) {
          shouldApply = true;

          if (rule.quantity_source === 'material_sqft') {
            quantity += catData.sqft / 100; // Convert to squares
          } else if (rule.quantity_source === 'material_count') {
            quantity += catData.count;
          } else if (rule.quantity_source === 'material_lf') {
            quantity += catData.lf;
          }
        }
      }

    } else if (rule.trigger_type === 'material_sku_pattern') {
      // Check for SKUs matching pattern (e.g., CORBEL%)
      const pattern = (rule.trigger_value || '').replace('%', '').toLowerCase();
      const matchingItems = materials.filter(item =>
        item.sku?.toLowerCase().startsWith(pattern)
      );

      if (matchingItems.length > 0) {
        shouldApply = true;
        quantity = matchingItems.reduce((sum, item) => sum + item.quantity, 0);
      }

    } else if (rule.trigger_type === 'detection_class') {
      // Check detection counts
      const classes = (rule.trigger_value || '').split(',').map(c => c.trim().toLowerCase());

      for (const cls of classes) {
        const detection = detectionCounts?.[cls];
        if (detection) {
          shouldApply = true;
          quantity += detection.count || 0;
        }
      }
    }

    // Apply the rule if conditions met and quantity > 0
    console.log(`      Final: shouldApply=${shouldApply}, quantity=${quantity}`);

    if (shouldApply && quantity > 0) {
      const unitCost = parseFloat(rate.base_rate) || 0;
      const multiplier = parseFloat(rate.difficulty_multiplier) || 1.0;
      const minCharge = parseFloat(rate.min_charge || '0');

      const baseCost = quantity * unitCost * multiplier;
      const totalCost = Math.max(baseCost, minCharge);

      console.log(`   ✅ ADDING LABOR: ${rule.rule_name}: ${quantity.toFixed(2)} ${rule.quantity_unit} × $${unitCost}/${rule.quantity_unit} = $${totalCost.toFixed(2)}`);

      laborItems.push({
        rate_id: rate.id,
        rate_name: rate.rate_name,
        description: rate.description || rule.description || '',
        quantity: Math.round(quantity * 100) / 100,
        unit: rule.quantity_unit || rate.unit,
        unit_cost: unitCost,
        total_cost: Math.round(totalCost * 100) / 100,
        notes: `From rule: ${rule.rule_id}`
      });
    }
  }

  const subtotal = laborItems.reduce((sum, item) => sum + item.total_cost, 0);
  console.log(`   📊 Installation labor subtotal: $${subtotal.toFixed(2)} (${laborItems.length} items)`);

  return { laborItems, subtotal: Math.round(subtotal * 100) / 100 };
}

/**
 * Legacy labor calculation - fallback if no rules available
 * Calculate installation labor based on Mike Skjei methodology
 */
function calculateInstallationLaborLegacy(
  materials: CombinedLineItem[],
  laborRates: LaborRate[],
  productCategory: string = 'lap_siding'
): { laborItems: LaborLineItem[], subtotal: number } {

  console.log('👷 Calculating installation labor (legacy method)...');
  console.log(`   Product category: ${productCategory}`);

  const RATE_MAP: Record<string, string> = {
    'lap_siding': 'Lap Siding Installation',
    'siding': 'Lap Siding Installation',
    'shingle': 'Shingle Siding Installation',
    'panel': 'Panel Siding Installation',
  };

  const targetRateName = RATE_MAP[productCategory] || 'Lap Siding Installation';
  console.log(`   Target labor rate: ${targetRateName}`);

  const totalSquares = materials
    .filter(m =>
      m.presentation_group === 'Siding' ||
      m.category?.toLowerCase().includes('siding') ||
      m.category === 'lap_siding'
    )
    .reduce((sum, m) => sum + (m.squares_for_labor || 0), 0);

  console.log(`   Total squares for labor: ${totalSquares.toFixed(2)} SQ`);

  const laborItems: LaborLineItem[] = [];

  if (totalSquares <= 0) {
    console.log('   ⚠️ No squares for labor - skipping');
    return { laborItems, subtotal: 0 };
  }

  const installRate = laborRates.find(r => r.rate_name === targetRateName);

  if (installRate) {
    const unitCost = parseFloat(installRate.base_rate) || 0;
    const multiplier = parseFloat(installRate.difficulty_multiplier) || 1.0;
    const minCharge = parseFloat(installRate.min_charge || '0');

    const baseCost = totalSquares * unitCost * multiplier;
    const totalCost = Math.max(baseCost, minCharge);

    console.log(`   💵 ${targetRateName}: ${totalSquares.toFixed(2)} SQ × $${unitCost}/SQ = $${totalCost.toFixed(2)}`);

    laborItems.push({
      rate_id: installRate.id,
      rate_name: installRate.rate_name,
      description: installRate.description,
      quantity: Math.round(totalSquares * 100) / 100,
      unit: installRate.unit,
      unit_cost: unitCost,
      total_cost: Math.round(totalCost * 100) / 100,
      notes: installRate.notes
    });
  } else {
    console.log(`   ⚠️ Labor rate not found: ${targetRateName}`);
  }

  const subtotal = laborItems.reduce((sum, item) => sum + item.total_cost, 0);
  console.log(`   📊 Installation labor subtotal: $${subtotal.toFixed(2)}`);

  return { laborItems, subtotal: Math.round(subtotal * 100) / 100 };
}

/**
 * Calculate overhead costs based on Mike Skjei methodology
 */
function calculateOverhead(
  overheadCosts: OverheadCost[],
  installationLaborSubtotal: number,
  config: { crew_size?: number; estimated_weeks?: number } = {}
): { overheadItems: OverheadLineItem[], subtotal: number } {

  console.log('🏗️ Calculating overhead costs...');

  const crewSize = config.crew_size || DEFAULT_CREW_SIZE;
  const estimatedWeeks = config.estimated_weeks || DEFAULT_ESTIMATED_WEEKS;

  console.log(`   Crew size: ${crewSize}, Estimated weeks: ${estimatedWeeks}`);
  console.log(`   Installation labor subtotal: $${installationLaborSubtotal.toFixed(2)}`);

  const overheadItems: OverheadLineItem[] = [];
  const sortedCosts = [...overheadCosts].sort((a, b) => a.display_order - b.display_order);

  for (const cost of sortedCosts) {
    let amount = 0;
    let quantity: number | undefined;
    let rate: number | undefined;

    if (cost.cost_name === 'Project Insurance') {
      console.log(`   ⏭️ Skipping ${cost.cost_name} (calculated at end)`);
      continue;
    }

    switch (cost.cost_type) {
      case 'percentage':
        if (cost.calculation_formula?.includes('0.1265')) {
          rate = SOC_UNEMPLOYMENT_RATE;
          amount = installationLaborSubtotal * rate;
          console.log(`   📊 ${cost.cost_name}: ${(rate * 100).toFixed(2)}% × $${installationLaborSubtotal.toFixed(2)} = $${amount.toFixed(2)}`);
        }
        break;

      case 'calculated':
        if (cost.calculation_formula?.includes('crew_size')) {
          const hours = crewSize * estimatedWeeks * 40;
          rate = LI_HOURLY_RATE;
          amount = hours * rate;
          quantity = hours;
          console.log(`   📊 ${cost.cost_name}: ${hours} hrs × $${rate}/hr = $${amount.toFixed(2)}`);
        }
        break;

      case 'flat_fee':
        quantity = parseFloat(cost.default_quantity) || 1;
        rate = parseFloat(cost.base_rate || '0');
        amount = quantity * rate;
        console.log(`   📊 ${cost.cost_name}: ${quantity} × $${rate} = $${amount.toFixed(2)}`);
        break;

      case 'per_day':
        quantity = parseFloat(cost.default_quantity) || 1;
        rate = parseFloat(cost.base_rate || '0');
        amount = quantity * rate;
        console.log(`   📊 ${cost.cost_name}: ${quantity} days × $${rate}/day = $${amount.toFixed(2)}`);
        break;
    }

    if (amount > 0) {
      overheadItems.push({
        cost_id: cost.id,
        cost_name: cost.cost_name,
        description: cost.description,
        category: cost.category,
        quantity,
        unit: cost.unit || undefined,
        rate,
        amount: Math.round(amount * 100) / 100,
        calculation_type: cost.cost_type,
        notes: cost.notes
      });
    }
  }

  const subtotal = overheadItems.reduce((sum, item) => sum + item.amount, 0);
  console.log(`   📊 Overhead subtotal: $${subtotal.toFixed(2)}`);

  return { overheadItems, subtotal: Math.round(subtotal * 100) / 100 };
}

/**
 * Calculate final project totals with markup and insurance
 */
function calculateProjectTotals(
  materialCost: number,
  installationLaborSubtotal: number,
  overheadSubtotal: number,
  markupRate: number = MARKUP_RATE
): ProjectTotals {

  console.log('💰 Calculating project totals...');
  console.log(`   Material cost: $${materialCost.toFixed(2)}`);
  console.log(`   Installation labor: $${installationLaborSubtotal.toFixed(2)}`);
  console.log(`   Overhead: $${overheadSubtotal.toFixed(2)}`);
  console.log(`   Markup rate: ${(markupRate * 100).toFixed(0)}%`);

  const materialMarkupAmount = materialCost * markupRate;
  const materialTotal = materialCost + materialMarkupAmount;

  const laborCostBeforeMarkup = installationLaborSubtotal + overheadSubtotal;
  const laborMarkupAmount = laborCostBeforeMarkup * markupRate;
  const laborTotal = laborCostBeforeMarkup + laborMarkupAmount;

  const subtotal = materialTotal + laborTotal;
  const projectInsurance = (subtotal / 1000) * INSURANCE_RATE_PER_THOUSAND;
  const grandTotal = subtotal + projectInsurance;

  console.log(`   Material total (with markup): $${materialTotal.toFixed(2)}`);
  console.log(`   Labor total (with markup): $${laborTotal.toFixed(2)}`);
  console.log(`   Project insurance: $${projectInsurance.toFixed(2)}`);
  console.log(`   Grand total: $${grandTotal.toFixed(2)}`);

  // Calculate overhead_total for display (includes project insurance)
  const overheadTotal = overheadSubtotal + projectInsurance;

  return {
    material_cost: Math.round(materialCost * 100) / 100,
    material_markup_rate: markupRate,
    material_markup_amount: Math.round(materialMarkupAmount * 100) / 100,
    material_total: Math.round(materialTotal * 100) / 100,

    installation_labor_subtotal: Math.round(installationLaborSubtotal * 100) / 100,
    overhead_subtotal: Math.round(overheadSubtotal * 100) / 100,
    overhead_total: Math.round(overheadTotal * 100) / 100,  // For display: includes project insurance
    labor_cost_before_markup: Math.round(laborCostBeforeMarkup * 100) / 100,
    labor_markup_rate: markupRate,
    labor_markup_amount: Math.round(laborMarkupAmount * 100) / 100,
    labor_total: Math.round(laborTotal * 100) / 100,

    subtotal: Math.round(subtotal * 100) / 100,
    project_insurance: Math.round(projectInsurance * 100) / 100,
    grand_total: Math.round(grandTotal * 100) / 100
  };
}

// ============================================================================
// MAIN V2 CALCULATION
// ============================================================================

export async function calculateWithAutoScopeV2(
  materialAssignments: MaterialAssignment[],
  extractionId?: string,
  webhookMeasurements?: WebhookMeasurements,
  organizationId?: string,
  markupRate: number = 0.15,
  detectionCounts?: Record<string, {
    count: number;
    total_lf?: number;
    total_sf?: number;
    display_name: string;
    measurement_type: 'count' | 'area' | 'linear';
    unit: string;
  }>,
  // V8.0: Spatial Containment parameters
  perMaterialMeasurements?: PerMaterialMeasurements,
  spatialContainment?: {
    enabled: boolean;
    matched_openings: number;
    total_openings: number;
    unmatched_openings?: number;
  }
): Promise<V2CalculationResult> {
  // =========================================================================
  // DEBUG: Log ALL incoming parameters at function entry
  // =========================================================================
  console.log('🚀 [Orchestrator] Function called with parameters:');
  console.log('   materialAssignments count:', materialAssignments?.length || 0);
  console.log('   extractionId:', extractionId);
  console.log('   organizationId:', organizationId);
  console.log('   markupRate:', markupRate);
  console.log('   webhookMeasurements keys:', webhookMeasurements ? Object.keys(webhookMeasurements) : 'undefined');
  console.log('   webhookMeasurements.trim:', JSON.stringify((webhookMeasurements as any)?.trim, null, 2));
  console.log('📊 Detection Counts received:', JSON.stringify(detectionCounts, null, 2));
  console.log('🎯 Belly Band from detection_counts:', {
    raw: detectionCounts?.belly_band,
    total_lf: detectionCounts?.belly_band?.total_lf,
    count: detectionCounts?.belly_band?.count
  });

  // V8.0: Log spatial containment parameters
  if (spatialContainment?.enabled) {
    console.log('🎯 [Orchestrator V8.0] SPATIAL CONTAINMENT ENABLED');
    console.log(`   Matched openings: ${spatialContainment.matched_openings}/${spatialContainment.total_openings}`);
    if (spatialContainment.unmatched_openings) {
      console.log(`   Unmatched openings: ${spatialContainment.unmatched_openings}`);
    }
  }
  if (perMaterialMeasurements && Object.keys(perMaterialMeasurements).length > 0) {
    console.log('🎯 [Orchestrator V8.0] Per-material measurements received:');
    for (const [matId, measures] of Object.entries(perMaterialMeasurements)) {
      console.log(`   ${measures.manufacturer}: ${measures.facade_sqft.toFixed(0)} SF, ${measures.window_count} windows (${measures.window_perimeter_lf.toFixed(1)} LF)`);
    }
  }

  const warnings: Array<{ code: string; message: string }> = [];
  const lineItems: CombinedLineItem[] = [];
  const missingItems: string[] = [];

  let totalMaterialCost = 0;
  // Note: Per-item labor removed - labor calculated separately via calculateInstallationLabor()

  // =========================================================================
  // FETCH LABOR RATES AND OVERHEAD COSTS FROM DATABASE
  // =========================================================================

  let laborRates: LaborRate[] = [];
  let laborAutoScopeRules: LaborAutoScopeRule[] = [];
  let sidingOverheadCosts: OverheadCost[] = [];

  if (isDatabaseConfigured()) {
    const client = getSupabaseClient();

    // Fetch labor rates for the trade
    console.log('📋 Fetching labor rates...');
    const { data: laborData, error: laborError } = await client
      .from('labor_rates')
      .select('*')
      .eq('active', true)
      .eq('trade', 'siding');

    if (laborError) {
      console.error('Error fetching labor rates:', laborError);
      warnings.push({
        code: 'LABOR_RATES_FETCH_ERROR',
        message: `Failed to fetch labor rates: ${laborError.message}`,
      });
    } else {
      laborRates = (laborData || []) as LaborRate[];
      console.log(`   Found ${laborRates.length} labor rates`);
    }

    // Fetch labor auto-scope rules with joined labor_rates
    console.log('📋 Fetching labor auto-scope rules...');
    const { data: laborRulesData, error: laborRulesError } = await client
      .from('labor_auto_scope_rules')
      .select(`
        *,
        labor_rates (
          id,
          rate_name,
          description,
          unit,
          base_rate,
          difficulty_multiplier,
          min_charge,
          notes
        )
      `)
      .eq('active', true)
      .eq('trade', 'siding')
      .order('priority');

    if (laborRulesError) {
      console.error('Error fetching labor auto-scope rules:', laborRulesError);
      // Not a critical error - fall back to old method
      console.log('   ⚠️ Will use legacy labor calculation method');
    } else {
      laborAutoScopeRules = (laborRulesData || []) as LaborAutoScopeRule[];
      console.log(`   Found ${laborAutoScopeRules.length} labor auto-scope rules`);
      // Log details of each rule for debugging
      for (const rule of laborAutoScopeRules) {
        console.log(`   📋 Rule ${rule.rule_id}: ${rule.rule_name} (trigger=${rule.trigger_type}, source=${rule.quantity_source}, labor_rate_id=${rule.labor_rate_id})`);
        console.log(`      labor_rates joined: ${rule.labor_rates ? `id=${rule.labor_rates.id}, rate=${rule.labor_rates.base_rate}` : 'NULL - JOIN FAILED!'}`);
      }
    }

    // Fetch overhead costs
    console.log('📋 Fetching overhead costs...');
    const { data: overheadData, error: overheadError } = await client
      .from('overhead_costs')
      .select('*')
      .eq('active', true);

    if (overheadError) {
      console.error('Error fetching overhead costs:', overheadError);
      warnings.push({
        code: 'OVERHEAD_COSTS_FETCH_ERROR',
        message: `Failed to fetch overhead costs: ${overheadError.message}`,
      });
    } else {
      // Filter for siding trade or universal costs
      sidingOverheadCosts = ((overheadData || []) as OverheadCost[]).filter(cost =>
        cost.applies_to_trade === null ||
        (Array.isArray(cost.applies_to_trade) && cost.applies_to_trade.includes('siding'))
      );
      console.log(`   Found ${sidingOverheadCosts.length} overhead costs for siding`);
    }
  }

  // =========================================================================
  // PART 1: Process Material Assignments (ID-based pricing)
  // =========================================================================

  // Extract trim totals from webhookMeasurements for fallback
  // Data can be in EITHER location:
  //   1. Nested: webhookMeasurements.trim.total_trim_lf (from Detection Editor via webhook.ts enrichment)
  //   2. Flat: webhookMeasurements.total_trim_lf (if passed directly)
  const wm = webhookMeasurements as any;

  // Check nested object first, then flat properties
  const trimTotalLf =
    Number(wm?.trim?.total_trim_lf) ||
    Number(wm?.total_trim_lf) ||
    0;

  const trimHeadLf =
    Number(wm?.trim?.total_head_lf) ||
    Number(wm?.total_head_lf) ||
    Number(wm?.trim_head_lf) ||
    0;

  const trimJambLf =
    Number(wm?.trim?.total_jamb_lf) ||
    Number(wm?.total_jamb_lf) ||
    Number(wm?.trim_jamb_lf) ||
    0;

  const trimSillLf =
    Number(wm?.trim?.total_sill_lf) ||
    Number(wm?.total_sill_lf) ||
    Number(wm?.trim_sill_lf) ||
    0;

  console.log('✂️ [MaterialAssignments] Trim totals extracted:', {
    trimTotalLf, trimHeadLf, trimJambLf, trimSillLf,
    sources: {
      nested_trim: wm?.trim,
      flat_total_trim_lf: wm?.total_trim_lf,
      flat_total_head_lf: wm?.total_head_lf,
      flat_total_jamb_lf: wm?.total_jamb_lf,
      flat_total_sill_lf: wm?.total_sill_lf,
    }
  });

  if (materialAssignments && materialAssignments.length > 0) {
    // =========================================================================
    // CLASS-BASED FILTERING - WHITELIST APPROACH
    // Only include explicit siding installation surface classes.
    // Excludes: garage (opening), exterior wall (container), building, facade, etc.
    // =========================================================================
    const SIDING_INSTALLATION_CLASSES = ['siding', 'gable'];

    // Filter to ONLY include siding installation classes (whitelist approach)
    const filteredMaterialAssignments = materialAssignments.filter(a => {
      const cls = (a.detection_class || '').toLowerCase();

      // Only include if class matches a siding installation class
      const isSidingInstallation = SIDING_INSTALLATION_CLASSES.some(sc => cls.includes(sc));

      if (!isSidingInstallation) {
        console.log(`   ⏭️ [LineItems] Skipping '${a.detection_class}' (${a.quantity?.toFixed(1) || 0} ${a.unit}) - not a siding installation area`);
        return false;
      }

      return true;
    });

    const removedCount = materialAssignments.length - filteredMaterialAssignments.length;
    if (removedCount > 0) {
      const removedArea = materialAssignments
        .filter(a => !filteredMaterialAssignments.includes(a))
        .filter(a => a.unit === 'SF')
        .reduce((sum, a) => sum + (a.quantity || 0), 0);
      console.log(`🏭 [LineItems] Filtered ${materialAssignments.length} → ${filteredMaterialAssignments.length} (removed ${removedCount} non-siding classes, ${removedArea.toFixed(0)} SF excluded)`);
    }

    // Batch fetch pricing for all assigned materials
    const pricingIds = filteredMaterialAssignments.map(m => m.pricing_item_id);
    const pricingMap = await getPricingByIds(pricingIds, organizationId);

    for (const assignment of filteredMaterialAssignments) {
      const pricing = pricingMap.get(assignment.pricing_item_id);

      if (!pricing) {
        console.warn(`⚠️ No pricing found for ID: ${assignment.pricing_item_id}`);
        missingItems.push(assignment.pricing_item_id);
        warnings.push({
          code: 'PRICING_NOT_FOUND',
          message: `No pricing found for material ID: ${assignment.pricing_item_id}`,
        });
        continue;
      }

      // =========================================================================
      // TRIM FALLBACK: Use aggregated trim totals when detection has no dimensions
      // Check both detection_class AND pricing.category for trim products
      // =========================================================================
      let effectiveQuantity = assignment.quantity;
      let notes = `From detection: ${assignment.quantity.toFixed(2)} ${assignment.unit}`;

      const detectionClass = assignment.detection_class?.toLowerCase() || '';
      const pricingCategory = pricing.category?.toLowerCase() || '';
      const productName = pricing.product_name?.toLowerCase() || '';

      // Check if this is a trim item by:
      // 1. detection_class is 'trim' OR contains 'trim'
      // 2. pricing category is 'trim'
      // 3. product name contains 'trim'
      const isTrimItem =
        detectionClass === 'trim' ||
        detectionClass.includes('trim') ||
        pricingCategory === 'trim' ||
        pricingCategory.includes('trim') ||
        productName.includes('trim');

      console.log(`✂️ [Trim Check] ${pricing.product_name}:`, {
        detection_class: assignment.detection_class,
        pricing_category: pricing.category,
        quantity: assignment.quantity,
        unit: assignment.unit,
        isTrimItem,
        trimTotalLf
      });

      if (isTrimItem && assignment.quantity === 0 && trimTotalLf > 0) {
        // Fallback to aggregated trim totals
        effectiveQuantity = trimTotalLf;
        notes = `From trim totals: ${trimTotalLf.toFixed(2)} LF (head: ${trimHeadLf.toFixed(1)}, jamb: ${trimJambLf.toFixed(1)}, sill: ${trimSillLf.toFixed(1)})`;
        console.log(`✂️ [Trim Fallback] ${pricing.product_name}: Using trim totals ${trimTotalLf.toFixed(2)} LF instead of 0`);
      }

      // Create a modified assignment with effective quantity for calculation
      const effectiveAssignment = { ...assignment, quantity: effectiveQuantity };

      // Calculate quantity based on unit conversion
      const quantity = calculateMaterialQuantity(effectiveAssignment, pricing);
      const materialCost = quantity * Number(pricing.material_cost || 0);
      const materialExtended = Math.round(materialCost * 100) / 100;

      // Calculate squares for labor (SF / 100 = squares)
      let squaresForLabor = 0;
      if (assignment.unit === 'SF') {
        squaresForLabor = effectiveQuantity / 100;
        console.log(`   📐 Squares for labor: ${effectiveQuantity} SF / 100 = ${squaresForLabor.toFixed(2)} SQ`);
      }

      // Get consistent presentation_group and item_order
      const presentationGroup = getPresentationGroup(pricing.category);
      const itemOrder = getItemOrder(presentationGroup, pricing.category);

      // Determine if this is a ColorPlus product (check product name for "ColorPlus")
      const isColorPlus = pricing.product_name?.toLowerCase().includes('colorplus') ||
                          pricing.product_name?.toLowerCase().includes('color plus');

      lineItems.push({
        description: pricing.product_name,
        sku: pricing.sku,
        quantity,
        unit: pricing.unit,
        category: pricing.category || assignment.detection_class,
        presentation_group: presentationGroup,
        item_order: itemOrder,

        material_unit_cost: Number(pricing.material_cost || 0),
        material_extended: materialExtended,
        labor_unit_cost: 0,  // Labor calculated separately by squares
        labor_extended: 0,   // Labor calculated separately by squares
        total_extended: materialExtended,  // Material only - labor separate

        squares_for_labor: squaresForLabor,
        labor_class: pricing.labor_class,  // Links to labor_rates.rate_name
        is_colorplus: isColorPlus,  // Flag for ColorPlus premium labor

        calculation_source: 'assigned_material',
        pricing_item_id: assignment.pricing_item_id,
        detection_id: assignment.detection_id,
        detection_ids: [assignment.detection_id],
        detection_count: 1,
        notes,
      });

      totalMaterialCost += materialCost;
      // Labor is now calculated separately via calculateInstallationLabor()
    }
  }

  // =========================================================================
  // PART 2: Generate Auto-Scope Items (SKU-based pricing)
  // =========================================================================

  // Check if material_assignments already include siding products
  // If so, skip auto-scope rules for siding panels to prevent duplicates
  const SIDING_CLASSES = ['siding', 'exterior_wall', 'gable', 'building'];
  const hasSidingAssignments = materialAssignments?.some(
    m => SIDING_CLASSES.includes(m.detection_class?.toLowerCase() || '')
  );

  if (hasSidingAssignments) {
    console.log('📋 User has siding material assignments - will skip auto-scope siding panels');
  }

  // Merge detection_counts into webhookMeasurements for buildMeasurementContext
  // This extracts belly_band_count and belly_band_lf from detection_counts
  const enrichedMeasurements: Record<string, any> = {
    ...(webhookMeasurements || {}),
  };
  if (detectionCounts?.belly_band) {
    enrichedMeasurements.belly_band_count = detectionCounts.belly_band.count || 0;
    enrichedMeasurements.belly_band_lf = detectionCounts.belly_band.total_lf || 0;
  }

  // =========================================================================
  // DEBUG: Log trim data flow
  // =========================================================================
  console.log('✂️ [Orchestrator] webhookMeasurements.trim:', JSON.stringify((webhookMeasurements as any)?.trim, null, 2));
  console.log('✂️ [Orchestrator] enrichedMeasurements.trim:', JSON.stringify(enrichedMeasurements.trim, null, 2));

  // =========================================================================
  // BUILD MANUFACTURER GROUPS from material assignments
  // This aggregates SF/LF by manufacturer for per-manufacturer auto-scope rules
  // V8.0: Also merges per_material_measurements from spatial containment
  // =========================================================================
  console.log('🏭 Building manufacturer groups from material assignments...');

  const manufacturerGroups = await buildManufacturerGroups(
    materialAssignments.map(a => ({
      pricing_item_id: a.pricing_item_id,
      quantity: a.quantity,
      unit: a.unit,
      area_sqft: a.area_sf ?? undefined,  // Map area_sf to area_sqft, convert null to undefined
      perimeter_lf: a.perimeter_lf ?? undefined,  // Convert null to undefined
      detection_id: a.detection_id,
      detection_class: a.detection_class,  // Pass detection_class for overlap filtering
    })),
    organizationId,
    perMaterialMeasurements  // V8.0: Pass per-material measurements from spatial containment
  );

  console.log(`🏭 Built ${Object.keys(manufacturerGroups).length} manufacturer groups`);
  for (const [mfr, data] of Object.entries(manufacturerGroups)) {
    const openingsInfo = data.total_openings_perimeter_lf !== undefined
      ? `, ${data.total_openings_perimeter_lf.toFixed(0)} LF openings (V8.0)`
      : '';
    console.log(`   ${mfr}: ${data.area_sqft.toFixed(0)} SF, ${data.linear_ft.toFixed(0)} LF${openingsInfo}`);
  }

  // =========================================================================
  // BUILD ASSIGNED MATERIALS for trigger condition evaluation
  // This enables material_category-based auto-scope rules (e.g., Artisan)
  // =========================================================================
  let assignedMaterialsForAutoScope: { sku: string; category: string; manufacturer: string; pricing_item_id?: string }[] = [];

  if (materialAssignments && materialAssignments.length > 0) {
    // Fetch pricing for all assigned materials to get categories
    const pricingIds = materialAssignments.map(m => m.pricing_item_id);
    const pricingMapForAutoScope = await getPricingByIds(pricingIds, organizationId);

    // Build the assigned materials list using the utility function
    assignedMaterialsForAutoScope = buildAssignedMaterialsFromPricing(
      materialAssignments.map(a => ({
        pricing_item_id: a.pricing_item_id,
        assigned_material_id: a.pricing_item_id,
        quantity: a.quantity,
        unit: a.unit,
      })),
      pricingMapForAutoScope
    );

    console.log(`🎨 [Artisan Debug] Built ${assignedMaterialsForAutoScope.length} assigned materials for auto-scope:`);
    for (const m of assignedMaterialsForAutoScope) {
      console.log(`   - SKU: ${m.sku}, Category: ${m.category}, Manufacturer: ${m.manufacturer}`);
    }
  }

  const autoScopeResult = await generateAutoScopeItemsV2(
    extractionId,
    enrichedMeasurements,
    organizationId,
    {
      skipSidingPanels: hasSidingAssignments,
      manufacturerGroups,  // Pass manufacturer groups for per-manufacturer rules
      assignedMaterials: assignedMaterialsForAutoScope,  // Pass assigned materials for category-based rules
      // V8.0: Pass spatial containment metadata for logging/diagnostics
      spatialContainment: spatialContainment,
    }
  );

  // =========================================================================
  // CONSOLIDATE ASSIGNED MATERIALS BEFORE ADDING AUTO-SCOPE
  // =========================================================================
  const itemsBeforeConsolidation = lineItems.length;
  const consolidatedAssigned = consolidateLineItems(lineItems);
  const itemsAfterConsolidation = consolidatedAssigned.length;

  console.log(`📦 Consolidated ${itemsBeforeConsolidation} line items → ${itemsAfterConsolidation}`);

  // Replace with consolidated items
  lineItems.length = 0;
  lineItems.push(...consolidatedAssigned);

  // Add auto-scope line items
  for (const autoItem of autoScopeResult.line_items) {
    // Determine presentation_group from category first (more reliable),
    // then fall back to normalizing the database's presentation_group
    // This ensures wrb/house_wrap categories go to 'Flashing & Weatherproofing'
    // even if the database rule has presentation_group: 'siding'
    const categoryBasedGroup = getPresentationGroup(autoItem.category);
    const normalizedGroup = categoryBasedGroup !== 'Other Materials'
      ? categoryBasedGroup
      : normalizePresentationGroup(autoItem.presentation_group);
    // Get item_order (higher = appears at bottom of section)
    const itemOrder = getItemOrder(normalizedGroup, autoItem.category);

    lineItems.push({
      description: autoItem.description,
      sku: autoItem.sku,
      quantity: autoItem.quantity,
      unit: autoItem.unit,
      category: autoItem.category,
      presentation_group: normalizedGroup,
      item_order: itemOrder,

      material_unit_cost: autoItem.material_unit_cost,
      material_extended: autoItem.material_extended,
      labor_unit_cost: 0,  // Labor calculated separately by squares
      labor_extended: 0,   // Labor calculated separately by squares
      total_extended: autoItem.material_extended,  // Material only - labor separate

      calculation_source: 'auto-scope',
      rule_id: autoItem.rule_id,
      formula_used: autoItem.formula_used,
      notes: autoItem.notes,
    });

    totalMaterialCost += autoItem.material_extended;
    // Labor is now calculated separately via calculateInstallationLabor()
  }

  // =========================================================================
  // BELLY BAND SUPPORTING MATERIALS
  // Generate additional items when belly band detections are present
  // =========================================================================
  const bellyBandLf = detectionCounts?.belly_band?.total_lf || 0;
  console.log('📏 Belly Band LF value:', bellyBandLf, '(type:', typeof bellyBandLf, ')');
  console.log('📏 Will generate belly band items:', bellyBandLf > 0);

  if (bellyBandLf > 0) {
    console.log(`✅ GENERATING BELLY BAND ITEMS for ${bellyBandLf.toFixed(1)} LF`);

    // Constants for belly band calculations
    const BOARD_LENGTH_FT = 12;
    const WASTE_FACTOR = 1.10; // 10% waste
    const FLASHING_LENGTH_FT = 10;
    const CAULK_COVERAGE_LF = 50;
    const NAILS_COVERAGE_LF = 150;

    // 1. HardieTrim 5/4 x 8 boards (12ft pieces) - main belly band material
    const boardPieces = Math.ceil((bellyBandLf / BOARD_LENGTH_FT) * WASTE_FACTOR);
    const boardUnitCost = 32.00;
    const boardExtended = boardPieces * boardUnitCost;
    lineItems.push({
      description: 'HardieTrim 5/4 x 8 x 12ft ColorPlus - Belly Band',
      sku: 'JH-TRIM-BB-8-CP',
      quantity: boardPieces,
      unit: 'ea',
      category: 'belly_band_trim',
      presentation_group: 'Belly Band',
      item_order: 1,
      material_unit_cost: boardUnitCost,
      material_extended: boardExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: boardExtended,
      calculation_source: 'auto-scope',
      notes: `Belly band trim boards: ${bellyBandLf.toFixed(1)} LF ÷ ${BOARD_LENGTH_FT}ft × ${WASTE_FACTOR} waste = ${boardPieces} pcs`,
    });
    totalMaterialCost += boardExtended;

    // 2. Z-Flashing 2" (10ft pieces) - runs along top of belly band
    const zFlashingPieces = Math.ceil((bellyBandLf / FLASHING_LENGTH_FT) * WASTE_FACTOR);
    const zFlashingUnitCost = 12.50;
    const zFlashingExtended = zFlashingPieces * zFlashingUnitCost;
    lineItems.push({
      description: 'Z-Flashing 2" Pre-Painted White - Belly Band Head',
      sku: '112Z2BPW',
      quantity: zFlashingPieces,
      unit: 'ea',
      category: 'belly_band_flashing',
      presentation_group: 'Belly Band',
      item_order: 2,
      material_unit_cost: zFlashingUnitCost,
      material_extended: zFlashingExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: zFlashingExtended,
      calculation_source: 'auto-scope',
      notes: `Head flashing for belly band: ${bellyBandLf.toFixed(1)} LF ÷ ${FLASHING_LENGTH_FT}ft = ${zFlashingPieces} pcs`,
    });
    totalMaterialCost += zFlashingExtended;

    // 3. Aluminum Drip Edge (10ft pieces) - at bottom of belly band
    const dripEdgePieces = Math.ceil((bellyBandLf / FLASHING_LENGTH_FT) * WASTE_FACTOR);
    const dripEdgeUnitCost = 8.50;
    const dripEdgeExtended = dripEdgePieces * dripEdgeUnitCost;
    lineItems.push({
      description: 'Aluminum Drip Edge 10ft - Belly Band Bottom',
      sku: 'ROOF-DRIP-10',
      quantity: dripEdgePieces,
      unit: 'ea',
      category: 'belly_band_flashing',
      presentation_group: 'Belly Band',
      item_order: 3,
      material_unit_cost: dripEdgeUnitCost,
      material_extended: dripEdgeExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: dripEdgeExtended,
      calculation_source: 'auto-scope',
      notes: `Drip edge for belly band bottom: ${bellyBandLf.toFixed(1)} LF ÷ ${FLASHING_LENGTH_FT}ft = ${dripEdgePieces} pcs`,
    });
    totalMaterialCost += dripEdgeExtended;

    // 4. Stainless Steel Trim Nails (1 box per 150 LF)
    const nailBoxes = Math.ceil(bellyBandLf / NAILS_COVERAGE_LF);
    const nailsUnitCost = 7.50;
    const nailsExtended = nailBoxes * nailsUnitCost;
    lineItems.push({
      description: 'Stainless Steel Trim Nails 2" - Belly Band',
      sku: 'TRIM-NAIL-SS-2',
      quantity: nailBoxes,
      unit: 'box',
      category: 'belly_band_fastener',
      presentation_group: 'Belly Band',
      item_order: 4,
      material_unit_cost: nailsUnitCost,
      material_extended: nailsExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: nailsExtended,
      calculation_source: 'auto-scope',
      notes: `Trim nails for belly band: ${bellyBandLf.toFixed(1)} LF ÷ ${NAILS_COVERAGE_LF} LF/box = ${nailBoxes} boxes`,
    });
    totalMaterialCost += nailsExtended;

    // 5. ColorMatch Caulk (1 tube per 50 LF for joints)
    const caulkTubes = Math.ceil(bellyBandLf / CAULK_COVERAGE_LF);
    const caulkUnitCost = 8.50;
    const caulkExtended = caulkTubes * caulkUnitCost;
    lineItems.push({
      description: 'ColorMatch Caulk - Belly Band Joints',
      sku: 'JH-CAULK-CM',
      quantity: caulkTubes,
      unit: 'tube',
      category: 'belly_band_caulk',
      presentation_group: 'Belly Band',
      item_order: 5,
      material_unit_cost: caulkUnitCost,
      material_extended: caulkExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: caulkExtended,
      calculation_source: 'auto-scope',
      notes: `Joint caulk for belly band: ${bellyBandLf.toFixed(1)} LF ÷ ${CAULK_COVERAGE_LF} LF/tube = ${caulkTubes} tubes`,
    });
    totalMaterialCost += caulkExtended;

    console.log(`🎀 Added ${5} belly band items totaling $${(boardExtended + zFlashingExtended + dripEdgeExtended + nailsExtended + caulkExtended).toFixed(2)}`);
  }

  // Debug: Log belly band items in lineItems
  const bellyBandItems = lineItems.filter(item =>
    item.presentation_group === 'Belly Band' ||
    item.category?.includes('belly_band')
  );
  console.log('📦 Belly Band items in lineItems:', bellyBandItems.length);
  bellyBandItems.forEach(item => {
    console.log(`  - ${item.description}: presentation_group="${item.presentation_group}", category="${item.category}"`);
  });

  // =========================================================================
  // SOFFIT - Auto-generate from detections
  // =========================================================================
  const soffitSf = detectionCounts?.soffit?.total_sf || 0;
  console.log('📏 Soffit SF value:', soffitSf);

  if (soffitSf > 0) {
    console.log(`✅ GENERATING SOFFIT ITEMS for ${soffitSf.toFixed(1)} SF`);

    // Soffit panels (12 SF per panel, 10% waste)
    const soffitPanels = Math.ceil(soffitSf / 12 * 1.10);
    const soffitPanelCost = 28.00;
    const soffitPanelExtended = soffitPanels * soffitPanelCost;
    lineItems.push({
      description: 'HardieSoffit 12" Vented Panel',
      sku: 'JH-SOFFIT-12-VENT',
      quantity: soffitPanels,
      unit: 'ea',
      category: 'soffit_panel',
      presentation_group: 'Soffit & Fascia',
      item_order: 1,
      material_unit_cost: soffitPanelCost,
      material_extended: soffitPanelExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: soffitPanelExtended,
      calculation_source: 'auto-scope',
      notes: `Soffit panels: ${soffitSf.toFixed(1)} SF × 1.10 waste ÷ 12 SF = ${soffitPanels} panels`,
    });
    totalMaterialCost += soffitPanelExtended;

    // J-channel for soffit (perimeter estimate)
    const soffitPerimeterLf = Math.sqrt(soffitSf) * 4;
    const jChannelPcs = Math.ceil(soffitPerimeterLf / 12 * 1.10);
    const jChannelCost = 6.50;
    const jChannelExtended = jChannelPcs * jChannelCost;
    lineItems.push({
      description: 'Soffit J-Channel 12ft',
      sku: 'SOFFIT-JCHANNEL-12',
      quantity: jChannelPcs,
      unit: 'ea',
      category: 'soffit_trim',
      presentation_group: 'Soffit & Fascia',
      item_order: 2,
      material_unit_cost: jChannelCost,
      material_extended: jChannelExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: jChannelExtended,
      calculation_source: 'auto-scope',
      notes: `J-channel: ~${soffitPerimeterLf.toFixed(0)} LF perimeter`,
    });
    totalMaterialCost += jChannelExtended;

    console.log(`📦 Added soffit items totaling $${(soffitPanelExtended + jChannelExtended).toFixed(2)}`);
  }

  // =========================================================================
  // FASCIA - Auto-generate from detections
  // =========================================================================
  const fasciaLf = detectionCounts?.fascia?.total_lf || 0;
  console.log('📏 Fascia LF value:', fasciaLf);

  if (fasciaLf > 0) {
    console.log(`✅ GENERATING FASCIA ITEMS for ${fasciaLf.toFixed(1)} LF`);

    // Fascia boards (12ft pieces, 10% waste)
    const fasciaPcs = Math.ceil(fasciaLf / 12 * 1.10);
    const fasciaCost = 24.00;
    const fasciaExtended = fasciaPcs * fasciaCost;
    lineItems.push({
      description: 'HardieTrim 5/4 x 6 x 12ft Fascia',
      sku: 'JH-TRIM-FASCIA-6',
      quantity: fasciaPcs,
      unit: 'ea',
      category: 'fascia_board',
      presentation_group: 'Soffit & Fascia',
      item_order: 3,
      material_unit_cost: fasciaCost,
      material_extended: fasciaExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: fasciaExtended,
      calculation_source: 'auto-scope',
      notes: `Fascia boards: ${fasciaLf.toFixed(1)} LF × 1.10 waste ÷ 12ft = ${fasciaPcs} pcs`,
    });
    totalMaterialCost += fasciaExtended;

    // Fascia nails
    const fasciaNailBoxes = Math.ceil(fasciaLf / 100);
    const fasciaNailCost = 7.50;
    const fasciaNailExtended = fasciaNailBoxes * fasciaNailCost;
    lineItems.push({
      description: 'Stainless Steel Trim Nails 1lb Box',
      sku: 'TRIM-NAILS-SS-1LB',
      quantity: fasciaNailBoxes,
      unit: 'box',
      category: 'fascia_fastener',
      presentation_group: 'Soffit & Fascia',
      item_order: 4,
      material_unit_cost: fasciaNailCost,
      material_extended: fasciaNailExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: fasciaNailExtended,
      calculation_source: 'auto-scope',
      notes: `Fascia nails: ${fasciaLf.toFixed(1)} LF ÷ 100 LF/box = ${fasciaNailBoxes} box`,
    });
    totalMaterialCost += fasciaNailExtended;

    console.log(`📦 Added fascia items totaling $${(fasciaExtended + fasciaNailExtended).toFixed(2)}`);
  }

  // =========================================================================
  // GUTTERS & DOWNSPOUTS - Auto-generate from detections
  // =========================================================================
  const gutterLf = detectionCounts?.gutter?.total_lf || 0;
  const downspoutCount = detectionCounts?.downspout?.count || 0;
  console.log('📏 Gutter LF value:', gutterLf, 'Downspout count:', downspoutCount);

  if (gutterLf > 0) {
    console.log(`✅ GENERATING GUTTER ITEMS for ${gutterLf.toFixed(1)} LF`);

    // Gutter sections (10ft pieces, 10% waste)
    const gutterPcs = Math.ceil(gutterLf / 10 * 1.10);
    const gutterCost = 12.00;
    const gutterExtended = gutterPcs * gutterCost;
    lineItems.push({
      description: '5" K-Style Aluminum Gutter 10ft',
      sku: 'GUTTER-5K-ALU-10',
      quantity: gutterPcs,
      unit: 'ea',
      category: 'gutter',
      presentation_group: 'Gutters & Downspouts',
      item_order: 1,
      material_unit_cost: gutterCost,
      material_extended: gutterExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: gutterExtended,
      calculation_source: 'auto-scope',
      notes: `Gutters: ${gutterLf.toFixed(1)} LF × 1.10 waste ÷ 10ft = ${gutterPcs} pcs`,
    });
    totalMaterialCost += gutterExtended;

    // Gutter hangers (1 per 2 LF)
    const hangerCount = Math.ceil(gutterLf / 2);
    const hangerCost = 1.50;
    const hangerExtended = hangerCount * hangerCost;
    lineItems.push({
      description: 'Hidden Gutter Hanger',
      sku: 'GUTTER-HANGER-HIDDEN',
      quantity: hangerCount,
      unit: 'ea',
      category: 'gutter_hanger',
      presentation_group: 'Gutters & Downspouts',
      item_order: 2,
      material_unit_cost: hangerCost,
      material_extended: hangerExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: hangerExtended,
      calculation_source: 'auto-scope',
      notes: `Hangers: ${gutterLf.toFixed(1)} LF ÷ 2 LF spacing = ${hangerCount} hangers`,
    });
    totalMaterialCost += hangerExtended;

    // End caps (2 per run, estimate runs from LF)
    const estimatedRuns = Math.ceil(gutterLf / 30);
    const endCapCount = estimatedRuns * 2;
    const endCapCost = 3.50;
    const endCapExtended = endCapCount * endCapCost;
    lineItems.push({
      description: 'Gutter End Cap',
      sku: 'GUTTER-ENDCAP',
      quantity: endCapCount,
      unit: 'ea',
      category: 'gutter_accessory',
      presentation_group: 'Gutters & Downspouts',
      item_order: 3,
      material_unit_cost: endCapCost,
      material_extended: endCapExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: endCapExtended,
      calculation_source: 'auto-scope',
      notes: `End caps: ~${estimatedRuns} runs × 2 = ${endCapCount} caps`,
    });
    totalMaterialCost += endCapExtended;

    console.log(`📦 Added gutter items totaling $${(gutterExtended + hangerExtended + endCapExtended).toFixed(2)}`);
  }

  if (downspoutCount > 0) {
    console.log(`✅ GENERATING DOWNSPOUT ITEMS for ${downspoutCount} downspouts`);

    // Downspouts (10ft each)
    const downspoutCost = 8.00;
    const downspoutExtended = downspoutCount * downspoutCost;
    lineItems.push({
      description: '2x3 Aluminum Downspout 10ft',
      sku: 'DOWNSPOUT-2X3-10',
      quantity: downspoutCount,
      unit: 'ea',
      category: 'downspout',
      presentation_group: 'Gutters & Downspouts',
      item_order: 4,
      material_unit_cost: downspoutCost,
      material_extended: downspoutExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: downspoutExtended,
      calculation_source: 'auto-scope',
      notes: `Downspouts from detection: ${downspoutCount} locations`,
    });
    totalMaterialCost += downspoutExtended;

    // Downspout brackets (3 per downspout)
    const dsBracketCount = downspoutCount * 3;
    const dsBracketCost = 2.00;
    const dsBracketExtended = dsBracketCount * dsBracketCost;
    lineItems.push({
      description: 'Downspout Bracket',
      sku: 'DOWNSPOUT-BRACKET',
      quantity: dsBracketCount,
      unit: 'ea',
      category: 'downspout_bracket',
      presentation_group: 'Gutters & Downspouts',
      item_order: 5,
      material_unit_cost: dsBracketCost,
      material_extended: dsBracketExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: dsBracketExtended,
      calculation_source: 'auto-scope',
      notes: `Brackets: ${downspoutCount} downspouts × 3 = ${dsBracketCount} brackets`,
    });
    totalMaterialCost += dsBracketExtended;

    // Elbows (2 per downspout - top and bottom)
    const elbowCount = downspoutCount * 2;
    const elbowCost = 4.00;
    const elbowExtended = elbowCount * elbowCost;
    lineItems.push({
      description: 'Downspout Elbow',
      sku: 'DOWNSPOUT-ELBOW',
      quantity: elbowCount,
      unit: 'ea',
      category: 'downspout',
      presentation_group: 'Gutters & Downspouts',
      item_order: 6,
      material_unit_cost: elbowCost,
      material_extended: elbowExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: elbowExtended,
      calculation_source: 'auto-scope',
      notes: `Elbows: ${downspoutCount} downspouts × 2 = ${elbowCount} elbows`,
    });
    totalMaterialCost += elbowExtended;

    console.log(`📦 Added downspout items totaling $${(downspoutExtended + dsBracketExtended + elbowExtended).toFixed(2)}`);
  }

  // =========================================================================
  // ARCHITECTURAL DETAILS - Corbels, Brackets, Shutters, Posts, Columns
  // =========================================================================
  const corbelCount = detectionCounts?.corbel?.count || 0;
  const bracketDetectionCount = detectionCounts?.bracket?.count || 0;
  const shutterCount = detectionCounts?.shutter?.count || 0;
  const postCount = detectionCounts?.post?.count || 0;
  const columnCount = detectionCounts?.column?.count || 0;

  if (corbelCount > 0) {
    console.log(`✅ GENERATING CORBEL ITEMS for ${corbelCount} corbels`);
    const corbelCost = 45.00;
    const corbelExtended = corbelCount * corbelCost;
    lineItems.push({
      description: 'Decorative Corbel - Primed',
      sku: 'CORBEL-DECORATIVE',
      quantity: corbelCount,
      unit: 'ea',
      category: 'corbel',
      presentation_group: 'Architectural Details',
      item_order: 1,
      material_unit_cost: corbelCost,
      material_extended: corbelExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: corbelExtended,
      calculation_source: 'auto-scope',
      notes: `Corbels from detection: ${corbelCount} locations`,
    });
    totalMaterialCost += corbelExtended;
  }

  if (bracketDetectionCount > 0) {
    console.log(`✅ GENERATING BRACKET ITEMS for ${bracketDetectionCount} brackets`);
    const bracketCost = 35.00;
    const bracketExtended = bracketDetectionCount * bracketCost;
    lineItems.push({
      description: 'Decorative Bracket - Primed',
      sku: 'BRACKET-DECORATIVE',
      quantity: bracketDetectionCount,
      unit: 'ea',
      category: 'bracket',
      presentation_group: 'Architectural Details',
      item_order: 2,
      material_unit_cost: bracketCost,
      material_extended: bracketExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: bracketExtended,
      calculation_source: 'auto-scope',
      notes: `Brackets from detection: ${bracketDetectionCount} locations`,
    });
    totalMaterialCost += bracketExtended;
  }

  if (shutterCount > 0) {
    console.log(`✅ GENERATING SHUTTER ITEMS for ${shutterCount} shutters`);
    const shutterCost = 65.00;
    const shutterExtended = shutterCount * shutterCost;
    lineItems.push({
      description: 'Exterior Shutter - Vinyl',
      sku: 'SHUTTER-VINYL',
      quantity: shutterCount,
      unit: 'ea',
      category: 'shutter',
      presentation_group: 'Architectural Details',
      item_order: 3,
      material_unit_cost: shutterCost,
      material_extended: shutterExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: shutterExtended,
      calculation_source: 'auto-scope',
      notes: `Shutters from detection: ${shutterCount} (pairs = ${Math.ceil(shutterCount / 2)})`,
    });
    totalMaterialCost += shutterExtended;
  }

  if (postCount > 0) {
    console.log(`✅ GENERATING POST ITEMS for ${postCount} posts`);
    const postCost = 85.00;
    const postExtended = postCount * postCost;
    lineItems.push({
      description: 'Porch Post Wrap - PVC',
      sku: 'POST-WRAP-PVC',
      quantity: postCount,
      unit: 'ea',
      category: 'post',
      presentation_group: 'Architectural Details',
      item_order: 4,
      material_unit_cost: postCost,
      material_extended: postExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: postExtended,
      calculation_source: 'auto-scope',
      notes: `Post wraps from detection: ${postCount} posts`,
    });
    totalMaterialCost += postExtended;
  }

  if (columnCount > 0) {
    console.log(`✅ GENERATING COLUMN ITEMS for ${columnCount} columns`);
    const columnCost = 150.00;
    const columnExtended = columnCount * columnCost;
    lineItems.push({
      description: 'Column Wrap - PVC',
      sku: 'COLUMN-WRAP-PVC',
      quantity: columnCount,
      unit: 'ea',
      category: 'column',
      presentation_group: 'Architectural Details',
      item_order: 5,
      material_unit_cost: columnCost,
      material_extended: columnExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: columnExtended,
      calculation_source: 'auto-scope',
      notes: `Column wraps from detection: ${columnCount} columns`,
    });
    totalMaterialCost += columnExtended;
  }

  // =========================================================================
  // PENETRATION FLASHING - Vents, Outlets, Hose Bibs, Light Fixtures
  // Skip auto-scope flashing for detections that have manual material assignments
  // =========================================================================
  const ventCount = detectionCounts?.vent?.count || 0;
  const gableVentCount = detectionCounts?.gable_vent?.count || 0;
  const outletCount = detectionCounts?.outlet?.count || 0;
  const hoseBibCount = detectionCounts?.hose_bib?.count || 0;
  const lightFixtureCount = detectionCounts?.light_fixture?.count || 0;

  // DEBUG: Log materialAssignments to understand structure
  console.log(`[DEBUG] materialAssignments received: ${materialAssignments?.length || 0} items`);
  if (materialAssignments && materialAssignments.length > 0) {
    console.log('[DEBUG] First materialAssignment structure:', JSON.stringify(materialAssignments[0], null, 2));
    console.log('[DEBUG] All assignment classes:', materialAssignments.map((ma: any) =>
      ma.detection_class || ma.class || ma.detectionClass || 'NO_CLASS'
    ).join(', '));
  }

  // Helper function to count material assignments for a detection class
  // Checks multiple property names for compatibility with different payload formats
  const getAssignedCount = (detectionClass: string): number => {
    if (!materialAssignments || !Array.isArray(materialAssignments)) {
      console.log(`[DEBUG] No materialAssignments array for class: ${detectionClass}`);
      return 0;
    }

    const assignmentsForClass = materialAssignments.filter((ma: any) => {
      // Check all possible property names for detection class
      const maClass = (ma.detection_class || ma.class || ma.detectionClass || '').toLowerCase();
      const matches = maClass === detectionClass.toLowerCase();
      if (matches) {
        console.log(`[DEBUG] Found matching assignment for ${detectionClass}:`, ma);
      }
      return matches;
    });

    const count = assignmentsForClass.reduce(
      (sum: number, ma: any) => sum + (ma.quantity || ma.count || ma.qty || 1), 0
    );

    console.log(`[DEBUG] getAssignedCount('${detectionClass}'): found ${assignmentsForClass.length} assignments, total count: ${count}`);
    return count;
  };

  // Calculate unassigned penetrations (those without manual material assignments)
  const unassignedVentCount = Math.max(0, ventCount - getAssignedCount('vent'));
  const unassignedGableVentCount = Math.max(0, gableVentCount - getAssignedCount('gable_vent'));
  const unassignedOutletCount = Math.max(0, outletCount - getAssignedCount('outlet'));
  const unassignedHoseBibCount = Math.max(0, hoseBibCount - getAssignedCount('hose_bib'));
  const unassignedLightFixtureCount = Math.max(0, lightFixtureCount - getAssignedCount('light_fixture'));

  const totalUnassignedPenetrations = unassignedVentCount + unassignedGableVentCount +
    unassignedOutletCount + unassignedHoseBibCount + unassignedLightFixtureCount;

  console.log(`🔍 Penetration check: ${ventCount} vents (${unassignedVentCount} unassigned), ${gableVentCount} gable vents (${unassignedGableVentCount} unassigned)`);

  if (totalUnassignedPenetrations > 0) {
    console.log(`✅ GENERATING PENETRATION FLASHING for ${totalUnassignedPenetrations} unassigned penetrations (skipping ${ventCount + gableVentCount + outletCount + hoseBibCount + lightFixtureCount - totalUnassignedPenetrations} with material assignments)`);

    // Penetration flashing blocks
    const flashBlockCost = 8.50;
    const flashBlockExtended = totalUnassignedPenetrations * flashBlockCost;
    lineItems.push({
      description: 'Siding Penetration Flashing Block',
      sku: 'FLASH-PENETRATION',
      quantity: totalUnassignedPenetrations,
      unit: 'ea',
      category: 'penetration',
      presentation_group: 'Flashing & Weatherproofing',
      item_order: 10,
      material_unit_cost: flashBlockCost,
      material_extended: flashBlockExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: flashBlockExtended,
      calculation_source: 'auto-scope',
      notes: `Penetration flashing (unassigned only): ${unassignedVentCount} vents + ${unassignedGableVentCount} gable vents + ${unassignedOutletCount} outlets + ${unassignedHoseBibCount} hose bibs + ${unassignedLightFixtureCount} lights = ${totalUnassignedPenetrations}`,
    });
    totalMaterialCost += flashBlockExtended;

    // Caulk for penetrations
    const penetrationCaulkTubes = Math.ceil(totalUnassignedPenetrations / 10);
    const penetrationCaulkCost = 8.50;
    const penetrationCaulkExtended = penetrationCaulkTubes * penetrationCaulkCost;
    lineItems.push({
      description: 'Sealant for Penetrations',
      sku: 'CAULK-PENETRATION',
      quantity: penetrationCaulkTubes,
      unit: 'tube',
      category: 'penetration',
      presentation_group: 'Flashing & Weatherproofing',
      item_order: 11,
      material_unit_cost: penetrationCaulkCost,
      material_extended: penetrationCaulkExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: penetrationCaulkExtended,
      calculation_source: 'auto-scope',
      notes: `Penetration sealant: ${totalUnassignedPenetrations} ÷ 10 per tube = ${penetrationCaulkTubes} tubes`,
    });
    totalMaterialCost += penetrationCaulkExtended;

    console.log(`📦 Added penetration flashing items totaling $${(flashBlockExtended + penetrationCaulkExtended).toFixed(2)}`);
  } else if (ventCount + gableVentCount + outletCount + hoseBibCount + lightFixtureCount > 0) {
    console.log(`⏭️ SKIPPING penetration flashing - all ${ventCount + gableVentCount + outletCount + hoseBibCount + lightFixtureCount} penetrations have material assignments`);
  }

  // Gable vents need additional trim ring (only for unassigned gable vents)
  if (unassignedGableVentCount > 0) {
    const gableVentTrimCost = 12.00;
    const gableVentTrimExtended = unassignedGableVentCount * gableVentTrimCost;
    lineItems.push({
      description: 'Gable Vent Trim Ring',
      sku: 'GABLE-VENT-TRIM',
      quantity: unassignedGableVentCount,
      unit: 'ea',
      category: 'gable_vent',
      presentation_group: 'Flashing & Weatherproofing',
      item_order: 12,
      material_unit_cost: gableVentTrimCost,
      material_extended: gableVentTrimExtended,
      labor_unit_cost: 0,
      labor_extended: 0,
      total_extended: gableVentTrimExtended,
      calculation_source: 'auto-scope',
      notes: `Gable vent trim rings: ${unassignedGableVentCount} unassigned vents (${gableVentCount - unassignedGableVentCount} have material assignments)`,
    });
    totalMaterialCost += gableVentTrimExtended;
  }

  // =========================================================================
  // ROOFING COMPONENTS - Log only (for roofing trade)
  // =========================================================================
  const eaveLf = detectionCounts?.eave?.total_lf || 0;
  const rakeLf = detectionCounts?.rake?.total_lf || 0;
  const ridgeLf = detectionCounts?.ridge?.total_lf || 0;
  const valleyLf = detectionCounts?.valley?.total_lf || 0;

  if (eaveLf > 0 || rakeLf > 0 || ridgeLf > 0 || valleyLf > 0) {
    console.log('📏 Roofing components detected:');
    console.log(`   - Eave: ${eaveLf.toFixed(1)} LF`);
    console.log(`   - Rake: ${rakeLf.toFixed(1)} LF`);
    console.log(`   - Ridge: ${ridgeLf.toFixed(1)} LF`);
    console.log(`   - Valley: ${valleyLf.toFixed(1)} LF`);
    console.log('   (These are passed to roofing trade API for drip edge, starter, ridge cap calculations)');
  }

  // =========================================================================
  // SUMMARY LOG - All Detection-Generated Items
  // =========================================================================
  const detectionGeneratedItems = lineItems.filter(item =>
    item.notes?.toLowerCase().includes('detection') ||
    item.notes?.toLowerCase().includes('from detection')
  );
  console.log('📦 Total detection-generated items:', detectionGeneratedItems.length);

  // =========================================================================
  // PART 3: Calculate Labor and Overhead using Mike Skjei Methodology
  // =========================================================================

  // Calculate material total (sum of material_extended from all items)
  const materialTotal = lineItems.reduce((sum, item) => sum + (item.material_extended || 0), 0);
  console.log(`📊 Material total: $${materialTotal.toFixed(2)}`);

  // Get facade area for labor calculations
  // IMPORTANT: Use gross facade area (NOT net siding) for WRB and demo calculations
  // WRB covers the entire wall including areas behind openings
  // Cast to any to check all possible property names since types may not be complete
  const wmLabor = webhookMeasurements as any;

  console.log(`   [DEBUG] webhookMeasurements keys: ${Object.keys(wmLabor || {}).join(', ')}`);
  console.log(`   [DEBUG] wmLabor.facade_area_sqft: ${wmLabor?.facade_area_sqft}`);
  console.log(`   [DEBUG] wmLabor.facade_sqft: ${wmLabor?.facade_sqft}`);
  console.log(`   [DEBUG] wmLabor.facade_total_sqft: ${wmLabor?.facade_total_sqft}`);
  console.log(`   [DEBUG] wmLabor.gross_wall_area_sqft: ${wmLabor?.gross_wall_area_sqft}`);
  console.log(`   [DEBUG] wmLabor.net_siding_area_sqft: ${wmLabor?.net_siding_area_sqft}`);

  const facadeAreaSqft = wmLabor?.facade_area_sqft ||      // MeasurementContext uses this
    wmLabor?.facade_sqft ||                                 // WebhookMeasurements type has this
    wmLabor?.facade_total_sqft ||                           // Database column name
    wmLabor?.gross_wall_area_sqft ||                        // Alternative name
    wmLabor?.net_siding_area_sqft ||                        // Fallback only if gross not available
    wmLabor?.net_siding_sqft ||                             // Another variation
    0;

  // Calculate installation labor using auto-scope rules (or legacy method if no rules)
  let laborItems: LaborLineItem[];
  let laborSubtotal: number;

  console.log(`\n👷 LABOR CALCULATION START`);
  console.log(`   laborAutoScopeRules.length: ${laborAutoScopeRules.length}`);
  console.log(`   facadeAreaSqft: ${facadeAreaSqft}`);
  console.log(`   lineItems.length: ${lineItems.length}`);
  console.log(`   laborRates.length: ${laborRates.length}`);

  if (laborAutoScopeRules.length > 0) {
    console.log(`   → Using rules-based labor calculation`);
    // Use new rules-based labor calculation with labor_class grouping
    const laborResult = calculateInstallationLaborFromRules(
      lineItems,
      laborAutoScopeRules,
      detectionCounts,
      facadeAreaSqft,
      laborRates  // Pass laborRates for labor_class-based grouping
    );
    laborItems = laborResult.laborItems;
    laborSubtotal = laborResult.subtotal;
  } else {
    // Fall back to legacy method
    const laborResult = calculateInstallationLaborLegacy(
      lineItems,
      laborRates,
      'lap_siding'
    );
    laborItems = laborResult.laborItems;
    laborSubtotal = laborResult.subtotal;
  }

  // Calculate overhead costs (without project insurance - that's added after markup calculation)
  const { overheadItems, subtotal: overheadSubtotal } = calculateOverhead(
    sidingOverheadCosts,
    laborSubtotal
  );

  // Calculate final totals with markup
  const projectTotals = calculateProjectTotals(
    materialTotal,
    laborSubtotal,
    overheadSubtotal
  );

  // =========================================================================
  // ADD PROJECT INSURANCE AS OVERHEAD LINE ITEM
  // Project insurance is calculated on the marked-up subtotal, so it must be
  // added after calculateProjectTotals. This ensures it appears in the
  // takeoff_line_items and Excel export.
  // =========================================================================
  if (projectTotals.project_insurance > 0) {
    overheadItems.push({
      cost_id: 'PROJECT-INSURANCE',
      cost_name: 'Project Insurance',
      description: 'General liability and workers comp insurance for project',
      category: 'insurance',
      quantity: 1,
      unit: 'project',
      rate: projectTotals.project_insurance,
      amount: projectTotals.project_insurance,
      calculation_type: 'calculated',
      notes: `$${INSURANCE_RATE_PER_THOUSAND.toFixed(2)} per $1,000 of project subtotal ($${projectTotals.subtotal.toFixed(2)})`
    });
    console.log(`   📊 Project Insurance: $${projectTotals.project_insurance.toFixed(2)} (added to overhead items)`);
  }

  // Update overhead subtotal to include project insurance
  const overheadTotalWithInsurance = overheadSubtotal + projectTotals.project_insurance;

  // =========================================================================
  // PART 4: Build Result
  // =========================================================================

  const assignedCount = lineItems.filter(i => i.calculation_source === 'assigned_material').length;
  const autoScopeCount = lineItems.filter(i => i.calculation_source === 'auto-scope').length;

  return {
    success: true,
    line_items: lineItems,
    labor: {
      installation_items: laborItems,
      installation_subtotal: laborSubtotal,
    },
    overhead: {
      items: overheadItems,
      subtotal: overheadTotalWithInsurance,  // Includes project insurance
    },
    totals: {
      material_cost: projectTotals.material_cost,
      labor_cost: projectTotals.labor_total,
      overhead: projectTotals.overhead_subtotal,
      subtotal: projectTotals.subtotal,
      markup_percent: projectTotals.material_markup_rate * 100,
      markup_amount: projectTotals.material_markup_amount + projectTotals.labor_markup_amount,
      total: projectTotals.grand_total,
    },
    project_totals: projectTotals,
    metadata: {
      pricing_method: 'hybrid-v2',
      calculation_method: 'mike_skjei_v1',
      assigned_items_count: assignedCount,
      auto_scope_items_count: autoScopeCount,
      items_priced: assignedCount + autoScopeCount,
      items_missing: missingItems,
      items_before_consolidation: itemsBeforeConsolidation,
      items_after_consolidation: itemsAfterConsolidation,
      measurement_source: autoScopeResult.measurement_source,
      rules_evaluated: autoScopeResult.rules_evaluated,
      rules_triggered: autoScopeResult.rules_triggered,
      markup_rate: MARKUP_RATE,
      crew_size: DEFAULT_CREW_SIZE,
      estimated_weeks: DEFAULT_ESTIMATED_WEEKS,
      warnings,
    },
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Consolidate line items by pricing_item_id (or SKU as fallback)
 * Merges multiple items with the same product into a single line item
 */
function consolidateLineItems(lineItems: CombinedLineItem[]): CombinedLineItem[] {
  const consolidated = new Map<string, CombinedLineItem>();

  for (const item of lineItems) {
    const key = item.pricing_item_id || item.sku;

    if (consolidated.has(key)) {
      const existing = consolidated.get(key)!;
      existing.quantity += item.quantity;
      existing.material_extended += item.material_extended;
      existing.labor_extended += item.labor_extended;
      existing.total_extended += item.total_extended;
      existing.squares_for_labor = (existing.squares_for_labor || 0) + (item.squares_for_labor || 0);

      // Track all detection IDs for provenance
      if (item.detection_ids) {
        existing.detection_ids = [...(existing.detection_ids || []), ...item.detection_ids];
      } else if (item.detection_id) {
        existing.detection_ids = [...(existing.detection_ids || []), item.detection_id];
      }
      existing.detection_count = (existing.detection_count || 1) + 1;
    } else {
      consolidated.set(key, {
        ...item,
        detection_ids: item.detection_ids || (item.detection_id ? [item.detection_id] : []),
        detection_count: 1,
        squares_for_labor: item.squares_for_labor || 0,
      });
    }
  }

  // Round all monetary values and return
  return Array.from(consolidated.values()).map(item => ({
    ...item,
    quantity: Math.round(item.quantity * 100) / 100,
    material_extended: Math.round(item.material_extended * 100) / 100,
    labor_extended: Math.round(item.labor_extended * 100) / 100,
    total_extended: Math.round(item.total_extended * 100) / 100
  }));
}

/**
 * Calculate material quantity based on assignment and pricing info
 */
function calculateMaterialQuantity(
  assignment: MaterialAssignment,
  pricing: PricingItem
): number {
  const wasteMultiplier = 1.12; // 12% waste factor
  const pricingUnit = pricing.unit?.toLowerCase() || '';

  // For siding: convert SF to squares (100 SF = 1 square)
  if (assignment.unit === 'SF' && (pricingUnit === 'square' || pricingUnit === 'sq')) {
    return Math.ceil((assignment.quantity * wasteMultiplier) / 100);
  }

  // For linear items sold by piece (e.g., 12ft pieces)
  if (assignment.unit === 'LF' && (pricingUnit === 'ea' || pricingUnit === 'pc' || pricingUnit === 'pieces')) {
    const pieceLength = 12; // Standard 12ft pieces
    return Math.ceil((assignment.quantity / pieceLength) * wasteMultiplier);
  }

  // For items sold by the same unit (SF to SF, LF to LF)
  if (assignment.unit === 'SF' && pricingUnit === 'sf') {
    return Math.ceil(assignment.quantity * wasteMultiplier);
  }

  if (assignment.unit === 'LF' && pricingUnit === 'lf') {
    return Math.ceil(assignment.quantity * wasteMultiplier);
  }

  // For siding/materials sold by piece with coverage data (e.g., HardiePlank)
  // Converts SF → ea using coverage_value from pricing_items
  if (assignment.unit === 'SF' && (pricingUnit === 'ea' || pricingUnit === 'pc' || pricingUnit === 'piece')) {
    const coveragePerPiece = pricing.coverage_value || 7.25; // Default to 7.25 SF per plank
    const pieces = Math.ceil((assignment.quantity * wasteMultiplier) / coveragePerPiece);

    console.log(`📐 SF→ea conversion: ${assignment.quantity} SF × ${wasteMultiplier} waste ÷ ${coveragePerPiece} coverage = ${pieces} pieces`);

    return pieces;
  }

  // Count-based items (EA to EA)
  if (assignment.unit === 'EA') {
    return assignment.quantity;
  }

  // Default: apply waste factor and return
  return Math.ceil(assignment.quantity * wasteMultiplier);
}

// Note: calculateLaborForMaterial removed - labor now calculated separately via calculateInstallationLabor()

/**
 * Map category to presentation group for consistent Excel output
 */
function getPresentationGroup(category?: string): string {
  const groupMap: Record<string, string> = {
    // Siding & Underlayment
    'siding': 'Siding',
    'lap_siding': 'Siding',
    'siding_panels': 'Siding',
    'shingle_siding': 'Siding',
    'panel_siding': 'Siding',
    'vertical_siding': 'Siding',
    'artisan': 'Siding',              // Artisan beaded lap siding (James Hardie)
    'artisan_siding': 'Siding',       // Alternative artisan category

    // Trim & Corners
    'trim': 'Trim',
    'corner': 'Corners',
    'corners': 'Corners',

    // Belly Band
    'belly_band': 'Belly Band',
    'belly_band_trim': 'Belly Band',
    'belly_band_flashing': 'Belly Band',
    'belly_band_fastener': 'Belly Band',
    'belly_band_caulk': 'Belly Band',

    // Soffit & Fascia
    'soffit': 'Soffit & Fascia',
    'soffit_panel': 'Soffit & Fascia',
    'soffit_trim': 'Soffit & Fascia',
    'soffit_fastener': 'Soffit & Fascia',
    'fascia': 'Soffit & Fascia',
    'fascia_board': 'Soffit & Fascia',
    'fascia_fastener': 'Soffit & Fascia',

    // Flashing & Weatherproofing
    'flashing': 'Flashing & Weatherproofing',
    'water_barrier': 'Flashing & Weatherproofing',
    'house_wrap': 'Flashing & Weatherproofing',
    'housewrap': 'Flashing & Weatherproofing',
    'wrb': 'Flashing & Weatherproofing',
    'weatherproofing': 'Flashing & Weatherproofing',
    'penetration': 'Flashing & Weatherproofing',
    'vent': 'Flashing & Weatherproofing',
    'vents': 'Flashing & Weatherproofing',  // Plural category from pricing_items
    'gable_vent': 'Flashing & Weatherproofing',
    'light_fixture': 'Flashing & Weatherproofing',
    'outlet': 'Flashing & Weatherproofing',
    'hose_bib': 'Flashing & Weatherproofing',

    // Fasteners & Accessories
    'fasteners': 'Fasteners',
    'accessories': 'Accessories',

    // Caulk & Sealants
    'caulk': 'Caulk & Sealants',

    // Architectural Details
    'corbel': 'Architectural Details',
    'bracket': 'Architectural Details',
    'shutter': 'Architectural Details',
    'post': 'Architectural Details',
    'column': 'Architectural Details',
    'architectural': 'Architectural Details',

    // Gutters & Downspouts
    'gutter': 'Gutters & Downspouts',
    'gutter_hanger': 'Gutters & Downspouts',
    'gutter_accessory': 'Gutters & Downspouts',
    'downspout': 'Gutters & Downspouts',
    'downspout_bracket': 'Gutters & Downspouts',

    // Roofing Components
    'eave': 'Roofing Components',
    'rake': 'Roofing Components',
    'ridge': 'Roofing Components',
    'valley': 'Roofing Components',

    // Paint & Primer
    'paint': 'Paint & Primer',
  };

  return groupMap[category?.toLowerCase() || ''] || 'Other Materials';
}

/**
 * Normalize presentation_group to consistent capitalized format
 * This ensures both material_assignments and auto-scope items use the same group names
 */
function normalizePresentationGroup(group?: string): string {
  const normalizeMap: Record<string, string> = {
    // Siding
    'siding': 'Siding',
    'siding & underlayment': 'Siding',

    // Trim & Corners
    'trim': 'Trim',
    'corners': 'Corners',
    'corner': 'Corners',
    'trim & corners': 'Trim',

    // Belly Band
    'belly band': 'Belly Band',
    'belly_band': 'Belly Band',

    // Soffit & Fascia
    'soffit': 'Soffit & Fascia',
    'fascia': 'Soffit & Fascia',
    'soffit & fascia': 'Soffit & Fascia',

    // Flashing & Weatherproofing
    'flashing': 'Flashing & Weatherproofing',
    'flashing & weatherproofing': 'Flashing & Weatherproofing',
    'house wrap & accessories': 'Flashing & Weatherproofing',
    'house wrap': 'Flashing & Weatherproofing',
    'housewrap': 'Flashing & Weatherproofing',
    'water_barrier': 'Flashing & Weatherproofing',
    'wrb': 'Flashing & Weatherproofing',
    'weatherproofing': 'Flashing & Weatherproofing',
    'penetrations': 'Flashing & Weatherproofing',

    // Fasteners & Accessories
    'fasteners': 'Fasteners',
    'fasteners & accessories': 'Fasteners',
    'accessories': 'Accessories',

    // Caulk & Sealants
    'caulk & sealants': 'Caulk & Sealants',
    'caulk': 'Caulk & Sealants',
    'sealants': 'Caulk & Sealants',

    // Architectural Details
    'architectural': 'Architectural Details',
    'architectural details': 'Architectural Details',

    // Gutters & Downspouts
    'gutter': 'Gutters & Downspouts',
    'gutters': 'Gutters & Downspouts',
    'gutters & downspouts': 'Gutters & Downspouts',

    // Roofing Components
    'roofing': 'Roofing Components',
    'roofing components': 'Roofing Components',

    // Paint & Primer
    'paint & primer': 'Paint & Primer',
    'paint': 'Paint & Primer',

    // Other
    'other materials': 'Other Materials',
    'other': 'Other Materials',
  };

  const lowered = group?.toLowerCase() || '';
  return normalizeMap[lowered] || group || 'Other Materials';
}

/**
 * Get item_order for a presentation group
 * Higher values appear at the bottom of the group in Excel output
 */
function getItemOrder(_presentationGroup: string, _category?: string): number {
  // All items use default order - section grouping handles organization
  return 10;
}
