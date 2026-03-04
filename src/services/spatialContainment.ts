/**
 * ============================================================================
 * SPATIAL CONTAINMENT SERVICE
 * ============================================================================
 * Extracted from n8n Multi-Trade Coordinator "Transform CAD to Measurements" node.
 * 
 * Takes an extraction_id + webhook data, queries detection geometry from Supabase,
 * performs spatial containment analysis (attributing openings, corners, trim to
 * facades), and returns trade-ready configs with per-material measurements.
 * 
 * Previously: 4 n8n Postgres query nodes + 945-line JS Code node
 * Now: Single API call with proper TypeScript types and unit testability
 * ============================================================================
 */

import { getSupabaseClient, isDatabaseConfigured } from './database';

// ============================================================================
// TYPES
// ============================================================================

/** Raw detection geometry from extraction_detections_draft */
interface DetectionGeometry {
  id: string;
  class: string;
  assigned_material_id: string | null;
  pixel_x: number;
  pixel_y: number;
  pixel_width: number;
  pixel_height: number;
  polygon_points: any | null;
  page_id: string;
  scale_ratio: number;
  width_ft: number;
  height_ft: number;
  perimeter_lf: number;
  area_sqft: number;
  line_length_lf: number;
  material_sku: string | null;
  material_name: string | null;
  material_manufacturer: string | null;
}

/** Assigned material row from the grouped query */
interface AssignedMaterialRow {
  assigned_material_id: string | null;
  sku: string | null;
  product_name: string | null;
  material_cost: number;
  labor_cost: number;
  price_source: string;
  product_unit: string | null;
  is_colorplus: boolean;
  requires_primer: boolean;
  coverage_value: number;
  coverage_unit: string | null;
  trade: string;
  measurement_type: string;
  unit_of_measure: string;
  waste_factor: number;
  display_name: string;
  display_order: number;
  material_category: string;
  detection_count: number;
  total_measurement: number;
  needs_pricing: boolean;
}

/** CAD/HOVER measurements from cad_hover_measurements */
interface CadHoverRow {
  [key: string]: any;
}

/** Classified callout from cad_material_callouts */
interface ClassifiedCallout {
  trade: string;
  category: string;
  normalized_text: string;
  match_confidence: number;
  callout_count: number;
}

/** Per-material measurement accumulator */
export interface PerMaterialMeasurement {
  material_id: string;
  material_sku: string | null;
  manufacturer: string;

  facade_sqft: number;
  facade_perimeter_lf: number;

  window_perimeter_lf: number;
  door_perimeter_lf: number;
  garage_perimeter_lf: number;
  window_count: number;
  door_count: number;
  garage_count: number;
  openings_area_sqft: number;

  outside_corner_count: number;
  outside_corner_lf: number;
  inside_corner_count: number;
  inside_corner_lf: number;

  trim_head_lf: number;
  trim_jamb_lf: number;
  trim_sill_lf: number;
  trim_total_lf: number;

  belly_band_lf: number;
  architectural_count: number;

  facades: string[];
  openings: string[];
  corners: string[];
  trim_segments: string[];
}

/** Spatial containment summary */
export interface SpatialContainmentSummary {
  version: string;
  facades_analyzed: number;
  openings_analyzed: number;
  openings_matched: number;
  corners_analyzed: number;
  corners_matched: number;
  trim_analyzed: number;
  trim_matched: number;
  materials_with_measurements: number;
}

/** Auto-scope item generated during transform */
interface AutoScopeItem {
  class: string;
  trade: string;
  product_name: string;
  sku: string;
  measurement_type: string;
  total_measurement: number;
  calculated_quantity?: number;
  unit_of_measure: string;
  coverage_value: number;
  coverage_unit: string;
  source: string;
  applies_to?: string;
  needs_pricing: boolean;
  detection_count?: number;
  breakdown?: Record<string, any>;
}

/** Product info from classified callouts */
interface ProductInfo {
  detected_product: string;
  category: string;
  confidence: number;
  callout_count: number;
}

/** Full result returned by the service */
export interface SpatialContainmentResult {
  success: boolean;
  source_type: string;
  hover_project_id: string;
  selected_trades: string[];
  measurements: any;
  confidence: number;
  parsed_at: string;
  webhook_data: any;
  siding: any;
  roofing: any;
  windows: any;
  gutters: any;
  cad_extraction: any;
  spatial_containment_summary: SpatialContainmentSummary;
  v81_summary: any;
}

// ============================================================================
// DETECTION CLASS CONSTANTS
// ============================================================================

const FACADE_CLASSES = ['exterior wall', 'exterior_wall', 'siding', 'wall', 'facade'];
const OPENING_CLASSES = ['window', 'door', 'opening', 'garage', 'garage_door', 'window_opening', 'door_opening'];
const CORNER_CLASSES = ['outside_corner', 'inside_corner', 'corner_outside', 'corner_inside', 'corner', 'outside corner', 'inside corner'];
const TRIM_CLASSES = ['trim_head', 'trim_jamb', 'trim_sill', 'trim', 'head_trim', 'jamb_trim', 'sill_trim'];
const BELLY_BAND_CLASSES = ['belly_band', 'belly band', 'band_board', 'horizontal_trim'];
const ARCHITECTURAL_CLASSES = ['corbel', 'bracket', 'decorative', 'gable_vent', 'louver'];

