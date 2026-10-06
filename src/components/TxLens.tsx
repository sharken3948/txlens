import { useMemo, useState } from "react";
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

type Risk = "low" | "medium" | "high" | "unknown";
type Warning = { type: string; severity: "low" | "medium" | "high"; message: string };
type Analysis = {
  action: string;
  summary: string;
  risk: Risk;
  confidence: number;
  warnings: Warning[];
  decoded: Record<string, unknown>;
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
  const cls =
    "w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--focus)]";
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-[var(--subtle)]">{props.label}</span>
      {props.textarea ? (
        <textarea
          className={cls}
          style={{ background: "var(--surface-muted)", borderColor: "var(--border)" }}
          rows={4}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          readOnly={props.readOnly}
        />
      ) : (
        <input
          className={cls}
          style={{ background: "var(--surface-muted)", borderColor: "var(--border)" }}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          readOnly={props.readOnly}
        />
      )}
    </label>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 text-sm text-[var(--danger)]">
      {message}
    </div>
  );
}

function PaymentCheckout({
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
  const req = state.requirement;
  const busy = state.status === "awaiting_signature" || state.status === "retrying";

  return (
    <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CreditCard size={17} className="text-[var(--accent)]" />
          <div>
            <div className="font-semibold">Payment required</div>
            <div className="text-xs text-[var(--subtle)]">Circle Gateway x402</div>
          </div>
        </div>
        <span className="mono text-xs px-2.5 py-1 rounded-full border border-[var(--accent)] text-[var(--accent)]">
          {price} USDC
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
          <div className="text-[var(--subtle)]">Network</div>
          <div className="mt-1 font-semibold">Arc Mainnet · 5042</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
          <div className="text-[var(--subtle)]">Seller</div>
          <div className="mt-1 mono break-all">{req?.payTo ?? "from 402 requirement"}</div>
        </div>
      </div>

      {!isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show} className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)]">
              Connect Wallet to Pay
            </button>
          )}
        </ConnectKitButton.Custom>
      ) : (
        <button
          onClick={onPay}
          disabled={busy}
          className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)] disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Wallet size={15} />}
          {state.status === "wrong_network"
            ? "Switch to Arc Mainnet"
            : state.status === "awaiting_signature"
              ? "Awaiting signature…"
              : state.status === "retrying"
                ? "Verifying payment…"
                : `Pay ${price} USDC & Analyze`}
        </button>
      )}

      {isConnected && chainId !== ARC_MAINNET_ID && (
        <div className="text-xs text-amber-300">Wallet is not on Arc Mainnet. The payment flow will request a network switch.</div>
      )}

      {state.error && (
        <div className="text-xs text-[var(--danger)]">{state.error}</div>
      )}

      {state.paymentResponse && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--success)] font-semibold">
            Payment settled
          </summary>
          <pre className="mt-2 overflow-auto rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
            {JSON.stringify(state.paymentResponse, null, 2)}
          </pre>
        </details>
      )}

      <div className="text-[11px] text-[var(--subtle)]">
        Agents can call the same endpoint directly and retry with a PAYMENT-SIGNATURE header. Browser and agent payments use the same x402 requirement.
      </div>
      <input type="hidden" value={header} readOnly />
    </div>
  );
}

