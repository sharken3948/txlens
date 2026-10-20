import { describe, expect, test } from "bun:test";
import { lookupArcTransaction } from "../src/server/arcLookup";

const TX_HASH = "0xa3efb83ad9ac4f2164d36b2579104cb7fb19c986cd623206b27387330e33fa33";
const BLOCK_HASH = "0xa3e997416b761f494d7aa1c31755e4a7ae3338a94072773fa2edea1fdccde98b";
const TX = {
  hash: TX_HASH,
  from: "0x052650d1764406d702252b20b2294346a594a1ef",
  to: "0x5294e9927c3306dcbadb03fe70b92e01ccede505",
  input: "0x",
  value: "0x0",
  blockNumber: "0x171b8cb",
  blockHash: BLOCK_HASH,
  transactionIndex: "0x0",
};
const RECEIPT = {
  transactionHash: TX_HASH,
  blockNumber: TX.blockNumber,
  blockHash: BLOCK_HASH,
  status: "0x1",
  logs: [],
};
const PENDING = { ...TX, blockNumber: null, blockHash: null, transactionIndex: null };
const OPTIONS = { retryDelayMs: 0 };

interface Call { provider: "primary" | "fallback"; method: string; attempt: number; signal: AbortSignal }
function rpcMock(
  respond: (call: Call) => unknown | Promise<unknown>,
  chain: (call: Call) => unknown = () => "0x13b2",
) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const { method, params } = JSON.parse(String(init?.body));
    expect(["eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt"]).toContain(method);
    expect(params).toEqual(method === "eth_chainId" ? [] : [TX_HASH]);
    expect(init?.redirect).toBe("error");
    const url = String(input);
    expect(["https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"]).toContain(url);
    const provider = url === "https://rpc.mainnet.arc.io" ? "primary" : "fallback";
    const attempt = calls.filter(call => call.provider === provider && call.method === method).length + 1;
    const call: Call = { provider, method, attempt, signal: init?.signal as AbortSignal };
    calls.push(call);
    const result = await (method === "eth_chainId" ? chain(call) : respond(call));
    return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id: 1, result });
  };
  return { fetchFn, calls };
}

const confirmed = (call: Call) => call.method === "eth_getTransactionByHash" ? TX : RECEIPT;
const pending = (call: Call) => call.method === "eth_getTransactionByHash" ? PENDING : null;
const rpcError = () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "https://private.invalid/?token=secret" } });

