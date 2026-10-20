import type { ReceiptLog } from "./abiEnrichment";

// Official Arc RPC reference: https://docs.arc.io/arc/references/rpc-endpoints
// dRPC was independently checked against chain 5042 and historical receipts.
const PROVIDERS = ["https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"] as const;
const RPC_TIMEOUT_MS = 1_200;
const LOOKUP_BUDGET_MS = 5_000;
const RETRY_DELAY_MS = 150;
const ROUNDS = 2;
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][\da-f]*)$/i;
const BYTES = /^0x(?:[\da-f]{2})*$/i;

export interface ArcTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  blockNumber: string | null;
  blockHash: string | null;
  transactionIndex: string | null;
}

interface ArcReceipt {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  status: "0x0" | "0x1";
  logs: ReceiptLog[];
}

type RpcResult = { ok: true; value: unknown } | { ok: false };
type LookupErrorCode = "receipt_unavailable" | "rpc_lookup_unavailable" | "rpc_lookup_inconsistent";
export type ArcLookupResult = {
  ok: true;
  tx: ArcTransaction;
  status: "success" | "failed" | "pending";
  logs: ReceiptLog[];
} | {
  ok: false;
  httpStatus: 404 | 503;
  error: string;
  code?: LookupErrorCode;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hex(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function transaction(value: unknown, hash: string): value is ArcTransaction {
  if (!object(value) || !hex(value.hash, HASH) || value.hash.toLowerCase() !== hash.toLowerCase()) return false;
  if (!hex(value.from, ADDRESS) || (value.to !== null && !hex(value.to, ADDRESS)) ||
      !hex(value.input, BYTES) || !hex(value.value, QUANTITY)) return false;
  if (value.chainId !== undefined && value.chainId !== "0x13b2") return false;
  if (value.blockNumber === null) return value.blockHash === null && value.transactionIndex === null;
  return hex(value.blockNumber, QUANTITY) && BigInt(value.blockNumber) <= BigInt(Number.MAX_SAFE_INTEGER) &&
    hex(value.blockHash, HASH) && hex(value.transactionIndex, QUANTITY);
}

function receipt(value: unknown, hash: string): value is ArcReceipt {
  return object(value) && hex(value.transactionHash, HASH) && value.transactionHash.toLowerCase() === hash.toLowerCase() &&
    hex(value.blockNumber, QUANTITY) && hex(value.blockHash, HASH) &&
    (value.status === "0x1" || value.status === "0x0") && Array.isArray(value.logs) &&
    value.logs.every(log => object(log) && hex(log.address, ADDRESS) && hex(log.data, BYTES) &&
      Array.isArray(log.topics) && log.topics.every(topic => hex(topic, HASH)) && log.removed !== true);
}

function sameBlock(a: { blockNumber: string | null; blockHash: string | null }, b: { blockNumber: string | null; blockHash: string | null }): boolean {
  return a.blockNumber?.toLowerCase() === b.blockNumber?.toLowerCase() &&
    a.blockHash?.toLowerCase() === b.blockHash?.toLowerCase();
}

function sameTransaction(a: ArcTransaction, b: ArcTransaction): boolean {
  return a.from.toLowerCase() === b.from.toLowerCase() && a.to?.toLowerCase() === b.to?.toLowerCase() &&
    a.input.toLowerCase() === b.input.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();
}

function sameReceipt(a: ArcReceipt, b: ArcReceipt): boolean {
  // Providers can decorate logs with different optional fields/key ordering.
  const content = (logs: ReceiptLog[]) => logs.map(log => [
    log.address.toLowerCase(), log.topics.map(topic => topic.toLowerCase()), log.data.toLowerCase(),
  ]);
  return sameBlock(a, b) && a.status === b.status && JSON.stringify(content(a.logs)) === JSON.stringify(content(b.logs));
}

function unavailable(code: LookupErrorCode): ArcLookupResult {
  const error = code === "receipt_unavailable"
    ? "Transaction is included in a block, but its execution receipt is temporarily unavailable. Retry this lookup."
    : "Arc Mainnet lookup is temporarily unavailable or inconsistent. Retry this lookup.";
  return { ok: false, httpStatus: 503, code, error };
}

async function rpc(
  url: string,
  method: string,
  params: string[],
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<RpcResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The race also bounds stalled response bodies and transports ignoring abort.
    return await Promise.race([
      (async (): Promise<RpcResult> => {
        const response = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) return { ok: false };
        const body: unknown = await response.json();
        if (!object(body) || body.jsonrpc !== "2.0" || body.id !== 1 || "error" in body || !("result" in body)) return { ok: false };
        return { ok: true, value: body.result };
      })(),
      new Promise<RpcResult>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ ok: false }); }, timeoutMs);
      }),
    ]);
  } catch {
    // Never forward provider errors, URLs, or credentials into API responses.
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

export async function lookupArcTransaction(
  hash: string,
  options: { fetchFn?: typeof fetch; timeoutMs?: number; budgetMs?: number; retryDelayMs?: number } = {},
): Promise<ArcLookupResult> {
  const deadline = performance.now() + (options.budgetMs ?? LOOKUP_BUDGET_MS);
  const fetchFn = options.fetchFn ?? fetch;
  let tx: ArcTransaction | null = null;
  let minedReceipt: ArcReceipt | null = null;
  let consistentlyAbsent = true;
  let completedAttempts = 0;
  const pendingProviders = new Set<string>();

  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) {
      const delay = Math.min(options.retryDelayMs ?? RETRY_DELAY_MS, Math.max(0, deadline - performance.now()));
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
    for (const url of PROVIDERS) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return unavailable(tx?.blockNumber ? "receipt_unavailable" : "rpc_lookup_unavailable");
      const timeout = Math.min(options.timeoutMs ?? RPC_TIMEOUT_MS, remaining);
      const [chain, txResult, receiptResult] = await Promise.all([
        rpc(url, "eth_chainId", [], timeout, fetchFn),
        rpc(url, "eth_getTransactionByHash", [hash], timeout, fetchFn),
        rpc(url, "eth_getTransactionReceipt", [hash], timeout, fetchFn),
      ]);
      completedAttempts++;
      pendingProviders.delete(url);
      if (!chain.ok || chain.value !== "0x13b2") { consistentlyAbsent = false; continue; }
      const validTx = txResult.ok && (txResult.value === null || transaction(txResult.value, hash));
      const validReceipt = receiptResult.ok && (receiptResult.value === null || receipt(receiptResult.value, hash));
      consistentlyAbsent &&= validTx && validReceipt && txResult.ok && txResult.value === null && receiptResult.ok && receiptResult.value === null;

      if (validTx && txResult.ok && txResult.value !== null) {
        const observed = txResult.value as ArcTransaction;
        if (tx && (!sameTransaction(tx, observed) || (tx.blockNumber !== null && observed.blockNumber !== null && !sameBlock(tx, observed)))) {
          return unavailable("rpc_lookup_inconsistent");
        }
        // Once observed mined, missing/pending responses cannot demote it.
        if (!tx || observed.blockNumber !== null) tx = observed;
        if (observed.blockNumber === null && validReceipt && receiptResult.ok && receiptResult.value === null) pendingProviders.add(url);
      }
      if (validReceipt && receiptResult.ok && receiptResult.value !== null) {
        const observed = receiptResult.value as ArcReceipt;
        if (minedReceipt && !sameReceipt(minedReceipt, observed)) return unavailable("rpc_lookup_inconsistent");
        minedReceipt = observed;
      }
      if (tx && tx.blockNumber !== null && minedReceipt) {
        if (!sameBlock(tx, minedReceipt)) return unavailable("rpc_lookup_inconsistent");
        return { ok: true, tx, status: minedReceipt.status === "0x1" ? "success" : "failed", logs: minedReceipt.logs };
      }
    }
  }
  if (tx && tx.blockNumber === null && !minedReceipt && pendingProviders.size === PROVIDERS.length) {
    return { ok: true, tx, status: "pending", logs: [] };
  }
  if (consistentlyAbsent && completedAttempts === PROVIDERS.length * ROUNDS) {
    return { ok: false, httpStatus: 404, error: `Transaction ${hash} not found on Arc Mainnet.` };
  }
  return unavailable(tx?.blockNumber && !minedReceipt ? "receipt_unavailable" : "rpc_lookup_unavailable");
}
