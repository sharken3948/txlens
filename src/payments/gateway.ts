export const ARC_MAINNET_NETWORK = "eip155:5042";
export const ARC_MAINNET_USDC = "0x3600000000000000000000000000000000000000";
export const GATEWAY_BATCH_NAME = "GatewayWalletBatched";
export const GATEWAY_BATCH_VERSION = "1";

export interface GatewayPaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export function pickArcGatewayRequirement(
  accepts: GatewayPaymentRequirement[],
): GatewayPaymentRequirement | null {
  return accepts.find((requirement) =>
    requirement.scheme === "exact" &&
    requirement.network === ARC_MAINNET_NETWORK &&
    requirement.asset.toLowerCase() === ARC_MAINNET_USDC &&
    requirement.extra?.name === GATEWAY_BATCH_NAME &&
    requirement.extra?.version === GATEWAY_BATCH_VERSION &&
    typeof requirement.extra?.verifyingContract === "string"
  ) ?? null;
}
