import { randomUUID, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';

const PUBLIC_PATHS = new Set(['/health', '/webhook/health']);
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface InboundAuthConfig {
  apiKey?: string;
  requireApiKey: boolean;
}

export function resolveInboundAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): InboundAuthConfig {
  const apiKey = env.ESTIMATION_API_KEY?.trim() || undefined;
  const runningOnRailway = Boolean(
    env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_ID,
  );
  const requireApiKey = (
    env.ESTIMATION_REQUIRE_API_KEY
    ?? (runningOnRailway ? 'true' : 'false')
  ).toLowerCase() === 'true';

  return { apiKey, requireApiKey };
}

function safeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function createInboundAuth(config: InboundAuthConfig): RequestHandler {
  return (request, response, next) => {
    const candidateRequestId = request.get('X-Estimate-Request-Id') || '';
    const requestId = SAFE_REQUEST_ID.test(candidateRequestId)
      ? candidateRequestId
      : randomUUID();
    response.setHeader('X-Request-Id', requestId);

    if (request.method === 'OPTIONS' || PUBLIC_PATHS.has(request.path)) {
      next();
      return;
    }

    if (!config.apiKey) {
      if (config.requireApiKey) {
        response.status(503).json({
          success: false,
          error: 'Service authentication is not configured',
        });
        return;
      }

      next();
      return;
    }

    const providedKey = request.get('X-API-Key') || '';
    if (!safeEqual(providedKey, config.apiKey)) {
      response.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    next();
  };
}
