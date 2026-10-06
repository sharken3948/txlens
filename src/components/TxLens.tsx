import { useEffect, useMemo, useState } from "react";
import { ConnectKitButton } from "connectkit";
import { useAccount } from "wagmi";
import { arc } from "viem/chains";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Hash,
  Info,
  Loader2,
  Repeat2,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Wallet,
  Zap,
} from "lucide-react";
import {
  ROUTE_PRICES,
  useX402Payment,
  type X402PaymentState,
} from "@/hooks/useX402Payment";
import { useDirectPayment } from "@/hooks/useDirectPayment";
import { useGatewayWallet } from "@/hooks/useGatewayWallet";

type Risk = "low" | "medium" | "high" | "unknown";
type PaymentMethod = "direct" | "gateway";
type Warning = { type: string; severity: "low" | "medium" | "high"; message: string };
type Analysis = {
  action: string;
  summary: string;
  risk: Risk;
  confidence: number;
  warnings: Warning[];
  decoded: Record<string, unknown>;
  function?: string;
  events?: Array<{
    address: string;
    topic0: string | null;
    decoded: boolean;
    event?: string;
    signature?: string;
    arguments?: Record<string, unknown>;
    source?: string;
  }>;
  enrichment?: {
    source: string;
    contract: string;
    implementation: string | null;
    contractName?: string;
    sourceUrl?: string;
  };
};
type TxMeta = {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  valueHex: string;
  input: string;
  status: "success" | "failed" | "pending" | "unknown";
  blockNumber: number | null;
  network: string;
  explorerUrl: string | null;
};
type LookupResult = Analysis & { transaction: TxMeta };

const ARC_MAINNET_ID = arc.id;

function riskIcon(risk: Risk) {
  if (risk === "low") return <ShieldCheck size={15} />;
  if (risk === "high") return <ShieldAlert size={15} />;
  return <ShieldQuestion size={15} />;
}

function riskClass(risk: Risk) {
  if (risk === "low") return "text-[var(--success)] border-[var(--success)]/30 bg-[var(--success)]/10";
  if (risk === "high") return "text-[var(--danger)] border-[var(--danger)]/30 bg-[var(--danger)]/10";
  if (risk === "medium") return "text-amber-300 border-amber-400/30 bg-amber-400/10";
  return "text-[var(--subtle)] border-[var(--subtle)]/30 bg-[var(--subtle)]/10";
}

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  textarea?: boolean;
  readOnly?: boolean;
}) {
  const cls = "w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--focus)]";
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-[var(--subtle)]">{props.label}</span>
      {props.textarea ? (
        <textarea className={cls} style={{ background: "var(--surface-muted)", borderColor: "var(--border)" }} rows={4}
          value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} readOnly={props.readOnly} />
      ) : (
        <input className={cls} style={{ background: "var(--surface-muted)", borderColor: "var(--border)" }}
          value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} readOnly={props.readOnly} />
      )}
    </label>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 text-sm text-[var(--danger)]">{message}</div>;
}

function PaymentMethodSelector({
  value,
  onChange,
}: {
  value: PaymentMethod;
  onChange: (value: PaymentMethod) => void;
}) {
  return (
    <div className="rounded-2xl border p-4 space-y-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Payment method</div>
          <div className="text-xs text-[var(--subtle)]">Choose what fits this usage pattern.</div>
        </div>
        <span className="mono text-[11px] text-[var(--accent)]">Arc Mainnet</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        <button
          onClick={() => onChange("direct")}
          className={`text-left rounded-xl border p-3 ${value === "direct" ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)]"}`}
        >
          <div className="flex items-center gap-2 font-semibold text-sm"><Wallet size={14} /> Direct USDC</div>
          <div className="mt-1 text-xs text-[var(--muted)]">Best for one-time use. Pay directly from your Arc wallet; network gas applies. No Gateway funding required.</div>
        </button>
        <button
          onClick={() => onChange("gateway")}
          className={`text-left rounded-xl border p-3 ${value === "gateway" ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)]"}`}
        >
          <div className="flex items-center gap-2 font-semibold text-sm"><Zap size={14} /> Use Gateway</div>
          <div className="mt-1 text-xs text-[var(--muted)]">Best for frequent requests. Fund once, then use Gateway Nanopayments with no per-request gas after funding.</div>
        </button>
      </div>
    </div>
  );
}

