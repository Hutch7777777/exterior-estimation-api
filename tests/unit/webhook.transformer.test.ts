/**
 * Tests for webhook transformer functions
 */

import {
  transformWebhookToCalculationRequest,
  transformCalculationToWebhookResponse
} from '../../src/transformers/webhook';
import { WebhookRequest } from '../../src/types/webhook';
import { PricedCalculationResponse } from '../../src/types/calculation';

describe('Webhook Transformers', () => {

  describe('transformWebhookToCalculationRequest', () => {

    it('transforms HOVER measurements to internal format', () => {
      const webhook: WebhookRequest = {
        project_id: 'test-001',
        project_name: 'Test Project',
        measurements: {
          facade_sqft: 2000,
          net_wall_area_sqft: 1606,
          windows: { count: 10, total_area_sqft: 200, perimeter_lf: 140 },
          doors: { count: 2, total_area_sqft: 40, perimeter_lf: 36 },
          garages: { count: 1, total_area_sqft: 154, perimeter_lf: 24 },
          outside_corners: { count: 4, total_lf: 40 },
          inside_corners: { count: 0, total_lf: 0 },
          gables: { count: 2 }
        },
        siding: {
          siding_color: 'Arctic White',
          siding_profile: 'cedarmill'
        }
      };

      const result = transformWebhookToCalculationRequest(webhook);

      expect(result.project.id).toBe('test-001');
      expect(result.measurements.siding.gross_area_sf).toBe(2000);
      expect(result.measurements.siding.net_area_sf).toBe(1606);
      expect(result.measurements.openings.windows.count).toBe(10);
      expect(result.measurements.corners.outside.count).toBe(4);
      expect(result.config.siding.finish).toBe('colorplus');
      expect(result.config.siding.color).toBe('Arctic White');
    });

    it('handles missing optional fields', () => {
      const webhook: WebhookRequest = {
        project_id: 'minimal-test',
        measurements: {
          facade_sqft: 1000,
          net_wall_area_sqft: 800
        }
      };

      const result = transformWebhookToCalculationRequest(webhook);

      expect(result.project.id).toBe('minimal-test');
      expect(result.measurements.openings.windows.count).toBe(0);
      expect(result.measurements.corners.outside.count).toBe(0);
      expect(result.config.siding.finish).toBe('primed');
    });

    it('calculates net area from gross if not provided', () => {
      const webhook: WebhookRequest = {
        project_id: 'calc-test',
        measurements: {
          facade_sqft: 2000,
          windows: { count: 10, total_area_sqft: 200 },
          doors: { count: 2, total_area_sqft: 40 },
          garages: { count: 1, total_area_sqft: 154 }
        }
      };

      const result = transformWebhookToCalculationRequest(webhook);

      // 2000 - (200 + 40 + 154) = 1606
      expect(result.measurements.siding.net_area_sf).toBe(1606);
    });

    it('sets default reveal when not provided', () => {
      const webhook: WebhookRequest = {
        project_id: 'reveal-test',
        measurements: {
          facade_sqft: 1000,
          net_wall_area_sqft: 800
        }
      };

      const result = transformWebhookToCalculationRequest(webhook);

      expect(result.config.siding.reveal_inches).toBe(6.75);
    });

    it('uses custom reveal when provided', () => {
      const webhook: WebhookRequest = {
        project_id: 'custom-reveal',
        measurements: {
          facade_sqft: 1000,
          net_wall_area_sqft: 800
        },
        siding: {
          siding_reveal: 8.25
        }
      };

      const result = transformWebhookToCalculationRequest(webhook);

      expect(result.config.siding.reveal_inches).toBe(8.25);
    });

  });

  describe('transformCalculationToWebhookResponse', () => {

    it('transforms calculation result to webhook format', () => {
      const calcResult: PricedCalculationResponse = {
        success: true,
        trade: 'siding',
        materials: [
          {
            id: '1',
            sku: 'TEST-SKU',
            description: 'Test Material',
            quantity: 18,
            unit: 'SQUARE',
            category: 'siding',
            presentation_group: 'siding',
            source: 'calculated',
            calculation: { formula: 'test', inputs: {}, result: 18 },
            unit_cost: 100,
            extended_cost: 1800,
            pricing_source: 'database'
          }
        ],
        labor: [
          {
            id: '2',
            description: 'Siding Installation',
            quantity: 16,
            unit: 'square',
            base_rate: 180,
            li_insurance: 22.77,
            unemployment: 2.34,
            total_rate: 205.11,
            extended: 3281.76,
            calculation: { formula: 'test', inputs: {}, result: 3281.76 },
            category: 'labor'
          }
        ],
        totals: {
          material_subtotal: 1800,
          labor_subtotal: 3281.76,
          overhead: 328.18,
          subtotal: 5409.94,
          markup_rate: 0.15,
          markup_amount: 811.49,
          total: 6221.43
        },
        pricing_metadata: {
          skus_found: 1,
          skus_missing: [],
          snapshot_name: 'Q1 2026'
        },
        provenance: {
          version: 'test',
          timestamp: '2026-01-18T00:00:00Z',
          warnings: []
        }
      };

      const webhook: WebhookRequest = {
        project_id: 'test-001',
        project_name: 'Test Project',
        measurements: { facade_sqft: 2000, net_wall_area_sqft: 1606 }
      };

      const result = transformCalculationToWebhookResponse(calcResult, webhook);

      expect(result.success).toBe(true);
      expect(result.project_id).toBe('test-001');
      expect(result.line_items.length).toBe(2); // 1 material + 1 labor
      expect(result.line_items[0].category).toBe('Siding');
      expect(result.line_items[1].category).toBe('Labor');
      expect(result.totals.material_cost).toBe(1800);
      expect(result.totals.labor_cost).toBe(3281.76);
      expect(result.totals.total).toBe(6221.43);
    });

    it('converts markup rate to percentage', () => {
      const calcResult: PricedCalculationResponse = {
        success: true,
        trade: 'siding',
        materials: [],
        labor: [],
        totals: {
          material_subtotal: 0,
          labor_subtotal: 0,
          overhead: 0,
          subtotal: 0,
          markup_rate: 0.15,
          markup_amount: 0,
          total: 0
        },
        pricing_metadata: {
          skus_found: 0,
          skus_missing: []
        },
        provenance: {
          version: 'test',
          timestamp: '2026-01-18T00:00:00Z',
          warnings: []
        }
      };

      const webhook: WebhookRequest = {
        project_id: 'test',
        measurements: { facade_sqft: 1000 }
      };

      const result = transformCalculationToWebhookResponse(calcResult, webhook);

      expect(result.totals.markup_percent).toBe(15);
    });

    it('maps category names correctly', () => {
      const calcResult: PricedCalculationResponse = {
        success: true,
        trade: 'siding',
        materials: [
          { id: '1', sku: 'S', description: 'Siding', quantity: 1, unit: 'EA', category: 'siding', presentation_group: 'Siding', source: 'calculated', calculation: { formula: '', inputs: {}, result: 1 } },
          { id: '2', sku: 'T', description: 'Trim', quantity: 1, unit: 'EA', category: 'trim', presentation_group: 'Trim', source: 'calculated', calculation: { formula: '', inputs: {}, result: 1 } },
          { id: '3', sku: 'F', description: 'Flashing', quantity: 1, unit: 'EA', category: 'flashing', presentation_group: 'Flashing', source: 'calculated', calculation: { formula: '', inputs: {}, result: 1 } },
          { id: '4', sku: 'W', description: 'Wrap', quantity: 1, unit: 'EA', category: 'water_barrier', presentation_group: 'Water Barrier', source: 'calculated', calculation: { formula: '', inputs: {}, result: 1 } },
          { id: '5', sku: 'N', description: 'Nails', quantity: 1, unit: 'EA', category: 'fasteners', presentation_group: 'Fasteners', source: 'calculated', calculation: { formula: '', inputs: {}, result: 1 } },
          { id: '6', sku: 'A', description: 'Accessory', quantity: 1, unit: 'EA', category: 'accessories', presentation_group: 'Accessories', source: 'calculated', calculation: { formula: '', inputs: {}, result: 1 } }
        ],
        labor: [],
        totals: { material_subtotal: 0, labor_subtotal: 0, overhead: 0, subtotal: 0, markup_rate: 0.15, markup_amount: 0, total: 0 },
        pricing_metadata: { skus_found: 0, skus_missing: [] },
        provenance: { version: 'test', timestamp: '2026-01-18T00:00:00Z', warnings: [] }
      };

      const webhook: WebhookRequest = { project_id: 'test', measurements: { facade_sqft: 1000 } };
      const result = transformCalculationToWebhookResponse(calcResult, webhook);

      expect(result.line_items[0].category).toBe('Siding');
      expect(result.line_items[1].category).toBe('Trim');
      expect(result.line_items[2].category).toBe('Flashing');
      expect(result.line_items[3].category).toBe('Water Barrier');
      expect(result.line_items[4].category).toBe('Fasteners');
      expect(result.line_items[5].category).toBe('Accessories');
    });

  });

});
