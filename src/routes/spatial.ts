/**
 * Spatial Containment API Route
 * POST /webhook/spatial-containment
 *
 * Replaces n8n Transform CAD node + 4 query nodes.
 * Accepts extraction_id + webhook_data, returns trade configs
 * with per-material measurements from spatial containment analysis.
 */

import { Router, Request, Response } from 'express';
import { performSpatialContainment } from '../services/spatialContainment';

const router = Router();

router.post('/webhook/spatial-containment', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const { extraction_id, ...webhookData } = req.body;

    if (!extraction_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: extraction_id',
      });
    }

    console.log(`\n🏗️ POST /webhook/spatial-containment - extraction_id: ${extraction_id}`);

    const result = await performSpatialContainment(extraction_id, webhookData);

    const elapsed = Date.now() - startTime;
    console.log(`✅ Spatial containment complete in ${elapsed}ms`);

    return res.json(result);

  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ Spatial containment failed after ${elapsed}ms:`, error.message);

    return res.status(500).json({
      success: false,
      error: error.message,
      elapsed_ms: elapsed,
    });
  }
});

export default router;
