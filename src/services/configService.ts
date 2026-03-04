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
