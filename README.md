# Seisin

**Proof of who holds what in a Zcash asset registry, without learning who they are.**

Collections sold on Zcash today, such as the zkSNARKs identities on Zilkroad, record ownership as a row in the marketplace's database: the buyer pays ZEC with a memo, and the operator writes "token → address". Zcash Shielded Assets are not on mainnet yet, so nothing on chain can hold, move or prove these tokens. Nobody outside the operator can check the supply, a holder's claim, or whether a token moved with its owner's consent.

Seisin makes that index checkable by anyone, while keeping holders private:

- **Fixed supply.** Every record commits to exactly `supply` tokens; changes only replace owners.
- **Owner consent.** A token moves only with a signature from its current one-time owner key. The operator cannot move it alone.
- **Checkable history.** Each record commits to the previous record and to the signed changes that produced it. Anyone can replay the public log and reproduce every record.
- **Anchored on Zcash.** Each record is written into the memo of a shielded Zcash mainnet note sent to the registry's anchor address. Your browser checks that note against the raw transaction with no viewing key.
- **Private proof of holding.** A holder proves they hold a token by answering a verifier's one-time challenge. No Zcash address or other token is revealed.

The full protocol and the privacy boundary (what anyone, the operator and a verifier can and cannot see, plus the known leaks) are in [SPEC.md](SPEC.md).

## What is real and what is demo

| | Status |
|---|---|
| Anchors | **Real, Zcash mainnet.** Epoch 0: [`d455a8d2…71a2`](https://blockchair.com/zcash/transaction/d455a8d2daa6bdb67d7f82fdf9f04df9c8b96f54a30c524add95c8148c1471a2), height 3,501,709. Epoch 1: [`aef09300…6f2d`](https://blockchair.com/zcash/transaction/aef09300bba856b4b2996e5c82454196961ea0aaf334c8eccec66b8e765c6f2d), height 3,501,716. Both are Ironwood notes with the record in the memo. |
| Keyless anchor check | **Real.** The browser fetches the transaction bytes from mainnet and checks the note and memo with [zcash-delivery-proof](https://github.com/saplingcash/zcash-delivery-proof) (vendored WASM, pinned commit and hash in `vendor/zcash-delivery-proof/SOURCE.md`). |
| Transfers, proofs, audit | **Real.** Ed25519 signatures, a Merkle tree and a hash-chained log, all checked in the browser. |
| The `deeds` collection | **Demo.** Tokens are handed out free ("demo issuance") so anyone can try the flow. A real collection would sell each token's first transfer for ZEC. |
| Payment ↔ transfer binding | **Not enforced in v1.** A transfer carries a `ref` field for a hash of the payment's delivery proof, but a change is valid without one. |
| Anchoring | **Manual in v1.** The operator pays each anchor note from a Zcash wallet (the Operator tab shows the payment request as a QR code). |

## Try it

1. **Registry:** run the audit. It rebuilds every record from the public log, checks every signature, and reads the latest anchor note from mainnet.
2. **Vault:** create a vault (a secret kept in your browser) and confirm its backup. Claim a demo token; it becomes yours when the operator seals the next record.
3. **Verify:** in another browser or profile, create a challenge. In the Vault, answer it with **Prove**, then paste the proof back. A proof only passes against an anchored record.
4. **Transfer:** the receiver makes a one-time receive code; the holder reviews it and holds to sign the transfer over.

## Run it

Requires Node 24.

```bash
npm ci
cp .env.example .env    # set ANCHOR_ADDRESS and ANCHOR_UIVK for a dedicated Zcash account
npm run build
npm start               # http://localhost:8787
```

Tests: `npm test` (set `LIVE=1` to also check a real mainnet note).

## Layout

- `src/core`: the protocol (registry, Merkle tree, memo format, anchor check), shared by the server and the browser.
- `src/server`: the operator service (Node's built-in SQLite). It rebuilds state from the log on every read, so it cannot serve a state the public log would not reproduce.
- `web`: the app (Vite + React).

## Licence

MIT. The vendored `zcash-delivery-proof` build is Apache-2.0 (see its LICENSE and NOTICE).