function GatewayWalletPanel() {
  const gw = useGatewayWallet();
  const busy = ["depositing", "initiating_withdrawal", "completing_withdrawal"].includes(gw.status);

  useEffect(() => {
    if (gw.isConnected) void gw.refresh();
  }, [gw.isConnected, gw.address]);

  return (
    <div className="rounded-2xl border p-4 space-y-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-sm">Gateway Wallet</div>
          <div className="text-xs text-[var(--subtle)]">Funding for repeated x402 nanopayments.</div>
        </div>
        {gw.isConnected && (
          <button onClick={() => void gw.refresh()} className="text-xs text-[var(--accent)]">Refresh</button>
        )}
      </div>

      {!gw.isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show} className="w-full h-10 rounded-xl bg-[var(--accent)] text-[var(--bg)] font-semibold text-sm">
              Connect Wallet
            </button>
          )}
        </ConnectKitButton.Custom>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
              <div className="text-[var(--subtle)]">Wallet USDC</div>
              <div className="mt-1 mono font-semibold">{gw.walletBalance ?? "—"}</div>
            </div>
            <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
              <div className="text-[var(--subtle)]">Gateway Balance</div>
              <div className="mt-1 mono font-semibold">{gw.gatewayBalance ?? "—"}</div>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Field label="Deposit to Gateway (USDC)" value={gw.depositAmount} onChange={gw.setDepositAmount} />
              <button disabled={busy} onClick={() => void gw.deposit()}
                className="w-full h-10 rounded-xl bg-[var(--accent)] text-[var(--bg)] font-semibold text-sm disabled:opacity-50">
                {gw.status === "depositing" ? "Depositing…" : "Deposit"}
              </button>
            </div>
            <div className="space-y-2">
              <Field label="Withdraw amount (USDC)" value={gw.withdrawAmount} onChange={gw.setWithdrawAmount} />
              <button disabled={busy} onClick={() => void gw.initiateWithdraw()}
                className="w-full h-10 rounded-xl border border-[var(--accent)] text-[var(--accent)] font-semibold text-sm disabled:opacity-50">
                {gw.status === "initiating_withdrawal" ? "Starting…" : "Start Withdraw"}
              </button>
            </div>
          </div>

          <button disabled={busy} onClick={() => void gw.completeWithdraw()}
            className="w-full h-9 rounded-xl border border-[var(--border)] text-xs font-semibold disabled:opacity-50">
            Complete eligible withdrawal
          </button>

          <div className="text-[11px] text-[var(--subtle)]">
            Circle's recovery withdrawal is a two-step flow with a mandatory 7-day activation delay. Starting another withdrawal on Arc adds to the pending amount and restarts that timer.
          </div>
          {gw.error && <div className="text-xs text-[var(--danger)]">{gw.error}</div>}
          {gw.lastResult && (
            <details className="text-xs">
              <summary className="cursor-pointer text-[var(--accent)]">Last Gateway operation</summary>
              <pre className="mt-2 overflow-auto rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>{JSON.stringify(gw.lastResult, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function GatewayCheckout({
  route,
  state,
  header,
  onPay,
}: {
  route: "analyze" | "lookup";
  state: X402PaymentState;
  header: string;
  onPay: () => void;
}) {
  const { isConnected, chainId } = useAccount();
  const price = state.displayPrice ?? ROUTE_PRICES[route];
  const busy = state.status === "awaiting_signature" || state.status === "retrying";
  return (
    <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CreditCard size={17} className="text-[var(--accent)]" />
          <div><div className="font-semibold">Gateway payment required</div><div className="text-xs text-[var(--subtle)]">Circle x402 Nanopayments</div></div>
        </div>
        <span className="mono text-xs px-2.5 py-1 rounded-full border border-[var(--accent)] text-[var(--accent)]">{price} USDC</span>
      </div>
      {!isConnected ? (
        <ConnectKitButton.Custom>{({ show }) => <button onClick={show} className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)]">Connect Wallet to Pay</button>}</ConnectKitButton.Custom>
      ) : (
        <button onClick={onPay} disabled={busy}
          className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)] disabled:opacity-50 flex items-center justify-center gap-2">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
          {state.status === "wrong_network" ? "Switch to Arc Mainnet" : state.status === "awaiting_signature" ? "Awaiting signature…" : state.status === "retrying" ? "Verifying payment…" : `Pay ${price} USDC with Gateway`}
        </button>
      )}
      {isConnected && chainId !== ARC_MAINNET_ID && <div className="text-xs text-amber-300">Wallet will be switched to Arc Mainnet.</div>}
      {state.error && <div className="text-xs text-[var(--danger)]">{state.error}</div>}
      <input type="hidden" value={header} readOnly />
    </div>
  );
}

