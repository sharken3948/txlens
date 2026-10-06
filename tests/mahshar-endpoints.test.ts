import { afterEach, describe, expect, test } from "bun:test";
import { encodeEventTopics, encodeFunctionData, parseAbi } from "viem";
import { ARC_MEMO_ADDRESS, ARC_NATIVE_USDC } from "../src/server/contractMetadata";

const SELLER = "0x540a0027509B1C9aA0a2c5C65491cC97083E16de";
const ANALYZE_TOKEN = "mahshar-analyze-test-token";
const LOOKUP_TOKEN = "mahshar-lookup-test-token";
const TX_HASH = `0x${"ab".repeat(32)}`;
const SENDER = "0x1111111111111111111111111111111111111111";
const MEMO_ID = `0x${"22".repeat(32)}` as const;
const MEMO_ABI = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
  "event BeforeMemo(uint256 indexed memoIndex)",
]);
const MEMO_INPUT = encodeFunctionData({
  abi: MEMO_ABI,
  functionName: "memo",
  args: [ARC_NATIVE_USDC, "0x", MEMO_ID, "0x1234"],
});
const BEFORE_MEMO_TOPICS = encodeEventTopics({
  abi: MEMO_ABI,
  eventName: "BeforeMemo",
  args: { memoIndex: 7n },
});

process.env.SELLER_WALLET_ADDRESS = SELLER;
process.env.DIRECT_PAYMENT_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
process.env.MAHSHAR_ANALYZE_API_TOKEN = ANALYZE_TOKEN;
process.env.MAHSHAR_LOOKUP_API_TOKEN = LOOKUP_TOKEN;

const { app } = await import("../server");
const originalFetch = globalThis.fetch;

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  finished: boolean;
  status(code: number): MockResponse;
  json(value: unknown): MockResponse;
  setHeader(name: string, value: string): void;
  end(value?: string): MockResponse;
}

function response(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    finished: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.finished = true; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); },
    end(value) {
      this.body = value ? JSON.parse(value) : undefined;
      this.finished = true;
      return this;
    },
  };
}

function routeHandlers(path: string): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = (app as any).router.stack.find((candidate: any) => candidate.route?.path === path);
  if (!layer) throw new Error(`Route ${path} is not registered.`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

async function invoke(path: string, body: unknown, token?: string): Promise<MockResponse> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const req = {
    body,
    headers,
    method: "POST",
    path,
    url: path,
    header(name: string) { return headers[name.toLowerCase()]; },
    get(name: string) { return headers[name.toLowerCase()]; },
  };
  const res = response();
  const handlers = routeHandlers(path);

  async function run(index: number): Promise<void> {
    if (index >= handlers.length || res.finished) return;
    let nextCalled = false;
    let nextError: unknown;
    await handlers[index](req, res, (error?: unknown) => {
      nextCalled = true;
      nextError = error;
    });
    if (nextError) throw nextError;
    if (nextCalled) await run(index + 1);
  }

  await run(0);
  return res;
}

function mockArcRpc(): void {
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = request.method === "eth_getTransactionByHash"
      ? {
          hash: TX_HASH,
          from: SENDER,
          to: ARC_MEMO_ADDRESS,
          input: MEMO_INPUT,
          value: "0x0",
          blockNumber: "0x10",
          transactionIndex: "0x0",
          gas: "0x5208",
          gasPrice: "0x1",
          nonce: "0x1",
        }
      : request.method === "eth_getTransactionReceipt"
        ? {
            status: "0x1",
            logs: [{ address: ARC_MEMO_ADDRESS, topics: BEFORE_MEMO_TOPICS, data: "0x" }],
          }
        : null;
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
}

