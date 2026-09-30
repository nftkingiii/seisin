import { useCallback, useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { proveOwnership, verifyOwnership, signTransfer, type OwnershipProof } from "../../src/core/registry.js";
import {
  api,
  audit,
  checkAnchorInBrowser,
  stateAt,
  vault,
  randomHex32,
  short,
  RECV,
  CHAL,
  type RegistryView,
  type Log,
  type Step,
} from "./lib";

type Tab = "registry" | "vault" | "verify" | "operator";
const TABS: { id: Tab; label: string }[] = [
  { id: "registry", label: "Registry" },
  { id: "vault", label: "Vault" },
  { id: "verify", label: "Verify" },
  { id: "operator", label: "Operator" },
];

const explorer = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`;
const toB64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "registry");
  const [view, setView] = useState<RegistryView | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [v, l] = await Promise.all([api.registry(), api.log()]);
      setView(v);
      setLog(l);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };

  return (
    <div className="shell">
      <header className="top">
        <h1>Seisin</h1>
        <p className="lede">Proof of who holds what in a Zcash asset registry, without learning who they are.</p>
      </header>
      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab on" : "tab"} onClick={() => go(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {view?.demoIssuance && (
        <p className="demo" role="note">
          <strong>Demo collection.</strong> Tokens in <code>{view.collection}</code> are handed out free to show the flow. Transfers, proofs and anchors are real.
        </p>
      )}
      {error && <p className="alert">Could not reach the registry: {error}</p>}
      {!view || !log ? (
        !error && <p className="muted">Loading the registry…</p>
      ) : (
        <main role="tabpanel">
          {tab === "registry" && <RegistryTab view={view} log={log} />}
          {tab === "vault" && <VaultTab view={view} log={log} refresh={refresh} />}
          {tab === "verify" && <VerifyTab view={view} log={log} />}
          {tab === "operator" && <OperatorTab view={view} refresh={refresh} />}
        </main>
      )}
      <footer className="foot">
        <a href="https://github.com/nftkingiii/seisin">Source</a> · <a href="/SPEC.md">Protocol and privacy boundary</a>
      </footer>
    </div>
  );
}

// ---------- shared bits ----------

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="code">
      <code>{children}</code>
      <Copy text={children} />
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.label} className={s.ok ? "ok" : "bad"}>
          <span className="mark" aria-hidden>
            {s.ok ? "✓" : "✕"}
          </span>
          <div>
            <strong>{s.label}</strong>
            <span className="sr">{s.ok ? " passed" : " failed"}</span>
            <p>{s.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------- Registry ----------

function RegistryTab({ view, log }: { view: RegistryView; log: Log }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const epochs = [...view.epochs].reverse();

  return (
    <>
      <div className="stats">
        <div>
          <span>Collection</span>
          <strong>{view.collection}</strong>
        </div>
        <div>
          <span>Supply</span>
          <strong>{view.supply}</strong>
        </div>
        <div>
          <span>Latest record</span>
          <strong>Epoch {view.head}</strong>
        </div>
        <div>
          <span>Anchored on Zcash</span>
          <strong>{view.latestAnchored === null ? "Not yet" : `Epoch ${view.latestAnchored}`}</strong>
        </div>
      </div>

      <Section
        title="Audit this registry"
        aside={
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setSteps(await audit(view, log));
              setBusy(false);
            }}
          >
            {busy ? "Checking…" : steps ? "Run again" : "Run the audit"}
          </button>
        }
      >
        <p className="muted">
          Your browser rebuilds every record from the public log, checks each transfer's owner signature, and reads the anchor note on Zcash mainnet with no key. Nothing here trusts the operator.
        </p>
        {steps && <StepList steps={steps} />}
      </Section>

      <Section title="Records">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Epoch</th>
                <th>Changes</th>
                <th>Record hash</th>
                <th>Anchor</th>
              </tr>
            </thead>
            <tbody>
              {epochs.map((e) => (
                <tr key={e.epoch}>
                  <td className="num">{e.epoch}</td>
                  <td className="num">{e.epoch === 0 ? "genesis" : e.changes}</td>
                  <td>
                    <code title={e.hash}>{short(e.hash, 10)}</code>
                  </td>
                  <td>
                    {e.anchor ? (
                      <a href={explorer(e.anchor.txid)} target="_blank" rel="noreferrer">
                        height {e.anchor.height}
                      </a>
                    ) : view.latestAnchored !== null && e.epoch < view.latestAnchored ? (
                      <span className="muted">covered by epoch {view.latestAnchored}</span>
                    ) : (
                      <span className="pill wait">not anchored</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {view.pending.length > 0 && (
          <p className="muted">
            {view.pending.length} signed change{view.pending.length > 1 ? "s" : ""} waiting for the next epoch: token{" "}
            {view.pending.map((p) => p.tokenId).join(", ")}.
          </p>
        )}
      </Section>

      {view.anchorAddress && (
        <Section title="Anchor account">
          <p className="muted">Every record is anchored by a shielded note to this address. Its viewing key is public, so anyone can list every anchor and spot two records for the same epoch.</p>
          <dl className="kv">
            <dt>Address</dt>
            <dd>
              <Code>{view.anchorAddress}</Code>
            </dd>
            {view.anchorUivk && (
              <>
                <dt>Viewing key</dt>
                <dd>
                  <Code>{view.anchorUivk}</Code>
                </dd>
              </>
            )}
          </dl>
        </Section>
      )}
    </>
  );
}

// ---------- Vault ----------

function VaultTab({ view, log, refresh }: { view: RegistryView; log: Log; refresh: () => Promise<void> }) {
  const [seeded, setSeeded] = useState(() => vault.seed() !== null);
  const [restoring, setRestoring] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!seeded)
    return (
      <Section title="Open a vault">
        <p className="muted">Your vault is a secret kept in this browser. Each token you receive gets its own one-time key from it, so your tokens cannot be linked to each other or to your Zcash wallet.</p>
        {restoring ? (
          <RestoreForm
            onDone={() => setSeeded(true)}
            onCancel={() => setRestoring(false)}
          />
        ) : (
          <div className="row">
            <button
              className="primary"
              onClick={() => {
                vault.create();
                setSeeded(true);
              }}
            >
              Create a vault
            </button>
            <button className="link" onClick={() => setRestoring(true)}>
              Restore from a backup
            </button>
          </div>
        )}
      </Section>
    );

  const head = stateAt(log, view.head);
  const held = head.owners.map((_, id) => ({ id, key: vault.keyFor(head, id) })).filter((h) => h.key);
  const waiting = view.pending.filter((p) => vault.used(view.collection, p.tokenId) >= 0 && !held.some((h) => h.id === p.tokenId));

  return (
    <>
      {msg && <p className={msg.ok ? "notice" : "alert"}>{msg.text}</p>}
      <Section title="Your tokens">
        {held.length === 0 && waiting.length === 0 ? (
          <p className="muted">This vault holds nothing yet.</p>
        ) : (
          <ul className="deeds">
            {held.map((h) => (
              <HeldToken key={h.id} id={h.id} view={view} log={log} refresh={refresh} setMsg={setMsg} />
            ))}
            {waiting.map((p) => (
              <li key={`w${p.tokenId}`} className="deed">
                <div className="deed-head">
                  <span className="deed-id">No. {p.tokenId}</span>
                  <span className="pill wait">waiting for the next epoch</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {view.demoIssuance && <DemoClaim view={view} log={log} refresh={refresh} setMsg={setMsg} />}
      </Section>
      <ReceivePanel view={view} />
      <Section title="Backup">
        <BackupPanel onForget={() => setSeeded(false)} />
      </Section>
    </>
  );
}

function RestoreForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          vault.restore(v);
          onDone();
        } catch (x) {
          setErr((x as Error).message);
        }
      }}
    >
      <label htmlFor="restore">Backup</label>
      <input id="restore" value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" spellCheck={false} />
      {err && <p className="alert">{err}</p>}
      <div className="row">
        <button className="primary" type="submit">
          Restore
        </button>
        <button className="link" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DemoClaim({ view, refresh, setMsg }: { view: RegistryView; log: Log; refresh: () => Promise<void>; setMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="demo-claim">
      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const owners = await fetch("/api/owners").then((r) => r.json());
            const queued = new Set(view.pending.map((p) => p.tokenId));
            const id = (owners.issuerHeld as boolean[]).findIndex((free, i) => free && !queued.has(i));
            if (id < 0) throw new Error("every demo token has been handed out");
            const k = vault.fresh(view.collection, id);
            await api.post("/api/issue", { tokenId: id, to: k.public });
            setMsg({ ok: true, text: `Token No. ${id} is on its way. It becomes yours when the operator seals the next epoch.` });
            await refresh();
          } catch (e) {
            setMsg({ ok: false, text: (e as Error).message });
          }
          setBusy(false);
        }}
      >
        {busy ? "Requesting…" : "Claim a demo token"}
      </button>
      <span className="muted small">Free, demo only. A real collection sells its first transfer for ZEC.</span>
    </div>
  );
}

function HeldToken({ id, view, log, refresh, setMsg }: { id: number; view: RegistryView; log: Log; refresh: () => Promise<void>; setMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const [mode, setMode] = useState<"none" | "prove" | "send">("none");
  const [input, setInput] = useState("");
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const prove = () => {
    const m = input.trim().match(new RegExp(`^${CHAL}:([a-z0-9-]+):([0-9a-f]{64})$`));
    if (!m) throw new Error("paste a challenge that starts with seisin-chal:");
    if (m[1] !== view.collection) throw new Error(`that challenge is for ${m[1]}, not ${view.collection}`);
    const epoch = view.latestAnchored ?? view.head;
    const s = stateAt(log, epoch);
    const k = vault.keyFor(s, id);
    if (!k) throw new Error(`you received this token after epoch ${epoch}, the latest anchored record; you can prove it once the operator anchors a newer one`);
    const p = proveOwnership(s, id, k.secret, m[2]);
    setOut(`seisin-proof:${toB64(p)}`);
  };

  const send = async () => {
    const m = input.trim().match(new RegExp(`^${RECV}:([a-z0-9-]+):(\\d+):([0-9a-f]{64})$`));
    if (!m) throw new Error("paste a receive code that starts with seisin-recv:");
    if (m[1] !== view.collection || Number(m[2]) !== id) throw new Error(`that code is for token ${m[2]} in ${m[1]}`);
    const s = stateAt(log, view.head);
    const k = vault.keyFor(s, id)!;
    const change = signTransfer(view.collection, view.head, { tokenId: id, from: k.public, to: m[3], ref: "00".repeat(32) }, k.secret);
    await api.post("/api/transfers", { change });
    setMsg({ ok: true, text: `Token No. ${id} is signed over. It moves when the operator seals the next epoch.` });
    setMode("none");
    await refresh();
  };

  const pending = view.pending.some((p) => p.tokenId === id);

  return (
    <li className="deed">
      <div className="deed-head">
        <span className="deed-id">No. {id}</span>
        {pending ? (
          <span className="pill wait">transfer waiting for the next epoch</span>
        ) : (
          <div className="row">
            <button className={mode === "prove" ? "ghost on" : "ghost"} onClick={() => { setMode(mode === "prove" ? "none" : "prove"); setInput(""); setOut(null); }}>
              Prove
            </button>
            <button className={mode === "send" ? "ghost on" : "ghost"} onClick={() => { setMode(mode === "send" ? "none" : "send"); setInput(""); setOut(null); }}>
              Transfer
            </button>
          </div>
        )}
      </div>
      {mode !== "none" && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              mode === "prove" ? prove() : await send();
            } catch (x) {
              setMsg({ ok: false, text: (x as Error).message });
            }
            setBusy(false);
          }}
        >
          <label htmlFor={`in${id}`}>{mode === "prove" ? "Verifier's challenge" : "Receiver's code"}</label>
          <input id={`in${id}`} value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} />
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !input.trim()}>
              {mode === "prove" ? "Create proof" : busy ? "Signing…" : "Sign and transfer"}
            </button>
          </div>
          {out && (
            <>
              <p className="muted small">Send this back to the verifier. It shows only that this token's current key answered their challenge.</p>
              <Code>{out}</Code>
            </>
          )}
        </form>
      )}
    </li>
  );
}

function ReceivePanel({ view }: { view: RegistryView }) {
  const [id, setId] = useState("");
  const [code, setCode] = useState<string | null>(null);
  return (
    <Section title="Receive a token">
      <p className="muted">Give the seller a one-time code. It names a fresh key that has never been used, so the sale cannot be linked to anything else in your vault.</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(id);
          if (!Number.isInteger(n) || n < 0 || n >= view.supply) return;
          const k = vault.fresh(view.collection, n);
          setCode(`${RECV}:${view.collection}:${n}:${k.public}`);
        }}
      >
        <label htmlFor="recv" className="sr">
          Token number
        </label>
        <input id="recv" className="narrow" type="number" min={0} max={view.supply - 1} placeholder="Token No." value={id} onChange={(e) => setId(e.target.value)} />
        <button className="secondary" type="submit" disabled={id === ""}>
          Make a receive code
        </button>
      </form>
      {code && <Code>{code}</Code>}
    </Section>
  );
}

function BackupPanel({ onForget }: { onForget: () => void }) {
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="stack">
      <p className="muted">Anyone with this backup can move your tokens. Keep it offline.</p>
      <div className="row">
        <button className="ghost" onClick={() => setShow(!show)}>
          {show ? "Hide backup" : "Show backup"}
        </button>
        {confirm ? (
          <>
            <button className="danger" onClick={() => { vault.forget(); onForget(); }}>
              Remove from this browser
            </button>
            <button className="link" onClick={() => setConfirm(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button className="link" onClick={() => setConfirm(true)}>
            Remove this vault
          </button>
        )}
      </div>
      {show && <Code>{vault.backup() ?? ""}</Code>}
    </div>
  );
}

// ---------- Verify ----------

function VerifyTab({ view, log }: { view: RegistryView; log: Log }) {
  const [nonce, setNonce] = useState<string | null>(null);
  const [proof, setProof] = useState("");
  const [result, setResult] = useState<{ ok: boolean; steps: Step[]; p?: OwnershipProof } | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = async () => {
    const steps: Step[] = [];
    let p: OwnershipProof;
    try {
      p = fromB64(proof.trim().replace(/^seisin-proof:/, ""));
    } catch {
      return setResult({ ok: false, steps: [{ label: "Readable proof", ok: false, detail: "that is not a Seisin proof" }] });
    }
    const target = view.epochs.find((e) => e.epoch === (view.latestAnchored ?? view.head))!;
    if (target.anchor) {
      try {
        const a = await checkAnchorInBrowser(view, target);
        steps.push({ label: "Record is on Zcash", ok: true, detail: `epoch ${target.epoch}, mined at height ${a.height}, checked here with no key` });
      } catch (e) {
        steps.push({ label: "Record is on Zcash", ok: false, detail: (e as Error).message });
      }
    } else {
      steps.push({ label: "Record is on Zcash", ok: false, detail: `no record is anchored yet; epoch ${target.epoch} is only the operator's word` });
    }
    // the record must also be the one the public log rebuilds
    const rebuilt = stateAt(log, target.epoch).record;
    steps.push({ label: "Record matches the public log", ok: rebuilt.root === target.record.root, detail: `root ${short(target.record.root, 10)}` });
    const why = nonce ? verifyOwnership(p, target.record, nonce) : "create a challenge first";
    steps.push({ label: "Holder answered your challenge", ok: why === null, detail: why ?? `token No. ${p.tokenId} is held by the key that signed your challenge` });
    setResult({ ok: steps.every((s) => s.ok), steps, p });
  };

  return (
    <>
      <Section title="1. Send a challenge">
        <p className="muted">A fresh challenge stops a holder from reusing an old proof or one made for someone else.</p>
        <div className="row">
          <button className={nonce ? "secondary" : "primary"} onClick={() => { setNonce(randomHex32()); setResult(null); }}>
            {nonce ? "New challenge" : "Create a challenge"}
          </button>
        </div>
        {nonce && <Code>{`${CHAL}:${view.collection}:${nonce}`}</Code>}
      </Section>
      <Section title="2. Check their proof">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await verify();
            setBusy(false);
          }}
        >
          <label htmlFor="proof">Proof from the holder</label>
          <textarea id="proof" rows={3} value={proof} onChange={(e) => setProof(e.target.value)} spellCheck={false} />
          <div className="row">
            <button className="primary" type="submit" disabled={!nonce || !proof.trim() || busy}>
              {busy ? "Checking…" : "Check proof"}
            </button>
          </div>
        </form>
        {result && (
          <div className={result.ok ? "verdict ok" : "verdict bad"}>
            <h3>{result.ok ? `Holder of No. ${result.p?.tokenId} confirmed` : "Not confirmed"}</h3>
            <StepList steps={result.steps} />
            {result.ok && (
              <p className="muted small">
                You learned that one token is held by the key that answered you. You did not learn their Zcash address, their other tokens, or who they bought from.
              </p>
            )}
          </div>
        )}
      </Section>
    </>
  );
}

