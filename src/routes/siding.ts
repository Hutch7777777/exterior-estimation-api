/**
 * Siding Calculation Routes
 */

import { Router, Request, Response } from 'express';
import { calculateSiding, calculateSidingWithPricing } from '../calculations/siding';
import { CalculationRequest } from '../types';
import { isDatabaseConfigured, testConnection } from '../services/database';

const router = Router();

/**
 * POST /api/v1/siding/calculate
 * Main calculation endpoint (materials only)
 */
router.post('/calculate', async (req: Request, res: Response) => {
  try {
    const request = req.body as CalculationRequest;

    // Basic validation
    if (!request.measurements) {
      res.status(400).json({
        success: false,
        error: 'Missing measurements in request body'
      });
      return;
    }

    if (!request.config) {
      res.status(400).json({
        success: false,
        error: 'Missing config in request body'
      });
      return;
    }

    // Run calculation
    const result = await calculateSiding(request);

    res.json(result);

  } catch (error) {
    console.error('Calculation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
});

/**
 * POST /api/v1/siding/calculate-priced
 * Full calculation with pricing and labor
 */
router.post('/calculate-priced', async (req: Request, res: Response) => {
  try {
    const request = req.body as CalculationRequest;
    const markupRate = req.body.markup_rate || 0.15;

    // Basic validation
    if (!request.measurements) {
      res.status(400).json({
        success: false,
        error: 'Missing measurements in request body'
      });
      return;
    }

    if (!request.config) {
      res.status(400).json({
        success: false,
        error: 'Missing config in request body'
      });
      return;
    }

    // Run calculation with pricing
    const result = await calculateSidingWithPricing(request, markupRate);

    res.json(result);

  } catch (error) {
    console.error('Priced calculation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
});

/**
 * GET /api/v1/siding/db-status
 * Check database connection status
 */
router.get('/db-status', async (req: Request, res: Response) => {
  const configured = isDatabaseConfigured();
  const connected = configured ? await testConnection() : false;

  res.json({
    database: {
      configured,
      connected,
      message: !configured
        ? 'Database not configured - using fallback pricing'
        : connected
          ? 'Connected to Supabase'
          : 'Database configured but connection failed'
    }
  });
});

/**
 * GET /api/v1/siding/test
 * Test endpoint with sample calculation
 */
router.get('/test', async (req: Request, res: Response) => {
  const sampleRequest: CalculationRequest = {
    source: {
      type: 'manual',
      confidence: 1.0
    },
    project: {
      id: 'test-project',
      name: 'Test Project'
    },
    measurements: {
      siding: {
        gross_area_sf: 2000,
        net_area_sf: 1606
      },
      openings: {
        total_area_sf: 394,
        total_perimeter_lf: 200,
        windows: {
          count: 10,
          perimeter_lf: 140
        },
        doors: {
          count: 2,
          perimeter_lf: 36
        },
        garages: {
          count: 1,
          perimeter_lf: 24
        }
      },
      corners: {
        inside: { count: 0, total_lf: 0 },
        outside: { count: 4, total_lf: 40 }
      },
      gables: {
        count: 2
      }
    },
    config: {
      siding: {
        reveal_inches: 6.75,
        finish: 'primed',
        profile: 'cedarmill'
      },
      window_trim: { include: false },
      door_trim: { include: false },
      garage_trim: { include: true, finish: 'colorplus', color: 'Arctic White' },
      corner_trim: { finish: 'primed' }
    }
  };

  try {
    const result = await calculateSiding(sampleRequest);
    res.json({
      description: 'Test calculation matching January 2026 output',
      request: sampleRequest,
      result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Test failed'
    });
  }
});

export default router;
