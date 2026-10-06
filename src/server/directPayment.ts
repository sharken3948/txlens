import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeFunctionData, keccak256, stringToHex } from "viem";
import { ARC_CHAIN_ID, ARC_USDC, USDC_AUTH_ABI_VRS } from "../payments/direct";

export { ARC_CHAIN_ID, ARC_USDC };
export const ARC_NETWORK = "eip155:5042";
export const DIRECT_PRICE_ATOMIC = { analyze: "2000", lookup: "3000" } as const;
export const QUOTE_TTL_SECONDS = 300;

export const USDC_AUTH_ABI = [
  ...USDC_AUTH_ABI_VRS,
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export type DirectRoute = keyof typeof DIRECT_PRICE_ATOMIC;

export type DirectQuotePayload = {
  route: DirectRoute;
  bodyHash: `0x${string}`;
  payer: `0x${string}`;
  amount: string;
  nonce: `0x${string}`;
  validAfter: string;
  validBefore: string;
};

export type DirectQuote = DirectQuotePayload & {
  token: string;
  network: typeof ARC_NETWORK;
  asset: typeof ARC_USDC;
  payTo: `0x${string}`;
};

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

type RpcTransaction = {
  to?: string | null;
  input?: string;
  blockNumber?: string | null;
};

type RpcReceipt = {
  status?: string;
  blockNumber?: string | null;
};

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Request body contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) result[key] = canonicalize(item);
    }
    return result;
  }
  throw new Error("Request body contains a value that cannot be represented as JSON.");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value ?? {}));
}

export function stableBodyHash(body: unknown): `0x${string}` {
  return keccak256(stringToHex(canonicalJson(body)));
}

export function signQuote(payload: DirectQuotePayload, secret: string): string {
  const raw = Buffer.from(canonicalJson(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(raw).digest("base64url");
  return `${raw}.${signature}`;
}

function isHex(value: unknown, bytes: number): value is `0x${string}` {
  return typeof value === "string" && new RegExp(`^0x[a-fA-F0-9]{${bytes * 2}}$`).test(value);
}

export function verifyQuoteToken(token: string, secret: string): DirectQuotePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [raw, signature] = parts;
  if (!raw || !signature) return null;

  const expected = createHmac("sha256", secret).update(raw).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<DirectQuotePayload>;
    if (payload.route !== "analyze" && payload.route !== "lookup") return null;
    if (!isHex(payload.bodyHash, 32) || !isHex(payload.payer, 20) || !isHex(payload.nonce, 32)) return null;
    if (payload.amount !== DIRECT_PRICE_ATOMIC[payload.route]) return null;
    if (!/^\d+$/.test(payload.validAfter ?? "") || !/^\d+$/.test(payload.validBefore ?? "")) return null;
    if (BigInt(payload.validAfter!) >= BigInt(payload.validBefore!)) return null;
    return payload as DirectQuotePayload;
  } catch {
    return null;
  }
}

export function createDirectQuote({
  route,
  payer,
  body,
  sellerAddress,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
}: {
  route: DirectRoute;
  payer: `0x${string}`;
  body: unknown;
  sellerAddress: `0x${string}`;
  secret: string;
  nowSeconds?: number;
  nonce?: `0x${string}`;
}): DirectQuote {
  const payload: DirectQuotePayload = {
    route,
    bodyHash: stableBodyHash(body),
    payer,
    amount: DIRECT_PRICE_ATOMIC[route],
    nonce,
    validAfter: "0",
    validBefore: String(nowSeconds + QUOTE_TTL_SECONDS),
  };
  return {
    token: signQuote(payload, secret),
    network: ARC_NETWORK,
    asset: ARC_USDC,
    payTo: sellerAddress,
    ...payload,
  };
}

function rpcResult<T>(response: unknown): T | null {
  if (!response || typeof response !== "object") return null;
  const record = response as { result?: T | null; error?: unknown };
  if (record.error || record.result == null) return null;
  return record.result;
}

export async function verifyDirectPayment({
  route,
  body,
  quoteToken,
  txHash,
  sellerAddress,
  secret,
  rpcCall,
}: {
  route: DirectRoute;
  body: unknown;
  quoteToken: string;
  txHash: string;
  sellerAddress: `0x${string}`;
  secret: string;
  rpcCall: RpcCall;
}): Promise<{ ok: true; payer: string; txHash: string } | { ok: false; error: string }> {
  const quote = verifyQuoteToken(quoteToken, secret);
  if (!quote) return { ok: false, error: "Invalid direct payment quote." };
  if (quote.route !== route || quote.bodyHash !== stableBodyHash(body)) {
    return { ok: false, error: "Direct payment quote does not match this request." };
  }
  if (!isHex(txHash, 32)) return { ok: false, error: "Invalid payment transaction hash." };

  const [txResponse, receiptResponse] = await Promise.all([
    rpcCall("eth_getTransactionByHash", [txHash]),
    rpcCall("eth_getTransactionReceipt", [txHash]),
  ]);
  const tx = rpcResult<RpcTransaction>(txResponse);
  const receipt = rpcResult<RpcReceipt>(receiptResponse);
  if (!tx || !receipt) return { ok: false, error: "Direct payment transaction is missing." };
  if (receipt.status !== "0x1") return { ok: false, error: "Direct payment transaction failed." };
  if ((tx.to ?? "").toLowerCase() !== ARC_USDC.toLowerCase()) {
    return { ok: false, error: "Direct payment did not call Arc USDC." };
  }
  if (!tx.input || !isHex(tx.input.slice(0, 10), 4)) {
    return { ok: false, error: "Could not decode direct USDC authorization." };
  }

  let authorization: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: USDC_AUTH_ABI, data: tx.input as `0x${string}` });
    if (decoded.functionName !== "transferWithAuthorization") throw new Error("wrong function");
    authorization = decoded.args;
  } catch {
    return { ok: false, error: "Could not decode direct USDC authorization." };
  }
  const [from, to, value, validAfter, validBefore, nonce] = authorization;
  if (String(from).toLowerCase() !== quote.payer.toLowerCase()) {
    return { ok: false, error: "Direct payment payer mismatch." };
  }
  if (String(to).toLowerCase() !== sellerAddress.toLowerCase()) {
    return { ok: false, error: "Direct payment recipient mismatch." };
  }
  if (String(value) !== quote.amount) return { ok: false, error: "Direct payment amount mismatch." };
  if (String(validAfter) !== quote.validAfter || String(validBefore) !== quote.validBefore) {
    return { ok: false, error: "Direct payment authorization window mismatch." };
  }
  if (String(nonce).toLowerCase() !== quote.nonce.toLowerCase()) {
    return { ok: false, error: "Direct payment nonce mismatch." };
  }

  const blockNumber = receipt.blockNumber ?? tx.blockNumber;
  if (!blockNumber) return { ok: false, error: "Direct payment block is missing." };
  const blockResponse = await rpcCall("eth_getBlockByNumber", [blockNumber, false]);
  const block = rpcResult<{ timestamp?: string }>(blockResponse);
  if (!block?.timestamp) return { ok: false, error: "Could not verify direct payment block time." };
  const blockTime = BigInt(block.timestamp);
  if (blockTime <= BigInt(quote.validAfter) || blockTime >= BigInt(quote.validBefore)) {
    return { ok: false, error: "Direct payment authorization was not valid when mined." };
  }
  return { ok: true, payer: quote.payer, txHash };
}
