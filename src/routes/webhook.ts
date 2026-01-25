/**
 * n8n Webhook Routes
 * Drop-in replacement for Multi-Trade Coordinator siding calculations
 * Supports both SKU-based and ID-based pricing paths
 */

import { Router, Request, Response } from 'express';
import { WebhookRequest, WebhookResponse, WebhookErrorResponse } from '../types/webhook';
import {
  calculateSidingWithPricing,
  calculateWithAutoScopeV2
} from '../calculations/siding';
import {
  transformWebhookToCalculationRequest,
  transformCalculationToWebhookResponse
} from '../transformers/webhook';

const router = Router();

/**
 * POST /webhook/siding-estimator
 * Main webhook endpoint for n8n Multi-Trade Coordinator
 * Supports dual pricing paths:
 *   - PATH 1: ID-based (material_assignments from Detection Editor)
 *   - PATH 2: SKU-based (traditional measurements-only flow)
 */
router.post('/siding-estimator', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const webhookRequest = req.body as WebhookRequest;

    // Validate required fields
    if (!webhookRequest.project_id) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: project_id',
        error_code: 'MISSING_PROJECT_ID',
        timestamp: new Date().toISOString()
      } as WebhookErrorResponse);
      return;
    }

    const markupRate = webhookRequest.markup_rate || 0.15;

    // =========================================================================
    // PATH 1: ID-Based Pricing with Auto-Scope V2 (material_assignments from Detection Editor)
    // =========================================================================
    if (webhookRequest.material_assignments && webhookRequest.material_assignments.length > 0) {
      console.log(`📥 Webhook received (V2 hybrid): project_id=${webhookRequest.project_id}, assignments=${webhookRequest.material_assignments.length}`);

      // Use V2 orchestrator which combines material assignments with auto-scope
      const result = await calculateWithAutoScopeV2(
        webhookRequest.material_assignments,
        webhookRequest.extraction_id,
        webhookRequest.measurements,
        webhookRequest.organization_id,
        markupRate,
        webhookRequest.detection_counts
      );

      // Transform to webhook response format
      const response: WebhookResponse = {
        success: true,
        trade: 'siding',
        project_id: webhookRequest.project_id,
        project_name: webhookRequest.project_name,
        line_items: result.line_items.map(item => ({
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          category: item.category,
          unit_cost: item.material_unit_cost,
          extended_cost: item.material_extended,
          base_rate: item.labor_unit_cost,
          total_rate: item.labor_extended / (item.quantity || 1),
          sku: item.sku,
          notes: item.notes,
          calculation_source: item.calculation_source,
          presentation_group: item.presentation_group,
        })),
        totals: result.totals,

        // V2 Mike Skjei Methodology - Pass through detailed breakdowns
        labor: result.labor,
        overhead: result.overhead,
        project_totals: result.project_totals,

        metadata: {
          version: 'siding-calc-v6.0.0-hybrid',
          timestamp: new Date().toISOString(),
          source: 'material_assignments_with_autoscope',
          pricing_snapshot: result.metadata.pricing_method,
          skus_found: result.metadata.items_priced,
          skus_missing: result.metadata.items_missing,
          warnings: result.metadata.warnings,
          // V2 specific metadata
          assigned_items_count: result.metadata.assigned_items_count,
          auto_scope_items_count: result.metadata.auto_scope_items_count,
          measurement_source: result.metadata.measurement_source,
          rules_evaluated: result.metadata.rules_evaluated,
          rules_triggered: result.metadata.rules_triggered,
          // V2 Mike Skjei calculation metadata
          calculation_method: result.metadata.calculation_method,
          markup_rate: result.metadata.markup_rate,
          crew_size: result.metadata.crew_size,
          estimated_weeks: result.metadata.estimated_weeks,
        },
      };

      const duration = Date.now() - startTime;
      console.log(`✅ Webhook complete (V2 hybrid): project_id=${webhookRequest.project_id}, assigned=${result.metadata.assigned_items_count}, auto_scope=${result.metadata.auto_scope_items_count}, duration=${duration}ms`);

      res.json(response);
      return;
    }

    // =========================================================================
    // PATH 2: SKU-Based Pricing (traditional measurements flow)
    // =========================================================================

    // Require measurements for SKU-based path
    if (!webhookRequest.measurements) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: measurements (or material_assignments for ID-based pricing)',
        error_code: 'MISSING_MEASUREMENTS',
        project_id: webhookRequest.project_id,
        timestamp: new Date().toISOString()
      } as WebhookErrorResponse);
      return;
    }

    console.log(`📥 Webhook received (SKU-based): project_id=${webhookRequest.project_id}`);

    // Transform to internal format
    const calculationRequest = transformWebhookToCalculationRequest(webhookRequest);

    // Run calculation with pricing
    const result = await calculateSidingWithPricing(calculationRequest, markupRate);

    // Transform to webhook response format
    const response = transformCalculationToWebhookResponse(result, webhookRequest);

    const duration = Date.now() - startTime;
    console.log(`✅ Webhook complete (SKU-based): project_id=${webhookRequest.project_id}, items=${response.line_items.length}, duration=${duration}ms`);

    res.json(response);

  } catch (error) {
    console.error('❌ Webhook error:', error);

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      error_code: 'CALCULATION_ERROR',
      project_id: req.body?.project_id,
      timestamp: new Date().toISOString()
    } as WebhookErrorResponse);
  }
});

/**
 * POST /webhook/calculate-siding
 * Alias endpoint (matches some existing workflow names)
 * Also supports dual pricing paths (ID-based and SKU-based)
 */
