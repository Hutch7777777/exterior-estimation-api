/**
 * Auto-Scope Types
 * Database-driven auto-scope rules for siding calculation
 */

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

  // Belly Band
  belly_band_count: number;
  belly_band_lf: number;

  // Other
  level_starter_lf: number;
  avg_wall_height_ft: number;

  // Computed helpers
  total_opening_perimeter_lf: number;
  total_corner_lf: number;
  total_openings_area_sqft: number;
  total_openings_count: number;

  // =========================================================================
  // TRIM TOTALS (computed from window + door + garage trim)
  // =========================================================================
  trim_total_lf: number;       // Total trim linear feet (all types combined)
  trim_head_lf: number;        // Total head trim (windows + doors + garages)
  trim_jamb_lf: number;        // Total jamb trim (windows + doors + garages)
  trim_sill_lf: number;        // Total sill trim (windows only)

  // =========================================================================
  // ALIASES for database formula compatibility
  // Database formulas use these variable names
  // =========================================================================
  facade_area_sqft: number;           // alias for facade_sqft
  openings_area_sqft: number;         // alias for total_openings_area_sqft
  outside_corners_count: number;      // alias for outside_corner_count
  inside_corners_count: number;       // alias for inside_corner_count
  openings_perimeter_lf: number;      // alias for total_opening_perimeter_lf
  openings_count: number;             // alias for total_openings_count
  facade_perimeter_lf: number;        // computed from facade dimensions
  facade_height_ft: number;           // alias for avg_wall_height_ft

  // =========================================================================
  // MANUFACTURER-SPECIFIC AREAS (optional, set when manufacturer groups exist)
  // =========================================================================
  artisan_sqft?: number;              // Artisan siding SF (for tab/staple calculations)
  artisan_area_sqft?: number;         // alias for artisan_sqft
}

// ============================================================================
// CAD/HOVER MEASUREMENTS (from database)
// ============================================================================

export interface CadHoverMeasurements {
  id: string;
  extraction_id: string;

  // Areas - ACTUAL DB column names
  facade_total_sqft?: number;
  facade_sqft?: number;
  gross_wall_area_sqft?: number;
  net_siding_sqft?: number;
  net_siding_area_sqft?: number;

  // Openings - pre-computed totals
  openings_area_sqft?: number;
  openings_count?: number;
  openings_total_perimeter_lf?: number;

  // Windows
  windows_count?: number;
  windows_area_sqft?: number;
  windows_perimeter_lf?: number;
  windows_head_lf?: number;
  windows_sill_lf?: number;
  windows_jamb_lf?: number;

  // Doors
  doors_count?: number;
  doors_area_sqft?: number;
  doors_perimeter_lf?: number;
  doors_head_lf?: number;
  doors_jamb_lf?: number;

  // Garages
  garages_count?: number;
  garages_area_sqft?: number;
  garages_perimeter_lf?: number;

  // Corners - ACTUAL DB column names
  corners_outside_count?: number;
  corners_outside_lf?: number;
  corners_inside_count?: number;
  corners_inside_lf?: number;

  // Gables
  gables_count?: number;
  gables_area_sqft?: number;
  gables_rake_lf?: number;

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

// ============================================================================
// AUTO-SCOPE V2 OPTIONS
// ============================================================================

/**
 * Material info for trigger condition evaluation
 * Used for material_category and sku_pattern trigger conditions
 */
export interface AssignedMaterial {
  /** SKU from pricing_items table (e.g., "JH-BBCP-16OC-CP-AW") */
  sku: string;
  /** Category from pricing_items table (e.g., "board_batten", "lap_siding") */
  category: string;
  /** Manufacturer name (e.g., "James Hardie") */
  manufacturer: string;
  /** Optional: pricing item ID for traceability */
  pricing_item_id?: string;
}

export interface AutoScopeV2Options {
  /** Skip siding panel rules if user has siding material assignments */
  skipSidingPanels?: boolean;
  /** Manufacturer groups for per-manufacturer rule application */
  manufacturerGroups?: ManufacturerGroups;
  /** Assigned materials for material_category/sku_pattern trigger conditions */
  assignedMaterials?: AssignedMaterial[];

