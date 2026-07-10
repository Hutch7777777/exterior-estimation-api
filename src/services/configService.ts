/**
 * Config Service - Database-Driven Configuration
 * 
 * Replaces hardcoded constants in orchestrator-v2.ts with values from:
 *   - calculation_constants table (markup rates, labor rates, L&I rates)
 *   - presentation_group_config table (category → display group mapping)
 *
 * Uses existing getSupabaseClient() from database.ts.
 * 5-minute in-memory cache to avoid per-request DB hits.
 * Falls back to hardcoded defaults if DB query fails (zero risk).
 */

import { getSupabaseClient, isDatabaseConfigured } from './database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalculationConstants {
  markup_rate: number;
  soc_unemployment_rate: number;
  li_hourly_rate: number;
  insurance_rate_per_thousand: number;
  default_crew_size: number;
  default_estimated_weeks: number;
  labor_rate_lap_siding: number;
  labor_rate_shingle_siding: number;
  labor_rate_panel_siding: number;
  labor_rate_board_batten: number;
  [key: string]: number;
}

export interface PresentationGroupEntry {
  source_category: string;
  display_title: string;
  display_color: string | null;
  display_order: number;
  trade: string | null;
}

// ---------------------------------------------------------------------------
// Cache (5-minute TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

let _constantsCache: CacheEntry<CalculationConstants> | null = null;
let _presentationGroupCache: CacheEntry<PresentationGroupEntry[]> | null = null;