// ============================================================================
// GEOMETRY HELPERS
// ============================================================================

function isPointInRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return px >= rx && px <= (rx + rw) && py >= ry && py <= (ry + rh);
}

function isDetectionInFacade(detection: DetectionGeometry, facade: DetectionGeometry): boolean {
  const cx = detection.pixel_x + (detection.pixel_width / 2);
  const cy = detection.pixel_y + (detection.pixel_height / 2);

  // Must be on same page
  if (detection.page_id !== facade.page_id) return false;

  return isPointInRect(
    cx, cy,
    facade.pixel_x, facade.pixel_y,
    facade.pixel_width, facade.pixel_height
  );
}

function normalizeOpeningClass(cls: string): 'window' | 'door' | 'garage' {
  const lower = (cls || '').toLowerCase();
  if (lower.includes('garage')) return 'garage';
  if (lower.includes('door')) return 'door';
  return 'window';
}

function normalizeCornerClass(cls: string): 'outside' | 'inside' {
  const lower = (cls || '').toLowerCase();
  if (lower.includes('inside')) return 'inside';
  return 'outside';
}

function normalizeTrimClass(cls: string): 'head' | 'jamb' | 'sill' | 'generic' {
  const lower = (cls || '').toLowerCase();
  if (lower.includes('head')) return 'head';
  if (lower.includes('jamb')) return 'jamb';
  if (lower.includes('sill')) return 'sill';
  return 'generic';
}

function findContainingFacade(detection: DetectionGeometry, facades: DetectionGeometry[]): DetectionGeometry | null {
  // Try exact containment first
  for (const facade of facades) {
    if (isDetectionInFacade(detection, facade)) {
      return facade;
    }
  }

  // Fallback: find closest facade on same page by center distance
  const cx = detection.pixel_x + (detection.pixel_width / 2);
  const cy = detection.pixel_y + (detection.pixel_height / 2);
  let closest: DetectionGeometry | null = null;
  let minDist = Infinity;

  for (const facade of facades) {
    if (detection.page_id !== facade.page_id) continue;
    const fcx = facade.pixel_x + (facade.pixel_width / 2);
    const fcy = facade.pixel_y + (facade.pixel_height / 2);
    const dist = Math.sqrt((cx - fcx) ** 2 + (cy - fcy) ** 2);
    if (dist < minDist) {
      minDist = dist;
      closest = facade;
    }
  }

  // Only use closest if within reasonable distance (facade diagonal * 1.5)
  if (closest) {
    const diag = Math.sqrt(closest.pixel_width ** 2 + closest.pixel_height ** 2);
    if (minDist < diag * 1.5) return closest;
  }

  return null;
}

function calculateFacadePerimeter(facade: DetectionGeometry): number {
  const width = facade.width_ft || 0;
  const height = facade.height_ft || 0;
  return 2 * (width + height);
}

// ============================================================================
// DATABASE QUERIES
// ============================================================================

async function queryDetectionGeometry(extractionId: string): Promise<DetectionGeometry[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc('get_detection_geometry_for_spatial', {
    p_extraction_id: extractionId,
  });

  if (error) {
    console.error('❌ queryDetectionGeometry failed:', error.message);
    // Fallback: raw query
    return queryDetectionGeometryRaw(extractionId);
  }

  return data || [];
}

/** Fallback raw query matching the n8n SQL exactly */
async function queryDetectionGeometryRaw(extractionId: string): Promise<DetectionGeometry[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('extraction_detections_draft')
    .select(`
      id,
      class,
      assigned_material_id,
      pixel_x,
      pixel_y,
      pixel_width,
      pixel_height,
      polygon_points,
      page_id,
      extraction_jobs!inner (
        default_scale_ratio
      ),
      pricing_items (
        sku,
        product_name,
        manufacturer
      )
    `)
    .eq('job_id', extractionId)
    .or('is_deleted.is.null,is_deleted.eq.false')
    .order('class')
    .order('pixel_x');

  if (error) {
    console.error('❌ queryDetectionGeometryRaw failed:', error.message);
    return [];
  }

  // Transform to DetectionGeometry with computed fields
  return (data || []).map((row: any) => {
    const scaleRatio = parseFloat(row.extraction_jobs?.default_scale_ratio) || 48;
    const pixelW = parseFloat(row.pixel_width) || 0;
    const pixelH = parseFloat(row.pixel_height) || 0;
    const widthFt = pixelW / scaleRatio;
    const heightFt = pixelH / scaleRatio;

    const isLineClass = ['trim_head', 'trim_jamb', 'trim_sill', 'belly_band', 'fascia', 'rake'].includes(row.class);

    return {
      id: row.id,
      class: row.class,
      assigned_material_id: row.assigned_material_id,
      pixel_x: parseFloat(row.pixel_x) || 0,
      pixel_y: parseFloat(row.pixel_y) || 0,
      pixel_width: pixelW,
      pixel_height: pixelH,
      polygon_points: row.polygon_points,
      page_id: row.page_id,
      scale_ratio: scaleRatio,
      width_ft: widthFt,
      height_ft: heightFt,
      perimeter_lf: 2 * (widthFt + heightFt),
      area_sqft: widthFt * heightFt,
      line_length_lf: isLineClass ? Math.max(widthFt, heightFt) : 0,
      material_sku: row.pricing_items?.sku || null,
      material_name: row.pricing_items?.product_name || null,
      material_manufacturer: row.pricing_items?.manufacturer || null,
    };
  });
}

