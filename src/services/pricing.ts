/**
 * Pricing Service - Fetches from Supabase pricing_items table
 * Supports both SKU-based and ID-based lookup with organization overrides
 */

import { getSupabaseClient, isDatabaseConfigured } from './database';

export interface PricingItem {
  id?: string;  // UUID primary key
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
  snapshot_name?: string;
  effective_date?: string;
  vendor_name?: string;
  // Additional fields from pricing_items table
  reveal_inches?: number;
  pieces_per_square?: number;
  coverage_value?: number;
  coverage_unit?: string;
}

interface PricingOverride {
  material_cost_override?: number;
  labor_rate_override?: number;
  markup_percent_override?: number;
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

// ============================================================================
// ID-BASED PRICING LOOKUP (for material_assignments)
// ============================================================================

/**
 * Look up pricing by UUID with optional organization override support
 */
export async function getPricingById(
  pricingItemId: string,
  organizationId?: string
): Promise<PricingItem | null> {
  if (!isDatabaseConfigured()) {
    console.warn('⚠️ Database not configured, cannot lookup pricing by ID');
    return null;
  }

  try {
    const client = getSupabaseClient();

    // Get base pricing from pricing_items table
    const { data: basePrice, error } = await client
      .from('pricing_items')
      .select('*')
      .eq('id', pricingItemId)
      .single();

    if (error || !basePrice) {
      console.error(`❌ Pricing not found for ID: ${pricingItemId}`, error?.message);
      return null;
    }

    // Check for organization override if applicable
    if (organizationId) {
      const { data: override } = await client
        .from('organization_pricing_overrides')
        .select('material_cost_override, labor_rate_override, markup_percent_override')
        .eq('pricing_item_id', pricingItemId)
        .eq('organization_id', organizationId)
        .single();

      if (override) {
        return {
          ...basePrice,
          material_cost: override.material_cost_override ?? basePrice.material_cost,
          base_labor_cost: override.labor_rate_override ?? basePrice.base_labor_cost,
          total_labor_cost: calculateTotalLabor(
            override.labor_rate_override ?? basePrice.base_labor_cost
          ),
        };
      }
    }

    return basePrice;
  } catch (err) {
    console.error('❌ Error fetching pricing by ID:', err);
    return null;
  }
}

/**
 * Batch lookup for multiple pricing IDs (more efficient than individual lookups)
 */
export async function getPricingByIds(
  pricingItemIds: string[],
  organizationId?: string
): Promise<Map<string, PricingItem>> {
  const results = new Map<string, PricingItem>();

  if (!isDatabaseConfigured() || pricingItemIds.length === 0) {
    return results;
  }

  try {
    const client = getSupabaseClient();

    // Get all base prices in one query
    const { data: basePrices, error } = await client
      .from('pricing_items')
      .select('*')
      .in('id', pricingItemIds);

    if (error || !basePrices) {
      console.error('❌ Failed to fetch pricing by IDs:', error?.message);
      return results;
    }

    // Get organization overrides if applicable
    const overrides = new Map<string, PricingOverride>();
    if (organizationId) {
      const { data: overrideData } = await client
        .from('organization_pricing_overrides')
        .select('pricing_item_id, material_cost_override, labor_rate_override, markup_percent_override')
        .eq('organization_id', organizationId)
        .in('pricing_item_id', pricingItemIds);

      if (overrideData) {
        overrideData.forEach(o => overrides.set(o.pricing_item_id, o));
      }
    }

    // Merge base prices with overrides
    basePrices.forEach(price => {
      const override = overrides.get(price.id);
      const finalPrice: PricingItem = {
        ...price,
        material_cost: Number(override?.material_cost_override ?? price.material_cost),
        base_labor_cost: Number(override?.labor_rate_override ?? price.base_labor_cost),
      };

      // Recalculate total labor if we have an override
      if (override?.labor_rate_override) {
        finalPrice.total_labor_cost = calculateTotalLabor(Number(override.labor_rate_override));
      }

      results.set(price.id, finalPrice);
    });

    console.log(`✅ Fetched ${results.size} pricing items by ID, ${overrides.size} overrides applied`);
    return results;
  } catch (err) {
    console.error('❌ Error in batch pricing lookup:', err);
    return results;
  }
}

/**
 * Calculate total labor cost using Mike Skjei methodology
 * Base + L&I (12.65%) + Unemployment (1.3%)
 */
export function calculateTotalLabor(baseLaborCost: number): number {
  const liRate = 0.1265;
  const unemploymentRate = 0.013;
  return baseLaborCost * (1 + liRate + unemploymentRate);
}
