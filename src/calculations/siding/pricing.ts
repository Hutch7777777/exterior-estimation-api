/**
 * Pricing Integration for Siding Calculations
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MaterialLineItem,
  PricedMaterialLineItem,
  LaborLineItem,
  TakeoffTotals
} from '../../types';
import { getPricingForSkus, PricingItem } from '../../services/pricing';
import {
  calculateLaborCost,
  LI_INSURANCE_RATE,
  UNEMPLOYMENT_RATE,
  FALLBACK_LABOR_RATES
} from '../../services/labor';

export async function applyPricingToMaterials(
  materials: MaterialLineItem[]
): Promise<{
  pricedMaterials: PricedMaterialLineItem[];
  skusFound: number;
  skusMissing: string[];
  snapshotName?: string;
}> {
  const skus = [...new Set(materials.map(m => m.sku))];
  const pricingMap = await getPricingForSkus(skus);
  const skusMissing: string[] = [];
  let snapshotName: string | undefined;

  const pricedMaterials: PricedMaterialLineItem[] = materials.map(material => {
    const pricing = pricingMap.get(material.sku);

    if (pricing) {
      snapshotName = snapshotName || pricing.snapshot_name;
      return {
        ...material,
        unit_cost: pricing.material_cost,
        extended_cost: Math.round(material.quantity * pricing.material_cost * 100) / 100,
        pricing_source: 'database' as const,
        pricing_snapshot: pricing.snapshot_name
      };
    } else {
      skusMissing.push(material.sku);
      return {
        ...material,
        unit_cost: undefined,
        extended_cost: undefined,
        pricing_source: 'none' as const
      };
    }
  });

  return { pricedMaterials, skusFound: pricingMap.size, skusMissing, snapshotName };
}

export async function generateLaborItems(
  materials: MaterialLineItem[],
  measurements: {
    net_siding_sqft: number;
    trim_lf: number;
    corner_lf: number;
    gable_count: number;
  }
): Promise<LaborLineItem[]> {
  const laborItems: LaborLineItem[] = [];

  // Siding installation
  const sidingSquares = measurements.net_siding_sqft / 100;
  if (sidingSquares > 0) {
    const labor = calculateLaborCost(FALLBACK_LABOR_RATES.lap_siding, sidingSquares);
    laborItems.push({
      id: uuidv4(),
      description: 'Siding Installation',
      quantity: Math.round(sidingSquares * 100) / 100,
      unit: 'square',
      base_rate: FALLBACK_LABOR_RATES.lap_siding,
      li_insurance: Math.round((labor.li_insurance_cost / sidingSquares) * 100) / 100,
      unemployment: Math.round((labor.unemployment_cost / sidingSquares) * 100) / 100,
      total_rate: Math.round((labor.total_labor_cost / sidingSquares) * 100) / 100,
      extended: labor.total_labor_cost,
      calculation: {
        formula: 'squares × base_rate × (1 + li_rate + unemployment_rate)',
        inputs: { squares: sidingSquares, base_rate: FALLBACK_LABOR_RATES.lap_siding, li_rate: LI_INSURANCE_RATE, unemployment_rate: UNEMPLOYMENT_RATE },
        result: labor.total_labor_cost
      },
      category: 'labor'
    });
  }

  // Trim installation
  if (measurements.trim_lf > 0) {
    const labor = calculateLaborCost(FALLBACK_LABOR_RATES.trim_install, measurements.trim_lf);
    laborItems.push({
      id: uuidv4(),
      description: 'Trim Installation',
      quantity: Math.round(measurements.trim_lf * 100) / 100,
      unit: 'lf',
      base_rate: FALLBACK_LABOR_RATES.trim_install,
      li_insurance: Math.round((labor.li_insurance_cost / measurements.trim_lf) * 100) / 100,
      unemployment: Math.round((labor.unemployment_cost / measurements.trim_lf) * 100) / 100,
      total_rate: Math.round((labor.total_labor_cost / measurements.trim_lf) * 100) / 100,
      extended: labor.total_labor_cost,
      calculation: {
        formula: 'trim_lf × base_rate × (1 + li_rate + unemployment_rate)',
        inputs: { trim_lf: measurements.trim_lf, base_rate: FALLBACK_LABOR_RATES.trim_install, li_rate: LI_INSURANCE_RATE, unemployment_rate: UNEMPLOYMENT_RATE },
        result: labor.total_labor_cost
      },
      category: 'labor'
    });
  }

  // Corner installation
  if (measurements.corner_lf > 0) {
    const labor = calculateLaborCost(FALLBACK_LABOR_RATES.corner_install, measurements.corner_lf);
    laborItems.push({
      id: uuidv4(),
      description: 'Corner Installation',
      quantity: Math.round(measurements.corner_lf * 100) / 100,
      unit: 'lf',
      base_rate: FALLBACK_LABOR_RATES.corner_install,
      li_insurance: Math.round((labor.li_insurance_cost / measurements.corner_lf) * 100) / 100,
      unemployment: Math.round((labor.unemployment_cost / measurements.corner_lf) * 100) / 100,
      total_rate: Math.round((labor.total_labor_cost / measurements.corner_lf) * 100) / 100,
      extended: labor.total_labor_cost,
      calculation: {
        formula: 'corner_lf × base_rate × (1 + li_rate + unemployment_rate)',
        inputs: { corner_lf: measurements.corner_lf, base_rate: FALLBACK_LABOR_RATES.corner_install, li_rate: LI_INSURANCE_RATE, unemployment_rate: UNEMPLOYMENT_RATE },
        result: labor.total_labor_cost
      },
      category: 'labor'
    });
  }

  // Gable top-out
  if (measurements.gable_count > 0) {
    const labor = calculateLaborCost(FALLBACK_LABOR_RATES.gable_topout, measurements.gable_count);
    laborItems.push({
      id: uuidv4(),
      description: 'Gable Top-Out',
      quantity: measurements.gable_count,
      unit: 'ea',
      base_rate: FALLBACK_LABOR_RATES.gable_topout,
      li_insurance: Math.round((labor.li_insurance_cost / measurements.gable_count) * 100) / 100,
      unemployment: Math.round((labor.unemployment_cost / measurements.gable_count) * 100) / 100,
      total_rate: Math.round((labor.total_labor_cost / measurements.gable_count) * 100) / 100,
      extended: labor.total_labor_cost,
      calculation: {
        formula: 'gable_count × base_rate × (1 + li_rate + unemployment_rate)',
        inputs: { gable_count: measurements.gable_count, base_rate: FALLBACK_LABOR_RATES.gable_topout, li_rate: LI_INSURANCE_RATE, unemployment_rate: UNEMPLOYMENT_RATE },
        result: labor.total_labor_cost
      },
      category: 'labor'
    });
  }

  return laborItems;
}

export function calculateTotals(
  materials: PricedMaterialLineItem[],
  labor: LaborLineItem[],
  markupRate: number = 0.15
): TakeoffTotals {
  const material_subtotal = materials
    .filter(m => m.extended_cost !== undefined)
    .reduce((sum, m) => sum + (m.extended_cost || 0), 0);

  const labor_subtotal = labor.reduce((sum, l) => sum + l.extended, 0);
  const overhead = Math.round(labor_subtotal * 0.10 * 100) / 100;
  const subtotal = material_subtotal + labor_subtotal + overhead;
  const markup_amount = Math.round(subtotal * markupRate * 100) / 100;
  const total = Math.round((subtotal + markup_amount) * 100) / 100;

  return {
    material_subtotal: Math.round(material_subtotal * 100) / 100,
    labor_subtotal: Math.round(labor_subtotal * 100) / 100,
    overhead,
    subtotal: Math.round(subtotal * 100) / 100,
    markup_rate: markupRate,
    markup_amount,
    total
  };
}
