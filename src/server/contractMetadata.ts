import { toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from "viem";

export const ARC_MEMO_ADDRESS = "0x5294e9927c3306dcbadb03fe70b92e01ccede505" as const;
export const ARC_NATIVE_USDC = "0x3600000000000000000000000000000000000000" as const;

const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const ARC_CHAIN_ID = "5042";
const MAX_EXPLORER_RESPONSE_BYTES = 512_000;
const MAX_ABI_ENTRIES = 1_000;
const SUCCESS_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 256;

export type MetadataTrust = "verified_contract_abi" | "arc_system_contract_abi";

export interface ContractMetadata {
  address: `0x${string}`;
  abi: Abi;
  contractName?: string;
  trust: MetadataTrust;
  sourceUrl?: string;
  isProxy?: boolean;
  implementation?: `0x${string}`;
}

export interface ContractMetadataProvider {
  getContractMetadata(address: `0x${string}`, signal?: AbortSignal): Promise<ContractMetadata | null>;
}

// Circle arc-node commit 6e76402; its Memo runtime artifact matches the code deployed at this fixed Arc address.
const MEMO_ABI = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "memoIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "BeforeMemo",
    anonymous: false,
    inputs: [{ name: "memoIndex", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "Memo",
    anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "callDataHash", type: "bytes32", indexed: false },
      { name: "memoId", type: "bytes32", indexed: true },
      { name: "memo", type: "bytes", indexed: false },
      { name: "memoIndex", type: "uint256", indexed: false },
    ],
  },
  {
    type: "error",
    name: "MemoFailed",
    inputs: [{ name: "returnData", type: "bytes" }],
  },
] as const satisfies Abi;

const USDC_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

const SYSTEM_CONTRACTS = new Map<string, ContractMetadata>([
  [ARC_MEMO_ADDRESS, {
    address: ARC_MEMO_ADDRESS,
    abi: MEMO_ABI,
    contractName: "Memo",
    trust: "arc_system_contract_abi",
    sourceUrl: "https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/contracts/src/memo/IMemo.sol",
  }],
  [ARC_NATIVE_USDC, {
    address: ARC_NATIVE_USDC,
    abi: USDC_EVENT_ABI,
    contractName: "USDC",
    trust: "arc_system_contract_abi",
    sourceUrl: "https://github.com/circlefin/stablecoin-evm",
  }],
]);

export function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbiParameter(value: unknown, depth = 0): boolean {
  if (depth > 5 || !isPlainObject(value)) return false;
  if (typeof value.type !== "string" || value.type.length < 1 || value.type.length > 256) return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.indexed !== undefined && typeof value.indexed !== "boolean") return false;
  if (value.components !== undefined) {
    if (!Array.isArray(value.components) || value.components.length > 100) return false;
    if (!value.components.every((component) => isAbiParameter(component, depth + 1))) return false;
  }
  return true;
}

