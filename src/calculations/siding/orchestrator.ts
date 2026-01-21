/**
 * Main Siding Calculation Orchestrator
 * Coordinates all calculation functions and assembles the response
 * Supports both SKU-based and ID-based pricing paths
 */

import {
  CalculationRequest,
  CalculationResponse,
  MaterialLineItem,
  PricedCalculationResponse
} from '../../types';

import { MaterialAssignment } from '../../types/webhook';

import {
  calculateLapSidingSquares,
  calculateOutsideCorners,
  calculateInsideCorners,
  calculateGarageTrim,
  calculateGableTopOutBase,
  calculateGableTopOutGable
} from './materials';

import {
  calculateWindowTrim,
  calculateDoorTrim,
  calculateWindowHeadFlashing,
  calculateDoorHeadFlashing
} from './trim';

import { generateAutoScopeItems } from './autoscope';

import {
  applyPricingToMaterials,
  generateLaborItems,
  calculateTotals
} from './pricing';

import {
  getPricingByIds,
  PricingItem,
  calculateTotalLabor
} from '../../services/pricing';

interface CalculationWarning {
  code: string;
  message: string;
  field?: string;
}

/**
 * Main calculation function
 * Takes a CalculationRequest and returns a complete CalculationResponse
 */
export async function calculateSiding(
  request: CalculationRequest
): Promise<CalculationResponse> {
  const warnings: CalculationWarning[] = [];
  const materials: MaterialLineItem[] = [];

  const { measurements, config } = request;
  const { siding, openings, corners, gables } = measurements;

  // =========================================================================
  // 1. MAIN SIDING
  // =========================================================================

  if (siding.net_area_sf > 0) {
    // Use squares format for material ordering (matches January 2026 output)
    const sidingItem = calculateLapSidingSquares(siding, config.siding);
    materials.push(sidingItem);
  } else {
    warnings.push({
      code: 'NO_SIDING_AREA',
      message: 'Net siding area is zero or not provided',
      field: 'measurements.siding.net_area_sf'
    });
  }

  // =========================================================================
  // 2. GABLE TOP-OUT TRIM
  // =========================================================================

  if (gables && gables.count > 0) {
    materials.push(calculateGableTopOutBase(gables.count));
    materials.push(calculateGableTopOutGable(gables.count));
  }

  // =========================================================================
  // 3. GARAGE TRIM
  // =========================================================================

  if (config.garage_trim?.include !== false && openings.garages.count > 0) {
    const garageTrim = calculateGarageTrim(
      openings.garages.perimeter_lf,
      openings.garages.count,
      config.garage_trim?.finish || config.corner_trim?.finish || 'primed',
      config.garage_trim?.color || config.corner_trim?.color
    );
    materials.push(garageTrim);
  }

  // =========================================================================
  // 4. CORNERS
  // =========================================================================

  if (corners.outside.count > 0 || corners.outside.total_lf > 0) {
    const outsideCorners = calculateOutsideCorners(
      corners.outside.total_lf,
      corners.outside.count,
      config.corner_trim?.finish || 'primed',
      config.corner_trim?.color
    );
    materials.push(outsideCorners);

    if (outsideCorners.low_confidence) {
      warnings.push({
        code: 'CORNER_LF_ESTIMATED',
        message: 'Outside corner LF estimated from count × 10ft',
        field: 'measurements.corners.outside.total_lf'
      });
    }
  }

  if (corners.inside.count > 0 || corners.inside.total_lf > 0) {
    const insideCorners = calculateInsideCorners(
      corners.inside.total_lf,
      corners.inside.count
    );
    materials.push(insideCorners);

    if (insideCorners.low_confidence) {
      warnings.push({
        code: 'CORNER_LF_ESTIMATED',
        message: 'Inside corner LF estimated from count × 10ft',
        field: 'measurements.corners.inside.total_lf'
      });
    }
  }

  // =========================================================================
  // 5. WINDOW TRIM & FLASHING
  // =========================================================================

  if (config.window_trim?.include && openings.windows.count > 0) {
    const windowTrim = calculateWindowTrim(
      openings.windows.perimeter_lf,
      openings.windows.count,
      config.window_trim
    );
    if (windowTrim) {
      materials.push(windowTrim);

      if (windowTrim.low_confidence) {
        warnings.push({
          code: 'WINDOW_TRIM_ESTIMATED',
          message: 'Window trim LF estimated from count × 14',
          field: 'measurements.openings.windows.perimeter_lf'
        });
      }
    }

    // Window head flashing
    const windowFlashing = calculateWindowHeadFlashing(
      openings.windows.head_lf || 0,
      openings.windows.count
    );
    if (windowFlashing) {
      materials.push(windowFlashing);
    }
  }

  // =========================================================================
  // 6. DOOR TRIM & FLASHING
  // =========================================================================

  if (config.door_trim?.include && openings.doors.count > 0) {
    const doorTrim = calculateDoorTrim(
      openings.doors.perimeter_lf,
      openings.doors.count,
      config.door_trim
    );
    if (doorTrim) {
      materials.push(doorTrim);
    }

    // Door head flashing
    const doorFlashing = calculateDoorHeadFlashing(
      openings.doors.head_lf || 0,
      openings.doors.count
    );
    if (doorFlashing) {
      materials.push(doorFlashing);
    }
  }

  // =========================================================================
  // 7. AUTO-SCOPE ITEMS
  // =========================================================================

  const facadeSqft = siding.gross_area_sf || siding.net_area_sf;
  if (facadeSqft > 0) {
    const autoScopeItems = generateAutoScopeItems(facadeSqft);
    materials.push(...autoScopeItems);
  }

  // =========================================================================
  // 8. BUILD RESPONSE
  // =========================================================================

  return {
    success: true,
    trade: 'siding',
    materials,
    provenance: {
      version: 'siding-calc-v2.0.0',
      timestamp: new Date().toISOString(),
      warnings
    }
  };
}