describe("bounded Arc Mainnet transaction lookup", () => {
  test("confirmed lookup preserves the transaction, execution status and receipt logs", async () => {
    const mock = rpcMock(confirmed);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toEqual({ ok: true, tx: TX, status: "success", logs: [] });
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.every(call => call.provider === "primary")).toBe(true);
  });

  test("a reverted transaction remains failed", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionByHash" ? TX : { ...RECEIPT, status: "0x0" });
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: true, status: "failed" });
  });

  test("falls back when the primary returns null", async () => {
    const mock = rpcMock(call => call.provider === "primary" ? null : confirmed(call));
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: true, status: "success" });
    expect(mock.calls).toHaveLength(6);
  });

  test("retries transient nulls even when both providers initially miss the transaction", async () => {
    const mock = rpcMock(call => call.attempt === 1 ? null : confirmed(call));
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: true, status: "success" });
    expect(mock.calls).toHaveLength(9);
  });

  test("recovers a transient missing receipt on the second round", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionByHash" ? TX : call.attempt === 1 ? null : RECEIPT);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: true, status: "success" });
    expect(mock.calls).toHaveLength(9);
  });

  test("can match a primary transaction with a fallback receipt", async () => {
    const mock = rpcMock(call => call.provider === "primary"
      ? call.method === "eth_getTransactionByHash" ? TX : null
      : call.method === "eth_getTransactionReceipt" ? RECEIPT : null);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: true, status: "success" });
  });

  test("returns retryable receipt unavailability for a mined transaction, never pending", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionByHash" ? TX : null);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503, code: "receipt_unavailable" });
    expect(mock.calls).toHaveLength(12);
  });

  test("receipt RPC errors do not turn mined transactions into pending transactions", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionByHash" ? TX : rpcError());
    const result = await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock });
    expect(result).toMatchObject({ ok: false, httpStatus: 503, code: "receipt_unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/secret|private\.invalid|-32000/);
  });

  test("returns pending only when both providers agree on an unmined transaction and absent receipt", async () => {
    const mock = rpcMock(pending);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toEqual({ ok: true, tx: PENDING, status: "pending", logs: [] });
  });

  test("does not infer pending from a receipt RPC error", async () => {
    const mock = rpcMock(call => call.provider === "primary" && call.method === "eth_getTransactionReceipt" ? rpcError() : pending(call));
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503 });
  });

  test("does not infer pending when one provider consistently cannot find the transaction", async () => {
    const mock = rpcMock(call => call.provider === "primary" ? pending(call) : null);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503 });
  });

  test("never demotes previously observed block inclusion to pending or not found", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionReceipt" ? null
      : call.provider === "primary" && call.attempt === 1 ? TX : PENDING);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503, code: "receipt_unavailable" });
  });

  test("404 requires valid null transaction AND receipt responses from both providers in both rounds", async () => {
    const mock = rpcMock(() => null);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toEqual({ ok: false, httpStatus: 404, error: `Transaction ${TX_HASH} not found on Arc Mainnet.` });
    expect(mock.calls).toHaveLength(12);
  });

  test("one failed read prevents a definitive 404", async () => {
    const mock = rpcMock(call => call.provider === "primary" && call.attempt === 1 ? rpcError() : null);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503 });
  });

  test("wrong-chain responses cannot establish not found", async () => {
    const mock = rpcMock(() => null, call => call.provider === "primary" ? "0x13b2" : "0x1");
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503 });
  });

  test("an orphan receipt cannot establish pending or not found", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionReceipt" ? RECEIPT : null);
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503 });
  });

  test("a transaction and receipt from different blocks are inconsistent", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionByHash" ? TX : { ...RECEIPT, blockHash: `0x${"ff".repeat(32)}` });
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503, code: "rpc_lookup_inconsistent" });
  });

  test("contradictory mined block assignments across providers are inconsistent", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionReceipt" ? null
      : call.provider === "primary" ? TX : { ...TX, blockNumber: "0x171b8cc" });
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503, code: "rpc_lookup_inconsistent" });
  });

  test("contradictory calldata across providers is inconsistent", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionReceipt" ? null
      : call.provider === "primary" ? TX : { ...TX, input: "0x1234" });
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503, code: "rpc_lookup_inconsistent" });
  });

  test("provider-specific receipt log decorations do not create a false conflict", async () => {
    const log = { address: TX.to, topics: [BLOCK_HASH], data: "0x" };
    const mock = rpcMock(call => {
      if (call.method === "eth_getTransactionByHash") return call.provider === "primary" ? null : TX;
      return { ...RECEIPT, logs: [call.provider === "primary" ? { ...log, blockTimestamp: "0x6ac25a4b" } : log] };
    });
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: true, status: "success" });
  });

  test("contradictory receipt statuses across providers are inconsistent", async () => {
    const mock = rpcMock(call => call.method === "eth_getTransactionByHash" ? null
      : { ...RECEIPT, status: call.provider === "primary" ? "0x1" : "0x0" });
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: false, httpStatus: 503, code: "rpc_lookup_inconsistent" });
  });

  for (const [name, bad] of [
    ["HTTP errors", () => new Response("private diagnostics", { status: 429 })],
    ["invalid JSON", () => new Response("not JSON")],
    ["missing result", () => Response.json({ jsonrpc: "2.0", id: 1 })],
    ["wrong response ID", () => Response.json({ jsonrpc: "2.0", id: 99, result: null })],
    ["RPC exceptions", () => { throw new Error("https://private.invalid/?token=secret"); }],
    ["wrong transaction hash", (call: Call) => call.method === "eth_getTransactionByHash" ? { ...TX, hash: `0x${"aa".repeat(32)}` } : null],
    ["invalid receipt status", (call: Call) => call.method === "eth_getTransactionReceipt" ? { ...RECEIPT, status: "0x2" } : TX],
    ["wrong receipt hash", (call: Call) => call.method === "eth_getTransactionReceipt" ? { ...RECEIPT, transactionHash: `0x${"aa".repeat(32)}` } : TX],
  ] as const) {
    test(`${name} remain retryable and do not expose provider diagnostics`, async () => {
      const mock = rpcMock(bad);
      const result = await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock });
      expect(result).toMatchObject({ ok: false, httpStatus: 503 });
      expect(JSON.stringify(result)).not.toMatch(/secret|private|429/);
    });
  }

  test("transport failure can recover on the fallback provider", async () => {
    const mock = rpcMock(call => {
      if (call.provider === "primary") throw new Error("Network unavailable");
      return confirmed(call);
    });
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock })).toMatchObject({ ok: true, status: "success" });
  });

  test("per-call timeouts cover stalled headers and abort outstanding reads", async () => {
    const mock = rpcMock(() => new Promise(() => {}));
    const start = performance.now();
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock, timeoutMs: 5 })).toMatchObject({ ok: false, httpStatus: 503 });
    expect(performance.now() - start).toBeLessThan(500);
    expect(mock.calls).toHaveLength(12);
    expect(mock.calls.every(call => call.signal.aborted)).toBe(true);
  });

  test("per-call timeouts cover stalled response bodies", async () => {
    const mock = rpcMock(() => {
      const response = new Response();
      response.json = () => new Promise(() => {});
      return response;
    });
    const start = performance.now();
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock, timeoutMs: 5 })).toMatchObject({ ok: false, httpStatus: 503 });
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("a shared request deadline prevents timeout multiplication across providers and retries", async () => {
    const mock = rpcMock(() => new Promise(() => {}));
    const start = performance.now();
    expect(await lookupArcTransaction(TX_HASH, { ...OPTIONS, ...mock, timeoutMs: 1_000, budgetMs: 20 })).toMatchObject({ ok: false, httpStatus: 503 });
    expect(performance.now() - start).toBeLessThan(500);
    expect(mock.calls.length).toBeLessThanOrEqual(6);
    expect(mock.calls.every(call => call.signal.aborted)).toBe(true);
  });
});
