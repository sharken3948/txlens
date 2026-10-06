export const ARC_CHAIN_ID = 5042;
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;

export const ARC_USDC_EIP712_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: ARC_CHAIN_ID,
  verifyingContract: ARC_USDC,
} as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const USDC_AUTH_ABI_VRS = [{
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
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
  outputs: [],
}] as const;
