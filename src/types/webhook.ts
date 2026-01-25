/**
 * n8n Webhook Request/Response Types
 * Matches Multi-Trade Coordinator format
 */

// ============================================================================
// MATERIAL ASSIGNMENT (for ID-based pricing lookup)
// ============================================================================

export interface MaterialAssignment {
  detection_id: string;
  detection_class: string;
  pricing_item_id: string;  // UUID from pricing_items.id
  quantity: number;
  unit: 'SF' | 'LF' | 'EA';
  area_sf?: number | null;
  perimeter_lf?: number | null;
}

// ============================================================================
// WEBHOOK REQUEST (from n8n)
// ============================================================================

export interface WebhookMeasurements {
  facade_sqft?: number;
  gross_wall_area_sqft?: number;
  net_wall_area_sqft?: number;
  net_siding_area_sqft?: number;

  windows?: {
    count: number;
    total_area_sqft?: number;
    perimeter_lf?: number;
    head_lf?: number;
    sill_lf?: number;
    jamb_lf?: number;
  };

  doors?: {
    count: number;
    total_area_sqft?: number;
    perimeter_lf?: number;
    head_lf?: number;
    jamb_lf?: number;
  };

  garages?: {
    count: number;
    total_area_sqft?: number;
    perimeter_lf?: number;
  };

  outside_corners?: {
    count: number;
    total_lf?: number;
  };

  inside_corners?: {
    count: number;
    total_lf?: number;
  };

  gables?: {
    count: number;
    area_sqft?: number;
    rake_lf?: number;
  };

  level_starter_lf?: number;
  avg_wall_height_ft?: number;
}

export interface WebhookSidingConfig {
  siding_product?: string;
  siding_color?: string;
  siding_profile?: 'smooth' | 'cedarmill';
  siding_reveal?: number;
  include_window_trim?: boolean;
  include_door_trim?: boolean;
  window_trim_width?: string;
  door_trim_width?: string;
  trim_color?: string;
}

export interface WebhookRequest {
  // Project info
  project_id: string;
  project_name?: string;
  client_name?: string;
  address?: string;

  // Trade
  trade?: 'siding';

  // Trade-specific config
  siding?: WebhookSidingConfig;

  // Measurements (from HOVER extraction) - optional if using material_assignments
  measurements?: WebhookMeasurements;

  // Detection counts by class (corbels, brackets, belly_bands, etc.) - from Detection Editor
  detection_counts?: Record<string, {
    count: number;
    total_lf?: number;  // For linear measurement types (e.g., belly_band)
    display_name: string;
    measurement_type: 'count' | 'area' | 'linear';
    unit: string;
  }>;

  // NEW: Material assignments from frontend (ID-based pricing)
  material_assignments?: MaterialAssignment[];

  // NEW: Organization context for multi-tenant pricing
  organization_id?: string;

  // Options
  include_pricing?: boolean;
  include_labor?: boolean;
  markup_rate?: number;

  // Source tracking
  source?: 'hover' | 'cad' | 'manual';
  extraction_id?: string;
  confidence?: number;
}

// ============================================================================
// WEBHOOK RESPONSE (for n8n Excel generation)
// ============================================================================

export interface WebhookLineItem {
  // Core fields for Excel
  description: string;
  quantity: number;
  unit: string;
  category: string;

  // Pricing (optional)
  unit_cost?: number;
  extended_cost?: number;

  // Labor breakdown (for labor items)
  base_rate?: number;
  li_insurance?: number;
  unemployment?: number;
  total_rate?: number;

  // Metadata
  sku?: string;
  size?: string;
  notes?: string;
  calculation_source?: string;
  low_confidence?: boolean;

  // V2 fields
  presentation_group?: string;
}

export interface WebhookTotals {
  material_cost: number;
  labor_cost: number;
  overhead: number;
  subtotal: number;
  markup_percent: number;
  markup_amount: number;
  total: number;
}

// ============================================================================
// V2 MIKE SKJEI METHODOLOGY TYPES
// ============================================================================

export interface WebhookLaborLineItem {
  rate_id: string;
  rate_name: string;
  description: string;
  quantity: number;        // In squares (SQ)
  unit: string;            // 'SQ' = 100 SF
  unit_cost: number;       // $/SQ
  total_cost: number;      // quantity * unit_cost
  notes?: string;
}

export interface WebhookLaborSection {
  installation_items: WebhookLaborLineItem[];
  installation_subtotal: number;
}

export interface WebhookOverheadLineItem {
  cost_id: string;
  cost_name: string;
  description: string;
  category: string;        // 'labor_burden', 'equipment', 'setup', etc.
  quantity?: number;
  unit?: string;
  rate?: number;
  amount: number;
  calculation_type: string; // 'percentage', 'calculated', 'flat_fee', 'per_day'
  notes?: string;
}

export interface WebhookOverheadSection {
  items: WebhookOverheadLineItem[];
  subtotal: number;
}

export interface WebhookProjectTotals {
  // Materials
  material_cost: number;
  material_markup_rate: number;      // 0.26 (26%)
  material_markup_amount: number;
  material_total: number;

  // Labor breakdown
  installation_labor_subtotal: number;
  overhead_subtotal: number;
  labor_cost_before_markup: number;  // installation + overhead
  labor_markup_rate: number;         // 0.26 (26%)
  labor_markup_amount: number;
  labor_total: number;

  // Final totals
  subtotal: number;                  // material_total + labor_total
  project_insurance: number;         // $24.38 per $1,000
  grand_total: number;               // subtotal + project_insurance
}

// ============================================================================
// WEBHOOK RESPONSE
// ============================================================================

export interface WebhookResponse {
  success: boolean;
  trade: 'siding';

  // Project echo
  project_id: string;
  project_name?: string;

  // Line items for Excel
  line_items: WebhookLineItem[];

  // Totals (legacy format for backward compatibility)
  totals: WebhookTotals;

  // V2 Mike Skjei Methodology - Detailed breakdowns
  labor?: WebhookLaborSection;
  overhead?: WebhookOverheadSection;
  project_totals?: WebhookProjectTotals;

  // Metadata
  metadata: {
    version: string;
    timestamp: string;
    source: string;
    pricing_snapshot?: string;
    skus_found: number;
    skus_missing: string[];
    warnings: Array<{ code: string; message: string }>;

    // V2 specific metadata (auto-scope)
    assigned_items_count?: number;
    auto_scope_items_count?: number;
    measurement_source?: 'database' | 'webhook' | 'fallback';
    rules_evaluated?: number;
    rules_triggered?: number;

    // V2 Mike Skjei metadata
    calculation_method?: string;      // 'mike_skjei_v1'
    markup_rate?: number;             // 0.26
    crew_size?: number;               // Default: 4
    estimated_weeks?: number;         // Default: 2
  };
}

export interface WebhookErrorResponse {
  success: false;
  error: string;
  error_code?: string;
  project_id?: string;
  timestamp: string;
}
