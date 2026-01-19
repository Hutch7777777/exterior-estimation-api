/**
 * Integration tests for siding API endpoints
 */

import { calculateSiding } from '../../src/calculations/siding';
import { CalculationRequest } from '../../src/types';

describe('Siding API Integration', () => {

  describe('Full calculation matching January 2026 output', () => {

    it('produces expected material list', async () => {
      const request: CalculationRequest = {
        source: { type: 'cad', confidence: 0.95 },
        project: { id: 'jan-2026-test', name: 'January 2026 Test' },
        measurements: {
          siding: {
            gross_area_sf: 2000,
            net_area_sf: 1606
          },
          openings: {
            total_area_sf: 394,
            total_perimeter_lf: 200,
            windows: { count: 10, perimeter_lf: 140 },
            doors: { count: 2, perimeter_lf: 36 },
            garages: { count: 1, perimeter_lf: 24 }
          },
          corners: {
            inside: { count: 0, total_lf: 0 },
            outside: { count: 4, total_lf: 40 }
          },
          gables: { count: 2 }
        },
        config: {
          siding: {
            product_name: "James Hardie 6.75\" x 12' Cedarmill Lap Siding",
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

      const result = await calculateSiding(request);

      expect(result.success).toBe(true);
      expect(result.trade).toBe('siding');

      // Find specific items and verify quantities
      const siding = result.materials.find(m => m.category === 'siding');
      expect(siding?.quantity).toBe(18); // 18 squares

      const outsideCorners = result.materials.find(m =>
        m.description.includes('Outside Corner')
      );
      expect(outsideCorners?.quantity).toBe(4);

      const gableBase = result.materials.find(m =>
        m.description === 'Whitewood Trim Primed 2x2x16'
      );
      expect(gableBase?.quantity).toBe(5);

      const gableTopOut = result.materials.find(m =>
        m.description.includes('Gable Top-Out')
      );
      expect(gableTopOut?.quantity).toBe(7);

      const garageTrim = result.materials.find(m =>
        m.description.includes('Garage Trim')
      );
      expect(garageTrim?.quantity).toBe(3);

      const houseWrap = result.materials.find(m =>
        m.description.includes('HardieWrap')
      );
      expect(houseWrap?.quantity).toBe(2);

      const staples = result.materials.find(m =>
        m.description.includes('Staples')
      );
      expect(staples?.quantity).toBe(4);
    });

    it('includes provenance information', async () => {
      const request: CalculationRequest = {
        source: { type: 'manual' },
        project: { id: 'test' },
        measurements: {
          siding: { gross_area_sf: 1000, net_area_sf: 800 },
          openings: {
            total_area_sf: 200,
            total_perimeter_lf: 100,
            windows: { count: 5, perimeter_lf: 70 },
            doors: { count: 1, perimeter_lf: 20 },
            garages: { count: 0, perimeter_lf: 0 }
          },
          corners: {
            inside: { count: 0, total_lf: 0 },
            outside: { count: 2, total_lf: 0 } // Will trigger estimation warning
          }
        },
        config: {
          siding: { finish: 'primed' },
          corner_trim: { finish: 'primed' }
        }
      };

      const result = await calculateSiding(request);

      expect(result.provenance).toBeDefined();
      expect(result.provenance.version).toContain('siding-calc');
      expect(result.provenance.timestamp).toBeDefined();

      // Should have warning about estimated corner LF
      const cornerWarning = result.provenance.warnings.find(w =>
        w.code === 'CORNER_LF_ESTIMATED'
      );
      expect(cornerWarning).toBeDefined();
    });

  });

});
