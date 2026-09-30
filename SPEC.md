# Seisin protocol, version 1

Seisin makes an operator's ownership index for memo-indexed Zcash assets checkable by anyone, without revealing who holds what.

Until Zcash Shielded Assets reach mainnet, collections such as zkSNARKs record ownership as a row in the marketplace's database: the buyer pays ZEC with a memo and the operator writes "token → address". Nobody outside the operator can check the supply, a holder's claim, or whether a token moved with its owner's consent. Seisin adds four guarantees on top of that index:

1. **Fixed supply.** Every record commits to exactly `supply` leaves; changes only replace leaves.
2. **Consent.** A token moves only with a signature from its current one-time owner key. The operator cannot move it alone.
3. **Checkable history.** Each record commits to the previous record and to its batch of signed changes, so anyone can replay the public log and reproduce every root.
4. **Private proof of holding.** A holder proves they hold a token by answering a verifier's challenge, without revealing a Zcash address or any other token they hold.

## Objects

All hashes are SHA-256 with a domain tag, and every input is length-prefixed (`src/core/bytes.ts`).

| Object | Definition |
|---|---|
| Owner key | Ed25519 key, `HKDF(seed, "seisin/key/1", collection ‖ tokenId ‖ n)`. Fresh per token and per acquisition `n`. |
| Leaf | `H("seisin/leaf/1", collection, tokenId, ownerKey)` |
| Root | Merkle root over the leaves in token order, padded to a power of two with `H("seisin/empty/1")` |
| Change | `{tokenId, from, to, ref, sig}`, where `sig` is the `from` key's signature over `H("seisin/transfer/1", collection, epoch, tokenId, from, to, ref)` |
| Record | `{collection, epoch, supply, prev, root, changes}`. `prev` is the previous record's hash; `changes` hashes this epoch's batch. |
| Ownership proof | Merkle path plus the owner key's signature over `H("seisin/own/1", collection, epoch, tokenId, ownerKey, nonce)` |

## Anchoring

The operator anchors each record by paying a small shielded note to the registry's **anchor address**, with this memo:

```
SEISIN/1 <collection> <epoch> <supply> <prev> <root> <changes>
```

For each anchor, the operator publishes the txid and a `zdp:1` delivery proof ([zcash-delivery-proof](https://github.com/saplingcash/zcash-delivery-proof)). A verifier:

1. fetches the transaction bytes from mainnet;
2. checks the delivery proof against those bytes with no key, which yields the memo;
3. checks the note went to the anchor address and the transaction is mined;
4. decodes the record and checks that it chains from the previous one.

The anchor address is a dedicated account. Its incoming viewing key is published, so anyone can list every anchor and spot a fork: two records with the same epoch.

## Privacy boundary

| Seen by | Can see | Cannot see |
|---|---|---|
| Anyone | Collection id, supply, every record, the change log: which token ids moved in which epoch, with one-time owner keys | Zcash addresses of holders, how many tokens one person holds, payment amounts, who paid whom |
| Chain observer | The anchor transactions: a shielded note to the anchor address, plus the fee | The payment between buyer and seller (shielded); any link from an owner key to a Zcash address |
| Operator | The Zcash address that paid for each purchase, as in the index Seisin replaces | Owner secrets; the operator cannot sign a transfer or an ownership proof |
| Verifier | That one token is held by the key answering its challenge in the latest record | The holder's address, other tokens, earlier or later keys |

**Known leaks:**
- The timing and token id of each transfer are public, because the log must be replayable.
- An operator that sees the buyer's payment memo can link that purchase's owner key to the paying address, just as its database does today.
- A holder who reuses a seed-derived key breaks unlinkability; the reference holder vault never does.

## Out of scope for version 1

- Enforcing that the payment happened before the transfer. `ref` binds a hash of the payment's delivery proof, but a change is valid without one.
- Censorship: an operator can refuse to include a signed transfer. The signed transfer is itself evidence that it was refused.
