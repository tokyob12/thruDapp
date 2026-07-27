export type ThruSigningContext = {
  mode: "managed_fee_payer";
  selectedAccountPublicKey: string | null;
  feePayerPublicKey: string;
  signerPublicKey: string;
  acceptedInputEncodings: [
    "signing_payload_base64",
    "raw_transaction_base64",
    "transaction_intent",
  ];
  outputEncoding: "raw_transaction_base64";
};

export type ThruTransactionIntent = {
  programAddress: string;
  instructionData: string;
  readWriteAddresses?: string[];
  readOnlyAddresses?: string[];
  walletAddress?: string;
};

export type ConnectedAccount = {
  publicKey: string;
};

export type ThruWalletProvider = {
  isConnected(): boolean;
  connect(): Promise<ConnectedAccount[]>;
  disconnect(): Promise<void>;
  getSigningContext(): Promise<ThruSigningContext>;
  /** Signs base64 wire bytes or a ThruTransactionIntent; returns signed raw tx as base64. */
  signTransaction(input: string | ThruTransactionIntent): Promise<string>;
};

declare global {
  interface Window {
    thruWallet?: ThruWalletProvider;
  }
}

export {};
