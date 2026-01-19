/**
 * Trim Calculations for Windows, Doors, and Generic Trim
 * Formula: (perimeter_lf / 12) × waste_factor
 */

import { v4 as uuidv4 } from 'uuid';
import { MaterialLineItem, CalculationStep, TrimConfig } from '../../types';
import { CONVERSION_SPECS, TRIM_SKUS } from '../../constants';

/**
 * Calculate window trim
 * Formula: (perimeter_lf / 12) × waste_factor
 */
export function calculateWindowTrim(
  perimeterLf: number,
  windowCount: number,
  config: TrimConfig
): MaterialLineItem | null {
  if (!config.include || (perimeterLf <= 0 && windowCount <= 0)) {
    return null;
  }

  const wasteFactor = CONVERSION_SPECS.trim.waste_factor;
  const pieceLength = CONVERSION_SPECS.trim.hardie_piece_length_ft;

  // Estimate perimeter if not provided
  let effectiveLf = perimeterLf;
  let isEstimated = false;

  if (effectiveLf <= 0 && windowCount > 0) {
    // Average window: 3'×4' = 14 LF perimeter
    effectiveLf = windowCount * 14;
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

  const width = config.width || '4';
  const finish = config.finish || 'primed';
  const finishLabel = finish === 'colorplus' ? (config.color || 'Arctic White') : 'Primed';

  // Get SKU based on width and finish
  const skuKey = width as keyof typeof TRIM_SKUS.casing;
  const sku = TRIM_SKUS.casing[skuKey]?.[finish] || `JH-TRIM-CASING-${width}-12-${finish === 'colorplus' ? 'CP' : 'PR'}`;

  return {
    id: uuidv4(),
    sku,
    description: `Window Trim - HardieTrim 5/4 x ${width} x 12ft ${finishLabel}`,
    quantity: piecesWithWaste,
    unit: 'PC',
    size: `5/4 x ${width} x 12'`,
    category: 'trim',
    presentation_group: 'trim',
    source: 'calculated',
    calculation,
    low_confidence: isEstimated,
    notes: `${effectiveLf} LF ÷ ${pieceLength} × ${wasteFactor} = ${piecesWithWaste} PC${isEstimated ? ' | ESTIMATED from count' : ''}`
  };
}

/**
 * Calculate door trim
 * Formula: (perimeter_lf / 12) × waste_factor
 * Note: Doors have head + jambs only (no sill)
 */
export function calculateDoorTrim(
  perimeterLf: number,
  doorCount: number,
  config: TrimConfig
): MaterialLineItem | null {
  if (!config.include || (perimeterLf <= 0 && doorCount <= 0)) {
    return null;
  }

  const wasteFactor = CONVERSION_SPECS.trim.waste_factor;
  const pieceLength = CONVERSION_SPECS.trim.hardie_piece_length_ft;

  let effectiveLf = perimeterLf;
  let isEstimated = false;

  if (effectiveLf <= 0 && doorCount > 0) {
    // Average door: 3'×7' = 17 LF (head + jambs, no sill)
    effectiveLf = doorCount * 17;
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

  const width = config.width || '4';
  const finish = config.finish || 'primed';
  const finishLabel = finish === 'colorplus' ? (config.color || 'Arctic White') : 'Primed';

  const skuKey = width as keyof typeof TRIM_SKUS.casing;
  const sku = TRIM_SKUS.casing[skuKey]?.[finish] || `JH-TRIM-CASING-${width}-12-${finish === 'colorplus' ? 'CP' : 'PR'}`;

  return {
    id: uuidv4(),
    sku,
    description: `Door Trim - HardieTrim 5/4 x ${width} x 12ft ${finishLabel}`,
    quantity: piecesWithWaste,
    unit: 'PC',
    size: `5/4 x ${width} x 12'`,
    category: 'trim',
    presentation_group: 'trim',
    source: 'calculated',
    calculation,
    low_confidence: isEstimated,
    notes: `${effectiveLf} LF ÷ ${pieceLength} × ${wasteFactor} = ${piecesWithWaste} PC${isEstimated ? ' | ESTIMATED from count' : ''}`
  };
}

/**
 * Calculate window head flashing
 * Formula: (head_lf / 10) × waste_factor
 */
export function calculateWindowHeadFlashing(
  headLf: number,
  windowCount: number
): MaterialLineItem | null {
  if (headLf <= 0 && windowCount <= 0) {
    return null;
  }

  const wasteFactor = CONVERSION_SPECS.flashing.waste_factor;
  const pieceLength = CONVERSION_SPECS.flashing.piece_length_ft;

  let effectiveLf = headLf;
  let isEstimated = false;

  if (effectiveLf <= 0 && windowCount > 0) {
    // Average window head: 4' wide
    effectiveLf = windowCount * 4;
    isEstimated = true;
  }

  const rawPieces = effectiveLf / pieceLength;
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);

  const calculation: CalculationStep = {
    formula: '(head_lf / piece_length) × waste_factor',
    inputs: {
      head_lf: effectiveLf,
      piece_length: pieceLength,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  return {
    id: uuidv4(),
    sku: 'JH-FLEX-FLASHING-6X100',
    description: 'Window Head Flashing',
    quantity: piecesWithWaste,
    unit: 'PC',
    size: '6" x 100\'',
    category: 'flashing',
    presentation_group: 'flashing',
    source: 'auto-scope',
    calculation,
    low_confidence: isEstimated,
    notes: `${effectiveLf} LF ÷ ${pieceLength} × ${wasteFactor} = ${piecesWithWaste} PC`
  };
}

/**
 * Calculate door head flashing
 */
export function calculateDoorHeadFlashing(
  headLf: number,
  doorCount: number
): MaterialLineItem | null {
  if (headLf <= 0 && doorCount <= 0) {
    return null;
  }

  const wasteFactor = CONVERSION_SPECS.flashing.waste_factor;
  const pieceLength = CONVERSION_SPECS.flashing.piece_length_ft;

  let effectiveLf = headLf;
  let isEstimated = false;

  if (effectiveLf <= 0 && doorCount > 0) {
    // Average door head: 3' wide
    effectiveLf = doorCount * 3;
    isEstimated = true;
  }

  const rawPieces = effectiveLf / pieceLength;
  const piecesWithWaste = Math.ceil(rawPieces * wasteFactor);

  const calculation: CalculationStep = {
    formula: '(head_lf / piece_length) × waste_factor',
    inputs: {
      head_lf: effectiveLf,
      piece_length: pieceLength,
      waste_factor: wasteFactor
    },
    result: piecesWithWaste
  };

  return {
    id: uuidv4(),
    sku: 'JH-FLEX-FLASHING-6X100',
    description: 'Door Head Flashing',
    quantity: piecesWithWaste,
    unit: 'PC',
    size: '6" x 100\'',
    category: 'flashing',
    presentation_group: 'flashing',
    source: 'auto-scope',
    calculation,
    low_confidence: isEstimated,
    notes: `${effectiveLf} LF ÷ ${pieceLength} × ${wasteFactor} = ${piecesWithWaste} PC`
  };
}
