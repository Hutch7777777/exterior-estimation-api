/**
 * Unit tests for siding material calculations
 * Validates against known outputs from n8n system
 */

import {
  calculateLapSiding,
  calculateLapSidingSquares,
  calculateOutsideCorners,
  calculateInsideCorners,
  calculateGarageTrim,
  calculateGableTopOutBase,
  calculateGableTopOutGable
} from '../../src/calculations/siding/materials';
import { SidingMeasurements, SidingProductConfig } from '../../src/types';

describe('Siding Material Calculations', () => {

  // =========================================================================
  // TEST: calculateLapSidingSquares
  // Based on January 2026 output: 18 squares from ~1606 SF net
  // =========================================================================

  describe('calculateLapSidingSquares', () => {

    it('matches January 2026 output: 18 squares from 1606 SF', () => {
      const measurements: SidingMeasurements = {
        gross_area_sf: 2000,
        net_area_sf: 1606
      };

      const config: SidingProductConfig = {
        product_name: "James Hardie 6.75\" x 12' Cedarmill Lap Siding",
        reveal_inches: 6.75,
        finish: 'primed',
        profile: 'cedarmill'
      };

      const result = calculateLapSidingSquares(measurements, config);

      // Formula: (1606 × 1.12) / 100 = 17.99 → 18
      expect(result.quantity).toBe(18);
      expect(result.unit).toBe('SQUARE');
      expect(result.category).toBe('siding');
    });

    it('calculates labor squares correctly', () => {
      const measurements: SidingMeasurements = {
        gross_area_sf: 2000,
        net_area_sf: 1606
      };

      const config: SidingProductConfig = {
        reveal_inches: 6.75,
        finish: 'primed'
      };

      const result = calculateLapSidingSquares(measurements, config);

      // Labor squares = net_area / 100 (no waste)
      expect(result.labor_quantity).toBeCloseTo(16.06, 2);
      expect(result.labor_unit).toBe('squares');
    });

    it('handles zero area', () => {
      const measurements: SidingMeasurements = {
        gross_area_sf: 0,
        net_area_sf: 0
      };

      const config: SidingProductConfig = {
        finish: 'primed'
      };

      const result = calculateLapSidingSquares(measurements, config);

      expect(result.quantity).toBe(0);
    });

  });

  // =========================================================================
  // TEST: calculateLapSiding (pieces)
  // Based on Mike Skjei: 370 PC from 2724 SF at 8.25" reveal
  // =========================================================================

  describe('calculateLapSiding (pieces)', () => {

    it('matches Mike Skjei output: 370 PC from 2724 SF at 8.25" reveal', () => {
      const measurements: SidingMeasurements = {
        gross_area_sf: 3000,
        net_area_sf: 2724
      };

      const config: SidingProductConfig = {
        product_name: 'Hardie Arctic White Cedarmill Lap',
        reveal_inches: 8.25,
        finish: 'colorplus',
        color: 'arctic_white',
        profile: 'cedarmill'
      };

      const result = calculateLapSiding(measurements, config);

      // Formula: (2724 / 8.25) × 1.12 = 330.18 × 1.12 = 369.8 → 370
      expect(result.quantity).toBe(370);
      expect(result.unit).toBe('PC');
    });

    it('calculates labor squares from net area', () => {
      const measurements: SidingMeasurements = {
        gross_area_sf: 3000,
        net_area_sf: 2724
      };

      const config: SidingProductConfig = {
        reveal_inches: 8.25,
        finish: 'colorplus'
      };

      const result = calculateLapSiding(measurements, config);

      // Labor = 2724 / 100 = 27.24 squares
      expect(result.labor_quantity).toBeCloseTo(27.24, 2);
    });

    it('uses default reveal when not specified', () => {
      const measurements: SidingMeasurements = {
        gross_area_sf: 1000,
        net_area_sf: 800
      };

      const config: SidingProductConfig = {
        finish: 'primed'
      };

      const result = calculateLapSiding(measurements, config);

      expect(result.calculation.inputs.reveal_inches).toBe(8.25);
    });

  });

  // =========================================================================
  // TEST: calculateOutsideCorners
  // Based on January 2026: 4 PC from 40 LF
  // =========================================================================

  describe('calculateOutsideCorners', () => {

    it('matches January 2026 output: 4 PC from 40 LF', () => {
      const result = calculateOutsideCorners(40, 4, 'primed');

      // Formula: (40 / 12) × 1.12 = 3.33 × 1.12 = 3.73 → 4
      expect(result.quantity).toBe(4);
      expect(result.unit).toBe('PC');
      expect(result.low_confidence).toBeFalsy();
    });

    it('estimates from count when LF is zero', () => {
      const result = calculateOutsideCorners(0, 4, 'primed');

      // Estimated: 4 corners × 10' default = 40 LF
      expect(result.quantity).toBe(4);
      expect(result.low_confidence).toBe(true);
    });

    it('calculates correctly: 26 PC from 268 LF', () => {
      const result = calculateOutsideCorners(268, 22, 'colorplus', 'Arctic White');

      // Formula: ceil((268 / 12) × 1.12) = ceil(22.33 × 1.12) = ceil(25.01) = 26
      expect(result.quantity).toBe(26);
      expect(result.description).toContain('Arctic White');
    });

  });

  // =========================================================================
  // TEST: calculateInsideCorners (whitewood)
  // =========================================================================

  describe('calculateInsideCorners', () => {

    it('uses 16ft whitewood pieces - 11 PC from 143 LF', () => {
      const result = calculateInsideCorners(143, 9);

      // Formula: ceil((143 / 16) × 1.12) = ceil(8.9375 × 1.12) = ceil(10.01) = 11
      expect(result.quantity).toBe(11);
      expect(result.sku).toBe('FRIEZE-1X8X12');
      expect(result.description).toContain('Frieze');
    });

    it('estimates from count when LF is zero', () => {
      const result = calculateInsideCorners(0, 9);

      // Estimated: 9 × 10' = 90 LF, (90/16) × 1.12 = 6.3 → 7
      expect(result.quantity).toBe(7);
      expect(result.low_confidence).toBe(true);
    });

  });

  // =========================================================================
  // TEST: calculateGarageTrim
  // Based on January 2026: 3 PC from 24 LF
  // =========================================================================

  describe('calculateGarageTrim', () => {

    it('matches January 2026 output: 3 PC from 24 LF', () => {
      const result = calculateGarageTrim(24, 1, 'colorplus', 'Arctic White');

      // Formula: (24 / 12) × 1.12 = 2 × 1.12 = 2.24 → 3
      expect(result.quantity).toBe(3);
      expect(result.low_confidence).toBeFalsy();
    });

    it('estimates from count when LF is zero (LOW CONFIDENCE)', () => {
      const result = calculateGarageTrim(0, 1, 'colorplus');

      // Estimated: 1 garage × 40 LF = 40 LF
      // (40 / 12) × 1.12 = 3.73 → 4
      expect(result.quantity).toBe(4);
      expect(result.low_confidence).toBe(true);
    });

  });

  // =========================================================================
  // TEST: calculateGableTopOut
  // Based on January 2026: 5 PC base, 7 PC gable from 2 gables
  // =========================================================================

  describe('calculateGableTopOut', () => {

    it('matches January 2026 base: 5 PC from 2 gables', () => {
      const result = calculateGableTopOutBase(2);

      // Formula: 2 × 2 × 1.12 = 4.48 → 5
      expect(result.quantity).toBe(5);
    });

    it('matches January 2026 gable: 7 PC from 2 gables', () => {
      const result = calculateGableTopOutGable(2);

      // Formula: ceil(2 × 3) × 1.12 = 6 × 1.12 = 6.72 → 7
      expect(result.quantity).toBe(7);
    });

  });

});
