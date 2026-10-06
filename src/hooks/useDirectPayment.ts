import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { arc } from "viem/chains";
import { parseSignature } from "viem";

const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;

const USDC_AUTH_ABI = [{
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

type DirectRoute = "analyze" | "lookup";
type Quote = {
  token: string;
  route: DirectRoute;
  payer: string;
  amount: string;
  nonce: `0x${string}`;
  validAfter: string;
  validBefore: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
};

export type DirectPaymentStatus =
  | "idle"
  | "wallet_disconnected"
  | "quoting"
  | "wrong_network"
  | "awaiting_signature"
  | "submitting"
  | "confirming"
  | "verifying"
  | "success"
  | "error";

export function useDirectPayment({
  route,
  body,
  onSuccess,
}: {
  route: DirectRoute;
  body: unknown;
  onSuccess: (payload: unknown) => void;
}) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arc.id });
  const [status, setStatus] = useState<DirectPaymentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setTxHash(null);
  }, []);

  const pay = useCallback(async () => {
    setError(null);
    if (!isConnected || !address) {
      setStatus("wallet_disconnected");
      setError("Connect your wallet to pay directly.");
      return;
    }

    try {
      setStatus("quoting");
      const quoteResp = await fetch("/api/direct/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route, payer: address, body }),
      });
      const quote = (await quoteResp.json()) as Quote & { error?: string };
      if (!quoteResp.ok) throw new Error(quote.error ?? "Could not create direct payment quote.");

      if (chainId !== arc.id) {
        setStatus("wrong_network");
        await switchChainAsync({ chainId: arc.id });
      }

      setStatus("awaiting_signature");
      const signature = await signTypedDataAsync({
        domain: {
          name: "USD Coin",
          version: "2",
          chainId: arc.id,
          verifyingContract: ARC_USDC,
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: address,
          to: quote.payTo,
          value: BigInt(quote.amount),
          validAfter: BigInt(quote.validAfter),
          validBefore: BigInt(quote.validBefore),
          nonce: quote.nonce,
        },
      });
      const { v, r, s } = parseSignature(signature);

      setStatus("submitting");
      const hash = await writeContractAsync({
        chainId: arc.id,
        address: ARC_USDC,
        abi: USDC_AUTH_ABI,
        functionName: "transferWithAuthorization",
        args: [
          address,
          quote.payTo,
          BigInt(quote.amount),
          BigInt(quote.validAfter),
          BigInt(quote.validBefore),
          quote.nonce,
          Number(v),
          r,
          s,
        ],
      });
      setTxHash(hash);

      setStatus("confirming");
      if (!publicClient) throw new Error("Arc client unavailable.");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Direct USDC payment transaction failed.");

      setStatus("verifying");
      const endpoint = route === "analyze" ? "/api/analyze" : "/api/lookup-tx";
      const paidResp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TxLens-Payment-Quote": quote.token,
          "X-TxLens-Payment-Tx": hash,
        },
        body: JSON.stringify(body),
      });
      const payload = await paidResp.json();
      if (!paidResp.ok) throw new Error(payload.error ?? `Server returned ${paidResp.status} after direct payment.`);

      setStatus("success");
      onSuccess(payload);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [address, body, chainId, isConnected, onSuccess, publicClient, route, signTypedDataAsync, switchChainAsync, writeContractAsync]);

  return { status, error, txHash, pay, reset };
}
