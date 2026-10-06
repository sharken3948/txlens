import { describe, expect, test } from "bun:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  type Abi,
} from "viem";
import { analyzeDeterministically } from "../src/server/analyzer";
import { analyzeWithEnrichment, type ReceiptLog } from "../src/server/abiEnrichment";
import {
  ARC_MEMO_ADDRESS,
  ARC_NATIVE_USDC,
  ArcSystemContractMetadataProvider,
  EtherscanArcMetadataProvider,
  type ContractMetadata,
  type ContractMetadataProvider,
} from "../src/server/contractMetadata";

const TARGET = "0x1111111111111111111111111111111111111111" as const;
const IMPLEMENTATION = "0x2222222222222222222222222222222222222222" as const;
const WRONG_TARGET = "0x3333333333333333333333333333333333333333" as const;

function metadata(
  address: `0x${string}`,
  abi: Abi,
  overrides: Partial<ContractMetadata> = {},
): ContractMetadata {
  return {
    address,
    abi,
    contractName: "Fixture",
    trust: "verified_contract_abi",
    ...overrides,
  };
}

function providerFor(entries: ContractMetadata[]): ContractMetadataProvider {
  const byAddress = new Map(entries.map((entry) => [entry.address.toLowerCase(), entry]));
  return {
    async getContractMetadata(address) {
      return byAddress.get(address.toLowerCase()) ?? null;
    },
  };
}

const UNKNOWN_ABI = parseAbi(["function execute(uint256 amount, string note)"]);

describe("deterministic analyzer boundary", () => {
  test("known built-in selectors keep the existing path without metadata lookup", async () => {
    let calls = 0;
    const provider: ContractMetadataProvider = {
      async getContractMetadata() { calls += 1; return null; },
    };
    const data = encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount)"]),
      functionName: "transfer",
      args: [WRONG_TARGET, 42n],
    });
    const result = await analyzeWithEnrichment({ chainId: 5042, to: TARGET, data }, { metadataProvider: provider });
    expect(result.action).toBe("token_transfer");
    expect(result.decoded).toEqual({ to: WRONG_TARGET, amount: "42" });
    expect(calls).toBe(0);
  });

  test("preserves existing high-risk approval warnings", () => {
    const data = encodeFunctionData({
      abi: parseAbi(["function approve(address spender, uint256 amount)"]),
      functionName: "approve",
      args: [WRONG_TARGET, (1n << 256n) - 1n],
    });
    const result = analyzeDeterministically({ chainId: 5042, to: TARGET, data });
    expect(result.action).toBe("token_approval");
    expect(result.risk).toBe("high");
    expect(result.warnings.map((warning) => warning.type)).toContain("unlimited_approval");
  });
});

describe("verified ABI calldata enrichment", () => {
  test("decodes an unknown selector and named arguments from an exact-contract ABI", async () => {
    const data = encodeFunctionData({ abi: UNKNOWN_ABI, functionName: "execute", args: [7n, "verified"] });
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: TARGET, data },
      { metadataProvider: providerFor([metadata(TARGET, UNKNOWN_ABI)]) },
    );
    expect(result.action).toBe("verified_contract_call");
    expect(result.function).toBe("execute(uint256,string)");
    expect(result.risk).toBe("unknown");
    expect(result.decoded.arguments).toEqual({ amount: "7", note: "verified" });
    expect(result.enrichment?.source).toBe("verified_contract_abi");
  });

  test("selects the correct overload by selector", async () => {
    const abi = parseAbi([
      "function run(uint256 value)",
      "function run(address recipient)",
    ]);
    const data = encodeFunctionData({ abi, functionName: "run", args: [WRONG_TARGET] });
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: TARGET, data },
      { metadataProvider: providerFor([metadata(TARGET, abi)]) },
    );
    expect(result.function).toBe("run(address)");
    expect(result.decoded.arguments).toEqual({ recipient: WRONG_TARGET });
  });

  test("rejects metadata returned for a different contract", async () => {
    const data = encodeFunctionData({ abi: UNKNOWN_ABI, functionName: "execute", args: [1n, "wrong"] });
    const provider: ContractMetadataProvider = {
      async getContractMetadata() { return metadata(WRONG_TARGET, UNKNOWN_ABI); },
    };
    const result = await analyzeWithEnrichment({ chainId: 5042, to: TARGET, data }, { metadataProvider: provider });
    expect(result.action).toBe("unknown_function_call");
    expect(result.warnings[0]?.type).toBe("unknown_calldata");
  });

  test("rejects malformed ABI metadata", async () => {
    const data = encodeFunctionData({ abi: UNKNOWN_ABI, functionName: "execute", args: [1n, "bad ABI"] });
    const malformed = metadata(TARGET, [{ type: "function", name: 12 }] as unknown as Abi);
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: TARGET, data },
      { metadataProvider: providerFor([malformed]) },
    );
    expect(result.action).toBe("unknown_function_call");
  });

  test("falls back safely for malformed calldata", async () => {
    const valid = encodeFunctionData({ abi: UNKNOWN_ABI, functionName: "execute", args: [1n, "truncated"] });
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: TARGET, data: valid.slice(0, 20) },
      { metadataProvider: providerFor([metadata(TARGET, UNKNOWN_ABI)]) },
    );
    expect(result.action).toBe("unknown_function_call");
    expect(result.risk).toBe("unknown");
  });

  test("uses only an explorer-declared and separately verified proxy implementation", async () => {
    const proxyAbi = parseAbi(["function implementation() view returns (address)"]);
    const data = encodeFunctionData({ abi: UNKNOWN_ABI, functionName: "execute", args: [9n, "proxy"] });
    const provider = providerFor([
      metadata(TARGET, proxyAbi, { isProxy: true, implementation: IMPLEMENTATION }),
      metadata(IMPLEMENTATION, UNKNOWN_ABI, { contractName: "Implementation" }),
    ]);
    const result = await analyzeWithEnrichment({ chainId: 5042, to: TARGET, data }, { metadataProvider: provider });
    expect(result.function).toBe("execute(uint256,string)");
    expect(result.enrichment?.source).toBe("verified_implementation_abi");
    expect(result.enrichment?.implementation).toBe(IMPLEMENTATION);
  });
});

