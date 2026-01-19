/**
 * Main Siding Calculation Orchestrator
 * Coordinates all calculation functions and assembles the response
 */

import {
  CalculationRequest,
  CalculationResponse,
  MaterialLineItem,
  PricedCalculationResponse
} from '../../types';

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
