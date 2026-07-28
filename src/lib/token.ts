import {
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferInstruction,
  deriveMintAddress,
  deriveTokenAccountAddress,
  formatRawAmount,
  isAccountNotFoundError,
  parseMintAccountData,
  parseTokenAccountData,
  TICKER_MAX_LENGTH,
} from "@thru/programs/token";
import { AccountView, Filter, FilterParamValue, PageRequest, Pubkey } from "@thru/sdk";
import { StateProofType } from "@thru/sdk/proto";
import { bytesToBase64 } from "./bytes";
import { getThruClient, submitSignedTransaction } from "./thru";

/** On-chain Token Program (Alphanet). */
export const TOKEN_PROGRAM_ADDRESS =
  "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq";

export const TOKEN_TX_FEE = 1n;
export { TICKER_MAX_LENGTH, formatRawAmount };

const LAST_MINT_STORAGE_KEY = "thruConnect.lastMint";
const CREATE_DRAFT_STORAGE_KEY = "thruConnect.createDraft";
const KNOWN_MINTS_STORAGE_KEY = "thruConnect.knownMints";

/** Token account data size (mint + owner + amount + frozen). */
const TOKEN_ACCOUNT_DATA_SIZE = 73;

export type LastMint = {
  address: string;
  ticker: string;
  decimals: number;
};

export type WalletToken = {
  mint: string;
  ticker: string;
  decimals: number;
  amount: bigint;
  amountDisplay: string;
  tokenAccount: string;
  isFrozen: boolean;
};

/** In-progress create flow so each step can be signed separately. */
export type CreateDraft = {
  mintAddress: string;
  tokenAccountAddress: string;
  ticker: string;
  decimals: number;
  mintCreated: boolean;
  accountCreated: boolean;
  mintSignature?: string;
  accountSignature?: string;
  mintToSignature?: string;
};

export type SignAndSubmit = (signingPayloadBase64: string) => Promise<string>;

export type TokenStep =
  | "initialize_mint"
  | "initialize_account"
  | "mint_to"
  | "initialize_dest_account"
  | "transfer";

export type TokenProgress = {
  step: TokenStep;
  message: string;
};

function randomSeedHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a human decimal amount (e.g. "1.5") into raw token units. */
export function parseTokenAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error("Amount must be a positive number");
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Amount must be a valid decimal number");
  }
  if (decimals < 0 || decimals > 18) {
    throw new Error("Decimals must be between 0 and 18");
  }

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > decimals) {
    throw new Error(`Amount has more than ${decimals} decimal places`);
  }

  const whole = BigInt(wholePart || "0");
  const frac = BigInt(fractionPart.padEnd(decimals, "0") || "0");
  const scale = 10n ** BigInt(decimals);
  const raw = whole * scale + frac;
  if (raw <= 0n) {
    throw new Error("Amount must be greater than 0");
  }
  return raw;
}

