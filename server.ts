/**
 * TxLens – transaction intent & risk explanation API
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { analyzeWithEnrichment, type ReceiptLog } from "./src/server/abiEnrichment";
import {
  ARC_NETWORK,
  ARC_USDC,
  DIRECT_PRICE_ATOMIC,
  createDirectQuote,
  verifyDirectPayment,
  type DirectRoute,
} from "./src/server/directPayment";

function getArcRpcUrl(): string {
  const proxyBase = process.env.RPC_PROXY_BASE_URL;
  const proxyToken = process.env.RPC_PROXY_TOKEN;
  const proxyChains = (process.env.RPC_PROXY_CHAINS ?? "").split(",").map((s) => s.trim());
  if (proxyBase && proxyToken && proxyChains.includes("Arc_Mainnet")) {
    return `${proxyBase}/api/rpc/Arc_Mainnet?_rpc_token=${proxyToken}`;
  }
  return "https://rpc.mainnet.arc.io";
}

const ARC_MAINNET = {
  chainId: 5042,
  name: "Arc Mainnet",
  explorer: "https://explorer.arc.io",
};

const SELLER_ADDRESS = process.env.SELLER_WALLET_ADDRESS ?? "";
const DIRECT_PAYMENT_SECRET = process.env.DIRECT_PAYMENT_SECRET ?? "";
const SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve(address,uint256)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0xf2fde38b": "transferOwnership(address)",
  "0x8da5cb5b": "owner()",
  "0x42966c68": "burn(uint256)",
  "0x40c10f19": "mint(address,uint256)",
  "0x70a08231": "balanceOf(address)",
  "0x313ce567": "decimals()",
  "0x06fdde03": "name()",
  "0xe985e9c5": "isApprovedForAll(address,address)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
};

const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

type RiskLevel = "low" | "medium" | "high" | "unknown";

interface Warning {
  type: string;
  severity: "low" | "medium" | "high";
  message: string;
}

interface AnalysisResult {
  action: string;
  summary: string;
  risk: RiskLevel;
  confidence: number;
  warnings: Warning[];
  decoded: Record<string, unknown>;
}

interface AnalyzeRequest {
  chainId: number;
  to: string;
  data?: string;
  value?: string;
}

interface EthTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  blockNumber: string | null;
  transactionIndex: string | null;
  gas: string;
  gasPrice: string;
  nonce: string;
}

function hexToAddress(hex: string): string {
  const stripped = hex.replace(/^0x/, "");
  return "0x" + stripped.slice(-40);
}

function hexToBigInt(hex: string): bigint {
  const stripped = hex.replace(/^0x/, "");
  if (!stripped) return 0n;
  return BigInt("0x" + stripped);
}

function decodeApprove(calldata: string) {
  const data = calldata.replace(/^0x/, "");
  if (data.length < 136) return null;
  return { spender: hexToAddress(data.slice(8, 72)), amount: hexToBigInt("0x" + data.slice(72, 136)) };
}

function decodeSetApprovalForAll(calldata: string) {
  const data = calldata.replace(/^0x/, "");
  if (data.length < 136) return null;
  return { operator: hexToAddress(data.slice(8, 72)), approved: hexToBigInt("0x" + data.slice(72, 136)) !== 0n };
}

function decodeTransfer(calldata: string) {
  const data = calldata.replace(/^0x/, "");
  if (data.length < 136) return null;
  return { to: hexToAddress(data.slice(8, 72)), amount: hexToBigInt("0x" + data.slice(72, 136)) };
}

function decodeTransferOwnership(calldata: string) {
  const data = calldata.replace(/^0x/, "");
  if (data.length < 72) return null;
  return { newOwner: hexToAddress(data.slice(8, 72)) };
}

function formatBigIntHuman(val: bigint): string {
  if (val === BigInt(MAX_UINT256)) return "unlimited (max uint256)";
  return val.toString();
}

function malformedResult(fn: string): AnalysisResult {
  return {
    action: "malformed_calldata",
    summary: `The calldata appears to target \`${fn}\` but the arguments could not be decoded — the data may be truncated or malformed.`,
    risk: "unknown",
    confidence: 0.4,
    warnings: [{ type: "malformed_calldata", severity: "medium", message: "Calldata selector matched a known function but argument decoding failed. The data may be incomplete." }],
    decoded: {},
  };
}

function analyze(req: AnalyzeRequest): AnalysisResult {
  const data = (req.data ?? "").trim();
  const value = BigInt(req.value ?? "0");
  const warnings: Warning[] = [];
  let decoded: Record<string, unknown> = {};

  if ((!data || data === "0x" || data === "0x0") && value > 0n) {
    return {
      action: "native_transfer",
      summary: `Sends ${value.toString()} wei of native currency to ${req.to}.`,
      risk: "low", confidence: 0.99, warnings: [],
      decoded: { to: req.to, amount: value.toString() },
    };
  }

  if (!data || data === "0x" || data === "0x0") {
    return {
      action: "empty_transaction",
      summary: "This transaction sends no value and carries no calldata. It may trigger a receive() or fallback() function on the target contract.",
      risk: "low", confidence: 0.9, warnings: [], decoded: {},
    };
  }

  const cleanData = data.replace(/^0x/, "");

  if (cleanData.length < 8) {
    return {
      action: "unknown",
      summary: "The calldata is too short to identify a function call. The transaction content is undecodable.",
      risk: "unknown", confidence: 0.5,
      warnings: [{ type: "undecodable_calldata", severity: "high", message: "Calldata is too short to contain a 4-byte selector. This is unusual and may indicate malformed input." }],
      decoded: {},
    };
  }

  const selector = "0x" + cleanData.slice(0, 8).toLowerCase();
  const knownSignature = SELECTORS[selector];

  if (selector === "0x095ea7b3") {
    const dec = decodeApprove(data);
    if (!dec) return malformedResult("approve(address,uint256)");
    const isUnlimited = dec.amount.toString() === MAX_UINT256;
    decoded = { spender: dec.spender, amount: formatBigIntHuman(dec.amount), isUnlimited };
    if (isUnlimited) {
      warnings.push({ type: "unlimited_approval", severity: "high", message: "Unlimited token spending permission detected. The approved address can spend all tokens of this type from your wallet at any time." });
    } else if (dec.amount > 10n ** 30n) {
      warnings.push({ type: "very_large_approval", severity: "medium", message: "A very large token approval is being granted. Verify this amount is expected." });
    }
    const risk: RiskLevel = isUnlimited ? "high" : dec.amount > 10n ** 30n ? "medium" : "low";
    const summary = isUnlimited
      ? `This transaction grants unlimited permission for ${dec.spender} to spend your ERC-20 tokens. The spender can withdraw any amount at any future time. Review whether this contract is trusted.`
      : `This transaction approves ${dec.spender} to spend ${formatBigIntHuman(dec.amount)} of your ERC-20 tokens. Only grant approvals to contracts you trust.`;
    return { action: "token_approval", summary, risk, confidence: 0.98, warnings, decoded };
  }

  if (selector === "0xa22cb465") {
    const dec = decodeSetApprovalForAll(data);
    if (!dec) return malformedResult("setApprovalForAll(address,bool)");
    decoded = { operator: dec.operator, approved: dec.approved };
    if (dec.approved) {
      warnings.push({ type: "approval_for_all", severity: "high", message: `Full operator approval granted to ${dec.operator}. This address can transfer any of your NFTs or tokens managed by this contract.` });
    }
    return {
      action: "set_approval_for_all",
      summary: dec.approved
        ? `This transaction gives ${dec.operator} permission to manage all of your NFTs or tokens on this contract.`
        : `This transaction revokes the operator approval for ${dec.operator} on this contract.`,
      risk: dec.approved ? "high" : "low", confidence: 0.97, warnings, decoded,
    };
  }

  if (selector === "0xa9059cbb") {
    const dec = decodeTransfer(data);
    if (!dec) return malformedResult("transfer(address,uint256)");
    decoded = { to: dec.to, amount: dec.amount.toString() };
    return { action: "token_transfer", summary: `Transfers ${dec.amount.toString()} token units to ${dec.to}. This sends tokens directly from the caller's balance.`, risk: "low", confidence: 0.97, warnings: [], decoded };
  }

  if (selector === "0x23b872dd") {
    if (cleanData.length < 200) return malformedResult("transferFrom(address,address,uint256)");
    const from = hexToAddress(cleanData.slice(8, 72));
    const to = hexToAddress(cleanData.slice(72, 136));
    const amount = hexToBigInt("0x" + cleanData.slice(136, 200));
    decoded = { from, to, amount: amount.toString() };
    return { action: "token_transfer_from", summary: `Moves ${amount.toString()} token units from ${from} to ${to} using a prior approval.`, risk: "low", confidence: 0.95, warnings: [], decoded };
  }

  if (selector === "0xf2fde38b") {
    const dec = decodeTransferOwnership(data);
    if (!dec) return malformedResult("transferOwnership(address)");
    decoded = { newOwner: dec.newOwner };
    warnings.push({ type: "ownership_transfer", severity: "high", message: `Contract ownership is being transferred to ${dec.newOwner}. The new owner gains full administrative control over the contract.` });
    return { action: "ownership_transfer", summary: `This transaction transfers administrative ownership of the contract at ${req.to} to ${dec.newOwner}.`, risk: "high", confidence: 0.96, warnings, decoded };
  }

  if (selector === "0x42842e0e" || selector === "0xb88d4fde") {
    if (cleanData.length < 200) return malformedResult(SELECTORS[selector] ?? "safeTransferFrom");
    const from = hexToAddress(cleanData.slice(8, 72));
    const to = hexToAddress(cleanData.slice(72, 136));
    const tokenId = hexToBigInt("0x" + cleanData.slice(136, 200));
    decoded = { from, to, tokenId: tokenId.toString() };
    return { action: "nft_transfer", summary: `Transfers NFT token ID ${tokenId.toString()} from ${from} to ${to}.`, risk: "low", confidence: 0.93, warnings: [], decoded };
  }

  if (knownSignature) {
    return {
      action: "known_function_call",
      summary: `This transaction calls the function ${knownSignature} on ${req.to}. The arguments could not be fully decoded.`,
      risk: "unknown", confidence: 0.7,
      warnings: [{ type: "partial_decode", severity: "low", message: `Function identified as ${knownSignature} but arguments were not fully decoded.` }],
      decoded: { selector, signature: knownSignature },
    };
  }

  return {
    action: "unknown_function_call",
    summary: `This transaction calls an unrecognized function (selector ${selector}) on ${req.to}. Without knowing the contract ABI, the exact behavior cannot be determined.`,
    risk: "unknown", confidence: 0.3,
    warnings: [{ type: "unknown_calldata", severity: "medium", message: `The 4-byte selector ${selector} is not recognized. Review the contract ABI before signing.` }],
    decoded: { selector },
  };
}

async function fetchArcTransaction(
  txHash: string
): Promise<{ ok: true; tx: EthTransaction } | { ok: false; error: string }> {
  let resp: Response;
  try {
    resp = await fetch(getArcRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txHash] }),
    });
  } catch (err) {
    return { ok: false, error: `RPC request failed: ${String(err)}` };
  }

  if (!resp.ok) return { ok: false, error: `RPC HTTP error ${resp.status}` };

  interface JsonRpcResponse { result: EthTransaction | null; error?: { message: string }; }
  let body: JsonRpcResponse;
  try {
    body = (await resp.json()) as JsonRpcResponse;
  } catch {
    return { ok: false, error: "Invalid JSON from RPC endpoint." };
  }

  if (body.error) return { ok: false, error: `RPC error: ${body.error.message}` };
  if (!body.result) return { ok: false, error: `Transaction ${txHash} not found on Arc Mainnet.` };
  return { ok: true, tx: body.result };
}

async function fetchTransactionReceipt(txHash: string): Promise<{
  status: "success" | "failed" | "pending" | "unknown";
  logs: ReceiptLog[];
}> {
  try {
    const resp = await fetch(getArcRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [txHash] }),
    });
    if (!resp.ok) return { status: "unknown", logs: [] };
    interface ReceiptResponse { result: { status: string; logs?: ReceiptLog[] } | null; error?: { message: string }; }
    const body = (await resp.json()) as ReceiptResponse;
    if (body.error || !body.result) return { status: "pending", logs: [] };
    return {
      status: body.result.status === "0x1" ? "success" : "failed",
      logs: Array.isArray(body.result.logs) ? body.result.logs : [],
    };
  } catch {
    return { status: "unknown", logs: [] };
  }
}

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Payment-Required, Payment-Signature, Payment-Response");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Payment-Required, Payment-Signature, Payment-Response, X-TxLens-Payment-Quote, X-TxLens-Payment-Tx");
  next();
});
app.options("/{*path}", (_req, res) => { res.sendStatus(204); });

if (!/^0x[a-fA-F0-9]{40}$/.test(SELLER_ADDRESS)) {
  throw new Error("SELLER_WALLET_ADDRESS must be a valid EVM address.");
}
if (DIRECT_PAYMENT_SECRET.length < 32) {
  throw new Error("DIRECT_PAYMENT_SECRET must be set to a strong secret (32+ chars).");
}

async function arcRpcCall(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(getArcRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 31, method, params }),
  });
  if (!response.ok) throw new Error(`Arc RPC HTTP error ${response.status}`);
  return response.json();
}

async function requireDirectPayment(req: express.Request, res: express.Response, route: DirectRoute): Promise<boolean> {
  const quote = req.header("x-txlens-payment-quote");
  const txHash = req.header("x-txlens-payment-tx");
  if (!quote || !txHash) {
    res.status(402).json({
      error: "Direct USDC payment required",
      paymentMode: "direct",
      quoteEndpoint: "/api/direct/quote",
      network: ARC_NETWORK,
      asset: ARC_USDC,
      amount: DIRECT_PRICE_ATOMIC[route],
      payTo: SELLER_ADDRESS,
    });
    return false;
  }
  let verification;
  try {
    verification = await verifyDirectPayment({
      route,
      body: req.body,
      quoteToken: quote,
      txHash,
      sellerAddress: SELLER_ADDRESS as `0x${string}`,
      secret: DIRECT_PAYMENT_SECRET,
      rpcCall: arcRpcCall,
    });
  } catch (error) {
    console.error("[TxLens] direct payment verification RPC error:", error);
    res.status(503).json({ error: "Could not verify direct payment on Arc. Retry this same paid request." });
    return false;
  }
  if (!verification.ok) {
    res.status(402).json({ error: verification.error, paymentMode: "direct" });
    return false;
  }
  return true;
}

app.post("/api/direct/quote", (req, res) => {
  const route = req.body?.route as DirectRoute;
  const payer = String(req.body?.payer ?? "");
  const body = req.body?.body;
  if ((route !== "analyze" && route !== "lookup") || !/^0x[a-fA-F0-9]{40}$/.test(payer) || !body) {
    res.status(400).json({ error: "Invalid direct payment quote request." });
    return;
  }
  res.json(createDirectQuote({
    route,
    payer: payer as `0x${string}`,
    body,
    sellerAddress: SELLER_ADDRESS as `0x${string}`,
    secret: DIRECT_PAYMENT_SECRET,
  }));
});

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS as `0x${string}`,
  networks: ARC_NETWORK,
});

app.post("/api/analyze", async (req, res) => {
  if (!(await requireDirectPayment(req, res, "analyze"))) return;
  if (Number(req.body?.chainId) !== ARC_MAINNET.chainId) {
    res.status(400).json({ error: "TxLens production supports Arc Mainnet only (chain ID 5042)." });
    return;
  }
  const body = req.body as AnalyzeRequest;
  if (!body.to || typeof body.to !== "string") {
    res.status(400).json({ error: "Missing required field: to" });
    return;
  }
  try {
    res.json(await analyzeWithEnrichment(body));
  } catch (err) {
    console.error("[TxLens] analyze error:", err);
    res.status(500).json({ error: "Internal analysis error", detail: String(err) });
  }
});

app.post("/api/lookup-tx", async (req, res) => {
  if (!(await requireDirectPayment(req, res, "lookup"))) return;
  const body = req.body as { txHash: string; chainId: number };
  const { txHash, chainId } = body;

  if (!txHash || typeof txHash !== "string") {
    res.status(400).json({ error: "Missing required field: txHash" });
    return;
  }
  if (!chainId || typeof chainId !== "number") {
    res.status(400).json({ error: "Missing required field: chainId (number)" });
    return;
  }
  if (chainId !== ARC_MAINNET.chainId) {
    res.status(400).json({ error: `Chain ID ${chainId} is not supported. Supported: 5042 (Arc Mainnet).` });
    return;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    res.status(400).json({ error: "Invalid transaction hash format. Expected 0x followed by 64 hex characters." });
    return;
  }

  const fetchResult = await fetchArcTransaction(txHash);
  if (!fetchResult.ok) {
    res.status(404).json({ error: fetchResult.error });
    return;
  }

  const { tx } = fetchResult;
  const receipt = await fetchTransactionReceipt(txHash);

  let valueDecimal = "0";
  try { valueDecimal = hexToBigInt(tx.value).toString(); } catch { valueDecimal = "0"; }

  const analysis = await analyzeWithEnrichment({
    chainId,
    to: tx.to ?? "0x0000000000000000000000000000000000000000",
    data: tx.input,
    value: valueDecimal
  }, { logs: receipt.logs });

  res.json({
    transaction: {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: valueDecimal,
      valueHex: tx.value,
      input: tx.input,
      status: receipt.status,
      blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
      network: ARC_MAINNET.name,
      explorerUrl: `${ARC_MAINNET.explorer}/tx/${tx.hash}`,
    },
    ...analysis,
  });
});


app.post("/api/analyze/gateway", gateway.require("$0.002"), async (req, res) => {
  const body = req.body as AnalyzeRequest;
  if (Number(body?.chainId) !== ARC_MAINNET.chainId) {
    res.status(400).json({ error: "TxLens production supports Arc Mainnet only (chain ID 5042)." });
    return;
  }
  if (!body.to || typeof body.to !== "string") {
    res.status(400).json({ error: "Missing required field: to" });
    return;
  }
  try { res.json(await analyzeWithEnrichment(body)); }
  catch (err) { res.status(500).json({ error: "Internal analysis error", detail: String(err) }); }
});

app.post("/api/lookup-tx/gateway", gateway.require("$0.003"), async (req, res) => {
  const body = req.body as { txHash: string; chainId: number };
  const { txHash, chainId } = body;
  if (!txHash || typeof txHash !== "string" || chainId !== ARC_MAINNET.chainId || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    res.status(400).json({ error: "Invalid Arc Mainnet transaction lookup request." });
    return;
  }
  const fetchResult = await fetchArcTransaction(txHash);
  if (!fetchResult.ok) { res.status(404).json({ error: fetchResult.error }); return; }
  const { tx } = fetchResult;
  const receipt = await fetchTransactionReceipt(txHash);
  let valueDecimal = "0";
  try { valueDecimal = hexToBigInt(tx.value).toString(); } catch {}
  const analysis = await analyzeWithEnrichment({
    chainId,
    to: tx.to ?? "0x0000000000000000000000000000000000000000",
    data: tx.input,
    value: valueDecimal,
  }, { logs: receipt.logs });
  res.json({
    transaction: {
      hash: tx.hash, from: tx.from, to: tx.to, value: valueDecimal, valueHex: tx.value,
      input: tx.input, status: receipt.status,
      blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
      network: ARC_MAINNET.name,
      explorerUrl: `${ARC_MAINNET.explorer}/tx/${tx.hash}`,
    },
    ...analysis,
  });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, "dist");

app.use(express.static(DIST_DIR));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "txlens-api", chain: "Arc Mainnet", chainId: ARC_MAINNET.chainId });
});

app.get("/{*path}", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/health") return next();
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[TxLens] server listening on 0.0.0.0:${PORT}`);
});