async function queryAssignedMaterials(extractionId: string): Promise<AssignedMaterialRow[]> {
  const supabase = getSupabaseClient();

  // Use raw SQL via rpc for the complex grouped query
  const { data, error } = await supabase.rpc('get_assigned_materials_for_spatial', {
    p_extraction_id: extractionId,
  });

  if (error) {
    console.error('❌ queryAssignedMaterials failed:', error.message);
    return [];
  }

  // Parse numeric fields
  return (data || []).map((m: any) => ({
    ...m,
    total_measurement: parseFloat(m.total_measurement) || 0,
    material_cost: parseFloat(m.material_cost) || 0,
    labor_cost: parseFloat(m.labor_cost) || 0,
    detection_count: parseInt(m.detection_count) || 1,
    coverage_value: parseFloat(m.coverage_value) || 1,
    waste_factor: parseFloat(m.waste_factor) || 1.1,
  }));
}

async function queryCadMeasurements(extractionId: string): Promise<CadHoverRow> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('cad_hover_measurements')
    .select('*')
    .eq('extraction_id', extractionId)
    .limit(1)
    .single();

  if (error) {
    console.warn('⚠️ No CAD measurements found:', error.message);
    return {};
  }

  return data || {};
}

async function queryClassifiedCallouts(extractionId: string): Promise<ClassifiedCallout[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('cad_material_callouts')
    .select('trade, material_type, normalized_text, match_confidence')
    .eq('extraction_id', extractionId)
    .in('trade', ['siding', 'roofing', 'windows', 'gutters', 'doors', 'trim'])
    .gte('match_confidence', 0.7);

  if (error) {
    console.warn('⚠️ No classified callouts found:', error.message);
    return [];
  }

  // Group by trade/category/text (matching the n8n GROUP BY)
  const grouped: Record<string, ClassifiedCallout> = {};
  for (const row of data || []) {
    const key = `${row.trade}|${row.material_type}|${row.normalized_text}`;
    if (!grouped[key]) {
      grouped[key] = {
        trade: row.trade,
        category: row.material_type,
        normalized_text: row.normalized_text,
        match_confidence: row.match_confidence,
        callout_count: 1,
      };
    } else {
      grouped[key].callout_count++;
    }
  }

  return Object.values(grouped);
}

// ============================================================================
// SPATIAL CONTAINMENT ANALYSIS
// ============================================================================

