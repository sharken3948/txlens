import {
  decodeEventLog,
  decodeFunctionData,
  toEventSelector,
  toEventSignature,
  toFunctionSelector,
  toFunctionSignature,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Hex,
} from "viem";
import {
  analyzeDeterministically,
  type AnalysisResult,
  type AnalyzeRequest,
  type DecodedEvent,
  type EnrichmentInfo,
} from "./analyzer";
import {
  createProductionMetadataProvider,
  isAddress,
  parseAndValidateAbi,
  type ContractMetadata,
  type ContractMetadataProvider,
} from "./contractMetadata";

const ENRICHMENT_TIMEOUT_MS = 3_000;
const MAX_LOGS = 100;
const MAX_LOG_CONTRACTS = 6;
const MAX_SERIALIZED_ARRAY_ITEMS = 100;
const MAX_SERIALIZED_OBJECT_KEYS = 100;
const MAX_SERIALIZED_STRING_LENGTH = 4_096;
const productionMetadataProvider = createProductionMetadataProvider();

export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

interface ResolvedAbi {
  abi: Abi;
  metadata: ContractMetadata;
  contract: `0x${string}`;
  implementation: `0x${string}` | null;
  source: string;
}

function trustedMetadata(metadata: ContractMetadata | null, expectedAddress: `0x${string}`): ContractMetadata | null {
  if (!metadata || metadata.address.toLowerCase() !== expectedAddress.toLowerCase()) return null;
  if (metadata.trust !== "verified_contract_abi" && metadata.trust !== "arc_system_contract_abi") return null;
  const abi = parseAndValidateAbi(metadata.abi);
  return abi ? { ...metadata, abi } : null;
}

export async function resolveContractAbis(
  contract: `0x${string}`,
  provider: ContractMetadataProvider,
  signal?: AbortSignal,
): Promise<ResolvedAbi[]> {
  const exact = trustedMetadata(await provider.getContractMetadata(contract, signal), contract);
  if (!exact) return [];

  const candidates: ResolvedAbi[] = [{
    abi: exact.abi,
    metadata: exact,
    contract,
    implementation: null,
    source: exact.trust,
  }];

  if (exact.isProxy && exact.implementation && isAddress(exact.implementation)) {
    const implementation = trustedMetadata(
      await provider.getContractMetadata(exact.implementation, signal),
      exact.implementation,
    );
    if (implementation) {
      candidates.push({
        abi: implementation.abi,
        metadata: implementation,
        contract,
        implementation: exact.implementation,
        source: "verified_implementation_abi",
      });
    }
  }
  return candidates;
}

function serializeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth limit]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length <= MAX_SERIALIZED_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_SERIALIZED_STRING_LENGTH)}…`;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SERIALIZED_ARRAY_ITEMS).map((item) => serializeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_SERIALIZED_OBJECT_KEYS)) {
      result[key] = serializeValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function namedArguments(inputs: readonly { name?: string }[], args: readonly unknown[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < inputs.length; index += 1) {
    const name = inputs[index]?.name || String(index);
    result[name] = serializeValue(args?.[index]);
  }
  return result;
}

function decodeCall(data: string, candidates: ResolvedAbi[]): {
  signature: string;
  arguments: Record<string, unknown>;
  enrichment: EnrichmentInfo;
} | null {
  if (!/^0x[a-fA-F0-9]{8,}$/.test(data) || data.length % 2 !== 0) return null;
  const selector = data.slice(0, 10).toLowerCase();
  for (const candidate of candidates) {
    for (const item of candidate.abi) {
      if (item.type !== "function") continue;
      const fn = item as AbiFunction;
      try {
        if (toFunctionSelector(fn).toLowerCase() !== selector) continue;
        const decoded = decodeFunctionData({ abi: [fn], data: data as Hex });
        return {
          signature: toFunctionSignature(fn),
          arguments: namedArguments(fn.inputs, decoded.args as readonly unknown[] | undefined),
          enrichment: {
            source: candidate.source,
            contract: candidate.contract,
            implementation: candidate.implementation,
            contractName: candidate.metadata.contractName,
            sourceUrl: candidate.metadata.sourceUrl,
          },
        };
      } catch {
        // A selector match with invalid argument encoding is not a valid decode.
      }
    }
  }
  return null;
}

function eventArguments(event: AbiEvent, args: unknown): Record<string, unknown> {
  if (Array.isArray(args)) return namedArguments(event.inputs, args);
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    event.inputs.forEach((input, index) => {
      const name = input.name || String(index);
      result[name] = serializeValue(record[name]);
    });
    return result;
  }
  return {};
}

function decodeLogWithCandidates(log: ReceiptLog, candidates: ResolvedAbi[]): DecodedEvent {
  const topic0 = log.topics[0] ?? null;
  const fallback: DecodedEvent = { address: log.address, topic0, decoded: false };
  if (!topic0 || !/^0x[a-fA-F0-9]{64}$/.test(topic0) || !/^0x(?:[a-fA-F0-9]{2})*$/.test(log.data)) return fallback;
  if (!log.topics.every((topic) => /^0x[a-fA-F0-9]{64}$/.test(topic))) return fallback;

  for (const candidate of candidates) {
    for (const item of candidate.abi) {
      if (item.type !== "event") continue;
      const event = item as AbiEvent;
      try {
        if (toEventSelector(event).toLowerCase() !== topic0.toLowerCase()) continue;
        const decoded = decodeEventLog({
          abi: [event],
          data: log.data as Hex,
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        return {
          address: log.address,
          topic0,
          decoded: true,
          event: decoded.eventName,
          signature: toEventSignature(event),
          arguments: eventArguments(event, decoded.args),
          source: candidate.source,
        };
      } catch {
        // Continue through overloads/candidates and retain a bounded unknown log if none decode.
      }
    }
  }
  return fallback;
}

async function decodeLogs(
  logs: ReceiptLog[],
  provider: ContractMetadataProvider,
  signal?: AbortSignal,
): Promise<DecodedEvent[]> {
  const boundedLogs = logs.slice(0, MAX_LOGS);
  const addresses = [...new Set(
    boundedLogs
      .map((log) => log.address.toLowerCase())
      .filter((address): address is `0x${string}` => isAddress(address)),
  )].slice(0, MAX_LOG_CONTRACTS);
  const resolved = new Map<string, ResolvedAbi[]>();
  await Promise.all(addresses.map(async (address) => {
    resolved.set(address, await resolveContractAbis(address, provider, signal));
  }));
  return boundedLogs.map((log) => decodeLogWithCandidates(log, resolved.get(log.address.toLowerCase()) ?? []));
}

async function enrich(
  request: AnalyzeRequest,
  logs: ReceiptLog[],
  provider: ContractMetadataProvider,
  base: AnalysisResult,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  let result = base;
  if (base.action === "unknown_function_call" && isAddress(request.to)) {
    const candidates = await resolveContractAbis(request.to, provider, signal);
    const call = decodeCall(request.data ?? "", candidates);
    if (call) {
      result = {
        action: "verified_contract_call",
        function: call.signature,
        summary: `A trusted contract-specific ABI decodes this as ${call.signature} on ${request.to}. ABI decoding explains the call but does not establish that the contract is safe.`,
        risk: "unknown",
        confidence: call.enrichment.implementation ? 0.94 : 0.95,
        warnings: [{
          type: "abi_decoding_not_safety",
          severity: "low",
          message: "The calldata was decoded from contract-specific authoritative metadata. This identifies intent but is not a security endorsement.",
        }],
        decoded: {
          selector: (request.data ?? "").slice(0, 10).toLowerCase(),
          signature: call.signature,
          arguments: call.arguments,
        },
        enrichment: call.enrichment,
      };
    }
  }

  if (logs.length > 0 && !signal.aborted) {
    const events = await decodeLogs(logs, provider, signal);
    if (events.length > 0) result = { ...result, events };
  }
  return result;
}

export async function analyzeWithEnrichment(
  request: AnalyzeRequest,
  options: {
    logs?: ReceiptLog[];
    metadataProvider?: ContractMetadataProvider;
    timeoutMs?: number;
  } = {},
): Promise<AnalysisResult> {
  const base = analyzeDeterministically(request);
  const logs = options.logs ?? [];
  if (base.action !== "unknown_function_call" && logs.length === 0) return base;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AnalysisResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(base);
    }, options.timeoutMs ?? ENRICHMENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      enrich(
        request,
        logs,
        options.metadataProvider ?? productionMetadataProvider,
        base,
        controller.signal,
      ).catch(() => base),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
