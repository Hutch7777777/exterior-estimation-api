/**
 * Unit tests for auto-scope calculations
 * Based on January 2026 output formulas
 */

import {
  calculateHouseWrap,
  calculateStaples,
  calculateSealant,
  calculateTouchUpPaint,
  generateAutoScopeItems
} from '../../src/calculations/siding/autoscope';

describe('Auto-Scope Calculations', () => {

  describe('calculateHouseWrap', () => {

    it('matches January 2026: 2 rolls from 2000 SF', () => {
      const result = calculateHouseWrap(2000);

      // Formula: ceil((2000 × 1.15) / 1350) = ceil(1.70) = 2
      expect(result.quantity).toBe(2);
      expect(result.unit).toBe('ROLL');
    });

    it('calculates 3 rolls for larger facade', () => {
      const result = calculateHouseWrap(3500);

      // Formula: ceil((3500 × 1.15) / 1350) = ceil(2.98) = 3
      expect(result.quantity).toBe(3);
    });

    it('handles zero area', () => {
      const result = calculateHouseWrap(0);
      expect(result.quantity).toBe(0);
    });

  });

  describe('calculateStaples', () => {

    it('matches January 2026: 4 boxes from 2000 SF', () => {
      const result = calculateStaples(2000);

      // Formula: ceil(2000 / 500) = 4
      expect(result.quantity).toBe(4);
      expect(result.unit).toBe('BOX');
    });

  });

  describe('calculateSealant', () => {

    it('matches January 2026: 4 tubes from 2000 SF', () => {
      const result = calculateSealant(2000);

      // Formula: ceil(2000 / 500) = 4
      expect(result.quantity).toBe(4);
      expect(result.unit).toBe('EA');
    });

  });

  describe('calculateTouchUpPaint', () => {

    it('matches January 2026: 2 quarts from 2000 SF', () => {
      const result = calculateTouchUpPaint(2000);

      // Formula: ceil(2000 / 1500) = 2
      expect(result.quantity).toBe(2);
      expect(result.unit).toBe('EA');
    });

  });

  describe('generateAutoScopeItems', () => {

    it('generates 7 items for valid facade area', () => {
      const items = generateAutoScopeItems(2000);

      expect(items.length).toBe(7);

      // Check all items are present
      const descriptions = items.map(i => i.description);
      expect(descriptions).toContain('HardieWrap Weather Barrier');
      expect(descriptions).toContain('A-11 Staples (House Wrap)');
      expect(descriptions).toContain('Paintable Sealant 10.1oz tube');
      expect(descriptions).toContain('Touch-Up Paint Quart');
      expect(descriptions).toContain('Hardie Blade - Fiber Cement Cutting');
      expect(descriptions).toContain('Spackle 6oz (Nail Hole Filler)');
      expect(descriptions).toContain('Black Jack Butyl Mastic');
    });

    it('returns empty array for zero area', () => {
      const items = generateAutoScopeItems(0);
      expect(items.length).toBe(0);
    });

  });

});