describe("explorer failure handling", () => {
  const data = encodeFunctionData({ abi: UNKNOWN_ABI, functionName: "execute", args: [1n, "fallback"] });

  test("malformed explorer ABI response degrades to the unknown result", async () => {
    const provider = new EtherscanArcMetadataProvider({
      apiKey: "test-key",
      fetchFn: async () => new Response(JSON.stringify({
        status: "1",
        result: [{ SourceCode: "contract Fixture {}", ABI: "not-json", ContractName: "Fixture", Proxy: "0" }],
      }), { status: 200 }),
    });
    const result = await analyzeWithEnrichment({ chainId: 5042, to: TARGET, data }, { metadataProvider: provider });
    expect(result.action).toBe("unknown_function_call");
  });

  test("unverified contract response degrades to the unknown result", async () => {
    const provider = new EtherscanArcMetadataProvider({
      apiKey: "test-key",
      fetchFn: async () => new Response(JSON.stringify({
        status: "1",
        result: [{ SourceCode: "", ABI: "Contract source code not verified", ContractName: "", Proxy: "0" }],
      }), { status: 200 }),
    });
    const result = await analyzeWithEnrichment({ chainId: 5042, to: TARGET, data }, { metadataProvider: provider });
    expect(result.action).toBe("unknown_function_call");
  });

  test("explorer timeout degrades to the unknown result", async () => {
    const provider = new EtherscanArcMetadataProvider({
      apiKey: "test-key",
      timeoutMs: 5,
      fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
      }),
    });
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: TARGET, data },
      { metadataProvider: provider, timeoutMs: 50 },
    );
    expect(result.action).toBe("unknown_function_call");
  });
});

describe("receipt event enrichment", () => {
  test("decodes verified events and arguments", async () => {
    const eventAbi = parseAbi(["event Completed(address indexed account, uint256 amount)"]);
    const topics = encodeEventTopics({ abi: eventAbi, eventName: "Completed", args: { account: WRONG_TARGET } });
    const log: ReceiptLog = {
      address: TARGET,
      topics,
      data: encodeAbiParameters([{ type: "uint256" }], [55n]),
    };
    const knownTransfer = encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount)"]),
      functionName: "transfer",
      args: [WRONG_TARGET, 1n],
    });
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: TARGET, data: knownTransfer },
      { logs: [log], metadataProvider: providerFor([metadata(TARGET, eventAbi)]) },
    );
    expect(result.action).toBe("token_transfer");
    expect(result.events?.[0]).toMatchObject({ decoded: true, event: "Completed" });
    expect(result.events?.[0]?.arguments).toEqual({ account: WRONG_TARGET, amount: "55" });
  });

  test("retains unknown log topics without inventing an event", async () => {
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: TARGET, data: "0xa9059cbb" + "00".repeat(64) },
      {
        logs: [{ address: TARGET, topics: [`0x${"99".repeat(32)}`], data: "0x" }],
        metadataProvider: providerFor([metadata(TARGET, parseAbi(["event Known(uint256 value)"]))]),
      },
    );
    expect(result.events).toEqual([{
      address: TARGET,
      topic0: `0x${"99".repeat(32)}`,
      decoded: false,
    }]);
  });
});

