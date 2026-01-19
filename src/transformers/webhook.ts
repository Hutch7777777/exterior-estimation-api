/**
 * Transform between n8n webhook format and internal API format
 */

import {
  CalculationRequest,
  PricedCalculationResponse,
  PricedMaterialLineItem,
  LaborLineItem
} from '../types/calculation';

import {
  WebhookRequest,
  WebhookResponse,
  WebhookLineItem,
  WebhookMeasurements
} from '../types/webhook';

/**
 * Transform webhook request to internal CalculationRequest format
 */
export function transformWebhookToCalculationRequest(
  webhook: WebhookRequest
): CalculationRequest {
  const m = webhook.measurements;
  const config = webhook.siding || {};

  // Calculate gross area if not provided
  const grossArea = m.facade_sqft || m.gross_wall_area_sqft || 0;

  // Calculate net area - try multiple field names
  const netArea = m.net_siding_area_sqft ||
                  m.net_wall_area_sqft ||
                  (grossArea - calculateOpeningsArea(m));

  // Calculate total openings area and perimeter
  const windowsArea = m.windows?.total_area_sqft || 0;
  const doorsArea = m.doors?.total_area_sqft || 0;
  const garagesArea = m.garages?.total_area_sqft || 0;
  const totalOpeningsArea = windowsArea + doorsArea + garagesArea;

  const windowsPerimeter = m.windows?.perimeter_lf || 0;
  const doorsPerimeter = m.doors?.perimeter_lf || 0;
  const garagesPerimeter = m.garages?.perimeter_lf || 0;
  const totalPerimeter = windowsPerimeter + doorsPerimeter + garagesPerimeter;

  return {
    source: {
      type: webhook.source || 'hover',
      extraction_id: webhook.extraction_id,
      confidence: webhook.confidence
    },
    project: {
      id: webhook.project_id,
      name: webhook.project_name,
      address: webhook.address,
      client_name: webhook.client_name
    },
    measurements: {
      siding: {
        gross_area_sf: grossArea,
        net_area_sf: netArea,
        level_starter_lf: m.level_starter_lf,
        avg_wall_height_ft: m.avg_wall_height_ft
      },
      openings: {
        total_area_sf: totalOpeningsArea,
        total_perimeter_lf: totalPerimeter,
        windows: {
          count: m.windows?.count || 0,
          perimeter_lf: m.windows?.perimeter_lf || 0,
          head_lf: m.windows?.head_lf,
          sill_lf: m.windows?.sill_lf,
          jamb_lf: m.windows?.jamb_lf
        },
        doors: {
          count: m.doors?.count || 0,
          perimeter_lf: m.doors?.perimeter_lf || 0,
          head_lf: m.doors?.head_lf,
          jamb_lf: m.doors?.jamb_lf
        },
        garages: {
          count: m.garages?.count || 0,
          perimeter_lf: m.garages?.perimeter_lf || 0
        }
      },
      corners: {
        outside: {
          count: m.outside_corners?.count || 0,
          total_lf: m.outside_corners?.total_lf || 0
        },
        inside: {
          count: m.inside_corners?.count || 0,
          total_lf: m.inside_corners?.total_lf || 0
        }
      },
      gables: m.gables ? {
        count: m.gables.count,
        area_sf: m.gables.area_sqft,
        rake_lf: m.gables.rake_lf
      } : undefined
    },
    config: {
      siding: {
        product_name: config.siding_product,
        reveal_inches: config.siding_reveal || 6.75,
        finish: config.siding_color ? 'colorplus' : 'primed',
        color: config.siding_color,
        profile: config.siding_profile || 'cedarmill'
      },
      window_trim: {
        include: config.include_window_trim ?? false,
        width: config.window_trim_width || '4',
        finish: config.trim_color ? 'colorplus' : 'primed',
        color: config.trim_color
      },
      door_trim: {
        include: config.include_door_trim ?? false,
        width: config.door_trim_width || '4',
        finish: config.trim_color ? 'colorplus' : 'primed',
        color: config.trim_color
      },
      garage_trim: {
        include: true,
        finish: config.trim_color ? 'colorplus' : 'primed',
        color: config.trim_color
      },
      corner_trim: {
        finish: config.siding_color ? 'colorplus' : 'primed',
        color: config.siding_color
      }
    }
  };
}

/**
 * Helper to calculate openings area from measurements
 */
function calculateOpeningsArea(m: WebhookMeasurements): number {
  const windows = m.windows?.total_area_sqft || 0;
  const doors = m.doors?.total_area_sqft || 0;
  const garages = m.garages?.total_area_sqft || 0;
  return windows + doors + garages;
}

/**
 * Transform material line item to webhook format
 */
function transformMaterialToLineItem(material: PricedMaterialLineItem): WebhookLineItem {
  return {
    description: material.description,
    quantity: material.quantity,
    unit: material.unit,
    category: material.category === 'siding' ? 'Siding' :
              material.category === 'trim' ? 'Trim' :
              material.category === 'flashing' ? 'Flashing' :
              material.category === 'water_barrier' ? 'Water Barrier' :
              material.category === 'fasteners' ? 'Fasteners' :
              material.category === 'accessories' ? 'Accessories' : 'Materials',
    unit_cost: material.unit_cost,
    extended_cost: material.extended_cost,
    sku: material.sku,
    size: material.size,
    notes: material.notes,
    calculation_source: material.source,
    low_confidence: material.low_confidence
  };
}

/**
 * Transform labor line item to webhook format
 */
function transformLaborToLineItem(labor: LaborLineItem): WebhookLineItem {
  return {
    description: labor.description,
    quantity: labor.quantity,
    unit: labor.unit,
    category: 'Labor',
    base_rate: labor.base_rate,
    li_insurance: labor.li_insurance,
    unemployment: labor.unemployment,
    total_rate: labor.total_rate,
    unit_cost: labor.total_rate,
    extended_cost: labor.extended,
    notes: `Base: $${labor.base_rate}/${labor.unit} + L&I: $${labor.li_insurance} + Unemployment: $${labor.unemployment}`,
    calculation_source: 'labor_calculation'
  };
}

/**
 * Transform calculation response to webhook response format
 */
export function transformCalculationToWebhookResponse(
  result: PricedCalculationResponse,
  request: WebhookRequest
): WebhookResponse {
  // Transform materials
  const materialItems = result.materials.map(transformMaterialToLineItem);

  // Transform labor
  const laborItems = result.labor.map(transformLaborToLineItem);

  // Combine all line items (materials first, then labor)
  const line_items = [...materialItems, ...laborItems];

  return {
    success: true,
    trade: 'siding',
    project_id: request.project_id,
    project_name: request.project_name,
    line_items,
    totals: {
      material_cost: result.totals.material_subtotal,
      labor_cost: result.totals.labor_subtotal,
      overhead: result.totals.overhead,
      subtotal: result.totals.subtotal,
      markup_percent: result.totals.markup_rate * 100,
      markup_amount: result.totals.markup_amount,
      total: result.totals.total
    },
    metadata: {
      version: result.provenance.version,
      timestamp: result.provenance.timestamp,
      source: request.source || 'hover',
      pricing_snapshot: result.pricing_metadata.snapshot_name,
      skus_found: result.pricing_metadata.skus_found,
      skus_missing: result.pricing_metadata.skus_missing,
      warnings: result.provenance.warnings
    }
  };
}
