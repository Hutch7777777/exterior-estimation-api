/**
 * n8n Webhook Routes
 * Drop-in replacement for Multi-Trade Coordinator siding calculations
 */

import { Router, Request, Response } from 'express';
import { WebhookRequest, WebhookErrorResponse } from '../types/webhook';
import { calculateSidingWithPricing } from '../calculations/siding';
import {
  transformWebhookToCalculationRequest,
  transformCalculationToWebhookResponse
} from '../transformers/webhook';

const router = Router();

/**
 * POST /webhook/siding-estimator
 * Main webhook endpoint for n8n Multi-Trade Coordinator
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

    if (!webhookRequest.measurements) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: measurements',
        error_code: 'MISSING_MEASUREMENTS',
        project_id: webhookRequest.project_id,
        timestamp: new Date().toISOString()
      } as WebhookErrorResponse);
      return;
    }

    // Log incoming request (helpful for debugging)
    console.log(`📥 Webhook received: project_id=${webhookRequest.project_id}`);

    // Transform to internal format
    const calculationRequest = transformWebhookToCalculationRequest(webhookRequest);

    // Run calculation with pricing
    const markupRate = webhookRequest.markup_rate || 0.15;
    const result = await calculateSidingWithPricing(calculationRequest, markupRate);

    // Transform to webhook response format
    const response = transformCalculationToWebhookResponse(result, webhookRequest);

    const duration = Date.now() - startTime;
    console.log(`✅ Webhook complete: project_id=${webhookRequest.project_id}, items=${response.line_items.length}, duration=${duration}ms`);

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

    if (!webhookRequest.measurements) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: measurements',
        error_code: 'MISSING_MEASUREMENTS',
        project_id: webhookRequest.project_id,
        timestamp: new Date().toISOString()
      } as WebhookErrorResponse);
      return;
    }

    console.log(`📥 Webhook (alias) received: project_id=${webhookRequest.project_id}`);

    const calculationRequest = transformWebhookToCalculationRequest(webhookRequest);
    const markupRate = webhookRequest.markup_rate || 0.15;
    const result = await calculateSidingWithPricing(calculationRequest, markupRate);
    const response = transformCalculationToWebhookResponse(result, webhookRequest);

    const duration = Date.now() - startTime;
    console.log(`✅ Webhook (alias) complete: project_id=${webhookRequest.project_id}, items=${response.line_items.length}, duration=${duration}ms`);

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
    version: '4.0.0',
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