export function parseAndValidateAbi(value: unknown): Abi | null {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > MAX_EXPLORER_RESPONSE_BYTES) return null;
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ABI_ENTRIES) return null;
  for (const entry of parsed) {
    if (!isPlainObject(entry) || typeof entry.type !== "string") return null;
    if (!new Set(["constructor", "error", "event", "fallback", "function", "receive"]).has(entry.type)) return null;
    if (["error", "event", "function"].includes(entry.type)) {
      if (typeof entry.name !== "string" || entry.name.length < 1 || entry.name.length > 256) return null;
      if (!Array.isArray(entry.inputs)) return null;
    }
    if (entry.inputs !== undefined && (!Array.isArray(entry.inputs) || !entry.inputs.every((input) => isAbiParameter(input)))) return null;
    if (entry.outputs !== undefined && (!Array.isArray(entry.outputs) || !entry.outputs.every((output) => isAbiParameter(output)))) return null;
    if (entry.anonymous !== undefined && typeof entry.anonymous !== "boolean") return null;
    if (entry.stateMutability !== undefined && typeof entry.stateMutability !== "string") return null;
    try {
      if (entry.type === "function") toFunctionSelector(entry as unknown as AbiFunction);
      if (entry.type === "event") toEventSelector(entry as unknown as AbiEvent);
    } catch {
      return null;
    }
  }
  return parsed as Abi;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_EXPLORER_RESPONSE_BYTES) throw new Error("Explorer response too large.");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_EXPLORER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Explorer response too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export class ArcSystemContractMetadataProvider implements ContractMetadataProvider {
  async getContractMetadata(address: `0x${string}`): Promise<ContractMetadata | null> {
    return SYSTEM_CONTRACTS.get(address.toLowerCase()) ?? null;
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type CacheEntry = { expiresAt: number; value: ContractMetadata | null };

export class EtherscanArcMetadataProvider implements ContractMetadataProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: {
    apiKey?: string;
    apiUrl?: string;
    fetchFn?: FetchLike;
    timeoutMs?: number;
    now?: () => number;
  } = {}) {}

  async getContractMetadata(address: `0x${string}`, outerSignal?: AbortSignal): Promise<ContractMetadata | null> {
    if (!isAddress(address) || !this.options.apiKey) return null;
    const key = address.toLowerCase();
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    const controller = new AbortController();
    const abort = () => controller.abort();
    outerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.options.timeoutMs ?? 2_500);

    let value: ContractMetadata | null = null;
    try {
      const url = new URL(this.options.apiUrl ?? ETHERSCAN_API_URL);
      url.searchParams.set("chainid", ARC_CHAIN_ID);
      url.searchParams.set("module", "contract");
      url.searchParams.set("action", "getsourcecode");
      url.searchParams.set("address", address);
      url.searchParams.set("apikey", this.options.apiKey);
      const response = await (this.options.fetchFn ?? fetch)(url, {
        headers: { Accept: "application/json", "User-Agent": "TxLens/1.0" },
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (!response.ok || contentLength > MAX_EXPLORER_RESPONSE_BYTES) throw new Error("Explorer response rejected.");
      const text = await readBoundedText(response);
      const payload = JSON.parse(text) as { status?: string; result?: unknown };
      if (payload.status !== "1" || !Array.isArray(payload.result) || payload.result.length !== 1) throw new Error("Contract is not verified.");
      const record = payload.result[0];
      if (!isPlainObject(record)) throw new Error("Malformed explorer metadata.");
      const sourceCode = typeof record.SourceCode === "string" ? record.SourceCode.trim() : "";
      const abi = parseAndValidateAbi(record.ABI);
      if (!sourceCode || !abi) throw new Error("Contract is not verified.");
      const implementation = isAddress(record.Implementation) ? record.Implementation : undefined;
      value = {
        address: address.toLowerCase() as `0x${string}`,
        abi,
        contractName: typeof record.ContractName === "string" && record.ContractName.length <= 256
          ? record.ContractName
          : undefined,
        trust: "verified_contract_abi",
        sourceUrl: `https://arc.etherscan.io/address/${address}#code`,
        isProxy: record.Proxy === "1" && Boolean(implementation),
        implementation,
      };
    } catch {
      value = null;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", abort);
    }

    this.setCache(key, value, now);
    return value;
  }

  private setCache(key: string, value: ContractMetadata | null, now: number): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      value,
      expiresAt: now + (value ? SUCCESS_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
    });
  }
}

export class CompositeContractMetadataProvider implements ContractMetadataProvider {
  constructor(private readonly providers: ContractMetadataProvider[]) {}

  async getContractMetadata(address: `0x${string}`, signal?: AbortSignal): Promise<ContractMetadata | null> {
    for (const provider of this.providers) {
      if (signal?.aborted) return null;
      const result = await provider.getContractMetadata(address, signal);
      if (result) return result;
    }
    return null;
  }
}

export function createProductionMetadataProvider(): ContractMetadataProvider {
  return new CompositeContractMetadataProvider([
    new ArcSystemContractMetadataProvider(),
    new EtherscanArcMetadataProvider({ apiKey: process.env.ETHERSCAN_API_KEY }),
  ]);
}
