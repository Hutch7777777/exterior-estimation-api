/**
 * Orchestrator V2 - Combines Material Assignments with Auto-Scope
 * Uses database-driven auto-scope rules for complete takeoff generation
 */

import { MaterialAssignment, WebhookMeasurements } from '../../types/webhook';
import {
  getPricingByIds,
  PricingItem
} from '../../services/pricing';
import {
  generateAutoScopeItemsV2,
  buildMeasurementContext
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
 * Calculate installation labor based on Mike Skjei methodology
 */
function calculateInstallationLabor(
  materials: CombinedLineItem[],
  laborRates: LaborRate[],
  productCategory: string = 'lap_siding'
): { laborItems: LaborLineItem[], subtotal: number } {

  console.log('👷 Calculating installation labor...');
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

  return {
    material_cost: Math.round(materialCost * 100) / 100,
    material_markup_rate: markupRate,
    material_markup_amount: Math.round(materialMarkupAmount * 100) / 100,
    material_total: Math.round(materialTotal * 100) / 100,

    installation_labor_subtotal: Math.round(installationLaborSubtotal * 100) / 100,
    overhead_subtotal: Math.round(overheadSubtotal * 100) / 100,
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
  markupRate: number = 0.15
): Promise<V2CalculationResult> {
  const warnings: Array<{ code: string; message: string }> = [];
  const lineItems: CombinedLineItem[] = [];
  const missingItems: string[] = [];

  let totalMaterialCost = 0;
  // Note: Per-item labor removed - labor calculated separately via calculateInstallationLabor()

  // =========================================================================
  // FETCH LABOR RATES AND OVERHEAD COSTS FROM DATABASE
  // =========================================================================

  let laborRates: LaborRate[] = [];
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

  if (materialAssignments && materialAssignments.length > 0) {
    // Batch fetch pricing for all assigned materials
    const pricingIds = materialAssignments.map(m => m.pricing_item_id);
    const pricingMap = await getPricingByIds(pricingIds, organizationId);

    for (const assignment of materialAssignments) {
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

      // Calculate quantity based on unit conversion
      const quantity = calculateMaterialQuantity(assignment, pricing);
      const materialCost = quantity * Number(pricing.material_cost || 0);
      const materialExtended = Math.round(materialCost * 100) / 100;

      // Calculate squares for labor (SF / 100 = squares)
      let squaresForLabor = 0;
      if (assignment.unit === 'SF') {
        squaresForLabor = assignment.quantity / 100;
        console.log(`   📐 Squares for labor: ${assignment.quantity} SF / 100 = ${squaresForLabor.toFixed(2)} SQ`);
      }

      // Get consistent presentation_group and item_order
      const presentationGroup = getPresentationGroup(pricing.category);
      const itemOrder = getItemOrder(presentationGroup, pricing.category);

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

        calculation_source: 'assigned_material',
        pricing_item_id: assignment.pricing_item_id,
        detection_id: assignment.detection_id,
        detection_ids: [assignment.detection_id],
        detection_count: 1,
        notes: `From detection: ${assignment.quantity.toFixed(2)} ${assignment.unit}`,
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

  const autoScopeResult = await generateAutoScopeItemsV2(
    extractionId,
    webhookMeasurements as Record<string, any>,
    organizationId,
    { skipSidingPanels: hasSidingAssignments }
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
  // PART 3: Calculate Labor and Overhead using Mike Skjei Methodology
  // =========================================================================

  // Calculate material total (sum of material_extended from all items)
  const materialTotal = lineItems.reduce((sum, item) => sum + (item.material_extended || 0), 0);
  console.log(`📊 Material total: $${materialTotal.toFixed(2)}`);

  // Calculate installation labor using squares
  const { laborItems, subtotal: laborSubtotal } = calculateInstallationLabor(
    lineItems,
    laborRates,
    'lap_siding'
  );

  // Calculate overhead costs
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
      subtotal: overheadSubtotal,
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
    'siding': 'Siding',
    'lap_siding': 'Siding',
    'siding_panels': 'Siding',
    'shingle_siding': 'Siding',
    'panel_siding': 'Siding',
    'vertical_siding': 'Siding',
    'trim': 'Trim',
    'corner': 'Corners',
    'corners': 'Corners',
    'flashing': 'Flashing & Weatherproofing',
    'water_barrier': 'Flashing & Weatherproofing',
    'house_wrap': 'Flashing & Weatherproofing',
    'housewrap': 'Flashing & Weatherproofing',
    'wrb': 'Flashing & Weatherproofing',
    'weatherproofing': 'Flashing & Weatherproofing',
    'fasteners': 'Fasteners',
    'accessories': 'Accessories',
    'caulk': 'Caulk & Sealants',
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
    'siding': 'Siding',
    'trim': 'Trim',
    'corners': 'Corners',
    'corner': 'Corners',
    'flashing': 'Flashing & Weatherproofing',
    'flashing & weatherproofing': 'Flashing & Weatherproofing',
    'house wrap & accessories': 'Flashing & Weatherproofing',
    'house wrap': 'Flashing & Weatherproofing',
    'housewrap': 'Flashing & Weatherproofing',
    'water_barrier': 'Flashing & Weatherproofing',
    'wrb': 'Flashing & Weatherproofing',
    'weatherproofing': 'Flashing & Weatherproofing',
    'fasteners': 'Fasteners',
    'accessories': 'Accessories',
    'caulk & sealants': 'Caulk & Sealants',
    'caulk': 'Caulk & Sealants',
    'paint & primer': 'Paint & Primer',
    'paint': 'Paint & Primer',
    'other materials': 'Other Materials',
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