function DirectCheckout({
  route,
  body,
  onSuccess,
}: {
  route: "analyze" | "lookup";
  body: unknown;
  onSuccess: (payload: unknown) => void;
}) {
  const { isConnected } = useAccount();
  const direct = useDirectPayment({ route, body, onSuccess });
  const busy = !["idle", "wallet_disconnected", "error", "success"].includes(direct.status);
  return (
    <div className="rounded-2xl border p-5 space-y-3" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
      <div className="flex justify-between gap-3">
        <div>
          <div className="font-semibold">Direct USDC</div>
          <div className="text-xs text-[var(--subtle)]">One-time authorization for exactly {ROUTE_PRICES[route]} USDC — not an unlimited token approval.</div>
        </div>
        <span className="mono text-xs text-[var(--accent)]">{ROUTE_PRICES[route]} USDC + gas</span>
      </div>
      {!isConnected ? (
        <ConnectKitButton.Custom>{({ show }) => <button onClick={show} className="w-full h-11 rounded-xl bg-[var(--accent)] text-[var(--bg)] font-semibold">Connect Wallet</button>}</ConnectKitButton.Custom>
      ) : (
        <button disabled={busy} onClick={() => void direct.pay()}
          className="w-full h-11 rounded-xl bg-[var(--accent)] text-[var(--bg)] font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Wallet size={15} />}
          {direct.status === "awaiting_signature" ? "Authorize USDC…" :
           direct.status === "submitting" ? "Submit payment…" :
           direct.status === "confirming" ? "Confirming on Arc…" :
           direct.status === "verifying" ? "Verifying payment…" :
           direct.txHash && direct.status === "error" ? "Retry paid request (no new charge)" :
           `Pay ${ROUTE_PRICES[route]} USDC & Continue`}
        </button>
      )}
      {direct.error && <div className="text-xs text-[var(--danger)]">{direct.error}</div>}
      {direct.txHash && <a className="text-xs text-[var(--accent)] inline-flex items-center gap-1" href={`https://explorer.arc.io/tx/${direct.txHash}`} target="_blank" rel="noreferrer">Payment transaction <ExternalLink size={11} /></a>}
    </div>
  );
}