function buildPerMaterialMeasurements(
  allDetections: DetectionGeometry[]
): {
  perMaterialMeasurements: Record<string, PerMaterialMeasurement>;
  summary: SpatialContainmentSummary;
} {
  // Classify detections
  const facades = allDetections.filter(d => FACADE_CLASSES.includes(d.class?.toLowerCase()));
  const openings = allDetections.filter(d => OPENING_CLASSES.includes(d.class?.toLowerCase()));
  const corners = allDetections.filter(d =>
    CORNER_CLASSES.some(c => d.class?.toLowerCase().includes(c.replace('_', ' ')) || d.class?.toLowerCase().includes(c))
  );
  const trimDetections = allDetections.filter(d =>
    TRIM_CLASSES.some(c => d.class?.toLowerCase().includes(c.replace('_', ' ')) || d.class?.toLowerCase().includes(c))
  );
  const bellyBands = allDetections.filter(d =>
    BELLY_BAND_CLASSES.some(c => d.class?.toLowerCase().includes(c.replace('_', ' ')) || d.class?.toLowerCase().includes(c))
  );
  const archElements = allDetections.filter(d =>
    ARCHITECTURAL_CLASSES.some(c => d.class?.toLowerCase().includes(c))
  );

  console.log(`🔍 SPATIAL CONTAINMENT ANALYSIS V8.1:`);
  console.log(`   Facades: ${facades.length}, Openings: ${openings.length}, Corners: ${corners.length}`);
  console.log(`   Trim: ${trimDetections.length}, Belly bands: ${bellyBands.length}, Architectural: ${archElements.length}`);

  // Initialize per-material buckets from facades
  const perMat: Record<string, PerMaterialMeasurement> = {};

  function ensureBucket(matId: string, sku?: string | null, manufacturer?: string | null): PerMaterialMeasurement {
    if (!perMat[matId]) {
      perMat[matId] = {
        material_id: matId,
        material_sku: sku || null,
        manufacturer: manufacturer || 'Generic',
        facade_sqft: 0, facade_perimeter_lf: 0,
        window_perimeter_lf: 0, door_perimeter_lf: 0, garage_perimeter_lf: 0,
        window_count: 0, door_count: 0, garage_count: 0, openings_area_sqft: 0,
        outside_corner_count: 0, outside_corner_lf: 0,
        inside_corner_count: 0, inside_corner_lf: 0,
        trim_head_lf: 0, trim_jamb_lf: 0, trim_sill_lf: 0, trim_total_lf: 0,
        belly_band_lf: 0, architectural_count: 0,
        facades: [], openings: [], corners: [], trim_segments: [],
      };
    }
    return perMat[matId];
  }

  // Accumulate facade area and perimeter
  for (const f of facades) {
    const matId = f.assigned_material_id || 'unassigned';
    const m = ensureBucket(matId, f.material_sku, f.material_manufacturer);
    m.facade_sqft += f.area_sqft || 0;
    m.facade_perimeter_lf += calculateFacadePerimeter(f);
    m.facades.push(f.id);
  }

  // Attribute openings to facades
  const unmatchedOpenings: DetectionGeometry[] = [];
  for (const opening of openings) {
    const facade = findContainingFacade(opening, facades);
    if (facade) {
      const matId = facade.assigned_material_id || 'unassigned';
      const m = ensureBucket(matId);
      const perim = opening.perimeter_lf || 0;
      const area = opening.area_sqft || 0;
      const cls = normalizeOpeningClass(opening.class);
      if (cls === 'window') { m.window_perimeter_lf += perim; m.window_count++; }
      else if (cls === 'door') { m.door_perimeter_lf += perim; m.door_count++; }
      else if (cls === 'garage') { m.garage_perimeter_lf += perim; m.garage_count++; }
      m.openings_area_sqft += area;
      m.openings.push(opening.id);
    } else {
      unmatchedOpenings.push(opening);
    }
  }

  // Attribute corners to facades
  const unmatchedCorners: DetectionGeometry[] = [];
  for (const corner of corners) {
    const facade = findContainingFacade(corner, facades);
    if (facade) {
      const matId = facade.assigned_material_id || 'unassigned';
      const m = ensureBucket(matId);
      const type = normalizeCornerClass(corner.class);
      const height = corner.height_ft || 8;
      if (type === 'outside') { m.outside_corner_count++; m.outside_corner_lf += height; }
      else { m.inside_corner_count++; m.inside_corner_lf += height; }
      m.corners.push(corner.id);
    } else {
      unmatchedCorners.push(corner);
    }
  }

  // Attribute trim to facades
  const unmatchedTrim: DetectionGeometry[] = [];
  for (const trim of trimDetections) {
    const facade = findContainingFacade(trim, facades);
    if (facade) {
      const matId = facade.assigned_material_id || 'unassigned';
      const m = ensureBucket(matId);
      const type = normalizeTrimClass(trim.class);
      const length = trim.line_length_lf || trim.width_ft || 0;
      if (type === 'head') m.trim_head_lf += length;
      else if (type === 'sill') m.trim_sill_lf += length;
      else m.trim_jamb_lf += length; // 'jamb' and 'generic' both go to jamb
      m.trim_total_lf += length;
      m.trim_segments.push(trim.id);
    } else {
      unmatchedTrim.push(trim);
    }
  }

  // Attribute belly bands to facades
  for (const bb of bellyBands) {
    const facade = findContainingFacade(bb, facades);
    if (facade) {
      const matId = facade.assigned_material_id || 'unassigned';
      const m = ensureBucket(matId);
      m.belly_band_lf += bb.line_length_lf || bb.width_ft || 0;
    }
  }

  // Attribute architectural elements to facades
  for (const arch of archElements) {
    const facade = findContainingFacade(arch, facades);
    if (facade) {
      const matId = facade.assigned_material_id || 'unassigned';
      const m = ensureBucket(matId);
      m.architectural_count++;
    }
  }

  // Add unmatched items to 'unassigned' bucket
  const unassigned = ensureBucket('unassigned');
  for (const o of unmatchedOpenings) {
    const cls = normalizeOpeningClass(o.class);
    const perim = o.perimeter_lf || 0;
    if (cls === 'window') { unassigned.window_perimeter_lf += perim; unassigned.window_count++; }
    else if (cls === 'door') { unassigned.door_perimeter_lf += perim; unassigned.door_count++; }
    else if (cls === 'garage') { unassigned.garage_perimeter_lf += perim; unassigned.garage_count++; }
  }
  for (const c of unmatchedCorners) {
    const type = normalizeCornerClass(c.class);
    const height = c.height_ft || 8;
    if (type === 'outside') { unassigned.outside_corner_count++; unassigned.outside_corner_lf += height; }
    else { unassigned.inside_corner_count++; unassigned.inside_corner_lf += height; }
  }

  // Log per-material breakdown
  console.log('\n📊 PER-MATERIAL MEASUREMENTS (V8.1):');
  for (const [matId, m] of Object.entries(perMat)) {
    const displayId = matId === 'unassigned' ? 'UNASSIGNED' : matId.substring(0, 8) + '...';
    console.log(`   ${displayId} (${m.manufacturer}): ${m.facade_sqft.toFixed(1)} SF, ${m.window_count}W/${m.door_count}D/${m.garage_count}G, ${m.outside_corner_count}OC/${m.inside_corner_count}IC`);
  }

  const summary: SpatialContainmentSummary = {
    version: '8.1',
    facades_analyzed: facades.length,
    openings_analyzed: openings.length,
    openings_matched: openings.length - unmatchedOpenings.length,
    corners_analyzed: corners.length,
    corners_matched: corners.length - unmatchedCorners.length,
    trim_analyzed: trimDetections.length,
    trim_matched: trimDetections.length - unmatchedTrim.length,
    materials_with_measurements: Object.keys(perMat).length,
  };

  return { perMaterialMeasurements: perMat, summary };
}

