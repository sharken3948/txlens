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

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface Warning {
  type: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface DecodedEvent {
  address: string;
  topic0: string | null;
  decoded: boolean;
  event?: string;
  signature?: string;
  arguments?: Record<string, unknown>;
  source?: string;
}

export interface EnrichmentInfo {
  source: string;
  contract: string;
  implementation: string | null;
  contractName?: string;
  sourceUrl?: string;
}

export interface AnalysisResult {
  action: string;
  summary: string;
  risk: RiskLevel;
  confidence: number;
  warnings: Warning[];
  decoded: Record<string, unknown>;
  function?: string;
  events?: DecodedEvent[];
  enrichment?: EnrichmentInfo;
}

export interface AnalyzeRequest {
  chainId: number;
  to: string;
  data?: string;
  value?: string;
}

function hexToAddress(hex: string): string {
  const stripped = hex.replace(/^0x/, "");
  return "0x" + stripped.slice(-40);
}

export function hexToBigInt(hex: string): bigint {
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

export function analyzeDeterministically(req: AnalyzeRequest): AnalysisResult {
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
