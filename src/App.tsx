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
import {
  buildTokenTransfer,
  clearCreateDraft,
  createMintStep,
  createOwnerTokenAccountStep,
  fetchMintInfo,
  formatRawAmount,
  listWalletTokens,
  loadCreateDraft,
  loadLastMint,
  mintToOwnerStep,
  parseTokenAmount,
  rememberMint,
  TICKER_MAX_LENGTH,
  TOKEN_TX_FEE,
  type CreateDraft,
  type LastMint,
  type WalletToken,
} from "./lib/token";
import "./App.css";

type TxPhase = "idle" | "building" | "awaiting_signature" | "submitting" | "done";
type CreateStepId = 1 | 2 | 3;

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

  const [ticker, setTicker] = useState(() => loadCreateDraft()?.ticker || "THRU");
  const [decimals, setDecimals] = useState(() => String(loadCreateDraft()?.decimals ?? 6));
  const [mintAmount, setMintAmount] = useState("1000");
  const [createPhase, setCreatePhase] = useState<TxPhase>("idle");
  const [activeCreateStep, setActiveCreateStep] = useState<CreateStepId | null>(null);
  const [createStatus, setCreateStatus] = useState<string | null>(() => {
    const draft = loadCreateDraft();
    if (!draft?.mintCreated) return null;
    if (!draft.accountCreated) return "Step 1 done — continue with step 2 when ready.";
    if (!draft.mintToSignature) return "Step 2 done — continue with step 3 when ready.";
    return "All steps completed. You can mint more or start a new token.";
  });
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(() => loadCreateDraft());
  const [createdMint, setCreatedMint] = useState<LastMint | null>(() => loadLastMint());
  const [createSignatures, setCreateSignatures] = useState<string[]>(() => {
    const draft = loadCreateDraft();
    return [draft?.mintSignature, draft?.accountSignature, draft?.mintToSignature].filter(
      (sig): sig is string => Boolean(sig),
    );
  });

  const [tokenMint, setTokenMint] = useState(() => loadLastMint()?.address ?? "");
  const [tokenDestination, setTokenDestination] = useState("");
  const [tokenAmount, setTokenAmount] = useState("1");
  const [tokenDecimals, setTokenDecimals] = useState(() =>
    String(loadLastMint()?.decimals ?? 6),
  );
  const [sendPhase, setSendPhase] = useState<TxPhase>("idle");
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sendSignatures, setSendSignatures] = useState<string[]>([]);

  const [walletTokens, setWalletTokens] = useState<WalletToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [watchMint, setWatchMint] = useState("");
  const [tokensRefreshKey, setTokensRefreshKey] = useState(0);

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
  }, [publicKey, setError, signature, createSignatures, sendSignatures]);

  useEffect(() => {
    if (!publicKey) {
      setWalletTokens([]);
      setTokensError(null);
      return;
    }

    let cancelled = false;
    setTokensLoading(true);
    setTokensError(null);

    void (async () => {
      try {
        const tokens = await listWalletTokens(publicKey);
        if (!cancelled) setWalletTokens(tokens);
      } catch (err) {
        if (!cancelled) {
          setWalletTokens([]);
          setTokensError(err instanceof Error ? err.message : "Failed to load tokens");
        }
      } finally {
        if (!cancelled) setTokensLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey, tokensRefreshKey, createSignatures, sendSignatures]);

  function refreshTokens() {
    setTokensRefreshKey((value) => value + 1);
  }

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

  async function runCreateSignAndSubmit(payload: string): Promise<string> {
    setCreatePhase("awaiting_signature");
    const signed = await signTransaction(payload);
    setCreatePhase("submitting");
    return submitSignedTransaction(signed);
  }

  function syncDraft(draft: CreateDraft) {
    setCreateDraft(draft);
    const mintInfo: LastMint = {
      address: draft.mintAddress,
      ticker: draft.ticker || createdMint?.ticker || ticker,
      decimals: draft.decimals,
    };
    setCreatedMint(mintInfo);
    rememberMint(mintInfo);
    setTokenMint(draft.mintAddress);
    setTokenDecimals(String(draft.decimals));
    setCreateSignatures(
      [draft.mintSignature, draft.accountSignature, draft.mintToSignature].filter(
        (sig): sig is string => Boolean(sig),
      ),
    );
    refreshTokens();
  }

  async function handleWatchMint(event: FormEvent) {
    event.preventDefault();
    const mintAddress = watchMint.trim();
    if (!mintAddress) return;

    setError(null);
    try {
      const info = await fetchMintInfo(mintAddress);
      rememberMint({
        address: mintAddress,
        ticker: info.ticker || "TOKEN",
        decimals: info.decimals,
      });
      setTokenMint(mintAddress);
      setTokenDecimals(String(info.decimals));
      setWatchMint("");
      refreshTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load mint");
    }
  }

  async function handleCreateMint() {
    if (!publicKey) return;
    setError(null);

    const decimalsNum = Number(decimals);
    if (!Number.isInteger(decimalsNum) || decimalsNum < 0 || decimalsNum > 18) {
      setError("Decimals must be an integer between 0 and 18");
      return;
    }

    try {
      setActiveCreateStep(1);
      setCreatePhase("building");
      setCreateStatus("Step 1 — Creating mint… confirm in ThruShield");
      const draft = await createMintStep(
        { owner: publicKey, ticker, decimals: decimalsNum },
        runCreateSignAndSubmit,
      );
      syncDraft(draft);
      setCreateStatus(`Step 1 done — mint ${draft.ticker} created. Continue with step 2 when ready.`);
      setCreatePhase("done");
    } catch (err) {
      setCreatePhase("idle");
      setCreateStatus(null);
      setError(err instanceof Error ? err.message : "Create mint failed");
    } finally {
      setActiveCreateStep(null);
    }
  }

  async function handleCreateTokenAccount() {
    if (!publicKey) return;
    const mintAddress = createDraft?.mintAddress ?? createdMint?.address;
    if (!mintAddress) {
      setError("Create the mint first (step 1)");
      return;
    }

    setError(null);
    try {
      setActiveCreateStep(2);
      setCreatePhase("building");
      setCreateStatus("Step 2 — Creating your token account… confirm in ThruShield");
      const { draft } = await createOwnerTokenAccountStep(
        { owner: publicKey, mintAddress },
        runCreateSignAndSubmit,
      );
      syncDraft(draft);
      setCreateStatus("Step 2 done — token account ready. Continue with step 3 when ready.");
      setCreatePhase("done");
    } catch (err) {
      setCreatePhase("idle");
      setCreateStatus(null);
      setError(err instanceof Error ? err.message : "Create token account failed");
    } finally {
      setActiveCreateStep(null);
    }
  }

  async function handleMintSupply() {
    if (!publicKey) return;
    const mintAddress = createDraft?.mintAddress ?? createdMint?.address;
    if (!mintAddress) {
      setError("Create the mint first (step 1)");
      return;
    }
    if (!(createDraft?.accountCreated ?? false)) {
      setError("Create your token account first (step 2)");
      return;
    }

    const decimalsNum = Number(createDraft?.decimals ?? decimals);
    setError(null);
    try {
      const rawAmount = parseTokenAmount(mintAmount, decimalsNum);
      setActiveCreateStep(3);
      setCreatePhase("building");
      setCreateStatus("Step 3 — Minting supply… confirm in ThruShield");
      const { draft } = await mintToOwnerStep(
        { owner: publicKey, mintAddress, amount: rawAmount },
        runCreateSignAndSubmit,
      );
      syncDraft(draft);
      setCreateStatus(
        `Step 3 done — minted ${formatRawAmount(rawAmount, decimalsNum)} ${draft.ticker || ""}`.trim(),
      );
      setCreatePhase("done");
    } catch (err) {
      setCreatePhase("idle");
      setCreateStatus(null);
      setError(err instanceof Error ? err.message : "Mint supply failed");
    } finally {
      setActiveCreateStep(null);
    }
  }

  function handleStartNewToken() {
    clearCreateDraft();
    setCreateDraft(null);
    setCreateSignatures([]);
    setCreateStatus(null);
    setCreatePhase("idle");
    setError(null);
  }

  async function handleSendToken(event: FormEvent) {
    event.preventDefault();
    if (!publicKey) return;

    setError(null);
    setSendSignatures([]);
    setSendStatus(null);

    const decimalsNum = Number(tokenDecimals);
    if (!Number.isInteger(decimalsNum) || decimalsNum < 0 || decimalsNum > 18) {
      setError("Token decimals must be an integer between 0 and 18");
      return;
    }

    try {
      const rawAmount = parseTokenAmount(tokenAmount, decimalsNum);
      rememberMint({
        address: tokenMint.trim(),
        ticker: createdMint?.ticker || "TOKEN",
        decimals: decimalsNum,
      });
      setSendPhase("building");
      setSendStatus("Building token transfer…");

      const result = await buildTokenTransfer(
        {
          owner: publicKey,
          mint: tokenMint,
          destinationOwner: tokenDestination,
          amount: rawAmount,
        },
        async (payload) => {
          setSendPhase("awaiting_signature");
          const signed = await signTransaction(payload);
          setSendPhase("submitting");
          return submitSignedTransaction(signed);
        },
        (progress) => {
          setSendStatus(progress.message);
          setSendPhase("awaiting_signature");
        },
      );

      setSendSignatures(result.signatures);
      setSendStatus("Token transfer submitted");
      setSendPhase("done");
    } catch (err) {
      setSendPhase("idle");
      setSendStatus(null);
      setError(err instanceof Error ? err.message : "Token transfer failed");
    }
  }

  const nativeBusy =
    phase === "building" || phase === "awaiting_signature" || phase === "submitting";
  const createBusy =
    createPhase === "building" ||
    createPhase === "awaiting_signature" ||
    createPhase === "submitting";
  const sendBusy =
    sendPhase === "building" ||
    sendPhase === "awaiting_signature" ||
    sendPhase === "submitting";
  const anyBusy = nativeBusy || createBusy || sendBusy;

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
          <h1>Connect wallet. Create tokens. Sign transfers.</h1>
          <p>
            This page talks to the ThruShield Chrome extension via{" "}
            <code>window.thruWallet</code>, builds unsigned transactions with{" "}
            <code>@thru/sdk</code> and <code>@thru/programs/token</code>, asks the wallet to
            sign, then submits the raw bytes.
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

        {status === "connected" && publicKey && (
          <section className="panel" aria-label="Wallet tokens">
            <div className="panel-head">
              <h2>Your tokens</h2>
              <button
                type="button"
                className="ghost ghost-compact"
                disabled={tokensLoading || anyBusy}
                onClick={refreshTokens}
              >
                {tokensLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            <p className="muted tokens-hint">
              Shows token balances for this connected wallet. Tokens you create or watch here are
              tracked automatically.
            </p>

            {tokensError && (
              <p className="error" role="alert">
                {tokensError}
              </p>
            )}

            {tokensLoading && walletTokens.length === 0 ? (
              <p className="status-line">Loading token balances…</p>
            ) : walletTokens.length === 0 ? (
              <p className="status-line">
                No tokens found yet. Create one below, or watch a mint address.
              </p>
            ) : (
              <ul className="token-list">
                {walletTokens.map((token) => (
                  <li key={token.mint}>
                    <div className="token-row">
                      <div>
                        <p className="token-ticker">
                          {token.ticker}
                          {token.isFrozen ? " · frozen" : ""}
                        </p>
                        <p className="token-mint" title={token.mint}>
                          {shortenAddress(token.mint, 8)}
                        </p>
                      </div>
                      <div className="token-amount">
                        <p>{token.amountDisplay}</p>
                        <button
                          type="button"
                          className="ghost ghost-compact"
                          disabled={anyBusy}
                          onClick={() => {
                            setTokenMint(token.mint);
                            setTokenDecimals(String(token.decimals));
                          }}
                        >
                          Use in Send
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <form className="form watch-form" onSubmit={(event) => void handleWatchMint(event)}>
              <label>
                Watch mint
                <input
                  value={watchMint}
                  onChange={(event) => setWatchMint(event.target.value)}
                  placeholder="ta… mint address"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={anyBusy || tokensLoading}
                />
              </label>
              <button
                type="submit"
                className="ghost"
                disabled={anyBusy || tokensLoading || !watchMint.trim()}
              >
                Add mint
              </button>
            </form>
          </section>
        )}

        {status === "connected" && (
          <div className="panel-grid">
            <section className="panel" aria-label="Sign transfer">
              <div className="panel-head">
                <h2>Transfer THRU</h2>
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
                    disabled={anyBusy}
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
                    disabled={anyBusy}
                  />
                </label>

                <button type="submit" className="primary" disabled={anyBusy || !destination.trim()}>
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

            <section className="panel" aria-label="Create token">
              <div className="panel-head">
                <h2>Create token</h2>
                <p className="muted">Fee = {TOKEN_TX_FEE.toString()} per step</p>
              </div>

              <div className="flow-note">
                <p>
                  Run each step with its own button. You choose when to sign — skip or stop anytime.
                </p>
                <ol>
                  <li>
                    <strong>Create mint</strong> — registers the token (ticker, decimals, authority)
                  </li>
                  <li>
                    <strong>Create token account</strong> — your balance account for this mint
                  </li>
                  <li>
                    <strong>Mint supply</strong> — credits the amount below to your account
                  </li>
                </ol>
              </div>

              <div className="form">
                <label>
                  Token name / ticker
                  <input
                    value={ticker}
                    onChange={(event) => setTicker(event.target.value.slice(0, TICKER_MAX_LENGTH))}
                    placeholder="MYTOKEN"
                    maxLength={TICKER_MAX_LENGTH}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={anyBusy || Boolean(createDraft?.mintCreated)}
                  />
                </label>

                <label>
                  Decimals
                  <input
                    value={decimals}
                    onChange={(event) => setDecimals(event.target.value)}
                    inputMode="numeric"
                    pattern="\d+"
                    disabled={anyBusy || Boolean(createDraft?.mintCreated)}
                  />
                </label>

                <label>
                  Mint amount (step 3)
                  <input
                    value={mintAmount}
                    onChange={(event) => setMintAmount(event.target.value)}
                    inputMode="decimal"
                    disabled={anyBusy}
                  />
                </label>

                <div className="step-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={anyBusy || !ticker.trim() || Boolean(createDraft?.mintCreated)}
                    onClick={() => void handleCreateMint()}
                  >
                    {stepButtonLabel(1, activeCreateStep, createPhase, createDraft?.mintCreated)}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      anyBusy || !createDraft?.mintCreated || Boolean(createDraft?.accountCreated)
                    }
                    onClick={() => void handleCreateTokenAccount()}
                  >
                    {stepButtonLabel(2, activeCreateStep, createPhase, createDraft?.accountCreated)}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={anyBusy || !createDraft?.accountCreated}
                    onClick={() => void handleMintSupply()}
                  >
                    {stepButtonLabel(3, activeCreateStep, createPhase, Boolean(createDraft?.mintToSignature))}
                  </button>
                </div>

                {createDraft?.mintCreated && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={anyBusy}
                    onClick={handleStartNewToken}
                  >
                    Start a new token
                  </button>
                )}
              </div>

              {createStatus && <p className="status-line">{createStatus}</p>}

              {createdMint && (
                <div className="success">
                  <p>
                    Mint · {createdMint.ticker} ({createdMint.decimals} decimals)
                  </p>
                  <code title={createdMint.address}>{shortenAddress(createdMint.address, 10)}</code>
                  <a
                    href={`https://scan.thru.org/address/${encodeURIComponent(createdMint.address)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open mint in explorer
                  </a>
                  {createSignatures.length > 0 && (
                    <ul className="sig-list">
                      {createSignatures.map((sig, index) => (
                        <li key={sig}>
                          <a
                            href={`https://scan.thru.org/tx/${encodeURIComponent(sig)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Tx {index + 1}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            <section className="panel" aria-label="Send token">
              <div className="panel-head">
                <h2>Send token</h2>
                <p className="muted">1–2 ThruShield approvals</p>
              </div>

              <div className="flow-note">
                <p>
                  Usually <strong>1 approval</strong> to transfer. If the recipient has never held
                  this token, ThruShield will ask once more to create their token account first.
                </p>
              </div>

              <form className="form" onSubmit={(event) => void handleSendToken(event)}>
                <label>
                  Mint
                  <input
                    value={tokenMint}
                    onChange={(event) => setTokenMint(event.target.value)}
                    placeholder="ta…"
                    spellCheck={false}
                    autoComplete="off"
                    required
                    disabled={anyBusy}
                  />
                </label>

                <label>
                  Destination owner
                  <input
                    value={tokenDestination}
                    onChange={(event) => setTokenDestination(event.target.value)}
                    placeholder="ta…"
                    spellCheck={false}
                    autoComplete="off"
                    required
                    disabled={anyBusy}
                  />
                </label>

                <label>
                  Decimals
                  <input
                    value={tokenDecimals}
                    onChange={(event) => setTokenDecimals(event.target.value)}
                    inputMode="numeric"
                    pattern="\d+"
                    required
                    disabled={anyBusy}
                  />
                </label>

                <label>
                  Amount
                  <input
                    value={tokenAmount}
                    onChange={(event) => setTokenAmount(event.target.value)}
                    inputMode="decimal"
                    required
                    disabled={anyBusy}
                  />
                </label>

                <button
                  type="submit"
                  className="primary"
                  disabled={anyBusy || !tokenMint.trim() || !tokenDestination.trim()}
                >
                  {sendPhaseLabel(sendPhase)}
                </button>
              </form>

              {sendStatus && <p className="status-line">{sendStatus}</p>}

              {sendSignatures.length > 0 && (
                <div className="success">
                  <p>Submitted</p>
                  <ul className="sig-list">
                    {sendSignatures.map((sig, index) => (
                      <li key={sig}>
                        <a
                          href={`https://scan.thru.org/tx/${encodeURIComponent(sig)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Tx {index + 1}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </div>
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

function stepButtonLabel(
  step: CreateStepId,
  activeStep: CreateStepId | null,
  phase: TxPhase,
  done?: boolean,
): string {
  const titles = {
    1: "1. Create mint",
    2: "2. Create token account",
    3: "3. Mint supply",
  } as const;

  if (done && activeStep !== step) {
    return step === 3 ? "3. Mint more" : `${titles[step]} ✓`;
  }

  if (activeStep === step) {
    switch (phase) {
      case "building":
        return "Building…";
      case "awaiting_signature":
        return "Confirm in ThruShield…";
      case "submitting":
        return "Submitting…";
      default:
        break;
    }
  }

  return titles[step];
}

function sendPhaseLabel(phase: TxPhase): string {
  switch (phase) {
    case "building":
      return "Building…";
    case "awaiting_signature":
      return "Confirm in ThruShield…";
    case "submitting":
      return "Submitting…";
    case "done":
      return "Send again";
    default:
      return "Sign & send token";
  }
}
