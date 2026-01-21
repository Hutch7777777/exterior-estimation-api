/**
 * Orchestrator V2 - Combines Material Assignments with Auto-Scope
 * Uses database-driven auto-scope rules for complete takeoff generation
 */

import { MaterialAssignment, WebhookMeasurements } from '../../types/webhook';
import {
  getPricingByIds,
  calculateTotalLabor,
  PricingItem
} from '../../services/pricing';
import {
  generateAutoScopeItemsV2,
  buildMeasurementContext
} from './autoscope-v2';
import { AutoScopeLineItem } from '../../types/autoscope';

// ============================================================================
// TYPES
// ============================================================================

export interface CombinedLineItem {
  description: string;
  sku: string;
  quantity: number;
  unit: string;
  category: string;
  presentation_group: string;

  // Pricing
  material_unit_cost: number;
  material_extended: number;
  labor_unit_cost: number;
  labor_extended: number;

  // Metadata
  calculation_source: 'assigned_material' | 'auto-scope';
  pricing_item_id?: string;
  detection_id?: string;
  rule_id?: string;
  formula_used?: string;
  notes?: string;
}

export interface V2CalculationResult {
  success: boolean;
  line_items: CombinedLineItem[];
  totals: {
    material_cost: number;
    labor_cost: number;
    overhead: number;
    subtotal: number;
    markup_percent: number;
    markup_amount: number;
    total: number;
  };
  metadata: {
    pricing_method: 'hybrid-v2';
    assigned_items_count: number;
    auto_scope_items_count: number;
    items_priced: number;
    items_missing: string[];
    measurement_source: 'database' | 'webhook' | 'fallback';
    rules_evaluated: number;
    rules_triggered: number;
    warnings: Array<{ code: string; message: string }>;
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
  let totalLaborCost = 0;

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
      const laborCost = calculateLaborForMaterial(pricing, quantity);

      lineItems.push({
        description: pricing.product_name,
        sku: pricing.sku,
        quantity,
        unit: pricing.unit,
        category: pricing.category || assignment.detection_class,
        presentation_group: getPresentationGroup(pricing.category),

        material_unit_cost: Number(pricing.material_cost || 0),
        material_extended: Math.round(materialCost * 100) / 100,
        labor_unit_cost: Number(pricing.base_labor_cost || 0),
        labor_extended: Math.round(laborCost * 100) / 100,

        calculation_source: 'assigned_material',
        pricing_item_id: assignment.pricing_item_id,
        detection_id: assignment.detection_id,
        notes: `From detection: ${assignment.quantity.toFixed(2)} ${assignment.unit}`,
      });

      totalMaterialCost += materialCost;
      totalLaborCost += laborCost;
    }
  }

  // =========================================================================
  // PART 2: Generate Auto-Scope Items (SKU-based pricing)
  // =========================================================================

  const autoScopeResult = await generateAutoScopeItemsV2(
    extractionId,
    webhookMeasurements as Record<string, any>,
    organizationId
  );

  // Add auto-scope line items
  for (const autoItem of autoScopeResult.line_items) {
    lineItems.push({
      description: autoItem.description,
      sku: autoItem.sku,
      quantity: autoItem.quantity,
      unit: autoItem.unit,
      category: autoItem.category,
      presentation_group: autoItem.presentation_group,

      material_unit_cost: autoItem.material_unit_cost,
      material_extended: autoItem.material_extended,
      labor_unit_cost: autoItem.labor_unit_cost,
      labor_extended: autoItem.labor_extended,

      calculation_source: 'auto-scope',
      rule_id: autoItem.rule_id,
      formula_used: autoItem.formula_used,
      notes: autoItem.notes,
    });

    totalMaterialCost += autoItem.material_extended;
    totalLaborCost += autoItem.labor_extended;
  }

  // =========================================================================
  // PART 3: Calculate Totals
  // =========================================================================

  const overhead = totalLaborCost * 0.10; // 10% overhead on labor
  const subtotal = totalMaterialCost + totalLaborCost + overhead;
  const markupAmount = subtotal * markupRate;
  const total = subtotal + markupAmount;

  // =========================================================================
  // PART 4: Build Result
  // =========================================================================

  const assignedCount = lineItems.filter(i => i.calculation_source === 'assigned_material').length;
  const autoScopeCount = lineItems.filter(i => i.calculation_source === 'auto-scope').length;

  return {
    success: true,
    line_items: lineItems,
    totals: {
      material_cost: Math.round(totalMaterialCost * 100) / 100,
      labor_cost: Math.round(totalLaborCost * 100) / 100,
      overhead: Math.round(overhead * 100) / 100,
      subtotal: Math.round(subtotal * 100) / 100,
      markup_percent: markupRate * 100,
      markup_amount: Math.round(markupAmount * 100) / 100,
      total: Math.round(total * 100) / 100,
    },
    metadata: {
      pricing_method: 'hybrid-v2',
      assigned_items_count: assignedCount,
      auto_scope_items_count: autoScopeCount,
      items_priced: assignedCount + autoScopeCount,
      items_missing: missingItems,
      measurement_source: autoScopeResult.measurement_source,
      rules_evaluated: autoScopeResult.rules_evaluated,
      rules_triggered: autoScopeResult.rules_triggered,
      warnings,
    },
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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

  // Count-based items (EA to EA)
  if (assignment.unit === 'EA') {
    return assignment.quantity;
  }

  // Default: apply waste factor and return
  return Math.ceil(assignment.quantity * wasteMultiplier);
}

/**
 * Calculate labor cost for a material using Mike Skjei methodology
 */
function calculateLaborForMaterial(
  pricing: PricingItem,
  quantity: number
): number {
  const baseLaborCost = Number(pricing.base_labor_cost || 0);

  if (baseLaborCost === 0) return 0;

  // Use pre-calculated total if available, otherwise calculate
  const totalRate = pricing.total_labor_cost || calculateTotalLabor(baseLaborCost);

  return quantity * totalRate;
}

/**
 * Map category to presentation group for consistent Excel output
 */
function getPresentationGroup(category?: string): string {
  const groupMap: Record<string, string> = {
    'siding': 'Siding',
    'lap_siding': 'Siding',
    'trim': 'Trim',
    'corner': 'Corners',
    'corners': 'Corners',
    'flashing': 'Flashing',
    'fasteners': 'Fasteners',
    'accessories': 'Accessories',
    'water_barrier': 'House Wrap & Accessories',
    'caulk': 'Caulk & Sealants',
    'paint': 'Paint & Primer',
  };

  return groupMap[category?.toLowerCase() || ''] || 'Other Materials';
}
