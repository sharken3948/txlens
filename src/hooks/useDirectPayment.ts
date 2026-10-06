import { useCallback, useRef, useState } from "react";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { arc } from "viem/chains";
import { parseSignature } from "viem";
import {
  ARC_USDC,
  ARC_USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_AUTH_ABI_VRS,
} from "@/payments/direct";

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

type PaidProof = {
  bodySnapshot: string;
  quote: Quote;
  txHash: `0x${string}`;
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as {
      shortMessage?: string;
      details?: string;
      message?: string;
      cause?: { reason?: string; shortMessage?: string };
    };
    return candidate.cause?.reason ?? candidate.cause?.shortMessage ?? candidate.shortMessage ?? candidate.details ?? candidate.message ?? String(error);
  }
  return String(error);
}

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
  const paidProof = useRef<PaidProof | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setTxHash(null);
  }, []);

  const pay = useCallback(async () => {
    setError(null);
    const bodySnapshot = JSON.stringify(body);
    const endpoint = route === "analyze" ? "/api/analyze" : "/api/lookup-tx";

    const submitPaidRequest = async (proof: PaidProof) => {
      setStatus("verifying");
      const paidResp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TxLens-Payment-Quote": proof.quote.token,
          "X-TxLens-Payment-Tx": proof.txHash,
        },
        body: JSON.stringify(body),
      });
      const payload = await paidResp.json();
      if (!paidResp.ok) throw new Error(payload.error ?? `Server returned ${paidResp.status} after direct payment.`);
      setStatus("success");
      onSuccess(payload);
    };

    if (paidProof.current?.bodySnapshot === bodySnapshot) {
      try {
        await submitPaidRequest(paidProof.current);
      } catch (err) {
        setStatus("error");
        setError(`${errorMessage(err)} Your confirmed payment is saved; retry will not charge you again.`);
      }
      return;
    }
    paidProof.current = null;

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
        domain: ARC_USDC_EIP712_DOMAIN,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
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
      const { v, r, s, yParity } = parseSignature(signature);
      const signatureV = v ?? BigInt((yParity ?? 0) + 27);

      if (!publicClient) throw new Error("Arc client unavailable.");
      const contractArgs = [
        address,
        quote.payTo,
        BigInt(quote.amount),
        BigInt(quote.validAfter),
        BigInt(quote.validBefore),
        quote.nonce,
        Number(signatureV),
        r,
        s,
      ] as const;

      setStatus("submitting");
      try {
        await publicClient.simulateContract({
          account: address,
          address: ARC_USDC,
          abi: USDC_AUTH_ABI_VRS,
          functionName: "transferWithAuthorization",
          args: contractArgs,
        });
      } catch (simulationError) {
        throw new Error(`Direct USDC payment simulation failed: ${errorMessage(simulationError)}`);
      }
      const hash = await writeContractAsync({
        chainId: arc.id,
        address: ARC_USDC,
        abi: USDC_AUTH_ABI_VRS,
        functionName: "transferWithAuthorization",
        args: contractArgs,
      });
      setTxHash(hash);

      setStatus("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Direct USDC payment transaction failed.");

      paidProof.current = { bodySnapshot, quote, txHash: hash };
      await submitPaidRequest(paidProof.current);
    } catch (err) {
      setStatus("error");
      const retryNote = paidProof.current?.bodySnapshot === bodySnapshot
        ? " Your confirmed payment is saved; retry will not charge you again."
        : "";
      setError(`${errorMessage(err)}${retryNote}`);
    }
  }, [address, body, chainId, isConnected, onSuccess, publicClient, route, signTypedDataAsync, switchChainAsync, writeContractAsync]);

  return { status, error, txHash, pay, reset };
}
