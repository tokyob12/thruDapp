# Thru Connect

Demo dApp that connects to the [ThruShield](https://github.com/tokyob12/thrushield-wallet) Chrome extension, signs a native Thru transfer, and submits it to Alphanet.

## Flow

1. ThruShield injects `window.thruWallet`
2. dApp calls `connect()` → user approves in the extension
3. dApp builds an unsigned transfer with `@thru/sdk`
4. dApp calls `signTransaction(base64)` → user confirms in ThruShield
5. dApp submits the signed raw bytes to `https://rpc.alphanet.thru.org`

## Prerequisites

- Chrome with ThruShield loaded (Developer mode → Load unpacked)
- Wallet unlocked and funded on Alphanet (use ThruShield faucet if needed)

## Run

```bash
npm install
npm run dev
```

Open the printed localhost URL, click **Connect ThruShield**, then send a transfer.

## Notes

- This uses ThruShield’s raw payload signing API (`raw_transaction_base64` / `signing_payload_base64`).
- Official Thru dApps using `@thru/wallet` send a transaction **intent** instead; that path targets the hosted wallet at `wallet.thru.org`.
