/**
 * Auto-Scope Types
 * Database-driven auto-scope rules for siding calculation
 */

// ============================================================================
// DATABASE TYPES (from siding_auto_scope_rules table)
// ============================================================================

export interface TriggerCondition {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'exists' | 'not_exists';
  value?: number | string | boolean;
}

export interface AutoScopeRule {
  id: string;
  sku: string;
  product_name: string;
  category: string;
  presentation_group: string;
  unit: string;

  // Formula for quantity calculation (uses measurement context variables)
  quantity_formula: string;

  // When to apply this rule
  trigger_conditions: TriggerCondition[] | null;

  // Ordering
  display_order: number;

  // Status
  is_active: boolean;

  // Metadata
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

// ============================================================================
// MEASUREMENT CONTEXT (flattened from various sources)
// ============================================================================

export interface MeasurementContext {
  // Primary areas
  facade_sqft: number;
  gross_wall_area_sqft: number;
  net_siding_area_sqft: number;

  // Windows
  window_count: number;
  window_area_sqft: number;
  window_perimeter_lf: number;
  window_head_lf: number;
  window_sill_lf: number;
  window_jamb_lf: number;

  // Doors
  door_count: number;
  door_area_sqft: number;
  door_perimeter_lf: number;
  door_head_lf: number;
  door_jamb_lf: number;

  // Garages
  garage_count: number;
  garage_area_sqft: number;
  garage_perimeter_lf: number;

  // Corners
  outside_corner_count: number;
  outside_corner_lf: number;
  inside_corner_count: number;
  inside_corner_lf: number;

  // Gables
  gable_count: number;
  gable_area_sqft: number;
  gable_rake_lf: number;

  // Other
  level_starter_lf: number;
  avg_wall_height_ft: number;

  // Computed helpers
  total_opening_perimeter_lf: number;
  total_corner_lf: number;
}

// ============================================================================
// CAD/HOVER MEASUREMENTS (from database)
// ============================================================================

export interface CadHoverMeasurements {
  id: string;
  extraction_id: string;

  // Areas
  facade_sqft?: number;
  gross_wall_area_sqft?: number;
  net_siding_area_sqft?: number;

  // Windows
  window_count?: number;
  window_total_area_sqft?: number;
  window_perimeter_lf?: number;
  window_head_lf?: number;
  window_sill_lf?: number;
  window_jamb_lf?: number;

  // Doors
  door_count?: number;
  door_total_area_sqft?: number;
  door_perimeter_lf?: number;
  door_head_lf?: number;
  door_jamb_lf?: number;

  // Garages
  garage_count?: number;
  garage_total_area_sqft?: number;
  garage_perimeter_lf?: number;

  // Corners
  outside_corner_count?: number;
  outside_corner_lf?: number;
  inside_corner_count?: number;
  inside_corner_lf?: number;

  // Gables
  gable_count?: number;
  gable_area_sqft?: number;
  gable_rake_lf?: number;

  // Other
  level_starter_lf?: number;
  avg_wall_height_ft?: number;

  // Metadata
  created_at?: string;
  updated_at?: string;
}

// ============================================================================
// AUTO-SCOPE LINE ITEM (output)
// ============================================================================

export interface AutoScopeLineItem {
  description: string;
  sku: string;
  quantity: number;
  unit: string;
  category: string;
  presentation_group: string;

  // Pricing (filled in later)
  material_unit_cost: number;
  material_extended: number;
  labor_unit_cost: number;
  labor_extended: number;

  // Metadata
  calculation_source: 'auto-scope';
  rule_id: string;
  formula_used: string;
  notes?: string;
}

// ============================================================================
// V2 RESULT TYPES
// ============================================================================

export interface AutoScopeV2Result {
  line_items: AutoScopeLineItem[];
  rules_evaluated: number;
  rules_triggered: number;
  rules_skipped: string[];
  measurement_source: 'database' | 'webhook' | 'fallback';
}
