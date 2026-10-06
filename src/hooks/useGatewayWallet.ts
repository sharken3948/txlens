import { useCallback, useMemo, useState } from "react";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import type { EIP1193Provider } from "viem";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { arc } from "viem/chains";

const appKit = new AppKit();

export function useGatewayWallet() {
  const { address, connector, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const [gatewayBalance, setGatewayBalance] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState("0.10");
  const [withdrawAmount, setWithdrawAmount] = useState("0.10");
  const [status, setStatus] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(null);

  const getAdapter = useCallback(async (switchToArc = false) => {
    if (!connector) throw new Error("Connect your wallet first.");
    if (switchToArc && chainId !== arc.id) await switchChainAsync({ chainId: arc.id });
    const provider = (await connector.getProvider()) as EIP1193Provider;
    return await createViemAdapterFromProvider({ provider });
  }, [chainId, connector, switchChainAsync]);

  const refresh = useCallback(async () => {
    if (!isConnected || !address) {
      setGatewayBalance(null);
      return;
    }
    setError(null);
    try {
      const adapter = await getAdapter(false);
      const balances = await appKit.unifiedBalance.getBalances({
        sources: { adapter },
        networkType: "mainnet",
      });
      setGatewayBalance(balances.totalConfirmedBalance ?? "0");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [address, getAdapter, isConnected]);

  const deposit = useCallback(async () => {
    const amount = Number(depositAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid deposit amount.");
      return;
    }
    setStatus("depositing");
    setError(null);
    try {
      const adapter = await getAdapter(true);
      const result = await appKit.unifiedBalance.deposit({
        from: { adapter, chain: "Arc" },
        amount: depositAmount,
        allowanceStrategy: "authorize",
      });
      setLastResult(result as unknown as Record<string, unknown>);
      setStatus("success");
      await refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [depositAmount, getAdapter, refresh]);

  const initiateWithdraw = useCallback(async () => {
    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid withdrawal amount.");
      return;
    }
    setStatus("initiating_withdrawal");
    setError(null);
    try {
      const adapter = await getAdapter(true);
      const result = await appKit.unifiedBalance.initiateRemoveFund({
        from: { adapter, chain: "Arc" },
        amount: withdrawAmount,
      });
      setLastResult(result as unknown as Record<string, unknown>);
      setStatus("withdrawal_pending");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [getAdapter, withdrawAmount]);

  const completeWithdraw = useCallback(async () => {
    setStatus("completing_withdrawal");
    setError(null);
    try {
      const adapter = await getAdapter(true);
      const result = await appKit.unifiedBalance.removeFund({
        from: { adapter, chain: "Arc" },
      });
      setLastResult(result as unknown as Record<string, unknown>);
      setStatus("success");
      await refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [getAdapter, refresh]);

  return useMemo(() => ({
    address,
    isConnected,
    gatewayBalance,
    depositAmount,
    setDepositAmount,
    withdrawAmount,
    setWithdrawAmount,
    status,
    error,
    lastResult,
    refresh,
    deposit,
    initiateWithdraw,
    completeWithdraw,
  }), [address, completeWithdraw, deposit, depositAmount, error, gatewayBalance, initiateWithdraw, isConnected, lastResult, refresh, status, withdrawAmount]);
}