// ---------- Operator ----------

function OperatorTab({ view, refresh }: { view: RegistryView; refresh: () => Promise<void> }) {
  const [token, setToken] = useState(() => sessionStorage.getItem("seisin.op") ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const head = view.epochs[view.epochs.length - 1];
  const needsAnchor = !head.anchor;

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setMsg({ ok: true, text: await fn() });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(false);
  };

  return (
    <>
      <Section title="Operator key">
        <p className="muted">Sealing and anchoring need the operator token. It cannot sign transfers or proofs; only holders can.</p>
        <input
          type="password"
          aria-label="Operator token"
          value={token}
          autoComplete="off"
          onChange={(e) => {
            setToken(e.target.value);
            sessionStorage.setItem("seisin.op", e.target.value);
          }}
        />
      </Section>
      {msg && <p className={msg.ok ? "notice" : "alert"}>{msg.text}</p>}
      <Section title="Seal the next epoch">
        {view.pending.length === 0 ? (
          <p className="muted">No signed changes are waiting.</p>
        ) : (
          <>
            <ul className="plain">
              {view.pending.map((p, i) => (
                <li key={i}>
                  Token No. {p.tokenId} <span className="muted">· {p.note}</span>
                </li>
              ))}
            </ul>
            <button className="primary" disabled={busy || !token} onClick={() => act(async () => {
              const r = await api.post<{ sealed: number }>("/api/operator/seal", {}, token);
              return `Sealed epoch ${r.sealed}.`;
            })}>
              Seal {view.pending.length} change{view.pending.length > 1 ? "s" : ""}
            </button>
          </>
        )}
      </Section>
      {needsAnchor && <AnchorPanel view={view} epoch={head.epoch} token={token} busy={busy} act={act} />}
    </>
  );
}

