/**
 * Labor Calculation Service - Mike Skjei Methodology
 * Formula: total = base + li_insurance (12.65%) + unemployment (1.3%)
 */

export const LI_INSURANCE_RATE = 0.1265;
export const UNEMPLOYMENT_RATE = 0.013;

export interface LaborCost {
  base_labor_cost: number;
  li_insurance_cost: number;
  unemployment_cost: number;
  total_labor_cost: number;
}

export function calculateLaborCost(
  baseRate: number,
  quantity: number,
  liRate: number = LI_INSURANCE_RATE,
  unemploymentRate: number = UNEMPLOYMENT_RATE
): LaborCost {
  const base_labor_cost = baseRate * quantity;
  const li_insurance_cost = base_labor_cost * liRate;
  const unemployment_cost = base_labor_cost * unemploymentRate;
  const total_labor_cost = base_labor_cost + li_insurance_cost + unemployment_cost;

  return {
    base_labor_cost: Math.round(base_labor_cost * 100) / 100,
    li_insurance_cost: Math.round(li_insurance_cost * 100) / 100,
    unemployment_cost: Math.round(unemployment_cost * 100) / 100,
    total_labor_cost: Math.round(total_labor_cost * 100) / 100
  };
}

export function calculateLIInsurance(baseLaborCost: number, rate: number = LI_INSURANCE_RATE): number {
  return Math.round(baseLaborCost * rate * 100) / 100;
}

export const FALLBACK_LABOR_RATES = {
  lap_siding: 180,
  shingle_siding: 200,
  panel_siding: 220,
  board_batten: 200,
  trim_install: 8.50,
  corner_install: 12.00,
  wrap_install: 0.35,
  gable_topout: 25.00
} as const;
