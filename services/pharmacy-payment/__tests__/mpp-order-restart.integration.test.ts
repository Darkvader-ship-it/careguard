import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Integration test (Issue #793): an order placed through the live
 * POST /pharmacy/order route survives a full server restart.
 *
 * Unlike mpp-store-persistence.test.ts (which mocks fs entirely), this test
 * uses the real filesystem against a temp data directory and re-imports the
 * server module between "boots" (vi.resetModules) to simulate a process
 * restart while keeping the same on-disk orders.json.
 *
 * Express, the MPP/Stellar SDKs, and file locking are mocked — the goal is
 * to exercise the route handlers' own read/write logic, not those deps.
 */

const mockSafeParse = vi.fn();
const mockApp = {
  use: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  listen: vi.fn(() => ({ close: vi.fn() })),
};

vi.mock('express', () => {
  const express = vi.fn(() => mockApp);
  (express as any).json = vi.fn(() => vi.fn());
  return { default: express };
});
vi.mock('mppx/server', () => ({
  Store: { memory: vi.fn(() => ({ type: 'memory' })), fileSystem: vi.fn((p: string) => ({ type: 'fileSystem', path: p })) },
  Mppx: {
    create: vi.fn(() => ({
      charge: () => () =>
        Promise.resolve({
          status: 200,
          withReceipt: (resp: Response) => resp,
        }),
    })),
  },
}));
vi.mock('@stellar/mpp/charge/server', () => ({ stellar: { charge: vi.fn(() => ({})) } }));
vi.mock('@stellar/mpp', () => ({ USDC_SAC_TESTNET: 'USDC_SAC_TESTNET' }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../shared/cors.ts', () => ({ createCorsMiddleware: vi.fn(() => vi.fn()) }));
vi.mock('../../shared/security-middleware.ts', () => ({ applySecurityMiddleware: vi.fn() }));
vi.mock('../../shared/logger.ts', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../shared/request-context.ts', () => ({ requestContextMiddleware: vi.fn(() => vi.fn()) }));
vi.mock('../../shared/request-logger.ts', () => ({ requestLoggerMiddleware: vi.fn(() => vi.fn()) }));
vi.mock('../../shared/sanitize.ts', () => ({ sanitizeUserString: vi.fn((s: string) => s) }));
vi.mock('../validation.ts', () => ({ MedicationOrderSchema: { safeParse: mockSafeParse } }));
vi.mock('proper-lockfile', () => ({
  default: { lock: vi.fn(() => Promise.resolve(() => Promise.resolve())) },
}));

function fakeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
    send(payload: any) { this.body = payload; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res;
}

async function bootServer() {
  vi.resetModules();
  await import('../server.ts');
  const postCalls = mockApp.post.mock.calls;
  const getCalls = mockApp.get.mock.calls;
  return {
    orderHandler: postCalls[postCalls.length - 1][1],
    ordersHandler: getCalls.filter((c) => c[0] === '/pharmacy/orders').pop()![1],
  };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'careguard-mpp-orders-'));
  process.env.DATA_DIR = dataDir;
  process.env.PHARMACY_1_PUBLIC_KEY = 'GPUB123TEST';
  process.env.MPP_SECRET_KEY = 'test-mpp-secret';
  mockSafeParse.mockReturnValue({
    success: true,
    data: { drug: 'Amoxicillin', pharmacy: 'Test Pharmacy', amount: 12.5 },
  });
});

afterAll(() => {
  delete process.env.DATA_DIR;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('MPP order persistence across a server restart (Issue #793)', () => {
  it('an order placed via POST /pharmacy/order is present in GET /pharmacy/orders after restart', async () => {
    const boot1 = await bootServer();
    const req: any = { body: {}, headers: {}, url: '/pharmacy/order', method: 'POST' };
    const res1 = fakeRes();
    await boot1.orderHandler(req, res1);

    expect(res1.statusCode).toBe(200);
    const placedOrder = res1.body.order;
    expect(placedOrder.id).toMatch(/^order-/);

    // Simulate a full process restart: fresh module load, same data dir.
    const boot2 = await bootServer();
    const res2 = fakeRes();
    await boot2.ordersHandler({} as any, res2);

    expect(res2.body.orders).toHaveLength(1);
    expect(res2.body.orders[0].id).toBe(placedOrder.id);
    expect(res2.body.orders[0].drug).toBe(placedOrder.drug);
  });

  it('a torn/partial orders.json does not crash boot and is reported as empty', async () => {
    const ordersFile = path.join(dataDir, 'orders.json');
    writeFileSync(ordersFile, '{"orders": [ this is not valid json', 'utf-8');

    const boot = await bootServer();
    const res = fakeRes();
    expect(() => boot.ordersHandler({} as any, res)).not.toThrow();
    expect(res.body.orders).toEqual([]);
  });
});
