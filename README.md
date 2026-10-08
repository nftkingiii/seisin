<img src="docs/wordmark.svg" alt="Seisin" width="280">

# Seisin

**Proof of who holds what in a Zcash asset registry, without learning who they are.**

Collections sold on Zcash today, such as the zkSNARKs identities on Zilkroad, record ownership as a row in the marketplace's database: the buyer pays ZEC with a memo, and the operator writes "token → address". Zcash Shielded Assets are not on mainnet yet, so nothing on chain can hold, move or prove these tokens. Nobody outside the operator can check the supply, a holder's claim, or whether a token moved with its owner's consent.

Seisin makes that index checkable by anyone, while keeping holders private:

- **Fixed supply.** Every record commits to exactly `supply` tokens; changes only replace owners.
- **Owner consent.** A token moves only with a signature from its current one-time owner key. The operator cannot move it alone.
- **Checkable history.** Each record commits to the previous record and to the signed changes that produced it. Anyone can replay the public log and reproduce every record.
- **Locked on Zcash.** Each record is written into the memo of a shielded Zcash mainnet note sent to the registry's lock (anchor) address. Your browser checks that note against the raw transaction with no viewing key.
- **Private proof of holding.** A holder proves they hold a token by answering a verifier's one-time challenge. No Zcash address or other token is revealed.

The full protocol and the privacy boundary (what anyone, the operator and a verifier can and cannot see, plus the known leaks) are in [SPEC.md](SPEC.md).

## What is real and what is demo

| | Status |
|---|---|
| Anchors | **Real, Zcash mainnet.** Epoch 0: [`d455a8d2…71a2`](https://blockchair.com/zcash/transaction/d455a8d2daa6bdb67d7f82fdf9f04df9c8b96f54a30c524add95c8148c1471a2), height 3,501,709. Epoch 1: [`aef09300…6f2d`](https://blockchair.com/zcash/transaction/aef09300bba856b4b2996e5c82454196961ea0aaf334c8eccec66b8e765c6f2d), height 3,501,716. Epoch 2: [`a4d7e5f8…a6ee`](https://blockchair.com/zcash/transaction/a4d7e5f8acebe034ab00d00d1263f66633cd97b3db7882a42de8f7219bf2a6ee), height 3,510,437, paid by the locker on its own. All are Ironwood notes with the record in the memo. |
| Keyless anchor check | **Real.** The browser fetches the transaction bytes from mainnet and checks the note and memo with [zcash-delivery-proof](https://github.com/saplingcash/zcash-delivery-proof) (vendored WASM, pinned commit and hash in `vendor/zcash-delivery-proof/SOURCE.md`). |
| Transfers, proofs, audit | **Real.** Ed25519 signatures, a Merkle tree and a hash-chained log, all checked in the browser. |
| The `deeds` collection | **Demo.** Tokens are handed out free ("demo issuance") so anyone can try the flow. A real collection would sell each token's first transfer for ZEC. |
| Paid first sales | **Built and tested, not switched on in the live deployment.** A buyer pays ZEC to the collection's sales address with a memo naming a fresh key from their vault; the server reads it with the sales viewing key and sets the transfer's `ref` to the hash of the payment's delivery proof. A token taken before the payment arrives is marked for refund. |
| Payment ↔ transfer binding | **Only for sales.** A sold transfer's `ref` binds its payment, but the protocol still accepts a change without one. |
| Publishing records | **Automatic.** Signed changes are published as a new record every 5 minutes. |
| Locking on Zcash | **Automatic, on mainnet.** A small capped wallet service (`locker/`) locks each new record as soon as it is published: at most 3 locks a day, at least 3 hours apart, about 0.00011 ZEC each. Record 2 was its first lock. The operator can still pay a lock by hand from any Zcash wallet (the Operator tab shows the request as a QR code). A proof passes only against a locked record. |
| Claim codes | **Real, not yet used on mainnet.** The flow is built and tested; no claim payment has been sent yet. |

## Try it

**One click:** open **Verify** and press **See it work**. It creates a challenge, answers it with the public demo vault, and checks the answer against the record locked on Zcash.

**Two people, links only:**

1. The verifier opens **Verify**, creates a challenge and sends the **challenge link**.
2. The holder opens it. Their vault opens with the request ready; one tap on **Prove No. X** makes a **proof link**.
3. The verifier opens the proof link. Verify checks it and shows "Holder of No. X confirmed". A proof link only passes in the browser that created the challenge, so a forwarded proof cannot be replayed.

No vault yet? In **Vault**, choose **Use the public demo vault**. It holds token No. 0 in a locked record.

> **Public demo key.** The demo vault's backup is published on purpose: `0d796d0bf9e20562bda2e554cc74fbb19bc5703c54f14e4822d0003e9af944b7`. It holds nothing of value, and the server refuses any transfer signed by its keys, so it can prove but never move its token. Never use it as a real vault.

**Transfers:** the receiver makes a **receive link** in their vault. The holder opens it, reviews the transfer, and holds the button to sign it over. It takes effect in the next published record.

## Gate a site on holding a token

Any site can let holders in without learning who they are:

```html
<script src="https://seisin.up.railway.app/gate.js"></script>
<button data-seisin-gate>Verify with Seisin</button>
```

The button asks Seisin for a one-time challenge bound to the site's origin, sends the visitor to their vault to prove a token, and brings them back with the proof. Seisin checks the proof against the record locked on Zcash, once, within 10 minutes, and only for the origin that asked. The page then receives a `seisin:verified` event with the token number and record. A demo is at [`/gate-demo.html`](https://seisin.up.railway.app/gate-demo.html).

## Backups

A vault is one secret in the browser. Holders can write it down, or download it as a file encrypted with a passphrase (PBKDF2-SHA256, 600,000 rounds, then AES-GCM) and restore from that file on another device.

## Bringing existing holders in

This is how a marketplace like Zilkroad would move its current index onto Seisin without exposing anyone:

1. In **Operator** (sidebar → Operator sign-in), paste the ownership list: one `token, shielded address` per line.
2. Seisin makes a one-time claim code per token and one Zcash payment request with an output to every holder. Each output's encrypted memo carries that holder's claim link. Pay it from the marketplace's wallet.
3. Each holder opens the link from their wallet's memo, sets up a vault, and taps **Claim**. The token moves to a fresh key in their vault.

Seisin stores only a hash of each code and never the address. The public log shows that a token was claimed, but not who claimed it.

## Run it

Requires Node 24.

```bash
npm ci
cp .env.example .env    # set ANCHOR_ADDRESS and ANCHOR_UIVK for a dedicated Zcash account
npm run build
npm start               # http://localhost:8787
```

Tests: `npm test` (set `LIVE=1` to also check a real mainnet note).

Audit the live registry from a terminal, the same way the browser does (replay the log, check every signature and each record's lock note on mainnet, no key):

```bash
node --import tsx scripts/audit-live.ts https://seisin.up.railway.app
```

## Layout

- `src/core`: the protocol (registry, Merkle tree, memo format, anchor check), shared by the server and the browser.
- `src/server`: the operator service (Node's built-in SQLite). It rebuilds state from the log on every read, so it cannot serve a state the public log would not reproduce.
- `web`: the app (Vite + React).

## Licence

MIT. The vendored `zcash-delivery-proof` build is Apache-2.0 (see its LICENSE and NOTICE).
