/**
 * Integration tests for webhook endpoints
 */

import {
  transformWebhookToCalculationRequest
} from '../../src/transformers/webhook';
import { calculateSidingWithPricing } from '../../src/calculations/siding';
import { WebhookRequest } from '../../src/types/webhook';

describe('Webhook API Integration', () => {

  describe('Full webhook flow', () => {

    it('processes HOVER measurements and returns formatted response', async () => {
      const webhookRequest: WebhookRequest = {
        project_id: 'integration-test',
        project_name: 'Integration Test Project',
        client_name: 'Test Client',
        address: '123 Test St',
        siding: {
          siding_product: "James Hardie 6.75\" Cedarmill",
          siding_color: 'Arctic White',
          siding_profile: 'cedarmill'
        },
        measurements: {
          facade_sqft: 2000,
          net_wall_area_sqft: 1606,
          windows: { count: 10, total_area_sqft: 200, perimeter_lf: 140 },
          doors: { count: 2, total_area_sqft: 40, perimeter_lf: 36 },
          garages: { count: 1, total_area_sqft: 154, perimeter_lf: 24 },
          outside_corners: { count: 4, total_lf: 40 },
          inside_corners: { count: 0, total_lf: 0 },
          gables: { count: 2 }
        }
      };

      // Transform
      const calcRequest = transformWebhookToCalculationRequest(webhookRequest);

      // Calculate
      const result = await calculateSidingWithPricing(calcRequest);

      // Verify
      expect(result.success).toBe(true);
      expect(result.materials.length).toBeGreaterThan(0);
      expect(result.labor.length).toBeGreaterThan(0);

      // Check siding calculation matches January 2026 output
      const siding = result.materials.find(m => m.category === 'siding');
      expect(siding?.quantity).toBe(18); // 18 squares
    });

    it('handles minimal measurements', async () => {
      const webhookRequest: WebhookRequest = {
        project_id: 'minimal-test',
        measurements: {
          facade_sqft: 1000,
          net_wall_area_sqft: 800
        }
      };

      const calcRequest = transformWebhookToCalculationRequest(webhookRequest);
      const result = await calculateSidingWithPricing(calcRequest);

      expect(result.success).toBe(true);
      expect(result.materials.length).toBeGreaterThan(0);
    });

    it('generates labor items based on measurements', async () => {
      const webhookRequest: WebhookRequest = {
        project_id: 'labor-test',
        measurements: {
          facade_sqft: 2000,
          net_wall_area_sqft: 1606,
          windows: { count: 10, perimeter_lf: 140 },
          doors: { count: 2, perimeter_lf: 36 },
          outside_corners: { count: 4, total_lf: 40 },
          gables: { count: 2 }
        }
      };

      const calcRequest = transformWebhookToCalculationRequest(webhookRequest);
      const result = await calculateSidingWithPricing(calcRequest);

      // Check labor items
      const sidingLabor = result.labor.find(l => l.description === 'Siding Installation');
      expect(sidingLabor).toBeDefined();
      expect(sidingLabor!.base_rate).toBe(180);

      const cornerLabor = result.labor.find(l => l.description === 'Corner Installation');
      expect(cornerLabor).toBeDefined();
      expect(cornerLabor!.quantity).toBe(40); // 40 LF of corners

      const gableLabor = result.labor.find(l => l.description === 'Gable Top-Out');
      expect(gableLabor).toBeDefined();
      expect(gableLabor!.quantity).toBe(2); // 2 gables
    });

    it('calculates totals correctly', async () => {
      const webhookRequest: WebhookRequest = {
        project_id: 'totals-test',
        measurements: {
          facade_sqft: 2000,
          net_wall_area_sqft: 1606
        },
        markup_rate: 0.15
      };

      const calcRequest = transformWebhookToCalculationRequest(webhookRequest);
      const result = await calculateSidingWithPricing(calcRequest, 0.15);

      // Verify totals structure
      expect(result.totals.material_subtotal).toBeDefined();
      expect(result.totals.labor_subtotal).toBeDefined();
      expect(result.totals.overhead).toBeDefined();
      expect(result.totals.subtotal).toBeDefined();
      expect(result.totals.markup_rate).toBe(0.15);
      expect(result.totals.markup_amount).toBeDefined();
      expect(result.totals.total).toBeDefined();

      // Verify math: subtotal = material + labor + overhead
      const expectedSubtotal = result.totals.material_subtotal + result.totals.labor_subtotal + result.totals.overhead;
      expect(result.totals.subtotal).toBeCloseTo(expectedSubtotal, 2);

      // Verify markup
      const expectedMarkup = result.totals.subtotal * 0.15;
      expect(result.totals.markup_amount).toBeCloseTo(expectedMarkup, 2);

      // Verify total
      const expectedTotal = result.totals.subtotal + result.totals.markup_amount;
      expect(result.totals.total).toBeCloseTo(expectedTotal, 2);
    });

  });

});