/**
 * Calculate siding with pricing from database
 * Extends calculateSiding with material pricing, labor costs, and totals
 */
export async function calculateSidingWithPricing(
  request: CalculationRequest,
  markupRate: number = 0.15
): Promise<PricedCalculationResponse> {
  // Get base calculation
  const baseResult = await calculateSiding(request);

  // Apply pricing to materials
  const { pricedMaterials, skusFound, skusMissing, snapshotName } =
    await applyPricingToMaterials(baseResult.materials);

  // Calculate net siding sqft for labor
  const netSidingSqft = request.measurements.siding.net_area_sf;
  const trimLf = request.measurements.openings.windows.perimeter_lf +
                 request.measurements.openings.doors.perimeter_lf;
  const cornerLf = request.measurements.corners.outside.total_lf +
                   request.measurements.corners.inside.total_lf;
  const gableCount = request.measurements.gables?.count || 0;

  // Generate labor items
  const labor = await generateLaborItems(baseResult.materials, {
    net_siding_sqft: netSidingSqft,
    trim_lf: trimLf,
    corner_lf: cornerLf,
    gable_count: gableCount
  });

  // Calculate totals
  const totals = calculateTotals(pricedMaterials, labor, markupRate);

  return {
    ...baseResult,
    materials: pricedMaterials,
    labor,
    totals,
    pricing_metadata: {
      snapshot_name: snapshotName,
      skus_found: skusFound,
      skus_missing: skusMissing
    }
  };
}

// ============================================================================
// ID-BASED PRICING PATH (for material_assignments from Detection Editor)
// ============================================================================

export interface AssignmentLineItem {
  description: string;
  sku: string;
  quantity: number;
  unit: string;
  category: string;
  material_unit_cost: number;
  material_extended: number;
  labor_unit_cost: number;
  labor_extended: number;
  total_extended: number;
  calculation_source: 'assigned_material' | 'auto-scope';
  pricing_item_id?: string;
  detection_id?: string;
  detection_ids?: string[];
  detection_count?: number;
  notes?: string;
}

export interface MaterialAssignmentResult {
  success: boolean;
  line_items: AssignmentLineItem[];
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
    pricing_method: 'id-based';
    items_priced: number;
    items_missing: string[];
    items_before_consolidation: number;
    items_after_consolidation: number;
    warnings: Array<{ code: string; message: string }>;
  };
}

/**
 * Consolidate line items by pricing_item_id (or SKU as fallback)
 * Merges multiple items with the same product into a single line item
 */