describe("Arc Memo mainnet regression fixture", () => {
  const input = "0xc3b2c4f800000000000000000000000036000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080e049bb9298f56182fbf55a235fe5e105f8555664c23503313ae6a2d031d51e4500000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000052650d1764406d702252b20b2294346a594a1ef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000060000000000000000000000000d4f1254c803662c46d9c21f80f4f3c15ff57e2c900000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000028416e65776f6e6520546f6b656e2044617461202620426f7420496e746567726174696f6e20415049000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002462333730623332312d363433362d343037332d393962662d37383366393230373338383300000000000000000000000000000000000000000000000000000000";
  const logs: ReceiptLog[] = [
    {
      address: ARC_MEMO_ADDRESS,
      topics: [
        "0xb252e055da754c72fbf7542cf424b190808a9b541e912894c5e15b4238c41501",
        `0x${"0".repeat(61)}302`,
      ],
      data: "0x",
    },
    {
      address: ARC_NATIVE_USDC,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x000000000000000000000000052650d1764406d702252b20b2294346a594a1ef",
        "0x000000000000000000000000052650d1764406d702252b20b2294346a594a1ef",
      ],
      data: `0x${"0".repeat(64)}`,
    },
    {
      address: ARC_MEMO_ADDRESS,
      topics: [
        "0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4",
        "0x000000000000000000000000052650d1764406d702252b20b2294346a594a1ef",
        "0x0000000000000000000000003600000000000000000000000000000000000000",
        "0xe049bb9298f56182fbf55a235fe5e105f8555664c23503313ae6a2d031d51e45",
      ],
      data: "0x438e25c08b3489b68f14b0a164e511af4c3c877fd69a3a2c48d71a24aecc2c020000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000030200000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000060000000000000000000000000d4f1254c803662c46d9c21f80f4f3c15ff57e2c900000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000028416e65776f6e6520546f6b656e2044617461202620426f7420496e746567726174696f6e20415049000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002462333730623332312d363433362d343037332d393962662d37383366393230373338383300000000000000000000000000000000000000000000000000000000",
    },
  ];

  test("decodes the authoritative Memo call and all known receipt events", async () => {
    const result = await analyzeWithEnrichment(
      { chainId: 5042, to: ARC_MEMO_ADDRESS, data: input, value: "0" },
      { logs, metadataProvider: new ArcSystemContractMetadataProvider() },
    );
    expect(result.action).toBe("verified_contract_call");
    expect(result.function).toBe("memo(address,bytes,bytes32,bytes)");
    expect(result.enrichment).toMatchObject({
      source: "arc_system_contract_abi",
      contract: ARC_MEMO_ADDRESS,
      implementation: null,
      contractName: "Memo",
    });
    expect(result.decoded.arguments).toMatchObject({
      target: ARC_NATIVE_USDC,
      data: "0xa9059cbb000000000000000000000000052650d1764406d702252b20b2294346a594a1ef0000000000000000000000000000000000000000000000000000000000000000",
      memoId: "0xe049bb9298f56182fbf55a235fe5e105f8555664c23503313ae6a2d031d51e45",
    });
    expect(result.events?.map((event) => event.event)).toEqual(["BeforeMemo", "Transfer", "Memo"]);
    expect(result.events?.[0]?.arguments?.memoIndex).toBe("770");
    expect(String(result.events?.[1]?.arguments?.from).toLowerCase()).toBe("0x052650d1764406d702252b20b2294346a594a1ef");
    expect(String(result.events?.[1]?.arguments?.to).toLowerCase()).toBe("0x052650d1764406d702252b20b2294346a594a1ef");
    expect(result.events?.[1]?.arguments?.value).toBe("0");
    expect(String(result.events?.[2]?.arguments?.sender).toLowerCase()).toBe("0x052650d1764406d702252b20b2294346a594a1ef");
    expect(String(result.events?.[2]?.arguments?.target).toLowerCase()).toBe(ARC_NATIVE_USDC);
    expect(result.events?.[2]?.arguments?.callDataHash).toBe("0x438e25c08b3489b68f14b0a164e511af4c3c877fd69a3a2c48d71a24aecc2c02");
    expect(result.events?.[2]?.arguments?.memoIndex).toBe("770");
  });
});

test("ABI enrichment has no payment-layer import coupling", async () => {
  for (const file of [
    "src/server/analyzer.ts",
    "src/server/abiEnrichment.ts",
    "src/server/contractMetadata.ts",
  ]) {
    const source = await Bun.file(file).text();
    expect(source).not.toContain("payments/");
    expect(source).not.toContain("directPayment");
    expect(source).not.toContain("x402");
  }
});
