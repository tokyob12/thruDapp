import type { ThruWalletProvider } from "../types/thruWallet";

export function getThruWallet(): ThruWalletProvider | null {
  return window.thruWallet ?? null;
}

export function isThruShieldInstalled(): boolean {
  return typeof window.thruWallet !== "undefined";
}

/** Wait for ThruShield inpage provider (injected by the content script). */
export async function waitForThruWallet(timeoutMs = 8000): Promise<ThruWalletProvider | null> {
  const existing = getThruWallet();
  if (existing) return existing;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (wallet: ThruWalletProvider | null) => {
      if (settled) return;
      settled = true;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      window.removeEventListener("thruWallet#initialized", onReady);
      resolve(wallet);
    };

    const onReady = () => {
      finish(getThruWallet());
    };

    window.addEventListener("thruWallet#initialized", onReady);

    const timer = window.setInterval(() => {
      const wallet = getThruWallet();
      if (wallet) finish(wallet);
    }, 100);

    const timeout = window.setTimeout(() => finish(null), timeoutMs);
  });
}