// ============================================================================
// TRADE CONFIG BUILDERS
// ============================================================================

function getProductInfo(callouts: ClassifiedCallout[], trade: string): ProductInfo | null {
  const tradeCallouts = callouts
    .filter(c => c.trade === trade)
    .sort((a, b) => b.match_confidence - a.match_confidence);

  if (tradeCallouts.length === 0) return null;

  const primary = tradeCallouts[0];
  return {
    detected_product: primary.normalized_text,
    category: primary.category,
    confidence: primary.match_confidence,
    callout_count: tradeCallouts.reduce((sum, c) => sum + c.callout_count, 0),
  };
}

function buildTrimItems(
  h: CadHoverRow,
  webhookData: any,
  measurementTotals: { window_count: number; door_count: number; garage_count: number }
): { autoTrimItems: AutoScopeItem[]; trimMeasurements: any } {
  const windowCount = measurementTotals.window_count || parseInt(h.openings_windows_count) || 0;
  const doorCount = measurementTotals.door_count || parseInt(h.openings_doors_count) || 0;
  const garageCount = measurementTotals.garage_count || 0;

  const trimPayload = webhookData.trim || {};
  const hasActualTrimMeasurements = parseFloat(trimPayload.total_trim_lf) > 0;

  let windowTrimLF: number, doorTrimLF: number, garageTrimLF: number, totalTrimLF: number;
  let trimHeadLF: number, trimJambLF: number, trimSillLF: number;
  let trimSource: string;

  if (hasActualTrimMeasurements) {
    trimHeadLF = parseFloat(trimPayload.total_head_lf) || 0;
    trimJambLF = parseFloat(trimPayload.total_jamb_lf) || 0;
    trimSillLF = parseFloat(trimPayload.total_sill_lf) || 0;
    totalTrimLF = parseFloat(trimPayload.total_trim_lf) || 0;
    trimSource = 'detection_editor';

    const totalOpenings = windowCount + doorCount + garageCount;
    if (totalOpenings > 0) {
      const headJambLF = trimHeadLF + trimJambLF;
      const perOpeningHeadJamb = headJambLF / totalOpenings;
      windowTrimLF = (windowCount * perOpeningHeadJamb) + trimSillLF;
      doorTrimLF = doorCount * perOpeningHeadJamb;
      garageTrimLF = garageCount * perOpeningHeadJamb;
    } else {
      windowTrimLF = totalTrimLF;
      doorTrimLF = 0;
      garageTrimLF = 0;
    }
  } else {
    windowTrimLF = parseFloat(h.window_trim_lf) || (windowCount * 14);
    doorTrimLF = parseFloat(h.door_trim_lf) || (doorCount * 17);
    garageTrimLF = garageCount * 40;
    totalTrimLF = windowTrimLF + doorTrimLF + garageTrimLF;
    trimHeadLF = 0;
    trimJambLF = 0;
    trimSillLF = 0;
    trimSource = 'estimated';
  }

  const autoTrimItems: AutoScopeItem[] = [];

  // Window/Door Trim
  if (windowTrimLF > 0 || doorTrimLF > 0) {
    autoTrimItems.push({
      class: 'trim_window_door',
      trade: 'trim',
      product_name: '5/4" x 4" Hardie Trim - Windows/Doors',
      sku: 'TRIM-5/4x4-12',
      measurement_type: 'linear',
      total_measurement: windowTrimLF + doorTrimLF,
      unit_of_measure: 'LF',
      detection_count: windowCount + doorCount,
      source: trimSource === 'detection_editor' ? 'detection_editor' : 'auto-calculated',
      coverage_value: 12,
      coverage_unit: 'LF',
      breakdown: {
        window_lf: windowTrimLF, window_count: windowCount,
        door_lf: doorTrimLF, door_count: doorCount,
        head_lf: hasActualTrimMeasurements ? trimHeadLF : null,
        jamb_lf: hasActualTrimMeasurements ? trimJambLF : null,
        sill_lf: hasActualTrimMeasurements ? trimSillLF : null,
      },
      needs_pricing: true,
    });
  }

  // Garage Trim
  if (garageTrimLF > 0) {
    autoTrimItems.push({
      class: 'trim_garage',
      trade: 'trim',
      product_name: '5/4" x 8" Hardie Trim - Garage',
      sku: 'TRIM-5/4x8-12',
      measurement_type: 'linear',
      total_measurement: garageTrimLF,
      unit_of_measure: 'LF',
      detection_count: garageCount,
      source: trimSource === 'detection_editor' ? 'detection_editor' : 'auto-calculated',
      coverage_value: 12,
      coverage_unit: 'LF',
      needs_pricing: true,
    });
  }

  return {
    autoTrimItems,
    trimMeasurements: {
      window_trim_lf: windowTrimLF,
      door_trim_lf: doorTrimLF,
      garage_trim_lf: garageTrimLF,
      total_trim_lf: totalTrimLF,
      head_lf: trimHeadLF,
      jamb_lf: trimJambLF,
      sill_lf: trimSillLF,
      trim_source: trimSource,
    },
  };
}

