import { useCallback, useEffect, useState } from "react";
import type { ConnectedAccount, ThruSigningContext } from "../types/thruWallet";
import { waitForThruWallet } from "../lib/wallet";

type WalletStatus = "checking" | "missing" | "ready" | "connecting" | "connected";

function formatWalletError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Failed to connect wallet";

  if (/unlock/i.test(message)) {
    return "Unlock ThruShield in the extension popup, then click Connect Wallet again.";
  }
  if (/rejected/i.test(message)) {
    return "Connection rejected in ThruShield.";
  }
  if (/timed out/i.test(message)) {
    return "Wallet request timed out. Keep ThruShield unlocked and approve the popup.";
  }
  return message;
}

export function useThruWallet() {
  const [status, setStatus] = useState<WalletStatus>("checking");
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [signingContext, setSigningContext] = useState<ThruSigningContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  const publicKey = accounts[0]?.publicKey ?? null;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const wallet = await waitForThruWallet();
      if (cancelled) return;

      if (!wallet) {
        setStatus("missing");
        return;
      }

      if (wallet.isConnected()) {
        try {
          const context = await wallet.getSigningContext();
          if (cancelled) return;
          setSigningContext(context);
          const key = context.selectedAccountPublicKey ?? context.signerPublicKey;
          setAccounts([{ publicKey: key }]);
          setStatus("connected");
          return;
        } catch {
          // Connected flag can be stale after reload — treat as ready to connect.
        }
      }

      setStatus("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setStatus("connecting");

    const wallet = await waitForThruWallet();
    if (!wallet) {
      setStatus("missing");
      setError(
        "ThruShield was not detected on this page. Load the rebuilt extension, unlock it, then reload this tab.",
      );
      return;
    }

    try {
      const connected = await wallet.connect();
      if (!Array.isArray(connected) || connected.length === 0 || !connected[0]?.publicKey) {
        throw new Error("ThruShield returned no account. Unlock the wallet and try again.");
      }

      const context = await wallet.getSigningContext();
      setAccounts(connected);
      setSigningContext(context);
      setStatus("connected");
    } catch (err) {
      setStatus("ready");
      setError(formatWalletError(err));
    }
  }, []);

  const disconnect = useCallback(async () => {
    setError(null);
    const wallet = await waitForThruWallet();
    if (!wallet) {
      setAccounts([]);
      setSigningContext(null);
      setStatus("missing");
      return;
    }

    try {
      await wallet.disconnect();
    } catch (err) {
      setError(formatWalletError(err));
    } finally {
      setAccounts([]);
      setSigningContext(null);
      setStatus("ready");
    }
  }, []);

  const signTransaction = useCallback(async (payloadBase64: string): Promise<string> => {
    const wallet = await waitForThruWallet();
    if (!wallet) {
      throw new Error("ThruShield extension not found");
    }
    if (!wallet.isConnected()) {
      throw new Error("Wallet not connected");
    }
    return wallet.signTransaction(payloadBase64);
  }, []);

  return {
    status,
    accounts,
    publicKey,
    signingContext,
    error,
    setError,
    connect,
    disconnect,
    signTransaction,
  };
}
