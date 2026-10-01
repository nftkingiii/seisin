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

import { IconRegistry, IconVault, IconVerify, IconOperator, IconCheck, IconCross, IconCopy, IconSeal, IconBook, IconCode, Mark } from "./icons";
import { useToast, HoldButton, Stepper } from "./behaviors";

type Tab = "registry" | "vault" | "verify" | "operator";
const TABS: { id: Tab; label: string; icon: () => ReactNode; title: string; sub: string }[] = [
  { id: "registry", label: "Registry", icon: IconRegistry, title: "Registry", sub: "Every record, rebuilt from the public log and checked in your browser." },
  { id: "vault", label: "Vault", icon: IconVault, title: "Vault", sub: "Your tokens, each held by a one-time key that only this browser knows." },
  { id: "verify", label: "Verify", icon: IconVerify, title: "Verify a holder", sub: "Confirm who holds a token without learning who they are." },
  { id: "operator", label: "Operator", icon: IconOperator, title: "Operator", sub: "Seal signed transfers into records and anchor them on Zcash." },
];

const explorer = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`;
const toB64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));

export function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = location.hash.slice(1) as Tab;
    return TABS.some((x) => x.id === t) ? t : "registry";
  });
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

  // Follow links and back/forward that change the hash after load.
  useEffect(() => {
    const onHash = () => {
      const t = location.hash.slice(1) as Tab;
      if (TABS.some((x) => x.id === t)) setTab(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
    window.scrollTo({ top: 0 });
  };

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="app">
      <div className="ambient" aria-hidden />
      <aside className="side" aria-label="Seisin">
        <div className="brand">
          <Mark />
          <div>
            <strong>Seisin</strong>
            <span>Title registry for Zcash assets</span>
          </div>
        </div>
        <nav className="nav" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} aria-label={t.label} title={t.label} className={tab === t.id ? "nav-item on" : "nav-item"} onClick={() => go(t.id)}>
              <t.icon />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <a href="/SPEC.md">
            <IconBook />
            <span>Protocol and privacy</span>
          </a>
          <a href="https://github.com/nftkingiii/seisin">
            <IconCode />
            <span>Source</span>
          </a>
        </div>
      </aside>

      <div className="main">
        <header className="bar">
          <div className="crumbs">
            <span>{view?.collection ?? "…"}</span>
            <span aria-hidden>/</span>
            <strong>{current.label}</strong>
          </div>
          {view && <AnchorChip view={view} />}
        </header>
        {view && <RecordStrip view={view} />}

        <div className="page" key={tab}>
          <h1 className="display">{current.title}</h1>
          <p className="sub">{current.sub}</p>
          {view?.demoIssuance && (
            <p className="demo" role="note">
              <strong>Demo collection.</strong> Tokens in <code>{view.collection}</code> are handed out free to show the flow. Transfers, proofs and anchors are real.
            </p>
          )}
          {error && <p className="alert">Could not reach the registry: {error}</p>}
          {!view || !log ? (
            !error && <div className="skeleton" aria-label="Loading the registry" />
          ) : (
            <main role="tabpanel" className="rise">
              {tab === "registry" && <RegistryTab view={view} log={log} />}
              {tab === "vault" && <VaultTab view={view} log={log} refresh={refresh} />}
              {tab === "verify" && <VerifyTab view={view} log={log} />}
              {tab === "operator" && <OperatorTab view={view} refresh={refresh} />}
            </main>
          )}
        </div>
      </div>
    </div>
  );
}

function AnchorChip({ view }: { view: RegistryView }) {
  return view.latestAnchored === null ? (
    <span className="chip idle">Not anchored yet</span>
  ) : (
    <span className="chip gold">
      <IconSeal /> Anchored at epoch {view.latestAnchored}
    </span>
  );
}

function RecordStrip({ view }: { view: RegistryView }) {
  const head = view.epochs[view.epochs.length - 1];
  const anchored = view.epochs.filter((e) => e.anchor).pop();
  const items: [string, string, string?][] = [
    ["Epoch", String(view.head)],
    ["Supply", String(view.supply)],
    ["Root", short(head.record.root, 6), head.record.root],
    ["Record", short(head.hash, 6), head.hash],
    ["Anchor height", anchored?.anchor ? String(anchored.anchor.height) : "none"],
    ["Waiting", `${view.pending.length} change${view.pending.length === 1 ? "" : "s"}`],
  ];
  return (
    <div className="strip" aria-label="Current record">
      {items.map(([k, v, title]) => (
        <div key={k}>
          <span>{k}</span>
          <strong title={title}>{v}</strong>
        </div>
      ))}
    </div>
  );
}

// ---------- shared bits ----------

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn"
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
      <span className={done ? "copied on" : "copied"} aria-live="polite">
        {done ? "Copied" : ""}
      </span>
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
            {s.ok ? <IconCheck /> : <IconCross />}
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
      <Section title="Record chain">
        <p className="muted">Each record commits to the one before it, so anchoring the newest record on Zcash also anchors every earlier one.</p>
        <Chain view={view} />
      </Section>

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

function Chain({ view }: { view: RegistryView }) {
  const anchoredAt = view.latestAnchored;
  return (
    <ol className="chain" aria-label="Records, oldest first">
      {view.epochs.map((e) => {
        const state = e.anchor ? "anchored" : anchoredAt !== null && e.epoch < anchoredAt ? "covered" : "open";
        const label = state === "anchored" ? `anchored at ${e.anchor!.height}` : state === "covered" ? "covered" : "not anchored";
        return (
          <li key={e.epoch} className={`epoch ${state}`} style={{ ["--i" as string]: e.epoch }}>
            <span className="node" aria-hidden>
              {state !== "open" && <IconSeal />}
            </span>
            <strong>{e.epoch}</strong>
            <small>{e.epoch === 0 ? "genesis" : `${e.changes} change${e.changes === 1 ? "" : "s"}`}</small>
            <small className="state">{label}</small>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Vault ----------

function VaultTab({ view, log, refresh }: { view: RegistryView; log: Log; refresh: () => Promise<void> }) {
  const [seeded, setSeeded] = useState(() => vault.seed() !== null);
  const [backed, setBacked] = useState(() => vault.backedUp());
  const [restoring, setRestoring] = useState(false);
  const toast = useToast();

  if (!seeded)
    return (
      <Section title="Open a vault">
        <p className="muted">Your vault is a secret kept in this browser. Each token you receive gets its own one-time key from it, so your tokens cannot be linked to each other or to your Zcash wallet.</p>
        {restoring ? (
          <RestoreForm
            onDone={() => {
              setSeeded(true);
              setBacked(true);
            }}
            onCancel={() => setRestoring(false)}
          />
        ) : (
          <div className="row" style={{ marginTop: 16 }}>
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
        {view.demoVault && !restoring && (
          <div className="demo-vault">
            <div>
              <strong>Just looking?</strong>
              <p>Open the public demo vault. It already holds a token in an anchored record, so you can prove it on the Verify tab straight away. Its backup is public, so it can prove but never transfer.</p>
            </div>
            <button
              className="secondary"
              onClick={() => {
                vault.useDemo(view.demoVault!);
                setSeeded(true);
                setBacked(true);
                toast(true, "Public demo vault opened.");
              }}
            >
              Use the public demo vault
            </button>
          </div>
        )}
      </Section>
    );

  const head = stateAt(log, view.head);
  const held = head.owners.map((_, id) => ({ id, key: vault.keyFor(head, id) })).filter((h) => h.key);
  const waiting = view.pending.filter((p) => vault.used(view.collection, p.tokenId) >= 0 && !held.some((h) => h.id === p.tokenId));
  const hasToken = held.length + waiting.length > 0;

  // Setup checklist: exactly one next action is open at a time.
  if (!backed || !hasToken)
    return (
      <>
        <Section title="Set up your vault">
          <ol className="tasks">
            <li className="done">
              <span className="dot" aria-hidden>
                <IconCheck />
              </span>
              <div>
                <strong>Vault created</strong>
                <p>A secret now lives in this browser.</p>
              </div>
            </li>
            <li className={backed ? "done" : "now"}>
              <span className="dot" aria-hidden>
                {backed ? <IconCheck /> : 2}
              </span>
              <div>
                <strong>{backed ? "Backup confirmed" : "Back up your vault"}</strong>
                {backed ? <p>You typed it back correctly.</p> : <BackupConfirm onDone={() => { setBacked(true); toast(true, "Backup confirmed."); }} />}
              </div>
            </li>
            <li className={hasToken ? "done" : backed ? "now" : ""}>
              <span className="dot" aria-hidden>
                {hasToken ? <IconCheck /> : 3}
              </span>
              <div>
                <strong>Receive your first token</strong>
                {backed && !hasToken && (
                  <>
                    <p>Ask a seller for a token with a receive code below{view.demoIssuance ? ", or claim a free demo token" : ""}.</p>
                    {view.demoIssuance && <DemoClaim view={view} refresh={refresh} />}
                  </>
                )}
              </div>
            </li>
          </ol>
        </Section>
        {backed && <ReceivePanel view={view} />}
      </>
    );

  return (
    <>
      {vault.isDemo() && (
        <p className="demo" role="note">
          <strong>Public demo vault.</strong> Anyone can open this vault, so it can prove what it holds but cannot transfer. Remove it under Backup to make your own.
        </p>
      )}
      <Section title="Your tokens" aside={<span className="small">{held.length} held{waiting.length ? ` · ${waiting.length} arriving` : ""}</span>}>
        <ul className="deeds">
          {held.map((h) => (
            <HeldToken key={h.id} id={h.id} view={view} log={log} refresh={refresh} />
          ))}
          {waiting.map((p) => (
            <li key={`w${p.tokenId}`} className="deed arriving">
              <div className="deed-head">
                <span className="deed-id">No. {p.tokenId}</span>
                <span className="pill wait">arrives with epoch {view.head + 1}</span>
              </div>
            </li>
          ))}
        </ul>
        {view.demoIssuance && <DemoClaim view={view} refresh={refresh} />}
      </Section>
      <ReceivePanel view={view} />
      <Section title="Backup">
        <BackupPanel onForget={() => { setSeeded(false); setBacked(false); }} />
      </Section>
    </>
  );
}

function BackupConfirm({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<"show" | "check">("show");
  const [tail, setTail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return stage === "show" ? (
    <>
      <p>Write this down somewhere offline. Anyone with it can move your tokens, and without it a lost browser means lost tokens.</p>
      <Code>{vault.backup() ?? ""}</Code>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => setStage("check")}>
          I wrote it down
        </button>
      </div>
    </>
  ) : (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (vault.confirmBackup(tail)) onDone();
        else setErr("That does not match the end of your backup. Check what you wrote down.");
      }}
    >
      <label htmlFor="tail">Type the last 6 characters of your backup</label>
      <input id="tail" className="narrow" value={tail} maxLength={6} onChange={(e) => { setTail(e.target.value); setErr(null); }} autoComplete="off" spellCheck={false} aria-invalid={!!err} aria-describedby={err ? "tail-err" : undefined} />
      {err && (
        <p className="field-err" id="tail-err">
          {err}
        </p>
      )}
      <div className="row">
        <button className="primary" type="submit" disabled={tail.trim().length !== 6}>
          Confirm backup
        </button>
        <button className="link" type="button" onClick={() => setStage("show")}>
          Show it again
        </button>
      </div>
    </form>
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
      <input id="restore" value={v} onChange={(e) => { setV(e.target.value); setErr(null); }} autoComplete="off" spellCheck={false} aria-invalid={!!err} />
      {err && <p className="field-err">{err}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={!v.trim()}>
          Restore
        </button>
        <button className="link" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DemoClaim({ view, refresh }: { view: RegistryView; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
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
            if (id < 0) throw new Error("Every demo token has been handed out.");
            const k = vault.fresh(view.collection, id);
            await api.post("/api/issue", { tokenId: id, to: k.public });
            toast(true, `Token No. ${id} is on its way. It arrives when the operator seals epoch ${view.head + 1}.`);
            await refresh();
          } catch (e) {
            toast(false, (e as Error).message);
          }
          setBusy(false);
        }}
      >
        {busy ? "Requesting…" : "Claim a demo token"}
      </button>
      <span className="small">Free, demo only. A real collection sells its first transfer for ZEC.</span>
    </div>
  );
}

type Review = { to: string; from: string };

function HeldToken({ id, view, log, refresh }: { id: number; view: RegistryView; log: Log; refresh: () => Promise<void> }) {
  const [mode, setMode] = useState<"none" | "prove" | "send">("none");
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const open = (m: "prove" | "send") => {
    setMode(mode === m ? "none" : m);
    setInput("");
    setErr(null);
    setOut(null);
    setReview(null);
  };

  const prove = () => {
    const m = input.trim().match(new RegExp(`^${CHAL}:([a-z0-9-]+):([0-9a-f]{64})$`));
    if (!m) throw new Error("Paste a challenge that starts with seisin-chal:");
    if (m[1] !== view.collection) throw new Error(`That challenge is for ${m[1]}, not ${view.collection}.`);
    const epoch = view.latestAnchored ?? view.head;
    const s = stateAt(log, epoch);
    const k = vault.keyFor(s, id);
    if (!k) throw new Error(`You received this token after epoch ${epoch}, the latest anchored record. You can prove it once a newer record is anchored.`);
    setOut(`seisin-proof:${toB64(proveOwnership(s, id, k.secret, m[2]))}`);
  };

  const check = () => {
    const m = input.trim().match(new RegExp(`^${RECV}:([a-z0-9-]+):(\\d+):([0-9a-f]{64})$`));
    if (!m) throw new Error("Paste a receive code that starts with seisin-recv:");
    if (m[1] !== view.collection || Number(m[2]) !== id) throw new Error(`That code is for token No. ${m[2]} in ${m[1]}, not this one.`);
    const k = vault.keyFor(stateAt(log, view.head), id)!;
    if (m[3] === k.public) throw new Error("That code points back at your own key.");
    setReview({ to: m[3], from: k.public });
  };

  const commit = async () => {
    setBusy(true);
    try {
      const k = vault.keyFor(stateAt(log, view.head), id)!;
      const change = signTransfer(view.collection, view.head, { tokenId: id, from: k.public, to: review!.to, ref: "00".repeat(32) }, k.secret);
      await api.post("/api/transfers", { change });
      toast(true, `Token No. ${id} is signed over. It moves when the operator seals epoch ${view.head + 1}.`);
      setMode("none");
      setReview(null);
      await refresh();
    } catch (e) {
      toast(false, (e as Error).message);
      setReview(null);
    }
    setBusy(false);
  };

  const pending = view.pending.some((p) => p.tokenId === id);

  return (
    <li className="deed">
      <div className="deed-head">
        <span className="deed-id">No. {id}</span>
        {pending ? (
          <span className="pill wait">leaves with epoch {view.head + 1}</span>
        ) : (
          <div className="row">
            <button className={mode === "prove" ? "ghost on" : "ghost"} aria-expanded={mode === "prove"} onClick={() => open("prove")}>
              Prove
            </button>
            {!vault.isDemo() && (
              <button className={mode === "send" ? "ghost on" : "ghost"} aria-expanded={mode === "send"} onClick={() => open("send")}>
                Transfer
              </button>
            )}
          </div>
        )}
      </div>

      {mode !== "none" && !review && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              mode === "prove" ? prove() : check();
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          <label htmlFor={`in${id}`}>{mode === "prove" ? "Verifier's challenge" : "Receiver's code"}</label>
          <input id={`in${id}`} value={input} onChange={(e) => { setInput(e.target.value); setErr(null); }} autoComplete="off" spellCheck={false} aria-invalid={!!err} aria-describedby={err ? `err${id}` : undefined} />
          {err && (
            <p className="field-err" id={`err${id}`}>
              {err}
            </p>
          )}
          <div className="row">
            <button className="primary" type="submit" disabled={!input.trim()}>
              {mode === "prove" ? "Create proof" : "Review transfer"}
            </button>
          </div>
          {out && (
            <div className="milestone">
              <strong>Proof ready</strong>
              <p>Send this back to the verifier. It shows only that this token's current key answered their challenge.</p>
              <Code>{out}</Code>
            </div>
          )}
        </form>
      )}

      {review && (
        <div className="review">
          <dl>
            <dt>Token</dt>
            <dd>No. {id}</dd>
            <dt>From</dt>
            <dd>
              <code>your key {short(review.from, 8)}</code>
            </dd>
            <dt>To</dt>
            <dd>
              <code>{short(review.to, 8)}</code>
            </dd>
            <dt>Takes effect</dt>
            <dd>when epoch {view.head + 1} is sealed</dd>
          </dl>
          <p className="small">Once sealed this cannot be undone. Only the new holder can move it after that.</p>
          <div className="row">
            <HoldButton label="Hold to sign over" doneLabel="Signed" disabled={busy} onCommit={commit} />
            <button className="link" type="button" onClick={() => setReview(null)} disabled={busy}>
              Back
            </button>
          </div>
        </div>
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
        style={{ marginTop: 16 }}
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
        <button className="ghost" onClick={() => setShow(!show)} aria-expanded={show}>
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
      return setResult({ ok: false, steps: [{ label: "Readable proof", ok: false, detail: "That is not a Seisin proof." }] });
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

  const at = result ? 2 : nonce ? 1 : 0;

  return (
    <>
      <Stepper steps={["Send a challenge", "Check their proof", "Result"]} at={at} />
      <Section title="Send a challenge">
        <p className="muted">A fresh challenge stops a holder from reusing an old proof or one made for someone else.</p>
        <div className="row" style={{ marginTop: 16 }}>
          <button className={nonce ? "secondary" : "primary"} onClick={() => { setNonce(randomHex32()); setResult(null); }}>
            {nonce ? "New challenge" : "Create a challenge"}
          </button>
        </div>
        {nonce && <Code>{`${CHAL}:${view.collection}:${nonce}`}</Code>}
      </Section>
      <Section title="Check their proof">
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
          <textarea id="proof" rows={3} value={proof} onChange={(e) => setProof(e.target.value)} spellCheck={false} disabled={!nonce} placeholder={nonce ? "seisin-proof:…" : "Create a challenge first"} />
          <div className="row">
            <button className="primary" type="submit" disabled={!nonce || !proof.trim() || busy}>
              {busy ? "Checking…" : "Check proof"}
            </button>
          </div>
        </form>
      </Section>
      {result && (
        <section className={result.ok ? "certificate ok" : "certificate bad"} aria-live="polite">
          <div className="cert-head">
            <span className="cert-seal" aria-hidden>
              {result.ok ? <IconSeal /> : <IconCross />}
            </span>
            <div>
              <h3>{result.ok ? `Holder of No. ${result.p?.tokenId} confirmed` : "Not confirmed"}</h3>
              <p className="small">{result.ok ? "Every check passed." : `${result.steps.filter((s) => !s.ok).length} of ${result.steps.length} checks did not pass.`}</p>
            </div>
          </div>
          <StepList steps={result.steps} />
          {result.ok && (
            <p className="small" style={{ marginTop: 14 }}>
              You learned that one token is held by the key that answered you. You did not learn their Zcash address, their other tokens, or who they bought from.
            </p>
          )}
        </section>
      )}
    </>
  );
}

// ---------- Operator ----------

function OperatorTab({ view, refresh }: { view: RegistryView; refresh: () => Promise<void> }) {
  const [token, setToken] = useState(() => sessionStorage.getItem("seisin.op") ?? "");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const head = view.epochs[view.epochs.length - 1];
  const needsAnchor = !head.anchor;

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      toast(true, await fn());
      await refresh();
    } catch (e) {
      toast(false, (e as Error).message);
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