router.post('/calculate-siding', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const webhookRequest = req.body as WebhookRequest;

    if (!webhookRequest.project_id) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: project_id',
        error_code: 'MISSING_PROJECT_ID',
        timestamp: new Date().toISOString()
      } as WebhookErrorResponse);
      return;
    }

    const markupRate = webhookRequest.markup_rate || 0.15;

    // PATH 1: ID-Based Pricing with Auto-Scope V2
    if (webhookRequest.material_assignments && webhookRequest.material_assignments.length > 0) {
      console.log(`📥 Webhook (alias, V2 hybrid) received: project_id=${webhookRequest.project_id}, assignments=${webhookRequest.material_assignments.length}`);

      // Use V2 orchestrator which combines material assignments with auto-scope
      const result = await calculateWithAutoScopeV2(
        webhookRequest.material_assignments,
        webhookRequest.extraction_id,
        webhookRequest.measurements,
        webhookRequest.organization_id,
        markupRate,
        webhookRequest.detection_counts
      );

      const response: WebhookResponse = {
        success: true,
        trade: 'siding',
        project_id: webhookRequest.project_id,
        project_name: webhookRequest.project_name,
        line_items: result.line_items.map(item => ({
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          category: item.category,
          unit_cost: item.material_unit_cost,
          extended_cost: item.material_extended,
          base_rate: item.labor_unit_cost,
          total_rate: item.labor_extended / (item.quantity || 1),
          sku: item.sku,
          notes: item.notes,
          calculation_source: item.calculation_source,
          presentation_group: item.presentation_group,
        })),
        totals: result.totals,

        // V2 Mike Skjei Methodology - Pass through detailed breakdowns
        labor: result.labor,
        overhead: result.overhead,
        project_totals: result.project_totals,

        metadata: {
          version: 'siding-calc-v6.0.0-hybrid',
          timestamp: new Date().toISOString(),
          source: 'material_assignments_with_autoscope',
          pricing_snapshot: result.metadata.pricing_method,
          skus_found: result.metadata.items_priced,
          skus_missing: result.metadata.items_missing,
          warnings: result.metadata.warnings,
          assigned_items_count: result.metadata.assigned_items_count,
          auto_scope_items_count: result.metadata.auto_scope_items_count,
          measurement_source: result.metadata.measurement_source,
          rules_evaluated: result.metadata.rules_evaluated,
          rules_triggered: result.metadata.rules_triggered,
          // V2 Mike Skjei calculation metadata
          calculation_method: result.metadata.calculation_method,
          markup_rate: result.metadata.markup_rate,
          crew_size: result.metadata.crew_size,
          estimated_weeks: result.metadata.estimated_weeks,
        },
      };

      const duration = Date.now() - startTime;
      console.log(`✅ Webhook (alias, V2 hybrid) complete: project_id=${webhookRequest.project_id}, assigned=${result.metadata.assigned_items_count}, auto_scope=${result.metadata.auto_scope_items_count}, duration=${duration}ms`);

      res.json(response);
      return;
    }

    // PATH 2: SKU-Based Pricing
    if (!webhookRequest.measurements) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: measurements (or material_assignments for ID-based pricing)',
        error_code: 'MISSING_MEASUREMENTS',
        project_id: webhookRequest.project_id,
        timestamp: new Date().toISOString()
      } as WebhookErrorResponse);
      return;
    }

    console.log(`📥 Webhook (alias, SKU-based) received: project_id=${webhookRequest.project_id}`);

    const calculationRequest = transformWebhookToCalculationRequest(webhookRequest);
    const result = await calculateSidingWithPricing(calculationRequest, markupRate);
    const response = transformCalculationToWebhookResponse(result, webhookRequest);

    const duration = Date.now() - startTime;
    console.log(`✅ Webhook (alias, SKU-based) complete: project_id=${webhookRequest.project_id}, items=${response.line_items.length}, duration=${duration}ms`);

    res.json(response);

  } catch (error) {
    console.error('❌ Webhook error:', error);

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      error_code: 'CALCULATION_ERROR',
      project_id: req.body?.project_id,
      timestamp: new Date().toISOString()
    } as WebhookErrorResponse);
  }
});

/**
 * GET /webhook/health
 * Health check for the webhook endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    endpoint: 'siding-estimator',
    version: '5.0.0',
    pricing_modes: ['sku-based', 'id-based'],
    features: {
      material_assignments: true,
      organization_overrides: true,
      multi_tenant: true,
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /webhook/test
 * Test endpoint with sample data
 */
router.post('/test', async (req: Request, res: Response) => {
  const testRequest: WebhookRequest = {
    project_id: 'webhook-test-001',
    project_name: 'Webhook Test Project',
    client_name: 'Test Client',
    address: '123 Test Street',
    trade: 'siding',
    siding: {
      siding_product: "James Hardie 6.75\" Cedarmill Lap",
      siding_color: 'Arctic White',
      siding_profile: 'cedarmill',
      siding_reveal: 6.75
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
    },
    include_pricing: true,
    include_labor: true,
    markup_rate: 0.15
  };

  // Use the test request or override with body
  const request = { ...testRequest, ...req.body };

  try {
    const calculationRequest = transformWebhookToCalculationRequest(request);
    const result = await calculateSidingWithPricing(calculationRequest);
    const response = transformCalculationToWebhookResponse(result, request);

    res.json({
      description: 'Webhook test with sample HOVER measurements',
      input: request,
      output: response
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Test failed',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