function consolidateLineItems(lineItems: AssignmentLineItem[]): AssignmentLineItem[] {
  const consolidated = new Map<string, AssignmentLineItem>();

  for (const item of lineItems) {
    const key = item.pricing_item_id || item.sku;

    if (consolidated.has(key)) {
      const existing = consolidated.get(key)!;
      existing.quantity += item.quantity;
      existing.material_extended += item.material_extended;
      existing.labor_extended += item.labor_extended;
      existing.total_extended += item.total_extended;

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
        detection_count: 1
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
 * Calculate from material assignments (ID-based pricing)
 * This is the new path used when Detection Editor sends assigned materials
 */
export async function calculateFromMaterialAssignments(
  materialAssignments: MaterialAssignment[],
  organizationId?: string,
  facadeSqft?: number,
  markupRate: number = 0.15
): Promise<MaterialAssignmentResult> {
  const warnings: Array<{ code: string; message: string }> = [];

  // Get all pricing in one batch query
  const pricingIds = materialAssignments.map(m => m.pricing_item_id);
  const pricingMap = await getPricingByIds(pricingIds, organizationId);

  const lineItems: AssignmentLineItem[] = [];
  let totalMaterialCost = 0;
  let totalLaborCost = 0;
  const missingItems: string[] = [];

  // Process each material assignment
  for (const assignment of materialAssignments) {
    const pricing = pricingMap.get(assignment.pricing_item_id);

    if (!pricing) {
      console.warn(`⚠️ No pricing found for ID: ${assignment.pricing_item_id}`);
      missingItems.push(assignment.pricing_item_id);
      warnings.push({
        code: 'PRICING_NOT_FOUND',
        message: `No pricing found for material ID: ${assignment.pricing_item_id}`
      });
      continue;
    }

    // Calculate quantity based on unit and coverage
    const quantity = calculateMaterialQuantity(assignment, pricing);
    const materialCost = quantity * Number(pricing.material_cost || 0);

    // Calculate labor based on the material type
    const laborCost = calculateLaborForMaterial(pricing, quantity);

    const totalExtended = Math.round((materialCost + laborCost) * 100) / 100;

    lineItems.push({
      description: pricing.product_name,
      sku: pricing.sku,
      quantity,
      unit: pricing.unit,
      category: pricing.category || assignment.detection_class,
      material_unit_cost: Number(pricing.material_cost || 0),
      material_extended: Math.round(materialCost * 100) / 100,
      labor_unit_cost: Number(pricing.base_labor_cost || 0),
      labor_extended: Math.round(laborCost * 100) / 100,
      total_extended: totalExtended,
      calculation_source: 'assigned_material',
      pricing_item_id: assignment.pricing_item_id,
      detection_id: assignment.detection_id,
      detection_ids: [assignment.detection_id],
      detection_count: 1,
      notes: `From detection: ${assignment.quantity.toFixed(2)} ${assignment.unit}`,
    });

    totalMaterialCost += materialCost;
    totalLaborCost += laborCost;
  }

  // Consolidate line items by pricing_item_id BEFORE adding auto-scope items
  const itemsBeforeConsolidation = lineItems.length;
  const consolidatedLineItems = consolidateLineItems(lineItems);
  const itemsAfterConsolidation = consolidatedLineItems.length;

  // Clear and replace with consolidated items
  lineItems.length = 0;
  lineItems.push(...consolidatedLineItems);

  // Add auto-scope items (house wrap, staples, etc.) based on facade area
  if (facadeSqft && facadeSqft > 0) {
    const autoScopeItems = generateAutoScopeItems(facadeSqft);
    for (const item of autoScopeItems) {
      lineItems.push({
        description: item.description,
        sku: item.sku,
        quantity: item.quantity,
        unit: item.unit,
        category: item.category || 'Accessories',
        material_unit_cost: 0, // Auto-scope pricing handled separately
        material_extended: 0,
        labor_unit_cost: 0,
        labor_extended: 0,
        total_extended: 0,
        calculation_source: 'auto-scope',
        notes: item.notes,
      });
    }
  }

  // Calculate totals
  const overhead = totalLaborCost * 0.10; // 10% overhead on labor
  const subtotal = totalMaterialCost + totalLaborCost + overhead;
  const markupAmount = subtotal * markupRate;
  const total = subtotal + markupAmount;

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
      pricing_method: 'id-based',
      items_priced: lineItems.filter(i => i.calculation_source === 'assigned_material').length,
      items_missing: missingItems,
      items_before_consolidation: itemsBeforeConsolidation,
      items_after_consolidation: itemsAfterConsolidation,
      warnings,
    },
  };
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

  // Count-based items (EA to EA)
  if (assignment.unit === 'EA') {
    return assignment.quantity;
  }

  // Default: apply waste factor and return
  return Math.ceil(assignment.quantity * wasteMultiplier);
}

/**
 * Calculate labor cost for a material using Mike Skjei methodology
 * Base + L&I (12.65%) + Unemployment (1.3%)
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
