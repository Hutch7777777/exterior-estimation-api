/**
 * Auto-Scope Item Calculations
 * These items are automatically added based on siding area/configuration
 *
 * Based on January 2026 output formulas:
 * - House wrap: ceil((facade_sqft × 1.15) / 1350)
 * - Staples: ceil(facade_sqft / 500)
 * - Sealant: ceil(facade_sqft / 500)
 * - Touch-up paint: ceil(facade_sqft / 1500)
 */

import { v4 as uuidv4 } from 'uuid';
import { MaterialLineItem, CalculationStep } from '../../types';
import { CONVERSION_SPECS, COVERAGE_RATES, AUTO_SCOPE_SKUS } from '../../constants';

/**
 * Calculate house wrap rolls
 * Formula: ceil((facade_sqft × 1.15) / 1350)
 */
export function calculateHouseWrap(facadeSqft: number): MaterialLineItem {
  const wasteFactor = CONVERSION_SPECS.housewrap.waste_factor;
  const rollCoverage = CONVERSION_SPECS.housewrap.roll_coverage_sqft;

  const adjustedArea = facadeSqft * wasteFactor;
  const rolls = Math.ceil(adjustedArea / rollCoverage);

  const calculation: CalculationStep = {
    formula: 'ceil((facade_sqft × waste_factor) / roll_coverage)',
    inputs: {
      facade_sqft: facadeSqft,
      waste_factor: wasteFactor,
      roll_coverage: rollCoverage
    },
    result: rolls
  };

  return {
    id: uuidv4(),
    sku: AUTO_SCOPE_SKUS.housewrap,
    description: 'HardieWrap Weather Barrier',
    quantity: rolls,
    unit: 'ROLL',
    size: "9' x 150'",
    category: 'water_barrier',
    presentation_group: 'fasteners',
    source: 'auto-scope',
    calculation,
    notes: `Math.ceil((${facadeSqft} × ${wasteFactor}) / ${rollCoverage}) = ${rolls} ROLL`
  };
}

/**
 * Calculate house wrap staples
 * Formula: ceil(facade_sqft / 500)
 */
export function calculateStaples(facadeSqft: number): MaterialLineItem {
  const coveragePerBox = COVERAGE_RATES.staples_per_sqft;
  const boxes = Math.ceil(facadeSqft / coveragePerBox);

  const calculation: CalculationStep = {
    formula: 'ceil(facade_sqft / coverage_per_box)',
    inputs: {
      facade_sqft: facadeSqft,
      coverage_per_box: coveragePerBox
    },
    result: boxes
  };

  return {
    id: uuidv4(),
    sku: AUTO_SCOPE_SKUS.staples,
    description: 'A-11 Staples (House Wrap)',
    quantity: boxes,
    unit: 'BOX',
    size: 'A-11',
    category: 'fasteners',
    presentation_group: 'fasteners',
    source: 'auto-scope',
    calculation,
    notes: `Math.ceil(${facadeSqft} / ${coveragePerBox}) = ${boxes} BOX`
  };
}

/**
 * Calculate paintable sealant
 * Formula: ceil(facade_sqft / 500)
 */
export function calculateSealant(facadeSqft: number): MaterialLineItem {
  const coveragePerTube = COVERAGE_RATES.sealant_per_sqft;
  const tubes = Math.ceil(facadeSqft / coveragePerTube);

  const calculation: CalculationStep = {
    formula: 'ceil(facade_sqft / coverage_per_tube)',
    inputs: {
      facade_sqft: facadeSqft,
      coverage_per_tube: coveragePerTube
    },
    result: tubes
  };

  return {
    id: uuidv4(),
    sku: AUTO_SCOPE_SKUS.sealant,
    description: 'Paintable Sealant 10.1oz tube',
    quantity: tubes,
    unit: 'EA',
    size: '10.1oz',
    category: 'accessories',
    presentation_group: 'fasteners',
    source: 'auto-scope',
    calculation,
    notes: `Math.ceil(${facadeSqft} / ${coveragePerTube}) = ${tubes} EA`
  };
}

/**
 * Calculate touch-up paint
 * Formula: ceil(facade_sqft / 1500)
 */
export function calculateTouchUpPaint(facadeSqft: number): MaterialLineItem {
  const coveragePerQuart = COVERAGE_RATES.touchup_paint_per_sqft;
  const quarts = Math.ceil(facadeSqft / coveragePerQuart);

  const calculation: CalculationStep = {
    formula: 'ceil(facade_sqft / coverage_per_quart)',
    inputs: {
      facade_sqft: facadeSqft,
      coverage_per_quart: coveragePerQuart
    },
    result: quarts
  };

  return {
    id: uuidv4(),
    sku: AUTO_SCOPE_SKUS.touchup_paint,
    description: 'Touch-Up Paint Quart',
    quantity: quarts,
    unit: 'EA',
    size: 'Quart',
    category: 'accessories',
    presentation_group: 'fasteners',
    source: 'auto-scope',
    calculation,
    notes: `Math.ceil(${facadeSqft} / ${coveragePerQuart}) = ${quarts} EA`
  };
}

/**
 * Calculate Hardie blade (fixed quantity)
 */
export function calculateHardieBlade(): MaterialLineItem {
  return {
    id: uuidv4(),
    sku: AUTO_SCOPE_SKUS.hardie_blade,
    description: 'Hardie Blade - Fiber Cement Cutting',
    quantity: 1,
    unit: 'EA',
    size: 'Blade',
    category: 'accessories',
    presentation_group: 'fasteners',
    source: 'auto-scope',
    calculation: {
      formula: 'fixed = 1',
      inputs: {},
      result: 1
    },
    notes: '1 = 1 EA'
  };
}

/**
 * Calculate spackle (fixed quantity)
 */
export function calculateSpackle(): MaterialLineItem {
  return {
    id: uuidv4(),
    sku: AUTO_SCOPE_SKUS.spackle,
    description: 'Spackle 6oz (Nail Hole Filler)',
    quantity: 1,
    unit: 'TUBE',
    size: '6oz',
    category: 'accessories',
    presentation_group: 'fasteners',
    source: 'auto-scope',
    calculation: {
      formula: 'fixed = 1',
      inputs: {},
      result: 1
    },
    notes: '1 = 1 TUBE'
  };
}

/**
 * Calculate butyl mastic (fixed quantity)
 */
export function calculateButylMastic(): MaterialLineItem {
  return {
    id: uuidv4(),
    sku: AUTO_SCOPE_SKUS.butyl_mastic,
    description: 'Black Jack Butyl Mastic',
    quantity: 1,
    unit: 'TUBE',
    size: 'BMastic',
    category: 'accessories',
    presentation_group: 'fasteners',
    source: 'auto-scope',
    calculation: {
      formula: 'fixed = 1',
      inputs: {},
      result: 1
    },
    notes: '1 = 1 TUBE'
  };
}

/**
 * Generate all auto-scope items for a siding project
 */
export function generateAutoScopeItems(facadeSqft: number): MaterialLineItem[] {
  if (facadeSqft <= 0) {
    return [];
  }

  return [
    calculateHouseWrap(facadeSqft),
    calculateStaples(facadeSqft),
    calculateSealant(facadeSqft),
    calculateTouchUpPaint(facadeSqft),
    calculateHardieBlade(),
    calculateSpackle(),
    calculateButylMastic()
  ];
}
