import {
  createInboundAuth,
  resolveInboundAuthConfig,
} from '../../src/middleware/inboundAuth';

function invokeMiddleware(options: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  apiKey?: string;
  requireApiKey: boolean;
}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const request = {
    path: options.path || '/webhook/siding-estimator',
    method: options.method || 'POST',
    get: (name: string) => headers[name.toLowerCase()],
  };
  const result: { status?: number; body?: unknown; next: boolean; headers: Record<string, string> } = {
    next: false,
    headers: {},
  };
  const response = {
    setHeader: (name: string, value: string) => {
      result.headers[name] = value;
    },
    status: (status: number) => {
      result.status = status;
      return response;
    },
    json: (body: unknown) => {
      result.body = body;
      return response;
    },
  };

  createInboundAuth({
    apiKey: options.apiKey,
    requireApiKey: options.requireApiKey,
  })(request as never, response as never, () => {
    result.next = true;
  });
  return result;
}

describe('estimation API inbound authentication', () => {
  it('requires an API key by default on Railway', () => {
    expect(resolveInboundAuthConfig({ RAILWAY_ENVIRONMENT_ID: 'railway-id' })).toEqual({
      apiKey: undefined,
      requireApiKey: true,
    });
  });

  it('leaves health checks public', () => {
    expect(invokeMiddleware({ path: '/health', requireApiKey: true }).next).toBe(true);
    expect(invokeMiddleware({ path: '/webhook/health', requireApiKey: true }).next).toBe(true);
  });

  it('fails closed when production auth is required but unconfigured', () => {
    const result = invokeMiddleware({ requireApiKey: true });
    expect(result.status).toBe(503);
    expect(result.next).toBe(false);
  });

  it('rejects an invalid key and accepts a valid one', () => {
    expect(invokeMiddleware({
      apiKey: 'expected-key',
      requireApiKey: true,
      headers: { 'X-API-Key': 'wrong-key' },
    }).status).toBe(401);
    expect(invokeMiddleware({
      apiKey: 'expected-key',
      requireApiKey: true,
      headers: {
        'X-API-Key': 'expected-key',
        'X-Estimate-Request-Id': 'request-123',
      },
    })).toMatchObject({
      next: true,
      headers: { 'X-Request-Id': 'request-123' },
    });
  });
});
