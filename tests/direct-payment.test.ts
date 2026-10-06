import { describe, expect, test } from "bun:test";
import { domainSeparator, encodeFunctionData, parseSignature, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_NETWORK,
  ARC_USDC,
  DIRECT_PRICE_ATOMIC,
  USDC_AUTH_ABI,
  createDirectQuote,
  stableBodyHash,
  verifyDirectPayment,
} from "../src/server/directPayment";
import {
  ARC_USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../src/payments/direct";

const SECRET = "test-secret-that-is-at-least-thirty-two-characters";
const PAYER = "0x1111111111111111111111111111111111111111" as const;
const OTHER_PAYER = "0x2222222222222222222222222222222222222222" as const;
const SELLER = "0x540a0027509B1C9aA0a2c5C65491cC97083E16de" as const;
const OTHER_SELLER = "0x3333333333333333333333333333333333333333" as const;
const NONCE = `0x${"44".repeat(32)}` as const;
const OTHER_NONCE = `0x${"55".repeat(32)}` as const;
const TX_HASH = `0x${"aa".repeat(32)}`;
const BODY = { chainId: 5042, txHash: `0x${"bb".repeat(32)}` };

function makeQuote() {
  return createDirectQuote({
    route: "lookup",
    payer: PAYER,
    body: BODY,
    sellerAddress: SELLER,
    secret: SECRET,
    nowSeconds: 1_000,
    nonce: NONCE,
  });
}

function authorizationInput(overrides: {
  payer?: `0x${string}`;
  seller?: `0x${string}`;
  amount?: bigint;
  nonce?: `0x${string}`;
} = {}) {
  return encodeFunctionData({
    abi: USDC_AUTH_ABI,
    functionName: "transferWithAuthorization",
    args: [
      overrides.payer ?? PAYER,
      overrides.seller ?? SELLER,
      overrides.amount ?? 3_000n,
      0n,
      1_300n,
      overrides.nonce ?? NONCE,
      27,
      `0x${"66".repeat(32)}`,
      `0x${"77".repeat(32)}`,
    ],
  });
}

function rpcFor(input: `0x${string}`, options: { timestamp?: number; missingTx?: boolean } = {}) {
  return async (method: string): Promise<unknown> => {
    if (method === "eth_getTransactionByHash") {
      return { result: options.missingTx ? null : { to: ARC_USDC, input, blockNumber: "0x10" } };
    }
    if (method === "eth_getTransactionReceipt") {
      return { result: { status: "0x1", blockNumber: "0x10" } };
    }
    if (method === "eth_getBlockByNumber") {
      return { result: { timestamp: `0x${(options.timestamp ?? 1_100).toString(16)}` } };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  };
}

async function verify(input: `0x${string}`, overrides: Partial<Parameters<typeof verifyDirectPayment>[0]> = {}) {
  const quote = makeQuote();
  return verifyDirectPayment({
    route: "lookup",
    body: BODY,
    quoteToken: quote.token,
    txHash: TX_HASH,
    sellerAddress: SELLER,
    secret: SECRET,
    rpcCall: rpcFor(input),
    ...overrides,
  });
}

describe("direct quote generation", () => {
  test("binds the Arc asset, seller, exact route price, payer, body, nonce, and validity", () => {
    const quote = makeQuote();
    expect(quote.network).toBe(ARC_NETWORK);
    expect(quote.asset).toBe(ARC_USDC);
    expect(quote.payTo).toBe(SELLER);
    expect(quote.amount).toBe(DIRECT_PRICE_ATOMIC.lookup);
    expect(quote.payer).toBe(PAYER);
    expect(quote.bodyHash).toBe(stableBodyHash(BODY));
    expect(quote.nonce).toBe(NONCE);
    expect(quote.validBefore).toBe("1300");
  });

  test("uses canonical object-key ordering for the request body hash", () => {
    expect(stableBodyHash({ a: 1, nested: { x: 2, y: 3 }, z: 4 })).toBe(
      stableBodyHash({ z: 4, nested: { y: 3, x: 2 }, a: 1 }),
    );
  });
});

describe("Arc USDC EIP-3009 typed data", () => {
  test("uses the live Arc domain separator and produces a recoverable 27/28 signature", async () => {
    expect(domainSeparator({ domain: ARC_USDC_EIP712_DOMAIN })).toBe(
      "0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84",
    );
    const account = privateKeyToAccount(`0x${"12".repeat(32)}`);
    const message = {
      from: account.address,
      to: SELLER,
      value: 3_000n,
      validAfter: 0n,
      validBefore: 1_300n,
      nonce: NONCE,
    };
    const signature = await account.signTypedData({
      domain: ARC_USDC_EIP712_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    expect([27n, 28n]).toContain(parseSignature(signature).v!);
    expect(await recoverTypedDataAddress({
      domain: ARC_USDC_EIP712_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature,
    })).toBe(account.address);
  });
});

describe("direct payment verification", () => {
  test("accepts a successful EIP-3009 transferWithAuthorization structure", async () => {
    expect(await verify(authorizationInput())).toEqual({ ok: true, payer: PAYER, txHash: TX_HASH });
  });

  test("rejects the wrong payer", async () => {
    expect(await verify(authorizationInput({ payer: OTHER_PAYER }))).toEqual({ ok: false, error: "Direct payment payer mismatch." });
  });

  test("rejects the wrong amount", async () => {
    expect(await verify(authorizationInput({ amount: 2_999n }))).toEqual({ ok: false, error: "Direct payment amount mismatch." });
  });

  test("rejects the wrong seller", async () => {
    expect(await verify(authorizationInput({ seller: OTHER_SELLER }))).toEqual({ ok: false, error: "Direct payment recipient mismatch." });
  });

  test("rejects the wrong nonce", async () => {
    expect(await verify(authorizationInput({ nonce: OTHER_NONCE }))).toEqual({ ok: false, error: "Direct payment nonce mismatch." });
  });

  test("rejects an authorization mined outside its validity window", async () => {
    const result = await verify(authorizationInput(), { rpcCall: rpcFor(authorizationInput(), { timestamp: 1_300 }) });
    expect(result).toEqual({ ok: false, error: "Direct payment authorization was not valid when mined." });
  });

  test("rejects a payment proof for a different request body", async () => {
    const result = await verify(authorizationInput(), { body: { ...BODY, chainId: 1 } });
    expect(result).toEqual({ ok: false, error: "Direct payment quote does not match this request." });
  });

  test("rejects a fake transaction hash with no transaction", async () => {
    const input = authorizationInput();
    const result = await verify(input, { rpcCall: rpcFor(input, { missingTx: true }) });
    expect(result).toEqual({ ok: false, error: "Direct payment transaction is missing." });
  });

  test("allows safe retry of the same paid request after quote wall-clock expiry", async () => {
    // Verification is anchored to the mined block time, not retry time.
    expect(await verify(authorizationInput())).toEqual({ ok: true, payer: PAYER, txHash: TX_HASH });
  });
});
