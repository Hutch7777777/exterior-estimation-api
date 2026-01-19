/**
 * Siding Calculation Types
 * Based on extraction analysis and Mike Skjei format
 */

// ============================================================================
// INPUT TYPES
// ============================================================================

export interface SidingMeasurements {
  /** Total facade area before opening deductions */
  gross_area_sf: number;

  /** Net siding area (gross - openings) */
  net_area_sf: number;

  /** Linear footage for starter strip */
  level_starter_lf?: number;

  /** Average wall height for corner estimation */
  avg_wall_height_ft?: number;
}

export interface OpeningsMeasurements {
  total_area_sf: number;
  total_perimeter_lf: number;

  windows: {
    count: number;
    perimeter_lf: number;
    head_lf?: number;
    sill_lf?: number;
    jamb_lf?: number;
  };

  doors: {
    count: number;
    perimeter_lf: number;
    head_lf?: number;
    jamb_lf?: number;
  };

  garages: {
    count: number;
    perimeter_lf: number;
  };
}

export interface CornerMeasurements {
  inside: {
    count: number;
    total_lf: number;
    is_estimated?: boolean;
  };
  outside: {
    count: number;
    total_lf: number;
    is_estimated?: boolean;
  };
}

export interface GableMeasurements {
  count: number;
  area_sf?: number;
  rake_lf?: number;
}

export interface CalculationMeasurements {
  siding: SidingMeasurements;
  openings: OpeningsMeasurements;
  corners: CornerMeasurements;
  gables?: GableMeasurements;
}

export interface SidingProductConfig {
  product_sku?: string;
  product_name?: string;
  reveal_inches?: number;
  finish: 'primed' | 'colorplus';
  color?: string;
  profile?: 'smooth' | 'cedarmill';
}

export interface TrimConfig {
  include: boolean;
  width?: string;
  finish?: 'primed' | 'colorplus';
  color?: string;
}

export interface CalculationConfig {
  siding: SidingProductConfig;
  window_trim?: TrimConfig;
  door_trim?: TrimConfig;
  garage_trim?: TrimConfig;
  corner_trim?: {
    finish: 'primed' | 'colorplus';
    color?: string;
  };
  pricing?: {
    material_markup_rate?: number;
    labor_markup_rate?: number;
  };
}

export interface CalculationRequest {
  source: {
    type: 'cad' | 'hover' | 'manual';
    extraction_id?: string;
    confidence?: number;
  };
  project: {
    id: string;
    name?: string;
    address?: string;
    client_name?: string;
  };
  measurements: CalculationMeasurements;
  config: CalculationConfig;
}

// ============================================================================
// OUTPUT TYPES
// ============================================================================

export interface CalculationStep {
  formula: string;
  inputs: Record<string, number>;
  result: number;
}

export interface MaterialLineItem {
  id: string;
  sku: string;
  description: string;
  quantity: number;
  unit: 'PC' | 'EA' | 'LF' | 'SF' | 'ROLL' | 'BOX' | 'SQUARE' | 'TUBE';
  size?: string;
  unit_cost?: number;
  extended?: number;
  category: 'siding' | 'trim' | 'flashing' | 'fasteners' | 'accessories' | 'water_barrier';
  presentation_group: string;
  source: 'calculated' | 'auto-scope' | 'assigned';
  calculation: CalculationStep;
  labor_quantity?: number;
  labor_unit?: string;
  low_confidence?: boolean;
  notes?: string;
}

export interface CalculationResponse {
  success: boolean;
  trade: 'siding';
  materials: MaterialLineItem[];
  provenance: {
    version: string;
    timestamp: string;
    warnings: Array<{
      code: string;
      message: string;
      field?: string;
    }>;
  };
}

// ============================================================================
// PRICING TYPES (Phase 3)
// ============================================================================

export interface PricedMaterialLineItem extends MaterialLineItem {
  unit_cost?: number;
  extended_cost?: number;
  pricing_source?: 'database' | 'fallback' | 'none';
  pricing_snapshot?: string;
}

export interface LaborLineItem {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  base_rate: number;
  li_insurance: number;
  unemployment: number;
  total_rate: number;
  extended: number;
  calculation: CalculationStep;
  category: 'labor';
}

export interface TakeoffTotals {
  material_subtotal: number;
  labor_subtotal: number;
  overhead: number;
  subtotal: number;
  markup_rate: number;
  markup_amount: number;
  total: number;
}

export interface PricedCalculationResponse extends CalculationResponse {
  materials: PricedMaterialLineItem[];
  labor: LaborLineItem[];
  totals: TakeoffTotals;
  pricing_metadata: {
    snapshot_name?: string;
    effective_date?: string;
    skus_found: number;
    skus_missing: string[];
  };
}