function AnchorPanel({ view, epoch, token, busy, act }: { view: RegistryView; epoch: number; token: string; busy: boolean; act: (fn: () => Promise<string>) => Promise<void> }) {
  const [req, setReq] = useState<{ memo: string; amount: string; uri: string | null } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [txid, setTxid] = useState("");

  useEffect(() => {
    fetch(`/api/anchor-request/${epoch}`)
      .then((r) => r.json())
      .then(async (r) => {
        setReq(r);
        setQr(r.uri ? await QRCode.toDataURL(r.uri, { margin: 1, width: 240, color: { dark: "#2b2533", light: "#fbf8f2" } }) : null);
      });
  }, [epoch]);

  return (
    <Section title={`Anchor epoch ${epoch}`}>
      {!view.anchorAddress ? (
        <p className="alert">No anchor account is configured. Set ANCHOR_ADDRESS and ANCHOR_UIVK on the service.</p>
      ) : !req ? (
        <p className="muted">Preparing the payment request…</p>
      ) : (
        <div className="anchor">
          {qr && <img src={qr} width={240} height={240} alt="Payment request for the anchor note" />}
          <div className="stack">
            <p className="muted">
              Pay {req.amount} ZEC to the anchor address from a shielded wallet with this memo. Scanning the code fills in both. Anchoring this record also covers every earlier one.
            </p>
            <Code>{req.memo}</Code>
            {req.uri && <Code>{req.uri}</Code>}
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const r = await api.post<{ height: number }>("/api/operator/anchor", { epoch, txid: txid.trim() }, token);
                  return `Epoch ${epoch} anchored at height ${r.height}.`;
                });
              }}
            >
              <label htmlFor="txid" className="sr">
                Transaction id
              </label>
              <input id="txid" placeholder="Transaction id once mined" value={txid} onChange={(e) => setTxid(e.target.value)} spellCheck={false} />
              <button className="primary" type="submit" disabled={busy || !token || !/^[0-9a-f]{64}$/.test(txid.trim())}>
                Record anchor
              </button>
            </form>
          </div>
        </div>
      )}
    </Section>
  );
}