function buildAutoScopeItems(
  h: CadHoverRow,
  totalSidingSF: number,
  assignedMaterials: AssignedMaterialRow[]
): AutoScopeItem[] {
  const items: AutoScopeItem[] = [];

  const hasColorPlusSiding = assignedMaterials.some(m => m.trade === 'siding' && m.is_colorplus);
  const requiresPrimer = assignedMaterials.some(m => m.trade === 'siding' && m.requires_primer && !m.is_colorplus);

  if (totalSidingSF > 0) {
    const wrbRolls = Math.ceil(totalSidingSF / 900);
    items.push({
      class: 'water_barrier',
      trade: 'siding',
      product_name: 'HardieWrap Weather Barrier',
      sku: 'HWRAP-9x100',
      measurement_type: 'area',
      total_measurement: totalSidingSF,
      calculated_quantity: wrbRolls,
      unit_of_measure: 'roll',
      coverage_value: 900,
      coverage_unit: 'SF',
      source: 'auto-scope',
      applies_to: 'all_siding',
      needs_pricing: true,
    });
  }

  if (requiresPrimer && !hasColorPlusSiding && totalSidingSF > 0) {
    const primerGallons = Math.ceil(totalSidingSF / 400);
    items.push({
      class: 'primer',
      trade: 'siding',
      product_name: 'Field Primer',
      sku: 'PRIMER-GAL',
      measurement_type: 'area',
      total_measurement: totalSidingSF,
      calculated_quantity: primerGallons,
      unit_of_measure: 'gallon',
      coverage_value: 400,
      coverage_unit: 'SF',
      source: 'auto-scope',
      applies_to: 'primed_siding_only',
      needs_pricing: true,
    });
  }

  return items;
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Perform spatial containment analysis and build trade configs.
 *
 * Replaces n8n nodes: Query CAD Measurements, Query Classified Callouts,
 * Query Assigned Materials, Query Detection Geometry, and Transform CAD to Measurements.
 *
 * @param extractionId - Job/extraction ID
 * @param webhookData - Original webhook payload (siding, roofing, windows, gutters configs + selected_trades)
 * @returns Trade-ready configs with per-material measurements
 */
export async function performSpatialContainment(
  extractionId: string,
  webhookData: any
): Promise<SpatialContainmentResult> {

  console.log('');
  console.log('═'.repeat(70));
  console.log('🏗️ SPATIAL CONTAINMENT SERVICE V8.1');
  console.log('═'.repeat(70));
  console.log(`   Extraction ID: ${extractionId}`);

  // =========================================================================
  // STEP 1: Query all data from Supabase
  // =========================================================================
  const [allDetections, assignedMaterials, h, classifiedCallouts] = await Promise.all([
    queryDetectionGeometry(extractionId),
    queryAssignedMaterials(extractionId),
    queryCadMeasurements(extractionId),
    queryClassifiedCallouts(extractionId),
  ]);

  console.log(`   Detections: ${allDetections.length}`);
  console.log(`   Assigned materials: ${assignedMaterials.length}`);
  console.log(`   Classified callouts: ${classifiedCallouts.length}`);

  // =========================================================================
  // STEP 2: Spatial containment analysis
  // =========================================================================
  const { perMaterialMeasurements, summary } = buildPerMaterialMeasurements(allDetections);

  // =========================================================================
  // STEP 3: Group assigned materials by trade
  // =========================================================================
  const materialsByTrade: Record<string, AssignedMaterialRow[]> = {
    siding: [], roofing: [], gutters: [], windows: [], trim: [], unassigned: [],
  };
  const measurementTotals = {
    siding_sf: 0, roofing_sf: 0, gutter_lf: 0,
    window_count: 0, door_count: 0, garage_count: 0, trim_lf: 0,
  };

  for (const m of assignedMaterials) {
    const trade = m.trade || 'unassigned';
    const bucket = materialsByTrade[trade] || materialsByTrade.unassigned;
    bucket.push(m);

    if (trade === 'siding' && m.measurement_type === 'area') measurementTotals.siding_sf += m.total_measurement;
    else if (trade === 'roofing' && m.measurement_type === 'area') measurementTotals.roofing_sf += m.total_measurement;
    else if (trade === 'gutters' && m.measurement_type === 'linear') measurementTotals.gutter_lf += m.total_measurement;
    else if (['window', 'window_opening'].includes(m.material_category)) measurementTotals.window_count += m.detection_count;
    else if (['door', 'door_opening'].includes(m.material_category)) measurementTotals.door_count += m.detection_count;
    else if (['garage', 'garage_door'].includes(m.material_category)) measurementTotals.garage_count += m.detection_count;
    else if (trade === 'trim' && m.measurement_type === 'linear') measurementTotals.trim_lf += m.total_measurement;
  }

  // =========================================================================
  // STEP 4: Build trim items
  // =========================================================================
  const { autoTrimItems, trimMeasurements } = buildTrimItems(h, webhookData, measurementTotals);

  // =========================================================================
  // STEP 5: Auto-scope items (WRB, primer)
  // =========================================================================
  const totalSidingSF = parseFloat(h.net_siding_sqft) || measurementTotals.siding_sf || 0;
  const autoScopeItems = buildAutoScopeItems(h, totalSidingSF, assignedMaterials);

  // =========================================================================
  // STEP 6: Trade selection
  // =========================================================================
  const detectedTrades = [...new Set(classifiedCallouts.map(c => c.trade))];
  const validTrades = ['siding', 'roofing', 'windows', 'gutters'];
  const userSelectedTrades = webhookData.selected_trades?.length > 0 ? webhookData.selected_trades : null;
  const autoDetectedTrades = detectedTrades.filter(t => validTrades.includes(t));
  let selectedTrades = userSelectedTrades || autoDetectedTrades;

  if (selectedTrades.length === 0) {
    if (materialsByTrade.siding.length > 0) selectedTrades.push('siding');
    if (materialsByTrade.roofing.length > 0) selectedTrades.push('roofing');
    if (materialsByTrade.gutters.length > 0) selectedTrades.push('gutters');
    if (materialsByTrade.windows.length > 0) selectedTrades.push('windows');
  }

  console.log(`   Selected trades: ${selectedTrades.join(', ') || 'none'}`);

  // =========================================================================
  // STEP 7: Product info from callouts
  // =========================================================================
  const sidingInfo = getProductInfo(classifiedCallouts, 'siding');
  const roofingInfo = getProductInfo(classifiedCallouts, 'roofing');
  const windowsInfo = getProductInfo(classifiedCallouts, 'windows');
  const guttersInfo = getProductInfo(classifiedCallouts, 'gutters');

  // =========================================================================
  // STEP 8: Build siding area (V8.1.2 fix)
  // =========================================================================
  const sidingNetArea = parseFloat(h.net_siding_sqft) > 0
    ? parseFloat(h.net_siding_sqft)
    : (measurementTotals.siding_sf || 0);

  const sidingTotalArea = parseFloat(h.facade_total_sqft) > 0
    ? parseFloat(h.facade_total_sqft)
    : (sidingNetArea * 1.1);

  const hasColorPlusSiding = materialsByTrade.siding.some((m: any) => m.is_colorplus === true);
  const requiresPrimer = materialsByTrade.siding.some((m: any) => m.requires_primer === true && !m.is_colorplus);

  // =========================================================================
  // STEP 9: Build measurements object
  // =========================================================================
  const measurements = {
    confidence: 1.0,
    extraction_notes: 'From CAD extraction with V8.1 spatial containment',
    measurements: {
      property_info: {
        story_count: parseInt(h.stories) || 1,
        has_basement: false,
        footprint_perimeter_ft: parseFloat(h.level_starter_lf) || 0,
      },
      roof: {
        total_area_sqft: measurementTotals.roofing_sf || parseFloat(h.roof_total_sqft) || 0,
        pitch: h.roof_pitch || '4/12',
        ridge_length_ft: parseFloat(h.ridge_lf) || 0,
        valley_length_ft: parseFloat(h.valley_lf) || 0,
        rake_length_ft: parseFloat(h.rake_lf) || 0,
        eave_length_ft: parseFloat(h.eave_lf) || 0,
        hip_length_ft: parseFloat(h.hip_lf) || 0,
      },
      siding: {
        total_area_sqft: sidingTotalArea,
        net_area_sqft: sidingNetArea,
        inside_corners: parseInt(h.inside_corners_count) || 0,
        outside_corners: parseInt(h.outside_corners_count) || 0,
        linear_footage_lf: parseFloat(h.level_starter_lf) || 0,
      },
      trim_measurements: {
        level_starter_lf: parseFloat(h.level_starter_lf) || 0,
        eave_lf: parseFloat(h.eave_lf) || 0,
        rake_lf: parseFloat(h.rake_lf) || 0,
        fascia_lf: parseFloat(h.fascia_lf) || 0,
        soffit_sqft: parseFloat(h.soffit_sqft) || 0,
        ...trimMeasurements,
      },
      belly_band: {
        detected: Object.values(perMaterialMeasurements).some(m => m.belly_band_lf > 0),
        estimated_lf: Object.values(perMaterialMeasurements).reduce((sum, m) => sum + m.belly_band_lf, 0),
        detection_method: 'cad',
      },
      gables: { count: parseInt(h.gable_count) || 2 },
      openings: {
        window_count: measurementTotals.window_count,
        door_count: measurementTotals.door_count,
        garage_count: measurementTotals.garage_count,
        total_perimeter_lf: parseFloat(h.openings_perimeter_lf) || 0,
      },
      gutters: {
        total_length_ft: measurementTotals.gutter_lf || parseFloat(h.gutter_lf) || parseFloat(h.eave_lf) || 0,
        downspouts_count: parseInt(h.downspout_count) || 4,
      },
    },
  };

  // =========================================================================
  // STEP 10: Build trade configs
  // =========================================================================
  const sidingConfig = {
    ...webhookData.siding,
    source_type: 'cad',
    extraction_id: extractionId,
    assigned_products: [
      ...materialsByTrade.siding,
      ...materialsByTrade.trim.filter((m: any) => m.measurement_type !== 'count'),
      ...autoTrimItems,
    ],
    count_items: [
      ...materialsByTrade.trim.filter((m: any) => m.measurement_type === 'count'),
      ...assignedMaterials.filter(m => m.measurement_type === 'count' && m.trade !== 'windows'),
    ],
    auto_scope_items: autoScopeItems,
    total_siding_sf: totalSidingSF,
    has_colorplus: hasColorPlusSiding,
    requires_primer: requiresPrimer,
    per_material_measurements: perMaterialMeasurements,
    spatial_containment: {
      enabled: true,
      version: '8.1',
      matched_openings: summary.openings_matched,
      total_openings: summary.openings_analyzed,
      unmatched_openings: summary.openings_analyzed - summary.openings_matched,
      matched_corners: summary.corners_matched,
      total_corners: summary.corners_analyzed,
      matched_trim: summary.trim_matched,
      total_trim: summary.trim_analyzed,
    },
    measurements: {
      facade_area_sqft: sidingTotalArea,
      net_siding_sqft: sidingNetArea,
      level_starter_lf: parseFloat(h.level_starter_lf) || 0,
      outside_corners_count: parseInt(h.outside_corners_count) || 0,
      outside_corners_lf: parseFloat(h.outside_corners_lf) || 0,
      inside_corners_count: parseInt(h.inside_corners_count) || 0,
      inside_corners_lf: parseFloat(h.inside_corners_lf) || 0,
      openings_perimeter_lf: parseFloat(h.openings_perimeter_lf) || 0,
      openings_windows_count: measurementTotals.window_count,
      openings_doors_count: measurementTotals.door_count,
      openings_garages_count: measurementTotals.garage_count,
      ...trimMeasurements,
    },
    cad_product_info: sidingInfo,
  };

  const roofingConfig = {
    ...webhookData.roofing,
    source_type: 'cad',
    extraction_id: extractionId,
    assigned_products: materialsByTrade.roofing,
    count_items: assignedMaterials.filter(m => m.trade === 'roofing' && m.measurement_type === 'count'),
    measurements: {
      roof_total_sqft: measurementTotals.roofing_sf || parseFloat(h.roof_total_sqft) || 0,
      roof_pitch: h.roof_pitch || '4/12',
      ridge_lf: parseFloat(h.ridge_lf) || 0,
      valley_lf: parseFloat(h.valley_lf) || 0,
      rake_lf: parseFloat(h.rake_lf) || 0,
      eave_lf: parseFloat(h.eave_lf) || 0,
      hip_lf: parseFloat(h.hip_lf) || 0,
    },
    cad_product_info: roofingInfo,
  };

  const windowsConfig = {
    ...webhookData.windows,
    source_type: 'cad',
    extraction_id: extractionId,
    assigned_products: materialsByTrade.windows,
    count_items: assignedMaterials.filter(m => m.trade === 'windows' && m.measurement_type === 'count'),
    measurements: {
      windows_count: measurementTotals.window_count,
      doors_count: measurementTotals.door_count,
      garages_count: measurementTotals.garage_count,
      openings_perimeter_lf: parseFloat(h.openings_perimeter_lf) || 0,
    },
    cad_product_info: windowsInfo,
  };

  const guttersConfig = {
    ...webhookData.gutters,
    source_type: 'cad',
    extraction_id: extractionId,
    assigned_products: materialsByTrade.gutters,
    count_items: assignedMaterials.filter(m => m.trade === 'gutters' && m.measurement_type === 'count'),
    measurements: {
      gutter_lf: measurementTotals.gutter_lf || parseFloat(h.gutter_lf) || parseFloat(h.eave_lf) || 0,
      downspout_count: parseInt(h.downspout_count) || 4,
    },
    cad_product_info: guttersInfo,
  };

  // =========================================================================
  // STEP 11: Build result
  // =========================================================================
  const timestamp = Date.now().toString().slice(-10);
  const random = Math.floor(Math.random() * 999999);
  const hoverProjectId = `cad-${timestamp}-${random}`;

  console.log('\n✅ SPATIAL CONTAINMENT COMPLETE');
  console.log(`   Per-material groups: ${Object.keys(perMaterialMeasurements).length}`);
  console.log(`   Selected trades: ${selectedTrades.join(', ')}`);

  return {
    success: true,
    source_type: 'cad',
    hover_project_id: hoverProjectId,
    selected_trades: selectedTrades,
    measurements,
    confidence: 1.0,
    parsed_at: new Date().toISOString(),
    webhook_data: webhookData,
    siding: sidingConfig,
    roofing: roofingConfig,
    windows: windowsConfig,
    gutters: guttersConfig,
    cad_extraction: {
      extraction_id: extractionId,
      source_filename: h.source_filename,
      detected_trades: [...new Set(classifiedCallouts.map(c => c.trade))],
      product_info: {
        siding: sidingInfo,
        roofing: roofingInfo,
        windows: windowsInfo,
        gutters: guttersInfo,
      },
    },
    spatial_containment_summary: summary,
    v81_summary: {
      total_siding_sf: totalSidingSF,
      has_colorplus: hasColorPlusSiding,
      auto_trim_items: autoTrimItems.length,
      auto_scope_items: autoScopeItems.length,
      trim_total_lf: trimMeasurements.total_trim_lf,
      trim_source: trimMeasurements.trim_source,
      per_material_count: Object.keys(perMaterialMeasurements).length,
    },
  };
}
