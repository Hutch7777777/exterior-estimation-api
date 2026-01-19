/**
 * Siding Material Calculations
 * Based on confirmed formulas from n8n analysis
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MaterialLineItem,
  SidingMeasurements,
  SidingProductConfig,
  CalculationStep
} from '../../types';
import { CONVERSION_SPECS } from '../../constants';

/**
 * Calculate lap siding quantity in PIECES
 * Formula: (net_area_sf / reveal_inches) × waste_factor
 */
export function calculateLapSiding(
  measurements: SidingMeasurements,
  config: SidingProductConfig
): MaterialLineItem {
  const netArea = measurements.net_area_sf;
  const revealInches = config.reveal_inches || CONVERSION_SPECS.siding.default_reveal_inches;
  const wasteFactor = CONVERSION_SPECS.siding.waste_factor;
  const plankLength = CONVERSION_SPECS.siding.plank_length_ft;

  const rawPieces = netArea / revealInches;
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);
  const squaresForLabor = netArea / 100;

  const calculation: CalculationStep = {
    formula: '(net_area_sf / reveal_inches) × waste_factor',
    inputs: {
      net_area_sf: netArea,
      reveal_inches: revealInches,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  const profile = config.profile || 'smooth';
  const finish = config.finish === 'colorplus' ? config.color || 'ColorPlus' : 'Primed';
  const description = config.product_name ||
    `HardiePlank ${revealInches}" ${profile.charAt(0).toUpperCase() + profile.slice(1)} ${finish}`;

  // Generate SKU based on reveal and profile (mapped to database)
  const profileCode = profile === 'cedarmill' ? 'CM' : 'SM';
  const finishCode = config.finish === 'colorplus' ? 'CP-' : '';
  const generatedSku = `JH-LAP-${revealInches.toString().replace('.', '')}-${profileCode}-${finishCode}12`;

  return {
    id: uuidv4(),
    sku: config.product_sku || generatedSku,
    description,
    quantity: piecesWithWaste,
    unit: 'PC',
    size: `${revealInches}" reveal × ${plankLength}'`,
    category: 'siding',
    presentation_group: 'siding',
    source: 'calculated',
    calculation,
    labor_quantity: Math.round(squaresForLabor * 100) / 100,
    labor_unit: 'squares',
    notes: `Material: (${netArea} sqft ÷ ${revealInches}") × ${wasteFactor} = ${piecesWithWaste} pcs`
  };
}

/**
 * Calculate lap siding quantity in SQUARES
 * Formula: (net_area_sf × waste_factor) / 100
 */
export function calculateLapSidingSquares(
  measurements: SidingMeasurements,
  config: SidingProductConfig
): MaterialLineItem {
  const netArea = measurements.net_area_sf;
  const wasteFactor = CONVERSION_SPECS.siding.waste_factor;

  const rawSquares = netArea / 100;
  const squaresWithWaste = Math.ceil(rawSquares * wasteFactor);

  const calculation: CalculationStep = {
    formula: '(net_area_sf × waste_factor) / 100',
    inputs: {
      net_area_sf: netArea,
      waste_factor: wasteFactor
    },
    result: squaresWithWaste
  };

  const profile = config.profile || 'cedarmill';
  const revealInches = config.reveal_inches || 6.75;
  const description = config.product_name ||
    `James Hardie ${revealInches}" x 12' ${profile.charAt(0).toUpperCase() + profile.slice(1)} Lap Siding`;

  // Generate SKU based on reveal and profile (mapped to database)
  const profileCode = profile === 'cedarmill' ? 'CM' : 'SM';
  const finishCode = config.finish === 'colorplus' ? 'CP-' : '';
  const generatedSku = `JH-LAP-${revealInches.toString().replace('.', '')}-${profileCode}-${finishCode}12`;

  return {
    id: uuidv4(),
    sku: config.product_sku || generatedSku,
    description,
    quantity: squaresWithWaste,
    unit: 'SQUARE',
    size: `${revealInches}" reveal`,
    category: 'siding',
    presentation_group: 'siding',
    source: 'calculated',
    calculation,
    labor_quantity: Math.round(rawSquares * 100) / 100,
    labor_unit: 'squares',
    notes: `(${netArea} sqft × ${wasteFactor}) / 100 = ${squaresWithWaste} squares`
  };
}

/**
 * Calculate outside corner trim
 * Formula: (corner_lf / 12) × waste_factor
 */
export function calculateOutsideCorners(
  cornerLf: number,
  cornerCount: number,
  finish: 'primed' | 'colorplus',
  color?: string
): MaterialLineItem {
  const wasteFactor = CONVERSION_SPECS.corners.waste_factor;
  const pieceLength = CONVERSION_SPECS.corners.piece_length_ft;

  let effectiveLf = cornerLf;
  let isEstimated = false;

  if (effectiveLf <= 0 && cornerCount > 0) {
    effectiveLf = cornerCount * CONVERSION_SPECS.corners.default_height_ft;
    isEstimated = true;
  }

  const rawPieces = effectiveLf / pieceLength;
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);

  const calculation: CalculationStep = {
    formula: '(corner_lf / piece_length) × waste_factor',
    inputs: {
      corner_lf: effectiveLf,
      piece_length: pieceLength,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  const finishLabel = finish === 'colorplus' ? (color || 'Arctic White') : 'Primed';

  return {
    id: uuidv4(),
    sku: finish === 'colorplus' ? '111Z2BPW-CP' : '111Z2BPW',
    description: `Outside Corner - HardieTrim 5/4 x 4 x 12ft ${finishLabel}`,
    quantity: piecesWithWaste,
    unit: 'PC',
    size: '5/4 x 4 x 12\'',
    category: 'trim',
    presentation_group: 'trim',
    source: 'calculated',
    calculation,
    low_confidence: isEstimated,
    notes: `${effectiveLf} LF ÷ ${pieceLength} × ${wasteFactor} = ${piecesWithWaste} PC${isEstimated ? ' | ESTIMATED from count' : ''}`
  };
}

/**
 * Calculate inside corner trim (whitewood 2x2x16)
 * Formula: (corner_lf / 16) × waste_factor
 */
export function calculateInsideCorners(
  cornerLf: number,
  cornerCount: number
): MaterialLineItem {
  const wasteFactor = CONVERSION_SPECS.trim.waste_factor;
  const pieceLength = CONVERSION_SPECS.trim.whitewood_piece_length_ft;

  let effectiveLf = cornerLf;
  let isEstimated = false;

  if (effectiveLf <= 0 && cornerCount > 0) {
    effectiveLf = cornerCount * CONVERSION_SPECS.corners.default_height_ft;
    isEstimated = true;
  }

  const rawPieces = effectiveLf / pieceLength;
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);

  const calculation: CalculationStep = {
    formula: '(corner_lf / piece_length) × waste_factor',
    inputs: {
      corner_lf: effectiveLf,
      piece_length: pieceLength,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  return {
    id: uuidv4(),
    sku: 'FRIEZE-1X8X12',
    description: 'Frieze Board 1x8x12 (Inside Corner)',
    quantity: piecesWithWaste,
    unit: 'PC',
    size: '1" x 8" x 12\'',
    category: 'trim',
    presentation_group: 'trim',
    source: 'calculated',
    calculation,
    low_confidence: isEstimated,
    notes: `${effectiveLf} LF ÷ ${pieceLength} × ${wasteFactor} = ${piecesWithWaste} PC`
  };
}

/**
 * Calculate garage trim
 * Formula: (perimeter_lf / 12) × waste_factor
 */
export function calculateGarageTrim(
  perimeterLf: number,
  garageCount: number,
  finish: 'primed' | 'colorplus',
  color?: string
): MaterialLineItem {
  const wasteFactor = CONVERSION_SPECS.trim.waste_factor;
  const pieceLength = CONVERSION_SPECS.trim.hardie_piece_length_ft;

  let effectiveLf = perimeterLf;
  let isEstimated = false;

  // Estimate if not provided: 16'x8' garage = 40 LF perimeter
  if (effectiveLf <= 0 && garageCount > 0) {
    effectiveLf = garageCount * 40;
    isEstimated = true;
  }

  const rawPieces = effectiveLf / pieceLength;
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);

  const calculation: CalculationStep = {
    formula: '(perimeter_lf / piece_length) × waste_factor',
    inputs: {
      perimeter_lf: effectiveLf,
      piece_length: pieceLength,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  const finishLabel = finish === 'colorplus' ? (color || 'Arctic White') : 'Primed';

  return {
    id: uuidv4(),
    sku: finish === 'colorplus' ? 'HARDIE-TRIM-54X6-12FT-CP' : 'HARDIE-TRIM-54X6-12FT',
    description: `Garage Trim - HardieTrim 5/4 x 6 x 12ft ${finishLabel}`,
    quantity: piecesWithWaste,
    unit: 'PC',
    size: '5/4 x 6 x 12\'',
    category: 'trim',
    presentation_group: 'trim',
    source: 'calculated',
    calculation,
    low_confidence: isEstimated,
    notes: `${effectiveLf} LF ÷ ${pieceLength} × ${wasteFactor} = ${piecesWithWaste} PC${isEstimated ? ' | LOW CONFIDENCE - verify garage size' : ''}`
  };
}

/**
 * Calculate gable top-out trim (base pieces)
 * Formula: gable_count × 2 × waste_factor
 */
export function calculateGableTopOutBase(gableCount: number): MaterialLineItem {
  const wasteFactor = CONVERSION_SPECS.trim.waste_factor;

  const rawPieces = gableCount * 2;
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);

  const calculation: CalculationStep = {
    formula: 'gable_count × 2 × waste_factor',
    inputs: {
      gable_count: gableCount,
      multiplier: 2,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  return {
    id: uuidv4(),
    sku: 'FRIEZE-1X8X12',
    description: 'Frieze Board 1x8x12 (Gable Base)',
    quantity: piecesWithWaste,
    unit: 'PC',
    size: '1x8x12',
    category: 'trim',
    presentation_group: 'trim',
    source: 'calculated',
    calculation,
    notes: `gable_count × 2 = ${rawPieces} × ${wasteFactor} waste → ${piecesWithWaste} PC`
  };
}

/**
 * Calculate gable top-out trim (gable pieces)
 * Formula: ceil(gable_count × 3) × waste_factor
 */
export function calculateGableTopOutGable(gableCount: number): MaterialLineItem {
  const wasteFactor = CONVERSION_SPECS.trim.waste_factor;

  const rawPieces = Math.ceil(gableCount * 3);
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);

  const calculation: CalculationStep = {
    formula: 'ceil(gable_count × 3) × waste_factor',
    inputs: {
      gable_count: gableCount,
      multiplier: 3,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  return {
    id: uuidv4(),
    sku: 'FRIEZE-1X8X12',
    description: 'Frieze Board 1x8x12 (Gable Top-Out)',
    quantity: piecesWithWaste,
    unit: 'PC',
    size: '1x8x12',
    category: 'trim',
    presentation_group: 'trim',
    source: 'calculated',
    calculation,
    notes: `Math.ceil(gable_count × 3) = ${rawPieces} × ${wasteFactor} waste → ${piecesWithWaste} PC`
  };
}
