# Exterior Estimation API - Codebase Context

Generated: 2026-01-18
Version: 2.0.0 (Phase 2 Complete)

## Project Structure

```
~/projects/exterior-estimation-api/
├── src/
│   ├── calculations/
│   │   └── siding/
│   │       ├── autoscope.ts      # Auto-scope item calculations (house wrap, staples, etc.)
│   │       ├── index.ts          # Module exports
│   │       ├── materials.ts      # Core siding/corner calculations
│   │       ├── orchestrator.ts   # Main calculation coordinator
│   │       └── trim.ts           # Window/door trim calculations
│   ├── constants/
│   │   ├── index.ts
│   │   └── siding.ts             # Conversion specs, SKUs, rates
│   ├── routes/
│   │   └── siding.ts             # API route handlers
│   ├── types/
│   │   ├── calculation.ts        # TypeScript interfaces
│   │   └── index.ts
│   └── index.ts                  # Express server entry point
├── tests/
│   ├── __mocks__/
│   │   └── uuid.ts
│   ├── integration/
│   │   └── siding.api.test.ts
│   └── unit/
│       ├── siding.autoscope.test.ts
│       ├── siding.materials.test.ts
│       └── siding.trim.test.ts
├── .env
├── jest.config.js
├── package.json
└── tsconfig.json
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with version info |
| GET | `/api/v1/siding/test` | Sample calculation with test data |
| POST | `/api/v1/siding/calculate` | Full calculation endpoint |

### Health Check Response
```json
{
  "status": "ok",
  "version": "2.0.0",
  "trade": "siding",
  "phase": "Phase 2 - Auto-Scope & Trim"
}
```

## Dependencies

### Production
```json
{
  "@supabase/supabase-js": "^2.90.1",
  "cors": "^2.8.5",
  "dotenv": "^17.2.3",
  "express": "^5.2.1",
  "uuid": "^13.0.0"
}
```

### Development
```json
{
  "@types/cors": "^2.8.19",
  "@types/express": "^5.0.6",
  "@types/jest": "^30.0.0",
  "@types/node": "^25.0.9",
  "@types/uuid": "^10.0.0",
  "@typescript-eslint/eslint-plugin": "^8.53.0",
  "@typescript-eslint/parser": "^8.53.0",
  "eslint": "^9.39.2",
  "jest": "^30.2.0",
  "nodemon": "^3.1.11",
  "prettier": "^3.8.0",
  "ts-jest": "^29.4.6",
  "ts-node": "^10.9.2",
  "typescript": "^5.9.3"
}
```

## Environment Variables

```bash
# .env structure
PORT=3000
NODE_ENV=development

