/**
 * Pricing Integration Tests
 * Tests pricing application, labor generation, and totals calculation
 */

import {
  applyPricingToMaterials,
  generateLaborItems,
  calculateTotals
} from '../../src/calculations/siding/pricing';
import { MaterialLineItem, PricedMaterialLineItem, LaborLineItem } from '../../src/types';

// Mock the pricing service - returns only SKUs that exist in our mock data
const mockPricingData = new Map([
  ['JHSC-LAP-675-PM', {
    sku: 'JHSC-LAP-675-PM',
    product_name: 'HardiePlank 6.75" Primed',
    material_cost: 245.00,
    snapshot_name: 'Q1-2026'
  }],
  ['JHSC-OSC-PM', {
    sku: 'JHSC-OSC-PM',
    product_name: 'Outside Corner Primed',
    material_cost: 28.50,
    snapshot_name: 'Q1-2026'
  }]
]);

jest.mock('../../src/services/pricing', () => ({
  getPricingForSkus: jest.fn().mockImplementation((skus: string[]) => {
    const result = new Map();
    for (const sku of skus) {
      const pricing = mockPricingData.get(sku);
      if (pricing) {
        result.set(sku, pricing);
      }
    }
    return Promise.resolve(result);
  })
}));

describe('Pricing Integration', () => {
  describe('applyPricingToMaterials', () => {
    it('should apply pricing from database to materials', async () => {
      const materials: MaterialLineItem[] = [
        {
          id: 'test-1',
          sku: 'JHSC-LAP-675-PM',
          description: 'HardiePlank Lap Siding 6.75" Primed',
          quantity: 20,
          unit: 'SQUARE',
          category: 'siding',
          presentation_group: 'Siding',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 20 }
        }
      ];

      const result = await applyPricingToMaterials(materials);

      expect(result.skusFound).toBe(1);
      expect(result.skusMissing).toHaveLength(0);
      expect(result.pricedMaterials[0].unit_cost).toBe(245.00);
      expect(result.pricedMaterials[0].extended_cost).toBe(4900.00);
      expect(result.pricedMaterials[0].pricing_source).toBe('database');
      expect(result.snapshotName).toBe('Q1-2026');
    });

    it('should handle missing SKUs gracefully', async () => {
      const materials: MaterialLineItem[] = [
        {
          id: 'test-1',
          sku: 'UNKNOWN-SKU',
          description: 'Unknown Product',
          quantity: 10,
          unit: 'EA',
          category: 'accessories',
          presentation_group: 'Accessories',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 10 }
        }
      ];

      const result = await applyPricingToMaterials(materials);

      expect(result.skusFound).toBe(0);
      expect(result.skusMissing).toContain('UNKNOWN-SKU');
      expect(result.pricedMaterials[0].unit_cost).toBeUndefined();
      expect(result.pricedMaterials[0].extended_cost).toBeUndefined();
      expect(result.pricedMaterials[0].pricing_source).toBe('none');
    });

    it('should handle mixed found and missing SKUs', async () => {
      const materials: MaterialLineItem[] = [
        {
          id: 'test-1',
          sku: 'JHSC-LAP-675-PM',
          description: 'Known Product',
          quantity: 10,
          unit: 'SQUARE',
          category: 'siding',
          presentation_group: 'Siding',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 10 }
        },
        {
          id: 'test-2',
          sku: 'UNKNOWN-SKU',
          description: 'Unknown Product',
          quantity: 5,
          unit: 'EA',
          category: 'accessories',
          presentation_group: 'Accessories',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 5 }
        }
      ];

      const result = await applyPricingToMaterials(materials);

      expect(result.skusFound).toBe(1);
      expect(result.skusMissing).toHaveLength(1);
      expect(result.pricedMaterials[0].pricing_source).toBe('database');
      expect(result.pricedMaterials[1].pricing_source).toBe('none');
    });
  });

  describe('generateLaborItems', () => {
    it('should generate siding installation labor', async () => {
      const materials: MaterialLineItem[] = [];
      const measurements = {
        net_siding_sqft: 1606,
        trim_lf: 0,
        corner_lf: 0,
        gable_count: 0
      };

      const labor = await generateLaborItems(materials, measurements);

      const sidingLabor = labor.find(l => l.description === 'Siding Installation');
      expect(sidingLabor).toBeDefined();
      expect(sidingLabor!.quantity).toBe(16.06); // 1606 / 100
      expect(sidingLabor!.unit).toBe('square');
      expect(sidingLabor!.base_rate).toBe(180);
    });

    it('should generate trim installation labor', async () => {
      const materials: MaterialLineItem[] = [];
      const measurements = {
        net_siding_sqft: 0,
        trim_lf: 100,
        corner_lf: 0,
        gable_count: 0
      };

      const labor = await generateLaborItems(materials, measurements);

      const trimLabor = labor.find(l => l.description === 'Trim Installation');
      expect(trimLabor).toBeDefined();
      expect(trimLabor!.quantity).toBe(100);
      expect(trimLabor!.unit).toBe('lf');
      expect(trimLabor!.base_rate).toBe(8.50);
    });

    it('should generate corner installation labor', async () => {
      const materials: MaterialLineItem[] = [];
      const measurements = {
        net_siding_sqft: 0,
        trim_lf: 0,
        corner_lf: 40,
        gable_count: 0
      };

      const labor = await generateLaborItems(materials, measurements);

      const cornerLabor = labor.find(l => l.description === 'Corner Installation');
      expect(cornerLabor).toBeDefined();
      expect(cornerLabor!.quantity).toBe(40);
      expect(cornerLabor!.unit).toBe('lf');
      expect(cornerLabor!.base_rate).toBe(12.00);
    });

    it('should generate gable top-out labor', async () => {
      const materials: MaterialLineItem[] = [];
      const measurements = {
        net_siding_sqft: 0,
        trim_lf: 0,
        corner_lf: 0,
        gable_count: 2
      };

      const labor = await generateLaborItems(materials, measurements);

      const gableLabor = labor.find(l => l.description === 'Gable Top-Out');
      expect(gableLabor).toBeDefined();
      expect(gableLabor!.quantity).toBe(2);
      expect(gableLabor!.unit).toBe('ea');
      expect(gableLabor!.base_rate).toBe(25.00);
    });

    it('should include L&I and unemployment in labor items', async () => {
      const materials: MaterialLineItem[] = [];
      const measurements = {
        net_siding_sqft: 1000, // 10 squares
        trim_lf: 0,
        corner_lf: 0,
        gable_count: 0
      };

      const labor = await generateLaborItems(materials, measurements);
      const sidingLabor = labor[0];

      // Base: 10 squares × $180 = $1800
      // L&I: $1800 × 0.1265 = $227.70
      // Unemployment: $1800 × 0.013 = $23.40
      // Total: $2051.10
      expect(sidingLabor.extended).toBe(2051.10);
    });
  });

  describe('calculateTotals', () => {
    it('should calculate totals with default markup', () => {
      const materials: PricedMaterialLineItem[] = [
        {
          id: 'test-1',
          sku: 'TEST-SKU',
          description: 'Test Material',
          quantity: 10,
          unit: 'EA',
          category: 'siding',
          presentation_group: 'Siding',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 10 },
          unit_cost: 100,
          extended_cost: 1000,
          pricing_source: 'database'
        }
      ];

      const labor: LaborLineItem[] = [
        {
          id: 'labor-1',
          description: 'Siding Installation',
          quantity: 10,
          unit: 'square',
          base_rate: 180,
          li_insurance: 22.77,
          unemployment: 2.34,
          total_rate: 205.11,
          extended: 2051.10,
          calculation: { formula: 'test', inputs: {}, result: 2051.10 },
          category: 'labor'
        }
      ];

      const totals = calculateTotals(materials, labor);

      expect(totals.material_subtotal).toBe(1000);
      expect(totals.labor_subtotal).toBe(2051.10);
      expect(totals.overhead).toBe(205.11); // 10% of labor
      expect(totals.subtotal).toBe(3256.21); // 1000 + 2051.10 + 205.11
      expect(totals.markup_rate).toBe(0.15);
      expect(totals.markup_amount).toBe(488.43); // 3256.21 × 0.15
      expect(totals.total).toBe(3744.64); // 3256.21 + 488.43
    });

    it('should calculate totals with custom markup rate', () => {
      const materials: PricedMaterialLineItem[] = [
        {
          id: 'test-1',
          sku: 'TEST-SKU',
          description: 'Test Material',
          quantity: 10,
          unit: 'EA',
          category: 'siding',
          presentation_group: 'Siding',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 10 },
          unit_cost: 100,
          extended_cost: 1000,
          pricing_source: 'database'
        }
      ];

      const labor: LaborLineItem[] = [];

      const totals = calculateTotals(materials, labor, 0.20);

      expect(totals.material_subtotal).toBe(1000);
      expect(totals.labor_subtotal).toBe(0);
      expect(totals.overhead).toBe(0);
      expect(totals.subtotal).toBe(1000);
      expect(totals.markup_rate).toBe(0.20);
      expect(totals.markup_amount).toBe(200);
      expect(totals.total).toBe(1200);
    });

    it('should exclude materials without pricing from subtotal', () => {
      const materials: PricedMaterialLineItem[] = [
        {
          id: 'test-1',
          sku: 'PRICED-SKU',
          description: 'Priced Material',
          quantity: 10,
          unit: 'EA',
          category: 'siding',
          presentation_group: 'Siding',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 10 },
          unit_cost: 100,
          extended_cost: 1000,
          pricing_source: 'database'
        },
        {
          id: 'test-2',
          sku: 'UNPRICED-SKU',
          description: 'Unpriced Material',
          quantity: 5,
          unit: 'EA',
          category: 'accessories',
          presentation_group: 'Accessories',
          source: 'calculated',
          calculation: { formula: 'test', inputs: {}, result: 5 },
          unit_cost: undefined,
          extended_cost: undefined,
          pricing_source: 'none'
        }
      ];

      const totals = calculateTotals(materials, []);

      // Only the priced material should be included
      expect(totals.material_subtotal).toBe(1000);
    });
  });
});
