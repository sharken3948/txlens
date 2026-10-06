/**
 * useX402Payment — browser-side x402 v2 payment hook for TxLens.
 */

import { useState, useCallback } from "react";
import { useAccount, useSwitchChain, useSignTypedData } from "wagmi";
import { arc } from "viem/chains";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";

export const HDR_PAYMENT_REQUIRED = "payment-required";
export const HDR_PAYMENT_SIGNATURE = "payment-signature";
export const HDR_PAYMENT_RESPONSE = "payment-response";

const ARC_MAINNET_CHAIN_ID = arc.id;

export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirement[];
  error?: string;
  resource?: unknown;
  extensions?: unknown;
}

export type PaymentStatus =
  | "idle"
  | "wallet_disconnected"
  | "wrong_network"
  | "awaiting_signature"
  | "user_rejected"
  | "signing_failed"
  | "retrying"
  | "verification_failed"
  | "success";

export interface X402PaymentState {
  status: PaymentStatus;
  paymentRequired: PaymentRequired | null;
  requirement: PaymentRequirement | null;
  displayPrice: string | null;
  paymentResponse: Record<string, unknown> | null;
  error: string | null;
}

export const ROUTE_PRICES: Record<string, string> = {
  analyze: "0.002",
  lookup: "0.003",
};

function decodeBase64Json<T>(b64: string): T {
  const json = atob(b64);
  return JSON.parse(json) as T;
}

function encodeBase64Json(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

function pickRequirement(
  accepts: PaymentRequirement[]
): PaymentRequirement | null {
  if (!accepts || accepts.length === 0) return null;
  return (
    accepts.find(
      (r) =>
        r.network === "eip155:5042" ||
        r.network === `eip155:${ARC_MAINNET_CHAIN_ID}`
    ) ?? null
  );
}

function formatUsdcAmount(raw: string): string {
  try {
    const n = BigInt(raw);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    return raw;
  }
}

export interface UseX402PaymentOptions {
  url: string;
  body: unknown;
  onSuccess: (data: unknown) => void;
}

export function useX402Payment({ url, body, onSuccess }: UseX402PaymentOptions) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  const [state, setState] = useState<X402PaymentState>({
    status: "idle",
    paymentRequired: null,
    requirement: null,
    displayPrice: null,
    paymentResponse: null,
    error: null,
  });

  const reset = useCallback(() => {
    setState({
      status: "idle",
      paymentRequired: null,
      requirement: null,
      displayPrice: null,
      paymentResponse: null,
      error: null,
    });
  }, []);

  const pay = useCallback(
    async (paymentRequiredHeader: string) => {
      let paymentRequired: PaymentRequired;
      try {
        paymentRequired = decodeBase64Json<PaymentRequired>(paymentRequiredHeader);
      } catch {
        setState((s) => ({
          ...s,
          status: "verification_failed",
          error: "Could not decode the PAYMENT-REQUIRED header from the server.",
        }));
        return;
      }

      const requirement = pickRequirement(paymentRequired.accepts ?? []);
      if (!requirement) {
        setState((s) => ({
          ...s,
          status: "verification_failed",
          error: "Arc Mainnet payment is unavailable in the server's 402 response.",
        }));
        return;
      }

      const displayPrice = formatUsdcAmount(requirement.amount);
      setState((s) => ({
        ...s,
        paymentRequired,
        requirement,
        displayPrice,
      }));

      if (!isConnected || !address) {
        setState((s) => ({
          ...s,
          status: "wallet_disconnected",
          error: "Connect your wallet to pay.",
        }));
        return;
      }

      if (chainId !== ARC_MAINNET_CHAIN_ID) {
        setState((s) => ({ ...s, status: "wrong_network", error: null }));
        try {
          await switchChainAsync({ chainId: ARC_MAINNET_CHAIN_ID });
        } catch {
          setState((s) => ({
            ...s,
            status: "wrong_network",
            error: "Please switch to Arc Mainnet to pay.",
          }));
          return;
        }
      }

      setState((s) => ({ ...s, status: "awaiting_signature", error: null }));

      const evmSigner = {
        address,
        signTypedData: async (params: {
          domain: {
            name: string;
            version: string;
            chainId: number;
            verifyingContract: `0x${string}`;
          };
          types: Record<string, Array<{ name: string; type: string }>>;
          primaryType: string;
          message: Record<string, unknown>;
        }) =>
          signTypedDataAsync({
            domain: params.domain,
            types: params.types,
            primaryType: params.primaryType,
            message: params.message,
          }),
      };

      const batchScheme = new BatchEvmScheme(evmSigner);

      let paymentPayload: {
        x402Version: number;
        accepted: PaymentRequirement;
        payload: unknown;
        resource?: unknown;
        extensions?: unknown;
      };
      try {
        const schemePayload = await batchScheme.createPaymentPayload(
          paymentRequired.x402Version ?? 2,
          requirement
        );
        paymentPayload = {
          ...schemePayload,
          accepted: requirement,
          ...(paymentRequired.resource ? { resource: paymentRequired.resource } : {}),
          ...(paymentRequired.extensions ? { extensions: paymentRequired.extensions } : {}),
        };
      } catch (err) {
        const msg = String(err);
        if (msg.toLowerCase().includes("user rejected") || msg.includes("4001")) {
          setState((s) => ({
            ...s,
            status: "user_rejected",
            error: "Signature cancelled.",
          }));
        } else {
          setState((s) => ({
            ...s,
            status: "signing_failed",
            error: `Payment authorization failed: ${msg}`,
          }));
        }
        return;
      }

      const paymentSignatureHeader = encodeBase64Json(paymentPayload);
      setState((s) => ({ ...s, status: "retrying", error: null }));

      let retryResp: Response;
      try {
        retryResp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [HDR_PAYMENT_SIGNATURE]: paymentSignatureHeader,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "verification_failed",
          error: `Network error on paid retry: ${String(err)}`,
        }));
        return;
      }

      const paymentResponseRaw = retryResp.headers.get(HDR_PAYMENT_RESPONSE);
      let paymentResponse: Record<string, unknown> | null = null;
      if (paymentResponseRaw) {
        try {
          paymentResponse = decodeBase64Json<Record<string, unknown>>(paymentResponseRaw);
        } catch {
          // Receipt parsing is non-fatal.
        }
      }

      const retryJson = (await retryResp.json()) as unknown;

      if (!retryResp.ok) {
        setState((s) => ({
          ...s,
          status: "verification_failed",
          paymentResponse,
          error:
            (retryJson as { error?: string }).error ??
            `Server returned ${retryResp.status} after payment.`,
        }));
        return;
      }

      setState((s) => ({
        ...s,
        status: "success",
        paymentResponse,
        error: null,
      }));
      onSuccess(retryJson);
    },
    [address, chainId, isConnected, signTypedDataAsync, switchChainAsync, url, body, onSuccess]
  );

  return { state, pay, reset };
}