function AnalysisCard({ result, transaction }: { result: Analysis; transaction?: TxMeta }) {
  return (
    <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
      <div className="flex items-start justify-between gap-4">
        <div><div className="text-xs uppercase tracking-wider text-[var(--subtle)]">Action</div><div className="display text-xl font-semibold mt-1">{result.action.split("_").map((x) => x[0]?.toUpperCase() + x.slice(1)).join(" ")}</div></div>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${riskClass(result.risk)}`}>{riskIcon(result.risk)}{result.risk} risk</span>
      </div>
      <div className="text-sm leading-relaxed text-[var(--ink-2)]">{result.summary}</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}><div className="text-[var(--subtle)]">Confidence</div><div className="mt-1 font-semibold">{Math.round(result.confidence * 100)}%</div></div>
        <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}><div className="text-[var(--subtle)]">Network</div><div className="mt-1 font-semibold">Arc Mainnet</div></div>
      </div>
      {transaction && <div className="space-y-2 text-xs"><div className="font-semibold">Transaction</div><div className="mono break-all text-[var(--muted)]">{transaction.hash}</div>{transaction.explorerUrl && <a className="inline-flex items-center gap-1 text-[var(--accent)]" href={transaction.explorerUrl} target="_blank" rel="noreferrer">View on Arc Explorer <ExternalLink size={11} /></a>}</div>}
      {result.enrichment && <div className="rounded-xl p-3 text-xs space-y-1" style={{ background: "var(--surface-muted)" }}>
        <div className="font-semibold">Contract-specific decoding</div>
        <div className="text-[var(--muted)]">{result.enrichment.contractName ?? "Verified contract"} · {result.function}</div>
        <div className="mono break-all text-[var(--subtle)]">{result.enrichment.contract}</div>
        {result.enrichment.implementation && <div className="mono break-all text-[var(--subtle)]">Implementation: {result.enrichment.implementation}</div>}
        {result.enrichment.sourceUrl && <a className="inline-flex items-center gap-1 text-[var(--accent)]" href={result.enrichment.sourceUrl} target="_blank" rel="noreferrer">View decoding source <ExternalLink size={11} /></a>}
      </div>}
      {result.warnings.map((warning) => <div key={warning.type + warning.message} className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs"><div className="flex items-center gap-2 font-semibold text-amber-300"><AlertTriangle size={13} />{warning.type}</div><div className="mt-1 text-[var(--muted)]">{warning.message}</div></div>)}
      {Object.keys(result.decoded).length > 0 && <pre className="overflow-auto rounded-xl p-3 text-xs" style={{ background: "var(--surface-muted)" }}>{JSON.stringify(result.decoded, null, 2)}</pre>}
      {result.events && result.events.length > 0 && <details className="text-xs">
        <summary className="cursor-pointer font-semibold text-[var(--accent)]">Receipt events ({result.events.filter((event) => event.decoded).length} decoded / {result.events.length})</summary>
        <pre className="mt-2 overflow-auto rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>{JSON.stringify(result.events, null, 2)}</pre>
      </details>}
    </div>
  );
}

function ManualMode({ paymentMethod }: { paymentMethod: PaymentMethod }) {
  const [to, setTo] = useState("");
  const [data, setData] = useState("");
  const [value, setValue] = useState("0");
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paymentHeader, setPaymentHeader] = useState<string | null>(null);
  const body = useMemo(() => ({ chainId: 5042, to: to.trim(), data: data.trim(), value: value.trim() || "0" }), [to, data, value]);
  const gateway = useX402Payment({ url: "/api/analyze/gateway", body, onSuccess: (payload) => { setResult(payload as Analysis); setPaymentHeader(null); } });

  async function start() {
    setError(null); setResult(null); setPaymentHeader(null); gateway.reset();
    if (!/^0x[a-fA-F0-9]{40}$/.test(to.trim())) { setError("Enter a valid destination address."); return; }
    if (paymentMethod === "direct") return;
    const resp = await fetch("/api/analyze/gateway", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (resp.status === 402) {
      const header = resp.headers.get("payment-required");
      if (!header) { setError("Gateway payment requirement was missing."); return; }
      setPaymentHeader(header); return;
    }
    const json = await resp.json();
    if (!resp.ok) setError(json.error ?? "Analysis failed.");
  }

  const valid = /^0x[a-fA-F0-9]{40}$/.test(to.trim());

  return <div className="space-y-4">
    <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between"><div className="font-semibold">Analyze transaction fields</div><span className="mono text-xs text-[var(--accent)]">{ROUTE_PRICES.analyze} USDC</span></div>
      <Field label="Chain" value="Arc Mainnet · 5042" onChange={() => {}} readOnly />
      <Field label="To" value={to} onChange={setTo} placeholder="0x..." />
      <Field label="Calldata" value={data} onChange={setData} placeholder="0x..." textarea />
      <Field label="Value" value={value} onChange={setValue} placeholder="0" />
      {paymentMethod === "gateway" && <button onClick={() => void start()} className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)] flex items-center justify-center gap-2"><Search size={15} /> Continue to Gateway Payment</button>}
    </div>
    <ErrorBanner message={error} />
    {paymentMethod === "direct" && valid && <DirectCheckout route="analyze" body={body} onSuccess={(payload) => setResult(payload as Analysis)} />}
    {paymentMethod === "gateway" && paymentHeader && gateway.state.status !== "success" && <GatewayCheckout route="analyze" state={gateway.state} header={paymentHeader} onPay={() => void gateway.pay(paymentHeader)} />}
    {result && <AnalysisCard result={result} />}
  </div>;
}

function HashMode({ paymentMethod }: { paymentMethod: PaymentMethod }) {
  const [txHash, setTxHash] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paymentHeader, setPaymentHeader] = useState<string | null>(null);
  const body = useMemo(() => ({ chainId: 5042, txHash: txHash.trim() }), [txHash]);
  const gateway = useX402Payment({ url: "/api/lookup-tx/gateway", body, onSuccess: (payload) => { setResult(payload as LookupResult); setPaymentHeader(null); } });

  async function start() {
    setError(null); setResult(null); setPaymentHeader(null); gateway.reset();
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash.trim())) { setError("Enter a valid transaction hash."); return; }
    if (paymentMethod === "direct") return;
    const resp = await fetch("/api/lookup-tx/gateway", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (resp.status === 402) {
      const header = resp.headers.get("payment-required");
      if (!header) { setError("Gateway payment requirement was missing."); return; }
      setPaymentHeader(header); return;
    }
    const json = await resp.json();
    if (!resp.ok) setError(json.error ?? "Lookup failed.");
  }

  const valid = /^0x[a-fA-F0-9]{64}$/.test(txHash.trim());

  return <div className="space-y-4">
    <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between"><div className="font-semibold">Lookup Arc Mainnet transaction</div><span className="mono text-xs text-[var(--accent)]">{ROUTE_PRICES.lookup} USDC</span></div>
      <Field label="Network" value="Arc Mainnet · 5042" onChange={() => {}} readOnly />
      <Field label="Transaction Hash" value={txHash} onChange={setTxHash} placeholder="0x..." />
      {paymentMethod === "gateway" && <button onClick={() => void start()} className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)] flex items-center justify-center gap-2"><Hash size={15} /> Continue to Gateway Payment</button>}
    </div>
    <ErrorBanner message={error} />
    {paymentMethod === "direct" && valid && <DirectCheckout route="lookup" body={body} onSuccess={(payload) => setResult(payload as LookupResult)} />}
    {paymentMethod === "gateway" && paymentHeader && gateway.state.status !== "success" && <GatewayCheckout route="lookup" state={gateway.state} header={paymentHeader} onPay={() => void gateway.pay(paymentHeader)} />}
    {result && <AnalysisCard result={result} transaction={result.transaction} />}
  </div>;
}

function HowItWorks() {
  const items = [
    ["One-time use", "Choose Direct USDC. TxLens creates a short-lived quote, you authorize one Arc USDC payment onchain, and the server verifies the exact EIP-3009 authorization before returning the result."],
    ["Frequent use", "Choose Gateway. Fund your unified balance once, then pay repeated x402 requests with Circle Nanopayments without per-request gas."],
    ["Agents", "API clients can use the Direct quote + proof headers or the Gateway x402 402/PAYMENT-SIGNATURE flow."],
  ];
  return <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
    <div className="flex items-center gap-2 font-semibold"><Info size={15} /> How TxLens payments work</div>
    {items.map(([title, body]) => <div key={title} className="flex gap-3"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" /><div><div className="text-sm font-semibold">{title}</div><div className="text-xs leading-relaxed text-[var(--muted)]">{body}</div></div></div>)}
  </div>;
}

export default function TxLens() {
  const [mode, setMode] = useState<"manual" | "hash">("manual");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("direct");

  return <div className="min-h-dvh flex flex-col" style={{ background: "var(--bg-gradient)" }}>
    <header className="border-b border-[var(--border)] px-4 py-4">
      <div className="max-w-2xl mx-auto flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-[var(--accent)] text-[var(--bg)] grid place-items-center"><Search size={17} /></div>
        <div><h1 className="display text-xl font-semibold">TxLens</h1><p className="text-xs text-[var(--subtle)]">Understand what an Arc transaction will do before you sign it.</p></div>
        <div className="ml-auto flex items-center gap-3"><span className="hidden sm:inline-flex mono text-xs px-2.5 py-1 rounded-full border border-[var(--accent)] text-[var(--accent)]">Arc Mainnet</span><ConnectKitButton /></div>
      </div>
    </header>

    <main className="flex-1 px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-4">
        <PaymentMethodSelector value={paymentMethod} onChange={setPaymentMethod} />
        {paymentMethod === "gateway" && <GatewayWalletPanel />}

        <div className="grid grid-cols-2 gap-1 rounded-xl p-1" style={{ background: "var(--surface-strong)", border: "1px solid var(--border)" }}>
          <button onClick={() => setMode("manual")} className={`h-9 rounded-lg text-xs font-semibold ${mode === "manual" ? "bg-[var(--surface-muted)]" : "text-[var(--subtle)]"}`}><Repeat2 size={13} className="inline mr-1" />Analyze by Fields</button>
          <button onClick={() => setMode("hash")} className={`h-9 rounded-lg text-xs font-semibold ${mode === "hash" ? "bg-[var(--surface-muted)]" : "text-[var(--subtle)]"}`}><Hash size={13} className="inline mr-1" />Lookup Arc Tx Hash</button>
        </div>

        {mode === "manual" ? <ManualMode paymentMethod={paymentMethod} /> : <HashMode paymentMethod={paymentMethod} />}
        <HowItWorks />
      </div>
    </main>

    <footer className="border-t border-[var(--border)] px-4 py-4 text-center text-xs text-[var(--subtle)]">TxLens · Arc Mainnet 5042 · Direct USDC + Gateway Nanopayments</footer>
  </div>;
}