function AnalysisCard({ result, transaction }: { result: Analysis; transaction?: TxMeta }) {
  return (
    <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--subtle)]">Action</div>
          <div className="display text-xl font-semibold mt-1">
            {result.action.split("_").map((x) => x[0]?.toUpperCase() + x.slice(1)).join(" ")}
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${riskClass(result.risk)}`}>
          {riskIcon(result.risk)}
          {result.risk} risk
        </span>
      </div>

      <div className="text-sm leading-relaxed text-[var(--ink-2)]">{result.summary}</div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
          <div className="text-[var(--subtle)]">Confidence</div>
          <div className="mt-1 font-semibold">{Math.round(result.confidence * 100)}%</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
          <div className="text-[var(--subtle)]">Network</div>
          <div className="mt-1 font-semibold">Arc Mainnet</div>
        </div>
      </div>

      {transaction && (
        <div className="space-y-2 text-xs">
          <div className="font-semibold">Transaction</div>
          <div className="mono break-all text-[var(--muted)]">{transaction.hash}</div>
          {transaction.explorerUrl && (
            <a className="inline-flex items-center gap-1 text-[var(--accent)]" href={transaction.explorerUrl} target="_blank" rel="noreferrer">
              View on Arc Explorer <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="space-y-2">
          {result.warnings.map((warning) => (
            <div key={warning.type + warning.message} className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold text-amber-300">
                <AlertTriangle size={13} />
                {warning.type}
              </div>
              <div className="mt-1 text-[var(--muted)]">{warning.message}</div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(result.decoded).length > 0 && (
        <div className="space-y-2 text-xs">
          <div className="font-semibold">Decoded</div>
          <pre className="overflow-auto rounded-xl p-3" style={{ background: "var(--surface-muted)" }}>
            {JSON.stringify(result.decoded, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ManualMode() {
  const [to, setTo] = useState("");
  const [data, setData] = useState("");
  const [value, setValue] = useState("0");
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paymentHeader, setPaymentHeader] = useState<string | null>(null);
  const body = useMemo(() => ({ chainId: 5042, to: to.trim(), data: data.trim(), value: value.trim() || "0" }), [to, data, value]);

  const payment = useX402Payment({
    url: "/api/analyze",
    body,
    onSuccess: (payload) => {
      setResult(payload as Analysis);
      setPaymentHeader(null);
    },
  });

  async function analyze() {
    setError(null);
    setResult(null);
    payment.reset();

    if (!/^0x[a-fA-F0-9]{40}$/.test(to.trim())) {
      setError("Enter a valid destination address.");
      return;
    }

    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.status === 402) {
      const header = resp.headers.get("payment-required");
      if (!header) {
        setError("Payment required but PAYMENT-REQUIRED header was missing.");
        return;
      }
      setPaymentHeader(header);
      return;
    }

    const json = await resp.json();
    if (!resp.ok) {
      setError(json.error ?? "Analysis failed.");
      return;
    }
    setResult(json as Analysis);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
        <div className="flex items-center justify-between">
          <div className="font-semibold">Analyze transaction fields</div>
          <span className="mono text-xs text-[var(--accent)]">{ROUTE_PRICES.analyze} USDC</span>
        </div>
        <Field label="Chain" value="Arc Mainnet · 5042" onChange={() => {}} readOnly />
        <Field label="To" value={to} onChange={setTo} placeholder="0x..." />
        <Field label="Calldata" value={data} onChange={setData} placeholder="0x..." textarea />
        <Field label="Value" value={value} onChange={setValue} placeholder="0" />
        <button onClick={() => void analyze()} className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)] flex items-center justify-center gap-2">
          <Search size={15} /> Analyze Transaction
        </button>
      </div>
      <ErrorBanner message={error} />
      {paymentHeader && payment.state.status !== "success" && (
        <PaymentCheckout route="analyze" state={payment.state} header={paymentHeader} onPay={() => void payment.pay(paymentHeader)} />
      )}
      {result && <AnalysisCard result={result} />}
    </div>
  );
}

function HashMode() {
  const [txHash, setTxHash] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paymentHeader, setPaymentHeader] = useState<string | null>(null);
  const body = useMemo(() => ({ chainId: 5042, txHash: txHash.trim() }), [txHash]);

  const payment = useX402Payment({
    url: "/api/lookup-tx",
    body,
    onSuccess: (payload) => {
      setResult(payload as LookupResult);
      setPaymentHeader(null);
    },
  });

  async function lookup() {
    setError(null);
    setResult(null);
    payment.reset();

    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash.trim())) {
      setError("Enter a valid transaction hash.");
      return;
    }

    const resp = await fetch("/api/lookup-tx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.status === 402) {
      const header = resp.headers.get("payment-required");
      if (!header) {
        setError("Payment required but PAYMENT-REQUIRED header was missing.");
        return;
      }
      setPaymentHeader(header);
      return;
    }

    const json = await resp.json();
    if (!resp.ok) {
      setError(json.error ?? "Lookup failed.");
      return;
    }
    setResult(json as LookupResult);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface-strong)", borderColor: "var(--border)" }}>
        <div className="flex items-center justify-between">
          <div className="font-semibold">Lookup Arc Mainnet transaction</div>
          <span className="mono text-xs text-[var(--accent)]">{ROUTE_PRICES.lookup} USDC</span>
        </div>
        <Field label="Network" value="Arc Mainnet · 5042" onChange={() => {}} readOnly />
        <Field label="Transaction Hash" value={txHash} onChange={setTxHash} placeholder="0x..." />
        <button onClick={() => void lookup()} className="w-full h-11 rounded-xl font-semibold bg-[var(--accent)] text-[var(--bg)] flex items-center justify-center gap-2">
          <Hash size={15} /> Lookup & Analyze
        </button>
      </div>
      <ErrorBanner message={error} />
      {paymentHeader && payment.state.status !== "success" && (
        <PaymentCheckout route="lookup" state={payment.state} header={paymentHeader} onPay={() => void payment.pay(paymentHeader)} />
      )}
      {result && <AnalysisCard result={result} transaction={result.transaction} />}
    </div>
  );
}

function HowItWorks() {
  const items = [
    ["Before signing", "Wallets and dApps can send to, data and value to TxLens before a user signs. TxLens explains the intent and flags broad permissions."],
    ["For AI agents", "Agents call /api/analyze and retry the 402 response with PAYMENT-SIGNATURE. The same x402 flow works without this frontend."],
    ["After execution", "Paste an Arc Mainnet transaction hash to inspect what happened onchain through /api/lookup-tx."],
  ];
  return (
    <div className="rounded-2xl border p-5 space-y-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2 font-semibold"><Info size={15} /> How TxLens is used</div>
      {items.map(([title, body]) => (
        <div key={title} className="flex gap-3">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div>
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-xs leading-relaxed text-[var(--muted)]">{body}</div>
          </div>
        </div>
      ))}
      <div className="rounded-xl border border-[var(--accent)]/20 bg-[var(--accent)]/5 p-3 text-xs">
        <strong>Primary use case:</strong> pre-sign transaction safety for wallets, dApps and AI agents.
      </div>
    </div>
  );
}

export default function TxLens() {
  const [mode, setMode] = useState<"manual" | "hash">("manual");

  return (
    <div className="min-h-dvh flex flex-col" style={{ background: "var(--bg-gradient)" }}>
      <header className="border-b border-[var(--border)] px-4 py-4">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[var(--accent)] text-[var(--bg)] grid place-items-center"><Search size={17} /></div>
          <div>
            <h1 className="display text-xl font-semibold">TxLens</h1>
            <p className="text-xs text-[var(--subtle)]">Understand what an Arc transaction will do before you sign it.</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden sm:inline-flex mono text-xs px-2.5 py-1 rounded-full border border-[var(--accent)] text-[var(--accent)]">
              Arc Mainnet
            </span>
            <ConnectKitButton />
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 py-8">
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-xl p-1" style={{ background: "var(--surface-strong)", border: "1px solid var(--border)" }}>
            <button onClick={() => setMode("manual")} className={`h-9 rounded-lg text-xs font-semibold ${mode === "manual" ? "bg-[var(--surface-muted)]" : "text-[var(--subtle)]"}`}>
              Analyze by Fields
            </button>
            <button onClick={() => setMode("hash")} className={`h-9 rounded-lg text-xs font-semibold ${mode === "hash" ? "bg-[var(--surface-muted)]" : "text-[var(--subtle)]"}`}>
              Lookup Arc Tx Hash
            </button>
          </div>

          {mode === "manual" ? <ManualMode /> : <HashMode />}
          <HowItWorks />
        </div>
      </main>

      <footer className="border-t border-[var(--border)] px-4 py-4 text-center text-xs text-[var(--subtle)]">
        TxLens · Arc Mainnet 5042 · Deterministic transaction analysis
      </footer>
    </div>
  );
}
