import { useEffect, useState, type FormEvent } from "react";
import { useThruWallet } from "./hooks/useThruWallet";
import { shortenAddress } from "./lib/bytes";
import {
  buildNativeTransfer,
  getAccountBalance,
  NATIVE_TRANSFER_FEE,
  submitSignedTransaction,
  THRU_RPC_URL,
} from "./lib/thru";
import "./App.css";

type TxPhase = "idle" | "building" | "awaiting_signature" | "submitting" | "done";

export default function App() {
  const {
    status,
    publicKey,
    signingContext,
    error,
    setError,
    connect,
    disconnect,
    signTransaction,
  } = useThruWallet();

  const [balance, setBalance] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("1");
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [signature, setSignature] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setBalance(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const info = await getAccountBalance(publicKey);
        if (!cancelled) setBalance(info.exists ? info.balance : "0 (account not on-chain)");
      } catch (err) {
        if (!cancelled) {
          setBalance(null);
          setError(err instanceof Error ? err.message : "Failed to load balance");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey, setError, signature]);

  async function handleTransfer(event: FormEvent) {
    event.preventDefault();
    if (!publicKey) return;

    setError(null);
    setSignature(null);

    const trimmedAmount = amount.trim();
    if (!/^\d+$/.test(trimmedAmount) || trimmedAmount === "0") {
      setError("Amount must be a positive integer");
      return;
    }

    try {
      setPhase("building");
      const { signingPayloadBase64 } = await buildNativeTransfer({
        fromAddress: publicKey,
        destination,
        amount: BigInt(trimmedAmount),
      });

      setPhase("awaiting_signature");
      const signedBase64 = await signTransaction(signingPayloadBase64);

      setPhase("submitting");
      const txSignature = await submitSignedTransaction(signedBase64);
      setSignature(txSignature);
      setPhase("done");
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : "Transfer failed");
    }
  }

  const busy = phase === "building" || phase === "awaiting_signature" || phase === "submitting";

  return (
    <div className="page">
      <div className="atmosphere" aria-hidden="true" />

      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <p className="brand-name">Thru Connect</p>
            <p className="brand-sub">Alphanet dApp demo</p>
          </div>
        </div>

        <div className="top-actions">
          <p className="rpc">{THRU_RPC_URL.replace("https://", "")}</p>
          {status === "connected" && publicKey ? (
            <button
              type="button"
              className="connect-btn connected-btn"
              title={publicKey}
              onClick={() => void disconnect()}
            >
              {shortenAddress(publicKey, 4)}
            </button>
          ) : (
            <button
              type="button"
              className="connect-btn"
              onClick={() => void connect()}
              disabled={status === "checking" || status === "connecting" || status === "missing"}
            >
              {status === "connecting"
                ? "Connecting…"
                : status === "checking"
                  ? "Checking…"
                  : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      <main className="stage">
        <section className="hero-copy">
          <h1>Connect wallet. Sign a transfer.</h1>
          <p>
            This page talks to the ThruShield Chrome extension via{" "}
            <code>window.thruWallet</code>, builds an unsigned native transfer with{" "}
            <code>@thru/sdk</code>, asks the wallet to sign, then submits the raw bytes.
          </p>

          {(status === "ready" || status === "connecting" || status === "checking") && (
            <button
              type="button"
              className="connect-btn connect-btn-lg"
              onClick={() => void connect()}
              disabled={status === "checking" || status === "connecting"}
            >
              {status === "connecting"
                ? "Waiting for approval…"
                : status === "checking"
                  ? "Looking for wallet…"
                  : "Connect Wallet"}
            </button>
          )}
        </section>

          {status === "missing" && (
          <section className="panel" aria-label="Wallet missing">
            <div className="callout">
              <p>
                ThruShield was not detected. In Chrome open{" "}
                <code>chrome://extensions</code>, enable Developer mode, click{" "}
                <strong>Load unpacked</strong>, and select:
              </p>
              <code className="path">thrushield-wallet/dist</code>
              <p>Unlock the wallet, then reload this page.</p>
              <a
                href="https://github.com/tokyob12/thrushield-wallet"
                target="_blank"
                rel="noreferrer"
              >
                ThruShield on GitHub
              </a>
            </div>
          </section>
        )}

        {status === "connected" && publicKey && (
          <section className="panel" aria-label="Wallet connection">
            <div className="panel-head">
              <h2>Wallet</h2>
              <StatusPill status={status} />
            </div>
            <div className="connected">
              <dl className="meta">
                <div>
                  <dt>Address</dt>
                  <dd title={publicKey}>{shortenAddress(publicKey, 8)}</dd>
                </div>
                <div>
                  <dt>Balance</dt>
                  <dd>{balance ?? "…"}</dd>
                </div>
                {signingContext && (
                  <div>
                    <dt>Signer</dt>
                    <dd title={signingContext.signerPublicKey}>
                      {shortenAddress(signingContext.signerPublicKey, 8)}
                    </dd>
                  </div>
                )}
              </dl>
              <button type="button" className="ghost" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
          </section>
        )}

        {status === "connected" && (
          <section className="panel" aria-label="Sign transfer">
            <div className="panel-head">
              <h2>Transfer</h2>
              <p className="muted">Fee = {NATIVE_TRANSFER_FEE.toString()} (EOA program)</p>
            </div>

            <form className="form" onSubmit={(event) => void handleTransfer(event)}>
              <label>
                Destination
                <input
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="ta…"
                  spellCheck={false}
                  autoComplete="off"
                  required
                  disabled={busy}
                />
              </label>

              <label>
                Amount
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="numeric"
                  pattern="\d+"
                  required
                  disabled={busy}
                />
              </label>

              <button type="submit" className="primary" disabled={busy || !destination.trim()}>
                {phaseLabel(phase)}
              </button>
            </form>

            {signature && (
              <div className="success">
                <p>Submitted</p>
                <code>{signature}</code>
                <a
                  href={`https://scan.thru.org/tx/${encodeURIComponent(signature)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in explorer
                </a>
              </div>
            )}
          </section>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label =
    status === "connected"
      ? "Connected"
      : status === "missing"
        ? "Not installed"
        : status === "connecting"
          ? "Connecting"
          : status === "checking"
            ? "Checking"
            : "Ready";

  return <span className={`pill pill-${status}`}>{label}</span>;
}

function phaseLabel(phase: TxPhase): string {
  switch (phase) {
    case "building":
      return "Building transaction…";
    case "awaiting_signature":
      return "Confirm in ThruShield…";
    case "submitting":
      return "Submitting…";
    case "done":
      return "Send another transfer";
    default:
      return "Sign & submit";
  }
}