function mockGatewaySupported(): void {
  globalThis.fetch = async () => Response.json({
    kinds: [{
      scheme: "exact",
      network: "eip155:5042",
      extra: {
        verifyingContract: "0x7777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
        assets: [{ symbol: "USDC", address: ARC_NATIVE_USDC }],
      },
    }],
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.MAHSHAR_ANALYZE_API_TOKEN = ANALYZE_TOKEN;
  process.env.MAHSHAR_LOOKUP_API_TOKEN = LOOKUP_TOKEN;
  delete process.env.MAHSHAR_API_TOKEN;
});

describe("Mahshar internal authentication", () => {
  for (const path of ["/api/internal/mahshar/analyze", "/api/internal/mahshar/lookup-tx"]) {
    test(`${path} rejects a missing bearer token`, async () => {
      expect((await invoke(path, {})).statusCode).toBe(401);
    });

    test(`${path} rejects an incorrect bearer token`, async () => {
      expect((await invoke(path, {}, "wrong-token")).statusCode).toBe(401);
    });
  }

  test("analyze token does not authorize lookup", async () => {
    expect((await invoke("/api/internal/mahshar/lookup-tx", {}, ANALYZE_TOKEN)).statusCode).toBe(401);
  });

  test("lookup token does not authorize analyze", async () => {
    expect((await invoke("/api/internal/mahshar/analyze", {}, LOOKUP_TOKEN)).statusCode).toBe(401);
  });

  test("analyze fails closed when its server token is unconfigured", async () => {
    delete process.env.MAHSHAR_ANALYZE_API_TOKEN;
    expect((await invoke("/api/internal/mahshar/analyze", {}, ANALYZE_TOKEN)).statusCode).toBe(401);
  });

  test("lookup fails closed when its server token is unconfigured", async () => {
    delete process.env.MAHSHAR_LOOKUP_API_TOKEN;
    expect((await invoke("/api/internal/mahshar/lookup-tx", {}, LOOKUP_TOKEN)).statusCode).toBe(401);
  });

  test("does not accept the retired MAHSHAR_API_TOKEN variable", async () => {
    delete process.env.MAHSHAR_ANALYZE_API_TOKEN;
    delete process.env.MAHSHAR_LOOKUP_API_TOKEN;
    process.env.MAHSHAR_API_TOKEN = "retired-token";
    expect((await invoke("/api/internal/mahshar/analyze", {}, "retired-token")).statusCode).toBe(401);
    expect((await invoke("/api/internal/mahshar/lookup-tx", {}, "retired-token")).statusCode).toBe(401);
  });
});

describe("Mahshar internal fulfillment", () => {
  test("a valid token fulfills analysis and preserves ABI enrichment", async () => {
    const response = await invoke("/api/internal/mahshar/analyze", {
      chainId: 5042,
      to: ARC_MEMO_ADDRESS,
      data: MEMO_INPUT,
      value: "0",
    }, ANALYZE_TOKEN);
    expect(response.statusCode).toBe(200);
    const body = response.body as Record<string, any>;
    expect(body.action).toBe("verified_contract_call");
    expect(body.function).toBe("memo(address,bytes,bytes32,bytes)");
    expect(body.enrichment?.source).toBe("arc_system_contract_abi");
  });

  test("a valid token fulfills lookup with receipt event enrichment", async () => {
    mockArcRpc();
    const response = await invoke("/api/internal/mahshar/lookup-tx", { chainId: 5042, txHash: TX_HASH }, LOOKUP_TOKEN);
    expect(response.statusCode).toBe(200);
    const body = response.body as Record<string, any>;
    expect(body.transaction).toMatchObject({ hash: TX_HASH, status: "success", network: "Arc Mainnet" });
    expect(body.function).toBe("memo(address,bytes,bytes32,bytes)");
    expect(body.events?.[0]).toMatchObject({ decoded: true, event: "BeforeMemo" });
    expect(body.events?.[0]?.arguments?.memoIndex).toBe("7");
  });

  for (const [path, body, token] of [
    ["/api/internal/mahshar/analyze", { chainId: 1, to: ARC_MEMO_ADDRESS, data: MEMO_INPUT }, ANALYZE_TOKEN],
    ["/api/internal/mahshar/lookup-tx", { chainId: 1, txHash: TX_HASH }, LOOKUP_TOKEN],
  ] as const) {
    test(`${path} remains restricted to Arc Mainnet`, async () => {
      const response = await invoke(path, body, token);
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.body)).toContain("5042");
    });
  }
});

describe("public payment boundaries", () => {
  test("public Direct USDC endpoints still require payment", async () => {
    expect((await invoke("/api/analyze", { chainId: 5042, to: ARC_MEMO_ADDRESS, data: MEMO_INPUT })).statusCode).toBe(402);
    expect((await invoke("/api/lookup-tx", { chainId: 5042, txHash: TX_HASH })).statusCode).toBe(402);
  });

  test("public Gateway endpoints still require payment", async () => {
    mockGatewaySupported();
    expect((await invoke("/api/analyze/gateway", { chainId: 5042, to: ARC_MEMO_ADDRESS, data: MEMO_INPUT })).statusCode).toBe(402);
    expect((await invoke("/api/lookup-tx/gateway", { chainId: 5042, txHash: TX_HASH })).statusCode).toBe(402);
  });
});