export function loadLastMint(): LastMint | null {
  try {
    const raw = localStorage.getItem(LAST_MINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastMint;
    if (
      typeof parsed?.address === "string" &&
      typeof parsed?.ticker === "string" &&
      typeof parsed?.decimals === "number"
    ) {
      return parsed;
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

export function saveLastMint(mint: LastMint): void {
  localStorage.setItem(LAST_MINT_STORAGE_KEY, JSON.stringify(mint));
  rememberMint(mint);
}

export function loadKnownMints(): LastMint[] {
  try {
    const raw = localStorage.getItem(KNOWN_MINTS_STORAGE_KEY);
    if (!raw) {
      const last = loadLastMint();
      return last ? [last] : [];
    }
    const parsed = JSON.parse(raw) as LastMint[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (mint) =>
        typeof mint?.address === "string" &&
        typeof mint?.ticker === "string" &&
        typeof mint?.decimals === "number",
    );
  } catch {
    return [];
  }
}

export function rememberMint(mint: LastMint): void {
  const normalized: LastMint = {
    address: mint.address.trim(),
    ticker: mint.ticker.trim().toUpperCase() || "TOKEN",
    decimals: mint.decimals,
  };
  if (!normalized.address) return;

  const existing = loadKnownMints().filter((item) => item.address !== normalized.address);
  existing.unshift(normalized);
  localStorage.setItem(KNOWN_MINTS_STORAGE_KEY, JSON.stringify(existing.slice(0, 100)));
}

export function loadCreateDraft(): CreateDraft | null {
  try {
    const raw = localStorage.getItem(CREATE_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CreateDraft;
    if (
      typeof parsed?.mintAddress === "string" &&
      typeof parsed?.tokenAccountAddress === "string" &&
      typeof parsed?.ticker === "string" &&
      typeof parsed?.decimals === "number"
    ) {
      return {
        ...parsed,
        mintCreated: Boolean(parsed.mintCreated),
        accountCreated: Boolean(parsed.accountCreated),
      };
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

export function saveCreateDraft(draft: CreateDraft): void {
  localStorage.setItem(CREATE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function clearCreateDraft(): void {
  localStorage.removeItem(CREATE_DRAFT_STORAGE_KEY);
}

async function readNonce(address: string): Promise<bigint> {
  const thru = getThruClient();
  const account = await thru.accounts.get(address, { view: AccountView.META_ONLY });
  return account.meta?.nonce ?? 0n;
}

async function waitForNonceIncrease(address: string, previousNonce: bigint): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const nonce = await readNonce(address);
      if (nonce > previousNonce) return;
    } catch {
      // account read can race briefly after submit
    }
    await sleep(400);
  }
  throw new Error("Timed out waiting for transaction confirmation");
}

async function accountExists(address: string): Promise<boolean> {
  const thru = getThruClient();
  try {
    await thru.accounts.get(address, { view: AccountView.META_ONLY });
    return true;
  } catch (err) {
    if (isAccountNotFoundError(err)) return false;
    // Some RPC errors surface differently; treat missing as not found when message matches.
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("does not exist")) return false;
    throw err;
  }
}

async function buildUnsignedWire(params: {
  feePayer: string;
  instructionData: (ctx: { getAccountIndex: (pubkey: Uint8Array) => number }) => Promise<Uint8Array>;
  readWrite: Uint8Array[];
  readOnly?: Uint8Array[];
  startSlot?: bigint;
  nonce?: bigint;
}): Promise<{ signingPayloadBase64: string; nonce: bigint }> {
  const thru = getThruClient();
  const nonce = params.nonce ?? (await readNonce(params.feePayer));
  const height = await thru.blocks.getBlockHeight();
  const startSlot = params.startSlot ?? height.finalized;

  const tx = await thru.transactions.build({
    feePayer: { publicKey: params.feePayer },
    program: TOKEN_PROGRAM_ADDRESS,
    header: {
      fee: TOKEN_TX_FEE,
      nonce,
      startSlot,
      expiryAfter: 100,
      // stateUnits / memoryUnits are uint16 (max 65535) on the wire
      computeUnits: 100_000,
      stateUnits: 10_000,
      memoryUnits: 10_000,
    },
    accounts: {
      readWrite: params.readWrite,
      readOnly: params.readOnly ?? [],
    },
    instructionData: params.instructionData,
  });

  return {
    signingPayloadBase64: bytesToBase64(tx.toWire()),
    nonce,
  };
}

async function signSubmitAndConfirm(
  feePayer: string,
  signingPayloadBase64: string,
  signAndSubmit: SignAndSubmit,
  previousNonce: bigint,
): Promise<string> {
  const signature = await signAndSubmit(signingPayloadBase64);
  await waitForNonceIncrease(feePayer, previousNonce);
  return signature;
}

function normalizeTicker(ticker: string): string {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized || normalized.length > TICKER_MAX_LENGTH) {
    throw new Error(`Ticker must be 1–${TICKER_MAX_LENGTH} characters`);
  }
  return normalized;
}

function normalizeDecimals(decimals: number): number {
  if (decimals < 0 || decimals > 18 || !Number.isInteger(decimals)) {
    throw new Error("Decimals must be an integer between 0 and 18");
  }
  return decimals;
}

/** Step 1 — create the mint account (ThruShield approval). */
export async function createMintStep(
  params: {
    owner: string;
    ticker: string;
    decimals: number;
  },
  signAndSubmit: SignAndSubmit,
): Promise<CreateDraft & { signature: string }> {
  const owner = params.owner;
  const ticker = normalizeTicker(params.ticker);
  const decimals = normalizeDecimals(params.decimals);

  const thru = getThruClient();
  const ownerBytes = Pubkey.from(owner).toBytes();
  const seedHex = randomSeedHex();
  const mint = deriveMintAddress(thru, owner, seedHex, TOKEN_PROGRAM_ADDRESS);
  const tokenAccount = deriveTokenAccountAddress(
    thru,
    owner,
    mint.address,
    TOKEN_PROGRAM_ADDRESS,
  );

  const mintProof = await thru.proofs.generate({
    address: mint.address,
    proofType: StateProofType.CREATING,
  });
  const mintTx = await buildUnsignedWire({
    feePayer: owner,
    startSlot: mintProof.slot,
    readWrite: [mint.bytes],
    instructionData: createInitializeMintInstruction({
      mintAccountBytes: mint.bytes,
      decimals,
      mintAuthorityBytes: ownerBytes,
      ticker,
      seedHex,
      stateProof: mintProof.proof,
    }),
  });
  const signature = await signSubmitAndConfirm(
    owner,
    mintTx.signingPayloadBase64,
    signAndSubmit,
    mintTx.nonce,
  );

  const draft: CreateDraft = {
    mintAddress: mint.address,
    tokenAccountAddress: tokenAccount.address,
    ticker,
    decimals,
    mintCreated: true,
    accountCreated: false,
    mintSignature: signature,
  };
  saveCreateDraft(draft);
  saveLastMint({ address: mint.address, ticker, decimals });

  return { ...draft, signature };
}

/** Step 2 — create the connected wallet's token account for the draft mint. */
export async function createOwnerTokenAccountStep(
  params: {
    owner: string;
    mintAddress: string;
  },
  signAndSubmit: SignAndSubmit,
): Promise<{ signature: string; draft: CreateDraft }> {
  const { owner } = params;
  const mintAddress = params.mintAddress.trim();
  const thru = getThruClient();
  const ownerBytes = Pubkey.from(owner).toBytes();
  const mintBytes = Pubkey.from(mintAddress).toBytes();
  const tokenAccount = deriveTokenAccountAddress(
    thru,
    owner,
    mintAddress,
    TOKEN_PROGRAM_ADDRESS,
  );

  if (await accountExists(tokenAccount.address)) {
    const existing = loadCreateDraft();
    const draft: CreateDraft = {
      mintAddress,
      tokenAccountAddress: tokenAccount.address,
      ticker: existing?.ticker ?? "",
      decimals: existing?.decimals ?? 6,
      mintCreated: true,
      accountCreated: true,
      mintSignature: existing?.mintSignature,
      accountSignature: existing?.accountSignature,
      mintToSignature: existing?.mintToSignature,
    };
    saveCreateDraft(draft);
    return { signature: draft.accountSignature ?? "", draft };
  }

  const accountProof = await thru.proofs.generate({
    address: tokenAccount.address,
    proofType: StateProofType.CREATING,
  });
  const accountTx = await buildUnsignedWire({
    feePayer: owner,
    startSlot: accountProof.slot,
    readWrite: [tokenAccount.bytes],
    readOnly: [mintBytes],
    instructionData: createInitializeAccountInstruction({
      tokenAccountBytes: tokenAccount.bytes,
      mintAccountBytes: mintBytes,
      ownerAccountBytes: ownerBytes,
      seedBytes: tokenAccount.derivedSeed,
      stateProof: accountProof.proof,
    }),
  });
  const signature = await signSubmitAndConfirm(
    owner,
    accountTx.signingPayloadBase64,
    signAndSubmit,
    accountTx.nonce,
  );

  const existing = loadCreateDraft();
  const draft: CreateDraft = {
    mintAddress,
    tokenAccountAddress: tokenAccount.address,
    ticker: existing?.ticker ?? "",
    decimals: existing?.decimals ?? 6,
    mintCreated: true,
    accountCreated: true,
    mintSignature: existing?.mintSignature,
    accountSignature: signature,
    mintToSignature: existing?.mintToSignature,
  };
  saveCreateDraft(draft);

  return { signature, draft };
}

/** Step 3 — mint supply into the owner's token account. */
export async function mintToOwnerStep(
  params: {
    owner: string;
    mintAddress: string;
    amount: bigint;
  },
  signAndSubmit: SignAndSubmit,
): Promise<{ signature: string; draft: CreateDraft }> {
  const { owner, amount } = params;
  const mintAddress = params.mintAddress.trim();
  if (amount <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  const thru = getThruClient();
  const ownerBytes = Pubkey.from(owner).toBytes();
  const mintBytes = Pubkey.from(mintAddress).toBytes();
  const tokenAccount = deriveTokenAccountAddress(
    thru,
    owner,
    mintAddress,
    TOKEN_PROGRAM_ADDRESS,
  );

  if (!(await accountExists(tokenAccount.address))) {
    throw new Error("Create your token account first (step 2)");
  }

  const mintToTx = await buildUnsignedWire({
    feePayer: owner,
    readWrite: [mintBytes, tokenAccount.bytes],
    instructionData: createMintToInstruction({
      mintAccountBytes: mintBytes,
      destinationAccountBytes: tokenAccount.bytes,
      authorityAccountBytes: ownerBytes,
      amount,
    }),
  });
  const signature = await signSubmitAndConfirm(
    owner,
    mintToTx.signingPayloadBase64,
    signAndSubmit,
    mintToTx.nonce,
  );

  const existing = loadCreateDraft();
  const draft: CreateDraft = {
    mintAddress,
    tokenAccountAddress: tokenAccount.address,
    ticker: existing?.ticker ?? "",
    decimals: existing?.decimals ?? 6,
    mintCreated: true,
    accountCreated: true,
    mintSignature: existing?.mintSignature,
    accountSignature: existing?.accountSignature,
    mintToSignature: signature,
  };
  saveCreateDraft(draft);
  if (draft.ticker) {
    saveLastMint({ address: mintAddress, ticker: draft.ticker, decimals: draft.decimals });
  }

  return { signature, draft };
}

/**
 * Transfer tokens to another owner. Creates the destination token account first if needed.
 */
export async function buildTokenTransfer(
  params: {
    owner: string;
    mint: string;
    destinationOwner: string;
    amount: bigint;
  },
  signAndSubmit: SignAndSubmit,
  onProgress?: (progress: TokenProgress) => void,
): Promise<{ signatures: string[]; destinationTokenAccount: string }> {
  const { owner, amount } = params;
  const mintAddress = params.mint.trim();
  const destinationOwner = params.destinationOwner.trim();

  if (amount <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  let mintPubkey: Pubkey;
  let destOwnerPubkey: Pubkey;
  try {
    mintPubkey = Pubkey.from(mintAddress);
  } catch {
    throw new Error("Invalid mint address (expected ta… format)");
  }
  try {
    destOwnerPubkey = Pubkey.from(destinationOwner);
  } catch {
    throw new Error("Invalid destination address (expected ta… format)");
  }

  if (destOwnerPubkey.toThruFmt() === owner) {
    throw new Error("Cannot transfer to the same wallet");
  }

  const thru = getThruClient();
  const mintBytes = mintPubkey.toBytes();

  const source = deriveTokenAccountAddress(thru, owner, mintAddress, TOKEN_PROGRAM_ADDRESS);
  const destination = deriveTokenAccountAddress(
    thru,
    destinationOwner,
    mintAddress,
    TOKEN_PROGRAM_ADDRESS,
  );

  const signatures: string[] = [];

  if (!(await accountExists(destination.address))) {
    onProgress?.({
      step: "initialize_dest_account",
      message: "Creating destination token account… confirm in ThruShield",
    });
    const destProof = await thru.proofs.generate({
      address: destination.address,
      proofType: StateProofType.CREATING,
    });
    const initDestTx = await buildUnsignedWire({
      feePayer: owner,
      startSlot: destProof.slot,
      readWrite: [destination.bytes],
      readOnly: [mintBytes, destOwnerPubkey.toBytes()],
      instructionData: createInitializeAccountInstruction({
        tokenAccountBytes: destination.bytes,
        mintAccountBytes: mintBytes,
        ownerAccountBytes: destOwnerPubkey.toBytes(),
        seedBytes: destination.derivedSeed,
        stateProof: destProof.proof,
      }),
    });
    signatures.push(
      await signSubmitAndConfirm(
        owner,
        initDestTx.signingPayloadBase64,
        signAndSubmit,
        initDestTx.nonce,
      ),
    );
  }

  onProgress?.({ step: "transfer", message: "Sending tokens… confirm in ThruShield" });
  const transferTx = await buildUnsignedWire({
    feePayer: owner,
    readWrite: [source.bytes, destination.bytes],
    instructionData: createTransferInstruction({
      sourceAccountBytes: source.bytes,
      destinationAccountBytes: destination.bytes,
      amount,
    }),
  });

  signatures.push(
    await signSubmitAndConfirm(
      owner,
      transferTx.signingPayloadBase64,
      signAndSubmit,
      transferTx.nonce,
    ),
  );

  return {
    signatures,
    destinationTokenAccount: destination.address,
  };
}

/** Convenience wrapper used by the UI for a shared sign → submit helper. */
export async function signAndSubmitTransaction(
  signingPayloadBase64: string,
  signTransaction: (payload: string) => Promise<string>,
): Promise<string> {
  const signedBase64 = await signTransaction(signingPayloadBase64);
  return submitSignedTransaction(signedBase64);
}

export async function fetchMintInfo(mintAddress: string) {
  const thru = getThruClient();
  const account = await thru.accounts.get(mintAddress, { view: AccountView.FULL });
  return parseMintAccountData(account);
}

export async function fetchTokenBalance(owner: string, mintAddress: string) {
  const thru = getThruClient();
  const tokenAccount = deriveTokenAccountAddress(
    thru,
    owner,
    mintAddress,
    TOKEN_PROGRAM_ADDRESS,
  );
  try {
    const account = await thru.accounts.get(tokenAccount.address, { view: AccountView.FULL });
    return {
      address: tokenAccount.address,
      ...parseTokenAccountData(account),
    };
  } catch (err) {
    if (isAccountNotFoundError(err)) {
      return { address: tokenAccount.address, mint: mintAddress, owner, amount: 0n, isFrozen: false };
    }
    throw err;
  }
}

async function resolveMintMeta(
  mintAddress: string,
  cache: Map<string, { ticker: string; decimals: number }>,
): Promise<{ ticker: string; decimals: number }> {
  const cached = cache.get(mintAddress);
  if (cached) return cached;

  try {
    const info = await fetchMintInfo(mintAddress);
    const meta = {
      ticker: info.ticker || "TOKEN",
      decimals: info.decimals,
    };
    cache.set(mintAddress, meta);
    rememberMint({ address: mintAddress, ...meta });
    return meta;
  } catch {
    const known = loadKnownMints().find((mint) => mint.address === mintAddress);
    const meta = {
      ticker: known?.ticker || "TOKEN",
      decimals: known?.decimals ?? 6,
    };
    cache.set(mintAddress, meta);
    return meta;
  }
}

async function fetchWalletTokenForMint(
  owner: string,
  mintAddress: string,
  mintCache: Map<string, { ticker: string; decimals: number }>,
): Promise<WalletToken | null> {
  const thru = getThruClient();
  const tokenAccount = deriveTokenAccountAddress(
    thru,
    owner,
    mintAddress,
    TOKEN_PROGRAM_ADDRESS,
  );

  try {
    const account = await thru.accounts.get(tokenAccount.address, { view: AccountView.FULL });
    const parsed = parseTokenAccountData(account);
    if (parsed.owner !== owner) return null;
    const meta = await resolveMintMeta(mintAddress, mintCache);
    return {
      mint: mintAddress,
      ticker: meta.ticker,
      decimals: meta.decimals,
      amount: parsed.amount,
      amountDisplay: formatRawAmount(parsed.amount, meta.decimals),
      tokenAccount: tokenAccount.address,
      isFrozen: parsed.isFrozen,
    };
  } catch (err) {
    if (isAccountNotFoundError(err)) return null;
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("does not exist")) return null;
    throw err;
  }
}

/**
 * List fungible tokens held by a wallet.
 * Uses known mints (local) plus an optional Token Program account scan when RPC allows it.
 */
export async function listWalletTokens(owner: string): Promise<WalletToken[]> {
  const thru = getThruClient();
  const mintCache = new Map<string, { ticker: string; decimals: number }>();
  const byMint = new Map<string, WalletToken>();

  // 1) Known / watched mints (always works with GetAccount)
  const known = loadKnownMints();
  const last = loadLastMint();
  if (last && !known.some((mint) => mint.address === last.address)) {
    known.unshift(last);
  }
  for (const mint of known) {
    mintCache.set(mint.address, { ticker: mint.ticker, decimals: mint.decimals });
  }

  await Promise.all(
    known.map(async (mint) => {
      try {
        const token = await fetchWalletTokenForMint(owner, mint.address, mintCache);
        if (token && token.amount > 0n) {
          byMint.set(token.mint, token);
        } else if (token) {
          // Keep zero balances for mints the user explicitly tracked
          byMint.set(token.mint, token);
        }
      } catch {
        // skip unreachable mint
      }
    }),
  );

  // 2) Best-effort discovery: accounts owned by the Token Program with token-account size
  try {
    let pageToken: string | undefined;
    let pages = 0;
    const maxPages = 20;

    do {
      const result = await thru.accounts.list({
        view: AccountView.FULL,
        filter: new Filter({
          expression: "account.meta.owner.value == params.program",
          params: {
            program: FilterParamValue.bytes(Pubkey.from(TOKEN_PROGRAM_ADDRESS).toBytes()),
          },
        }),
        page: new PageRequest({ pageSize: 100, pageToken }),
      });

      for (const account of result.accounts) {
        const data = account.data?.data;
        const dataSize = Number(account.meta?.dataSize ?? data?.length ?? 0);
        if (!data || dataSize !== TOKEN_ACCOUNT_DATA_SIZE) continue;
        try {
          const parsed = parseTokenAccountData(account);
          if (parsed.owner !== owner) continue;
          if (byMint.has(parsed.mint)) continue;
          const meta = await resolveMintMeta(parsed.mint, mintCache);
          byMint.set(parsed.mint, {
            mint: parsed.mint,
            ticker: meta.ticker,
            decimals: meta.decimals,
            amount: parsed.amount,
            amountDisplay: formatRawAmount(parsed.amount, meta.decimals),
            tokenAccount: account.address.toThruFmt(),
            isFrozen: parsed.isFrozen,
          });
        } catch {
          // not a token account / parse failure
        }
      }

      pageToken = result.page?.nextPageToken;
      pages += 1;
    } while (pageToken && pages < maxPages);
  } catch {
    // Public RPC may deny ListAccounts — known-mint path still works.
  }

  return Array.from(byMint.values()).sort((a, b) => {
    if (a.amount === b.amount) return a.ticker.localeCompare(b.ticker);
    return a.amount > b.amount ? -1 : 1;
  });
}
