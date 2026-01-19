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
// TRIM SKUS (mapped to database pricing_items)
// ============================================================================

export const TRIM_SKUS = {
  casing: {
    '3.5': { colorplus: 'HARDIE-TRIM-54X35-12FT-CP', primed: 'HARDIE-TRIM-54X35-12FT' },
    '4': { colorplus: 'HARDIE-TRIM-54X4-12FT-CP', primed: 'HARDIE-TRIM-54X4-12FT' },
    '5.5': { colorplus: 'HARDIE-TRIM-54X55-12FT-CP', primed: 'HARDIE-TRIM-54X55-12FT' },
    '7.25': { colorplus: 'HARDIE-TRIM-54X725-12FT-CP', primed: 'HARDIE-TRIM-54X725-12FT' }
  },
  garage: {
    '4': { colorplus: 'HARDIE-TRIM-54X4-12FT-CP', primed: 'HARDIE-TRIM-54X4-12FT' },
    '6': { colorplus: 'HARDIE-TRIM-54X6-12FT-CP', primed: 'HARDIE-TRIM-54X6-12FT' },
    '8': { colorplus: 'HARDIE-TRIM-54X8-12FT-CP', primed: 'HARDIE-TRIM-54X8-12FT' }
  },
  inside_corner: { colorplus: '110Z2BPW-CP', primed: '110Z2BPW' },
  outside_corner: { colorplus: '111Z2BPW-CP', primed: '111Z2BPW' },
  whitewood: { '2x2x16': 'FRIEZE-1X8X12' }
} as const;

// ============================================================================
// AUTO-SCOPE ITEM SKUS (mapped to database pricing_items)
// ============================================================================

export const AUTO_SCOPE_SKUS = {
  housewrap: 'JH-WEATHER-BARRIER-9X100',
  housewrap_tape: 'JH-SEAM-TAPE-2X100',
  flashing_tape: 'JH-FLEX-FLASHING-6X100',
  staples: 'STAPLES-A11-9/16',
  sealant: 'CAULK-PAINT-10OZ',
  touchup_paint: 'JH-TOUCHUP-COLORPLUS',
  spackle: 'SPACKLE-HARDIE-6OZ',
  butyl_mastic: 'MASTIC-BUTYL-11OZ',
  hardie_blade: 'JH-BLADE-FIBER-CEMENT',
  siding_nails: 'NAILS-SIDING-COIL-1.5'
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