function isCacheValid<T>(cache: CacheEntry<T> | null): cache is CacheEntry<T> {
  if (!cache) return false;
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

export function clearConfigCache(): void {
  _constantsCache = null;
  _presentationGroupCache = null;
}

// ---------------------------------------------------------------------------
// Default values — exact match of current hardcoded constants
// ---------------------------------------------------------------------------

const DEFAULT_CONSTANTS: CalculationConstants = {
  markup_rate: 0.26,
  soc_unemployment_rate: 0.1265,
  li_hourly_rate: 3.56,
  insurance_rate_per_thousand: 24.38,
  default_crew_size: 4,
  default_estimated_weeks: 2,
  labor_rate_lap_siding: 180,
  labor_rate_shingle_siding: 200,
  labor_rate_panel_siding: 220,
  labor_rate_board_batten: 200,
};

// ---------------------------------------------------------------------------
// CALCULATION CONSTANTS
// ---------------------------------------------------------------------------

export async function getCalculationConstants(
  trade?: string
): Promise<CalculationConstants> {
  if (isCacheValid(_constantsCache)) {
    return _constantsCache.data;
  }

  if (!isDatabaseConfigured()) {
    console.warn('⚠️ configService: Database not configured, using defaults');
    return DEFAULT_CONSTANTS;
  }

  try {
    const supabase = getSupabaseClient();

    let query = supabase
      .from('calculation_constants')
      .select('constant_name, constant_value, trade')
      .eq('active', true);

    if (trade) {
      query = query.or(`trade.is.null,trade.eq.${trade}`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('⚠️ configService: Failed to query calculation_constants:', error.message);
      return DEFAULT_CONSTANTS;
    }

    if (!data || data.length === 0) {
      console.warn('⚠️ configService: No constants found in DB, using defaults');
      return DEFAULT_CONSTANTS;
    }

    const constants: CalculationConstants = { ...DEFAULT_CONSTANTS };

    // Global constants first (trade IS NULL)
    for (const row of data.filter((r: any) => r.trade === null)) {
      constants[row.constant_name] = Number(row.constant_value);
    }

    // Trade-specific override globals
    for (const row of data.filter((r: any) => r.trade !== null)) {
      constants[row.constant_name] = Number(row.constant_value);
    }

    _constantsCache = { data: constants, timestamp: Date.now() };
    console.log(`✅ configService: Loaded ${data.length} constants from DB`);
    return constants;

  } catch (err: any) {
    console.error('⚠️ configService: Exception loading constants:', err.message);
    return DEFAULT_CONSTANTS;
  }
}

// ---------------------------------------------------------------------------
// PRESENTATION GROUP CONFIG
// ---------------------------------------------------------------------------

async function loadPresentationGroupConfig(): Promise<PresentationGroupEntry[]> {
  if (isCacheValid(_presentationGroupCache)) {
    return _presentationGroupCache.data;
  }

  if (!isDatabaseConfigured()) {
    return [];
  }

  try {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('presentation_group_config')
      .select('source_category, display_title, display_color, display_order, trade')
      .eq('active', true)
      .order('display_order');

    if (error) {
      console.error('⚠️ configService: Failed to query presentation_group_config:', error.message);
      return [];
    }

    _presentationGroupCache = { data: data || [], timestamp: Date.now() };
    console.log(`✅ configService: Loaded ${data?.length || 0} presentation group configs`);
    return data || [];

  } catch (err: any) {
    console.error('⚠️ configService: Exception loading presentation groups:', err.message);
    return [];
  }
}

export async function getPresentationGroupTitle(
  category: string,
  trade?: string
): Promise<string> {
  const configs = await loadPresentationGroupConfig();
  const normalized = category?.toLowerCase().trim() || '';

  if (trade) {
    const tradeMatch = configs.find(
      (c) => c.source_category === normalized && c.trade === trade
    );
    if (tradeMatch) return tradeMatch.display_title;
  }

  const globalMatch = configs.find(
    (c) => c.source_category === normalized && c.trade === null
  );
  if (globalMatch) return globalMatch.display_title;

  return normalized
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Other Materials';
}

export async function getPresentationGroupMap(
  trade?: string
): Promise<Record<string, { title: string; color: string; order: number }>> {
  const configs = await loadPresentationGroupConfig();
  const map: Record<string, { title: string; color: string; order: number }> = {};

  for (const c of configs.filter((c) => c.trade === null)) {
    map[c.source_category] = {
      title: c.display_title,
      color: c.display_color || 'F5F5F5',
      order: c.display_order,
    };
  }

  if (trade) {
    for (const c of configs.filter((c) => c.trade === trade)) {
      map[c.source_category] = {
        title: c.display_title,
        color: c.display_color || 'F5F5F5',
        order: c.display_order,
      };
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// PROJECT ESTIMATE SETTINGS (from project_configurations table)
// ---------------------------------------------------------------------------

/**
 * Estimate settings from the frontend EstimateSettingsPanel
 * Stored in project_configurations.configuration_data
 */
export interface ProjectEstimateSettings {
  /** Per-project waste override as a percentage (for example, 12 = 12%). */
  waste_factor_percent?: number;
  wrb?: {
    product?: string;        // "tyvek-homewrap", "henry-jumbotex", etc.
    layer_mode?: string;     // "auto", "single", "double"
    include_seam_tape?: boolean;
  };
  corners?: {
    default_height?: number;
    include_inside?: boolean;
    inside_count?: number | null;
    inside_lf?: number | null;
    outside_count?: number | null;
    outside_lf?: number | null;
  };
  top_out?: {
    include?: boolean;
    size_1?: string;         // "1x2"
    size_2?: string;         // "2x2"
    manual_lf?: number | null;
  };
  flashing?: {
    door_head?: string;      // "kynar", "galvanized", "z-flashing", "none"
    window_head?: string;
    base_starter?: string;   // "z-flashing", "drip-edge", "none"
    include_kickout?: boolean;
    include_moistop?: boolean;
    include_fortiflash?: boolean;
    include_rolled_galv?: boolean;
    include_joint_flashing?: boolean;
    include_corner_flashing?: boolean;
  };
  overhead?: {
    li_rate?: number;
    crew_size?: number;
    toilet_cost?: number;
    mobilization?: number;
    dumpster_cost?: number;
    include_toilet?: boolean;
    insurance_rate?: number;
    estimated_weeks?: number;
    include_dumpster?: boolean;
    mobilization_note?: string;
  };
  door_trim?: {
    include?: boolean;
    material?: string;       // "hardie_5/4x6"
    manual_lf?: number | null;
  };
  window_trim?: {
    include?: boolean;
    material?: string;       // "hardie_5/4x4"
    manual_lf?: number | null;
    include_slope_sill?: boolean;
  };
  belly_band?: {
    include?: boolean;
    size?: string;
    manual_lf?: number | null;
    flashing_type?: string;
  };
  consumables?: {
    caulk_type?: string;
    include_spackle?: boolean;
    include_trim_nails?: boolean;
    include_primer_cans?: boolean;
    include_wood_blades?: boolean;
    include_siding_nails?: boolean;
    include_hardie_blades?: boolean;
    include_paintable_caulk?: boolean;
    include_color_matched_caulk?: boolean;
  };
  trim_system?: string;      // "hardie" | "whitewood"
  wrb_product?: string | null;
  markup_percent?: number;
  // Trade configuration fields (from trade_configurations form)
  window_trim_width?: string;   // "3.5", "4", "5.5", "6", "7.25"
  window_trim_finish?: string;  // "colorplus", "primed"
  door_trim_width?: string;
  door_trim_finish?: string;
}

/**
 * Fetch estimate settings from project_configurations table
 * Uses service role client to bypass RLS
 *
 * @param projectId - The project UUID
 * @returns Estimate settings or null if not found
 */
export async function getProjectEstimateSettings(
  projectId: string
): Promise<ProjectEstimateSettings | null> {
  if (!projectId) {
    console.log('⚠️ getProjectEstimateSettings: No project_id provided');
    return null;
  }

  if (!isDatabaseConfigured()) {
    console.warn('⚠️ getProjectEstimateSettings: Database not configured');
    return null;
  }

  try {
    // Use service role client to bypass RLS
    const { getSupabaseServiceClient } = await import('./database');
    const supabase = getSupabaseServiceClient();

    // Fetch the siding trade configuration (has wrb, overhead, trim settings)
    // May have multiple rows per project (one per trade), so we order by updated_at
    const { data, error } = await supabase
      .from('project_configurations')
      .select('configuration_data, trade, updated_at')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('⚠️ getProjectEstimateSettings: Query error:', error.message);
      return null;
    }

    if (!data || data.length === 0) {
      console.log(`ℹ️ getProjectEstimateSettings: No config found for project ${projectId}`);
      return null;
    }

    // Look for siding trade config first (has overhead, wrb, trim settings)
    const sidingConfig = data.find((row: any) => row.trade === 'siding');
    if (sidingConfig?.configuration_data) {
      console.log(`✅ getProjectEstimateSettings: Loaded siding config for project ${projectId}`);
      return sidingConfig.configuration_data as ProjectEstimateSettings;
    }

    // Fallback: use the most recently updated config that has estimate settings keys
    for (const row of data) {
      const config = row.configuration_data as any;
      if (config && (config.overhead || config.trim_system || config.wrb || config.window_trim)) {
        console.log(`✅ getProjectEstimateSettings: Loaded config (trade=${row.trade}) for project ${projectId}`);
        return config as ProjectEstimateSettings;
      }
    }

    // Last resort: return the first row's config
    if (data[0]?.configuration_data) {
      console.log(`✅ getProjectEstimateSettings: Using first available config for project ${projectId}`);
      return data[0].configuration_data as ProjectEstimateSettings;
    }

    console.log(`ℹ️ getProjectEstimateSettings: No valid config data for project ${projectId}`);
    return null;

  } catch (err: any) {
    console.error('⚠️ getProjectEstimateSettings: Exception:', err.message);
    return null;
  }
}
