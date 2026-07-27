import { AccountView, createThruClient, Pubkey, type Thru } from "@thru/sdk";
import { base64ToBytes, bytesToBase64 } from "./bytes";

export const THRU_RPC_URL = "https://rpc.alphanet.thru.org";
export const NATIVE_TRANSFER_FEE = 1n;

/** EOA program pubkey (all zeros) — native balance transfers. */
export const EOA_PROGRAM = new Uint8Array(32);

let client: Thru | null = null;

export function getThruClient(): Thru {
  if (!client) {
    client = createThruClient({ baseUrl: THRU_RPC_URL });
  }
  return client;
}

function encodeU16Le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function encodeU32Le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function encodeU64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** EOA TRANSFER: discriminant=1, amount, from_idx, to_idx */
export function buildEoaTransferInstruction(
  fromAccountIdx: number,
  toAccountIdx: number,
  amount: bigint,
): Uint8Array {
  return concatBytes(
    encodeU32Le(1),
    encodeU64Le(amount),
    encodeU16Le(fromAccountIdx),
    encodeU16Le(toAccountIdx),
  );
}

export type AccountBalance = {
  address: string;
  exists: boolean;
  balance: string;
  nonce: string;
};

export async function getAccountBalance(address: string): Promise<AccountBalance> {
  const thru = getThruClient();
  try {
    const account = await thru.accounts.get(address, { view: AccountView.META_ONLY });
    return {
      address,
      exists: true,
      balance: (account.meta?.balance ?? 0n).toString(),
      nonce: (account.meta?.nonce ?? 0n).toString(),
    };
  } catch {
    return { address, exists: false, balance: "0", nonce: "0" };
  }
}

/**
 * Build an unsigned native transfer for ThruShield to sign.
 * Account layout: [0 fee_payer/from, 1 program, 2 destination]
 */
export async function buildNativeTransfer(params: {
  fromAddress: string;
  destination: string;
  amount: bigint;
}): Promise<{ signingPayloadBase64: string; fee: bigint }> {
  const { fromAddress, destination, amount } = params;

  if (amount <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  let destinationPubkey: Pubkey;
  try {
    destinationPubkey = Pubkey.from(destination.trim());
  } catch {
    throw new Error("Invalid destination address (expected ta… format)");
  }

  if (destinationPubkey.toThruFmt() === fromAddress) {
    throw new Error("Cannot transfer to the same account");
  }

  const thru = getThruClient();
  const account = await thru.accounts.get(fromAddress, { view: AccountView.META_ONLY });
  const balance = account.meta?.balance ?? 0n;
  const nonce = account.meta?.nonce ?? 0n;
  const totalRequired = amount + NATIVE_TRANSFER_FEE;

  if (balance < totalRequired) {
    throw new Error(
      `Insufficient balance. Need ${totalRequired} (amount ${amount} + fee ${NATIVE_TRANSFER_FEE}), have ${balance}`,
    );
  }

  const height = await thru.blocks.getBlockHeight();

  const tx = await thru.transactions.build({
    feePayer: { publicKey: fromAddress },
    program: EOA_PROGRAM,
    header: {
      fee: NATIVE_TRANSFER_FEE,
      nonce,
      startSlot: height.finalized,
      expiryAfter: 100,
      computeUnits: 10_000,
      stateUnits: 10_000,
      memoryUnits: 10_000,
    },
    accounts: {
      readWrite: [destinationPubkey],
      readOnly: [],
    },
    instructionData: buildEoaTransferInstruction(0, 2, amount),
  });

  return {
    // Prefer full wire (zero signature slot) so wallets using Transaction.fromWire accept it.
    // ThruShield also accepts toWireForSigning() payloads.
    signingPayloadBase64: bytesToBase64(tx.toWire()),
    fee: NATIVE_TRANSFER_FEE,
  };
}

export async function submitSignedTransaction(signedBase64: string): Promise<string> {
  const thru = getThruClient();
  return thru.transactions.send(base64ToBytes(signedBase64));
}
