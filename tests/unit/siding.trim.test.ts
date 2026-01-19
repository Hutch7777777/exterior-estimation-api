/**
 * Unit tests for trim calculations
 */

import {
  calculateWindowTrim,
  calculateDoorTrim,
  calculateWindowHeadFlashing,
  calculateDoorHeadFlashing
} from '../../src/calculations/siding/trim';
import { TrimConfig } from '../../src/types';

describe('Trim Calculations', () => {

  describe('calculateWindowTrim', () => {

    it('calculates from perimeter LF', () => {
      const config: TrimConfig = {
        include: true,
        width: '4',
        finish: 'colorplus',
        color: 'Arctic White'
      };

      const result = calculateWindowTrim(140, 10, config);

      // Formula: (140 / 12) × 1.12 = 11.67 × 1.12 = 13.07 → 14
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(14);
      expect(result!.low_confidence).toBeFalsy();
    });

    it('estimates from count when perimeter is zero', () => {
      const config: TrimConfig = {
        include: true,
        width: '4',
        finish: 'primed'
      };

      const result = calculateWindowTrim(0, 10, config);

      // Estimated: 10 × 14 LF = 140 LF
      // (140 / 12) × 1.12 = 14
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(14);
      expect(result!.low_confidence).toBe(true);
    });

    it('returns null when not included', () => {
      const config: TrimConfig = {
        include: false
      };

      const result = calculateWindowTrim(140, 10, config);
      expect(result).toBeNull();
    });

    it('matches Mike Skjei: 50 PC from 535 LF', () => {
      const config: TrimConfig = {
        include: true,
        width: '4',
        finish: 'colorplus',
        color: 'Arctic White'
      };

      const result = calculateWindowTrim(535, 38, config);

      // Formula: (535 / 12) × 1.12 = 44.58 × 1.12 = 49.93 → 50
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(50);
    });

  });

  describe('calculateDoorTrim', () => {

    it('calculates from perimeter LF', () => {
      const config: TrimConfig = {
        include: true,
        width: '4',
        finish: 'primed'
      };

      const result = calculateDoorTrim(36, 2, config);

      // Formula: (36 / 12) × 1.12 = 3 × 1.12 = 3.36 → 4
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(4);
    });

    it('estimates from count when perimeter is zero', () => {
      const config: TrimConfig = {
        include: true,
        width: '4',
        finish: 'primed'
      };

      const result = calculateDoorTrim(0, 2, config);

      // Estimated: 2 × 17 LF = 34 LF
      // (34 / 12) × 1.12 = 3.17 → 4
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(4);
      expect(result!.low_confidence).toBe(true);
    });

  });

  describe('calculateWindowHeadFlashing', () => {

    it('calculates from head LF', () => {
      const result = calculateWindowHeadFlashing(40, 10);

      // Formula: (40 / 10) × 1.10 = 4 × 1.10 = 4.4 → 5
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(5);
      expect(result!.category).toBe('flashing');
    });

    it('estimates from count when head LF is zero', () => {
      const result = calculateWindowHeadFlashing(0, 10);

      // Estimated: 10 × 4' = 40 LF
      // (40 / 10) × 1.10 = 5
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(5);
      expect(result!.low_confidence).toBe(true);
    });

  });

});
