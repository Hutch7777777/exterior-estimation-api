/**
 * Pricing Service - Fetches from Supabase v_pricing_current view
 */

import { getSupabaseClient, isDatabaseConfigured } from './database';

export interface PricingItem {
  sku: string;
  product_name: string;
  manufacturer: string;
  category: string;
  trade: string;
  unit: string;
  material_cost: number;
  base_labor_cost: number;
  li_insurance_cost: number;
  unemployment_cost: number;
  total_labor_cost: number;
  equipment_cost: number;
  total_cost: number;
  snapshot_name: string;
  effective_date: string;
  vendor_name: string;
}

let pricingCache: Map<string, PricingItem> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchPricingData(): Promise<Map<string, PricingItem>> {
  if (pricingCache && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return pricingCache;
  }

  if (!isDatabaseConfigured()) {
    console.warn('⚠️ Database not configured - using fallback pricing');
    return new Map();
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('v_pricing_current')
      .select('*')
      .eq('trade', 'siding');

    if (error) {
      console.error('❌ Error fetching pricing:', error.message);
      return pricingCache || new Map();
    }

    const newCache = new Map<string, PricingItem>();
    for (const item of data || []) {
      newCache.set(item.sku, item as PricingItem);
    }

    pricingCache = newCache;
    cacheTimestamp = Date.now();
    console.log(`✅ Loaded ${newCache.size} pricing items from database`);
    return newCache;
  } catch (err) {
    console.error('❌ Database connection error:', err);
    return pricingCache || new Map();
  }
}

export async function getPricingBySku(sku: string): Promise<PricingItem | null> {
  const pricing = await fetchPricingData();
  return pricing.get(sku) || null;
}

export async function getPricingForSkus(skus: string[]): Promise<Map<string, PricingItem>> {
  const allPricing = await fetchPricingData();
  const result = new Map<string, PricingItem>();
  for (const sku of skus) {
    const pricing = allPricing.get(sku);
    if (pricing) result.set(sku, pricing);
  }
  return result;
}

export function clearPricingCache(): void {
  pricingCache = null;
  cacheTimestamp = 0;
}
