/**
 * Labor Calculation Tests
 * Tests Mike Skjei methodology: base + L&I (12.65%) + unemployment (1.3%)
 */

import {
  calculateLaborCost,
  calculateLIInsurance,
  LI_INSURANCE_RATE,
  UNEMPLOYMENT_RATE,
  FALLBACK_LABOR_RATES
} from '../../src/services/labor';

describe('Labor Calculations - Mike Skjei Methodology', () => {
  describe('calculateLaborCost', () => {
    it('should calculate labor with L&I and unemployment for siding installation', () => {
      // 10 squares at $180/square
      const result = calculateLaborCost(180, 10);

      expect(result.base_labor_cost).toBe(1800);
      expect(result.li_insurance_cost).toBe(227.70); // 1800 × 0.1265
      expect(result.unemployment_cost).toBe(23.40);  // 1800 × 0.013
      expect(result.total_labor_cost).toBe(2051.10); // 1800 + 227.70 + 23.40
    });

    it('should calculate labor for trim installation', () => {
      // 100 LF at $8.50/LF
      const result = calculateLaborCost(8.50, 100);

      expect(result.base_labor_cost).toBe(850);
      expect(result.li_insurance_cost).toBe(107.53); // 850 × 0.1265 = 107.525 → 107.53
      expect(result.unemployment_cost).toBe(11.05);  // 850 × 0.013 = 11.05
      expect(result.total_labor_cost).toBe(968.58);  // 850 + 107.53 + 11.05
    });

    it('should calculate labor for corner installation', () => {
      // 40 LF at $12/LF
      const result = calculateLaborCost(12, 40);

      expect(result.base_labor_cost).toBe(480);
      expect(result.li_insurance_cost).toBe(60.72);  // 480 × 0.1265
      expect(result.unemployment_cost).toBe(6.24);   // 480 × 0.013
      expect(result.total_labor_cost).toBe(546.96);  // 480 + 60.72 + 6.24
    });

    it('should calculate labor for gable top-out', () => {
      // 2 gables at $25 each
      const result = calculateLaborCost(25, 2);

      expect(result.base_labor_cost).toBe(50);
      expect(result.li_insurance_cost).toBe(6.33);   // 50 × 0.1265 = 6.325 → 6.33
      expect(result.unemployment_cost).toBe(0.65);   // 50 × 0.013
      expect(result.total_labor_cost).toBe(56.98);   // 50 + 6.33 + 0.65
    });

    it('should handle zero quantity', () => {
      const result = calculateLaborCost(180, 0);

      expect(result.base_labor_cost).toBe(0);
      expect(result.li_insurance_cost).toBe(0);
      expect(result.unemployment_cost).toBe(0);
      expect(result.total_labor_cost).toBe(0);
    });

    it('should allow custom rates', () => {
      // Custom L&I rate of 15% and unemployment of 2%
      const result = calculateLaborCost(100, 10, 0.15, 0.02);

      expect(result.base_labor_cost).toBe(1000);
      expect(result.li_insurance_cost).toBe(150);    // 1000 × 0.15
      expect(result.unemployment_cost).toBe(20);     // 1000 × 0.02
      expect(result.total_labor_cost).toBe(1170);    // 1000 + 150 + 20
    });
  });

  describe('calculateLIInsurance', () => {
    it('should calculate L&I insurance at default rate', () => {
      const result = calculateLIInsurance(1000);
      expect(result).toBe(126.50); // 1000 × 0.1265
    });

    it('should calculate L&I insurance at custom rate', () => {
      const result = calculateLIInsurance(1000, 0.10);
      expect(result).toBe(100);
    });
  });

  describe('Constants', () => {
    it('should have correct L&I insurance rate', () => {
      expect(LI_INSURANCE_RATE).toBe(0.1265);
    });

    it('should have correct unemployment rate', () => {
      expect(UNEMPLOYMENT_RATE).toBe(0.013);
    });

    it('should have correct fallback labor rates', () => {
      expect(FALLBACK_LABOR_RATES.lap_siding).toBe(180);
      expect(FALLBACK_LABOR_RATES.shingle_siding).toBe(200);
      expect(FALLBACK_LABOR_RATES.panel_siding).toBe(220);
      expect(FALLBACK_LABOR_RATES.board_batten).toBe(200);
      expect(FALLBACK_LABOR_RATES.trim_install).toBe(8.50);
      expect(FALLBACK_LABOR_RATES.corner_install).toBe(12.00);
      expect(FALLBACK_LABOR_RATES.wrap_install).toBe(0.35);
      expect(FALLBACK_LABOR_RATES.gable_topout).toBe(25.00);
    });
  });

  describe('Edge Cases', () => {
    it('should handle fractional quantities', () => {
      // 16.06 squares (typical for 1606 sqft)
      const result = calculateLaborCost(180, 16.06);

      expect(result.base_labor_cost).toBe(2890.80);
      expect(result.li_insurance_cost).toBe(365.69); // 2890.80 × 0.1265
      expect(result.unemployment_cost).toBe(37.58);  // 2890.80 × 0.013
      expect(result.total_labor_cost).toBe(3294.07);
    });

    it('should handle very small quantities', () => {
      const result = calculateLaborCost(180, 0.5);

      expect(result.base_labor_cost).toBe(90);
      expect(result.li_insurance_cost).toBe(11.39);  // 90 × 0.1265 = 11.385 → 11.39
      expect(result.unemployment_cost).toBe(1.17);   // 90 × 0.013
      expect(result.total_labor_cost).toBe(102.56);
    });
  });
});