# Supabase (not yet configured)
# SUPABASE_URL=
# SUPABASE_ANON_KEY=
```

## Supabase Configuration

**Status: Installed but not configured**

The `@supabase/supabase-js` package is installed but no Supabase client has been created yet. No environment variables for Supabase URL or keys are present.

## Type Definitions

### CalculationRequest (Input)
```typescript
interface CalculationRequest {
  source: {
    type: 'cad' | 'hover' | 'manual';
    extraction_id?: string;
    confidence?: number;
  };
  project: {
    id: string;
    name?: string;
    address?: string;
    client_name?: string;
  };
  measurements: CalculationMeasurements;
  config: CalculationConfig;
}
```

### CalculationMeasurements
```typescript
interface CalculationMeasurements {
  siding: {
    gross_area_sf: number;
    net_area_sf: number;
    level_starter_lf?: number;
    avg_wall_height_ft?: number;
  };
  openings: {
    total_area_sf: number;
    total_perimeter_lf: number;
    windows: { count: number; perimeter_lf: number; head_lf?: number; sill_lf?: number; jamb_lf?: number; };
    doors: { count: number; perimeter_lf: number; head_lf?: number; jamb_lf?: number; };
    garages: { count: number; perimeter_lf: number; };
  };
  corners: {
    inside: { count: number; total_lf: number; is_estimated?: boolean; };
    outside: { count: number; total_lf: number; is_estimated?: boolean; };
  };
  gables?: { count: number; area_sf?: number; rake_lf?: number; };
}
```

### CalculationConfig
```typescript
interface CalculationConfig {
  siding: {
    product_sku?: string;
    product_name?: string;
    reveal_inches?: number;
    finish: 'primed' | 'colorplus';
    color?: string;
    profile?: 'smooth' | 'cedarmill';
  };
  window_trim?: { include: boolean; width?: string; finish?: 'primed' | 'colorplus'; color?: string; };
  door_trim?: { include: boolean; width?: string; finish?: 'primed' | 'colorplus'; color?: string; };
  garage_trim?: { include: boolean; width?: string; finish?: 'primed' | 'colorplus'; color?: string; };
  corner_trim?: { finish: 'primed' | 'colorplus'; color?: string; };
  pricing?: { material_markup_rate?: number; labor_markup_rate?: number; };
}
```

### CalculationResponse (Output)
```typescript
interface CalculationResponse {
  success: boolean;
  trade: 'siding';
  materials: MaterialLineItem[];
  provenance: {
    version: string;
    timestamp: string;
    warnings: Array<{ code: string; message: string; field?: string; }>;
  };
}
```

### MaterialLineItem
```typescript
interface MaterialLineItem {
  id: string;
  sku: string;
  description: string;
  quantity: number;
  unit: 'PC' | 'EA' | 'LF' | 'SF' | 'ROLL' | 'BOX' | 'SQUARE' | 'TUBE';
  size?: string;
  unit_cost?: number;
  extended?: number;
  category: 'siding' | 'trim' | 'flashing' | 'fasteners' | 'accessories' | 'water_barrier';
  presentation_group: string;
  source: 'calculated' | 'auto-scope' | 'assigned';
  calculation: { formula: string; inputs: Record<string, number>; result: number; };
  labor_quantity?: number;
  labor_unit?: string;
  low_confidence?: boolean;
  notes?: string;
}
```

## Sample Test Response

**Endpoint:** `GET /api/v1/siding/test`

**Request (embedded in test endpoint):**
```json
{
  "source": { "type": "manual", "confidence": 1.0 },
  "project": { "id": "test-project", "name": "Test Project" },
  "measurements": {
    "siding": { "gross_area_sf": 2000, "net_area_sf": 1606 },
    "openings": {
      "total_area_sf": 394,
      "total_perimeter_lf": 200,
      "windows": { "count": 10, "perimeter_lf": 140 },
      "doors": { "count": 2, "perimeter_lf": 36 },
      "garages": { "count": 1, "perimeter_lf": 24 }
    },
    "corners": {
      "inside": { "count": 0, "total_lf": 0 },
      "outside": { "count": 4, "total_lf": 40 }
    },
    "gables": { "count": 2 }
  },
  "config": {
    "siding": { "reveal_inches": 6.75, "finish": "primed", "profile": "cedarmill" },
    "window_trim": { "include": false },
    "door_trim": { "include": false },
    "garage_trim": { "include": true, "finish": "colorplus", "color": "Arctic White" },
    "corner_trim": { "finish": "primed" }
  }
}
```

**Response Materials (12 items):**

| SKU | Description | Qty | Unit | Category |
|-----|-------------|-----|------|----------|
| JH-LAP-6.75-CE | James Hardie 6.75" x 12' Cedarmill Lap Siding | 18 | SQUARE | siding |
| WW-2x2x16-PR | Whitewood Trim Primed 2x2x16 | 5 | PC | trim |
| WW-2x2x16-PR | Whitewood Trim 2x2x16 (Gable Top-Out) | 7 | PC | trim |
| JH-TRIM-GARAGE-6-12-CP | Garage Trim - HardieTrim 5/4 x 6 x 12ft Arctic White | 3 | PC | trim |
| JH-TRIM-OC-4-12-PR | Outside Corner - HardieTrim 5/4 x 4 x 12ft Primed | 4 | PC | trim |
| HWRAP-9x150 | HardieWrap Weather Barrier | 2 | ROLL | water_barrier |
| STAPLES-A11 | A-11 Staples (House Wrap) | 4 | BOX | fasteners |
| SEALANT-10OZ | Paintable Sealant 10.1oz tube | 4 | EA | accessories |
| PAINT-TOUCHUP-QT | Touch-Up Paint Quart | 2 | EA | accessories |
| BLADE-HARDIE | Hardie Blade - Fiber Cement Cutting | 1 | EA | accessories |
| SPACKLE-6OZ | Spackle 6oz (Nail Hole Filler) | 1 | TUBE | accessories |
| MASTIC-BUTYL | Black Jack Butyl Mastic | 1 | TUBE | accessories |

## Constants Reference

### Conversion Specs
```typescript
const CONVERSION_SPECS = {
  siding: { default_reveal_inches: 8.25, plank_length_ft: 12, waste_factor: 1.12, pieces_per_square_default: 12.12 },
  shingle: { pieces_per_square: 43, waste_factor: 1.18, coverage_per_square: 100 },
  panel: { width_ft: 4, height_ft: 8, waste_factor: 1.18 },
  trim: { waste_factor: 1.12, hardie_piece_length_ft: 12, whitewood_piece_length_ft: 16 },
  corners: { waste_factor: 1.12, piece_length_ft: 12, default_height_ft: 10 },
  flashing: { waste_factor: 1.10, piece_length_ft: 10 },
  housewrap: { roll_coverage_sqft: 1350, waste_factor: 1.15 }
};
```

### Coverage Rates
```typescript
const COVERAGE_RATES = {
  staples_per_sqft: 500,
  sealant_per_sqft: 500,
  touchup_paint_per_sqft: 1500,
  nails_per_square: 15,
  tape_per_sqft: 500
};
```

### Labor Rates
```typescript
const LABOR_RATES = {
  lap_siding: 180,
  shingle_siding: 200,
  panel_siding: 220,
  board_batten: 200
};
```

## Calculation Functions

### materials.ts
- `calculateLapSiding(measurements, config)` - Siding in PIECES
- `calculateLapSidingSquares(measurements, config)` - Siding in SQUARES
- `calculateOutsideCorners(cornerLf, cornerCount, finish, color)` - Outside corner trim
- `calculateInsideCorners(cornerLf, cornerCount)` - Inside corner whitewood
- `calculateGarageTrim(perimeterLf, garageCount, finish, color)` - Garage door trim
- `calculateGableTopOutBase(gableCount)` - Gable base pieces
- `calculateGableTopOutGable(gableCount)` - Gable top-out pieces

### trim.ts
- `calculateWindowTrim(perimeterLf, windowCount, config)` - Window trim pieces
- `calculateDoorTrim(perimeterLf, doorCount, config)` - Door trim pieces
- `calculateWindowHeadFlashing(headLf, windowCount)` - Window head flashing
- `calculateDoorHeadFlashing(headLf, doorCount)` - Door head flashing

### autoscope.ts
- `calculateHouseWrap(facadeSqft)` - House wrap rolls
- `calculateStaples(facadeSqft)` - Staple boxes
- `calculateSealant(facadeSqft)` - Sealant tubes
- `calculateTouchUpPaint(facadeSqft)` - Touch-up paint quarts
- `calculateHardieBlade()` - Fixed: 1 blade
- `calculateSpackle()` - Fixed: 1 tube
- `calculateButylMastic()` - Fixed: 1 tube
- `generateAutoScopeItems(facadeSqft)` - All auto-scope items

### orchestrator.ts
- `calculateSiding(request)` - Main orchestrator that coordinates all calculations

## Test Summary

```
Test Suites: 4 passed, 4 total
Tests:       33 passed, 33 total

- siding.materials.test.ts: 15 tests
- siding.autoscope.test.ts: 9 tests
- siding.trim.test.ts: 8 tests
- siding.api.test.ts: 2 tests (integration)
```

## Scripts

```bash
npm run dev          # Start with nodemon (hot reload)
npm run build        # Compile TypeScript
npm start            # Run compiled JS
npm test             # Run Jest tests
npm run test:watch   # Watch mode
npm run test:coverage # With coverage
npm run typecheck    # TypeScript check only
npm run lint         # ESLint
```