  // V8.0: Spatial Containment options
  /** Spatial containment metadata from n8n workflow */
  spatialContainment?: {
    enabled: boolean;
    matched_openings: number;
    total_openings: number;
    unmatched_openings?: number;
  };
}

// ============================================================================
// MANUFACTURER GROUPING TYPES (for mixed-manufacturer projects)
// ============================================================================

/**
 * Aggregated measurements for a single manufacturer's products
 * Used to calculate manufacturer-specific auto-scope quantities
 *
 * Example: If a project has 800 SF of James Hardie and 400 SF of Nichiha,
 * there will be two ManufacturerMeasurements entries.
 *
 * V8.0: Added opening measurements (windows, doors, garages)
 * V8.1: Added perimeter, corners, trim, belly band, and architectural
 */
export interface ManufacturerMeasurements {
  /** Manufacturer name (e.g., "James Hardie", "Nichiha") */
  manufacturer: string;
  /** Total square footage of this manufacturer's siding products */
  area_sqft: number;
  /** Total linear feet of this manufacturer's trim/linear products */
  linear_ft: number;
  /** Total piece count of this manufacturer's discrete items */
  piece_count: number;
  /** Detection IDs that contributed to this manufacturer's totals */
  detection_ids: string[];

  // =========================================================================
  // V8.0: Per-material opening measurements from spatial containment
  // These are set when per_material_measurements is provided in the webhook
  // =========================================================================

  /** Window perimeter LF contained within this manufacturer's facades */
  window_perimeter_lf?: number;
  /** Door perimeter LF contained within this manufacturer's facades */
  door_perimeter_lf?: number;
  /** Garage perimeter LF contained within this manufacturer's facades */
  garage_perimeter_lf?: number;
  /** Count of windows contained within this manufacturer's facades */
  window_count?: number;
  /** Count of doors contained within this manufacturer's facades */
  door_count?: number;
  /** Count of garages contained within this manufacturer's facades */
  garage_count?: number;
  /** Total area of openings contained within this manufacturer's facades */
  openings_area_sqft?: number;
  /** Computed: total perimeter LF of all openings (window + door + garage) */
  total_openings_perimeter_lf?: number;

  // =========================================================================
  // V8.1: Perimeter (for starter strips, Z-flashing)
  // =========================================================================

  /** Perimeter of facades covered by this manufacturer (for starter strips) */
  facade_perimeter_lf?: number;

  // =========================================================================
  // V8.1: Corners
  // =========================================================================

  /** Count of outside corners in this manufacturer's facades */
  outside_corner_count?: number;
  /** Total linear feet of outside corners */
  outside_corner_lf?: number;
  /** Count of inside corners in this manufacturer's facades */
  inside_corner_count?: number;
  /** Total linear feet of inside corners */
  inside_corner_lf?: number;
  /** Total corner linear feet (outside + inside) */
  total_corner_lf?: number;

  // =========================================================================
  // V8.1: Trim
  // =========================================================================

  /** Head trim linear feet (tops of windows/doors) */
  trim_head_lf?: number;
  /** Jamb trim linear feet (sides of windows/doors) */
  trim_jamb_lf?: number;
  /** Sill trim linear feet (bottoms of windows) */
  trim_sill_lf?: number;
  /** Total trim linear feet */
  trim_total_lf?: number;

  // =========================================================================
  // V8.1: Other Measurements
  // =========================================================================

  /** Belly band linear feet within this manufacturer's facades */
  belly_band_lf?: number;
  /** Count of architectural elements (corbels, brackets, etc.) */
  architectural_count?: number;
}

/**
 * Map of manufacturer name to their aggregated measurements
 * Key is the manufacturer name from pricing_items table
 *
 * Example:
 * {
 *   "James Hardie": { area_sqft: 800, linear_ft: 120, ... },
 *   "Nichiha": { area_sqft: 400, linear_ft: 60, ... }
 * }
 */
export type ManufacturerGroups = Record<string, ManufacturerMeasurements>;
