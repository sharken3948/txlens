import { describe, expect, test } from "bun:test";
import {
  ARC_MAINNET_NETWORK,
  ARC_MAINNET_USDC,
  pickArcGatewayRequirement,
  type GatewayPaymentRequirement,
} from "../src/payments/gateway";

function requirement(overrides: Partial<GatewayPaymentRequirement> = {}): GatewayPaymentRequirement {
  return {
    scheme: "exact",
    network: ARC_MAINNET_NETWORK,
    asset: ARC_MAINNET_USDC,
    amount: "2000",
    payTo: "0x540a0027509B1C9aA0a2c5C65491cC97083E16de",
    maxTimeoutSeconds: 604_900,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x7777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    },
    ...overrides,
  };
}

describe("Gateway requirement selection", () => {
  test("selects only a valid Arc Mainnet USDC batching requirement", () => {
    const arc = requirement();
    expect(pickArcGatewayRequirement([
      requirement({ network: "eip155:8453" }),
      arc,
    ])).toBe(arc);
  });

  test("does not fall back to another chain", () => {
    expect(pickArcGatewayRequirement([requirement({ network: "eip155:1" })])).toBeNull();
  });

  test("rejects the wrong Arc asset or non-batching metadata", () => {
    expect(pickArcGatewayRequirement([requirement({ asset: "0x0000000000000000000000000000000000000001" })])).toBeNull();
    expect(pickArcGatewayRequirement([requirement({ extra: { name: "GatewayWalletBatched", version: "2", verifyingContract: "0x1" } })])).toBeNull();
  });
});
