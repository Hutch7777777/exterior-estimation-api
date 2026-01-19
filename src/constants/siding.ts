/**
 * Siding Calculation Constants
 * Extracted from n8n workflow analysis
 */

// ============================================================================
// CONVERSION SPECIFICATIONS
// ============================================================================

export const CONVERSION_SPECS = {
  siding: {
    default_reveal_inches: 8.25,
    plank_length_ft: 12,
    waste_factor: 1.12,
    pieces_per_square_default: 12.12
  },
  shingle: {
    pieces_per_square: 43,
    waste_factor: 1.18,
    coverage_per_square: 100
  },
  panel: {
    width_ft: 4,
    height_ft: 8,
    waste_factor: 1.18
  },
  trim: {
    waste_factor: 1.12,
    hardie_piece_length_ft: 12,
    whitewood_piece_length_ft: 16
  },
  corners: {
    waste_factor: 1.12,
    piece_length_ft: 12,
    default_height_ft: 10
  },
  flashing: {
    waste_factor: 1.10,
    piece_length_ft: 10
  },
  housewrap: {
    roll_coverage_sqft: 1350,
    waste_factor: 1.15
  }
} as const;

// ============================================================================
// COVERAGE RATES
// ============================================================================

export const COVERAGE_RATES = {
  staples_per_sqft: 500,
  sealant_per_sqft: 500,
  touchup_paint_per_sqft: 1500,
  nails_per_square: 15,
  tape_per_sqft: 500
} as const;

// ============================================================================
// TRIM SKUS
// ============================================================================

export const TRIM_SKUS = {
  casing: {
    '3.5': { colorplus: 'JH-TRIM-CASING-3.5-12-CP', primed: 'JH-TRIM-CASING-3.5-12-PR' },
    '4': { colorplus: 'JH-TRIM-CASING-4-12-CP', primed: 'JH-TRIM-CASING-4-12-PR' },
    '5.5': { colorplus: 'JH-TRIM-CASING-5.5-12-CP', primed: 'JH-TRIM-CASING-5.5-12-PR' },
    '7.25': { colorplus: 'JH-TRIM-CASING-7.25-12-CP', primed: 'JH-TRIM-CASING-7.25-12-PR' }
  },
  garage: {
    '4': { colorplus: 'JH-TRIM-GARAGE-4-12-CP', primed: 'JH-TRIM-GARAGE-4-12-PR' },
    '6': { colorplus: 'JH-TRIM-GARAGE-6-12-CP', primed: 'JH-TRIM-GARAGE-6-12-PR' },
    '8': { colorplus: 'JH-TRIM-GARAGE-8-12-CP', primed: 'JH-TRIM-GARAGE-8-12-PR' }
  },
  inside_corner: { colorplus: 'JH-TRIM-IC-4-12-CP', primed: 'JH-TRIM-IC-4-12-PR' },
  outside_corner: { colorplus: 'JH-TRIM-OC-4-12-CP', primed: 'JH-TRIM-OC-4-12-PR' },
  whitewood: { '2x2x16': 'WW-2x2x16-PR' }
} as const;

// ============================================================================
// AUTO-SCOPE ITEM SKUS
// ============================================================================

export const AUTO_SCOPE_SKUS = {
  housewrap: 'HWRAP-9x150',
  housewrap_tape: 'TAPE-TYVEK-3x165',
  flashing_tape: 'TAPE-FLASH-4x75',
  staples: 'STAPLES-A11',
  sealant: 'SEALANT-10OZ',
  touchup_paint: 'PAINT-TOUCHUP-QT',
  spackle: 'SPACKLE-6OZ',
  butyl_mastic: 'MASTIC-BUTYL',
  hardie_blade: 'BLADE-HARDIE',
  siding_nails: 'NAILS-SIDING-COIL'
} as const;

// ============================================================================
// LABOR RATES
// ============================================================================

export const LABOR_RATES = {
  lap_siding: 180,
  shingle_siding: 200,
  panel_siding: 220,
  board_batten: 200
} as const;

// ============================================================================
// OVERHEAD RATES
// ============================================================================

export const OVERHEAD_RATES = {
  soc_unemployment_rate: 0.13,
  li_rate_per_hour: 3.56,
  insurance_per_1000: 20.32,
  default_crew_size: 4,
  default_hours_per_week: 40
} as const;
