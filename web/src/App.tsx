import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { proveOwnership, verifyOwnership, signTransfer, ownerKey, type OwnershipProof, type RegistryState } from "../../src/core/registry.js";
import { hexToBytes } from "../../src/core/bytes.js";
import { encryptBackup, decryptBackup, MIN_PASSPHRASE } from "../../src/core/backup.js";
import {
  api,
  audit,
  checkAnchorInBrowser,
  stateAt,
  vault,
  randomHex32,
  short,
  links,
  parseIntent,
  decodeProof,
  encodeProof,
  challenges,
  sealEta,
  type Intent,
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
  { id: "operator", label: "Operator", icon: IconOperator, title: "Operator", sub: "Publish records, lock them on Zcash, and bring existing holders in." },
];

const explorer = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`;
const INTENT = "seisin.intent";
const SHOW_OP = "seisin.showop";

function session(k: string, v?: string | null): string | null {
  try {
    if (v === undefined) return sessionStorage.getItem(k);
    if (v === null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {}
  return null;
}

/** Where a link should land: a request opens the tab that answers it. */
function readHash(): { tab: Tab | null; intent: Intent | null; operator: boolean } {
  const h = location.hash.slice(1);
  if (h === "operator") return { tab: "operator", intent: null, operator: true };
  if (TABS.some((t) => t.id === h)) return { tab: h as Tab, intent: null, operator: false };
  const intent = parseIntent(location.hash);
  if (!intent) return { tab: null, intent: null, operator: false };
  return { tab: intent.kind === "check" ? "verify" : "vault", intent, operator: false };
}

export function App() {
  const first = useRef(readHash());
  const [showOp, setShowOp] = useState(() => first.current.operator || session(SHOW_OP) === "1" || !!session("seisin.op"));
  const [tab, setTab] = useState<Tab>(() => first.current.tab ?? "registry");
  const [intent, setIntent] = useState<Intent | null>(() => {
    if (first.current.intent) return first.current.intent;
    try {
      return JSON.parse(session(INTENT) ?? "null");
    } catch {
      return null;
    }
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
    // Records publish on their own, so keep the page current without a reload.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // A request link is remembered until it is answered, even across vault setup.
  const take = useCallback((r: ReturnType<typeof readHash>) => {
    if (r.operator) {
      session(SHOW_OP, "1");
      setShowOp(true);
    }
    if (r.intent) {
      session(INTENT, JSON.stringify(r.intent));
      setIntent(r.intent);
    }
    if (r.tab) {
      setTab(r.tab);
      history.replaceState(null, "", `#${r.tab}`);
    }
  }, []);

  useEffect(() => {
    take(first.current);
    const onHash = () => take(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [take]);

  const done = useCallback(() => {
    session(INTENT, null);
    setIntent(null);
  }, []);

  const go = (t: Tab) => {
    if (t === "operator") {
      session(SHOW_OP, "1");
      setShowOp(true);
    }
    setTab(t);
    history.replaceState(null, "", `#${t}`);
    window.scrollTo({ top: 0 });
  };

  const tabs = TABS.filter((t) => t.id !== "operator" || showOp);
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
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} aria-label={t.label} title={t.label} className={tab === t.id ? "nav-item on" : "nav-item"} onClick={() => go(t.id)}>
              <t.icon />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          {!showOp && (
            <a
              href="#operator"
              onClick={(e) => {
                e.preventDefault();
                go("operator");
              }}
            >
              <IconOperator />
              <span>Operator sign-in</span>
            </a>
          )}
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
          {view && <LockChip view={view} />}
        </header>
        {view && tab === "registry" && <RecordStrip view={view} />}

        <div className="page" key={tab}>
          <h1 className="display">{current.title}</h1>
          <p className="sub">{current.sub}</p>
          {view?.demoIssuance && (
            <p className="demo" role="note">
              <strong>Demo collection.</strong> Tokens in <code>{view.collection}</code> are handed out free to show the flow. Transfers, proofs and the Zcash locks are real.
            </p>
          )}
          {error && <p className="alert">Could not reach the registry: {error}</p>}
          {!view || !log ? (
            !error && <div className="skeleton" aria-label="Loading the registry" />
          ) : (
            <main role="tabpanel" className="rise">
              {tab === "registry" && <RegistryTab view={view} log={log} go={go} />}
              {tab === "vault" && <VaultTab view={view} log={log} refresh={refresh} intent={intent} done={done} />}
              {tab === "verify" && <VerifyTab view={view} log={log} intent={intent?.kind === "check" ? intent : null} done={done} />}
              {tab === "operator" && <OperatorTab view={view} refresh={refresh} />}
            </main>
          )}
        </div>
      </div>
    </div>
  );
}

function LockChip({ view }: { view: RegistryView }) {
  return view.latestAnchored === null ? (
    <span className="chip idle">Not locked on Zcash yet</span>
  ) : (
    <span className="chip gold">
      <IconSeal /> Locked on Zcash · record {view.latestAnchored}
    </span>
  );
}

function RecordStrip({ view }: { view: RegistryView }) {
  const head = view.epochs[view.epochs.length - 1];
  const anchored = view.epochs.filter((e) => e.anchor).pop();
  const items: [string, string, string?][] = [
    ["Record", String(view.head)],
    ["Supply", String(view.supply)],
    ["Root", short(head.record.root, 6), head.record.root],
    ["Record hash", short(head.hash, 6), head.hash],
    ["Zcash height", anchored?.anchor ? String(anchored.anchor.height) : "none"],
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

function QR({ value, alt, size = 220 }: { value: string; alt: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 2, width: size, errorCorrectionLevel: "L", color: { dark: "#0b0b0d", light: "#f4f4f5" } }).then(setSrc, () => setSrc(null));
  }, [value, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt={alt} /> : <div className="qr" style={{ width: size, height: size }} aria-hidden />;
}

/** A link to hand to someone else: copy it, share it, or show it as a QR code to scan. */
function ShareLink({ link, note, qrAlt }: { link: string; note: string; qrAlt: string }) {
  const [qr, setQr] = useState(false);
  const canShare = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <div className="share">
      <p className="small">{note}</p>
      <div className="code">
        <code>{link}</code>
        <Copy text={link} label="Copy link" />
      </div>
      <div className="row">
        <button className="ghost" onClick={() => setQr(!qr)} aria-expanded={qr}>
          {qr ? "Hide QR code" : "Show QR code"}
        </button>
        {canShare && (
          <button className="ghost" onClick={() => navigator.share({ url: link }).catch(() => {})}>
            Share…
          </button>
        )}
      </div>
      {qr && <QR value={link} alt={qrAlt} />}
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

function RegistryTab({ view, log, go }: { view: RegistryView; log: Log; go: (t: Tab) => void }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const epochs = [...view.epochs].reverse();
  const runAudit = async () => {
    setBusy(true);
    setSteps(await audit(view, log));
    setBusy(false);
  };

  return (
    <>
      <HowItWorks go={go} runAudit={runAudit} />
      <Section title="Record chain">
        <p className="muted">Each record commits to the one before it, so locking the newest record on Zcash also locks every earlier one.</p>
        <Chain view={view} />
      </Section>

      <Section
        title="Audit this registry"
        aside={
          <button
            className="primary"
            disabled={busy}
            onClick={runAudit}
          >
            {busy ? "Checking…" : steps ? "Run again" : "Run the audit"}
          </button>
        }
      >
        <p className="muted">
          Your browser rebuilds every record from the public log, checks each transfer's owner signature, and reads the record's note on Zcash mainnet with no key. Nothing here trusts the operator.
        </p>
        {steps && <StepList steps={steps} />}
      </Section>

      <Section title="Records">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Record</th>
                <th>Changes</th>
                <th>Record hash</th>
                <th>On Zcash</th>
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
                        locked at height {e.anchor.height}
                      </a>
                    ) : view.latestAnchored !== null && e.epoch < view.latestAnchored ? (
                      <span className="muted">locked through record {view.latestAnchored}</span>
                    ) : (
                      <span className="pill wait">not locked yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {view.pending.length > 0 && (
          <p className="muted">
            {view.pending.length} signed change{view.pending.length > 1 ? "s" : ""} will be published {sealEta(view)}: token {view.pending.map((p) => p.tokenId).join(", ")}.
          </p>
        )}
      </Section>

      {view.anchorAddress && (
        <Section title="Zcash lock account">
          <p className="muted">Every record is locked by a shielded note to this address. Its viewing key is public, so anyone can list every lock and spot two records with the same number.</p>
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

const INTRO = "seisin.intro.hidden";

/** Three steps for a first visit, each with one thing to try. Hidden once read. */
function HowItWorks({ go, runAudit }: { go: (t: Tab) => void; runAudit: () => void }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(INTRO) === "1";
    } catch {
      return false;
    }
  });
  if (hidden)
    return (
      <p className="small intro-again">
        <button
          className="link"
          onClick={() => {
            try {
              localStorage.removeItem(INTRO);
            } catch {}
            setHidden(false);
          }}
        >
          How Seisin works
        </button>
      </p>
    );
  const steps = [
    { n: "1", title: "Hold privately", body: "Your vault gives every token its own one-time key. Nobody can link your tokens to each other or to your Zcash wallet.", act: "Open a vault", run: () => go("vault") },
    { n: "2", title: "Prove with a link", body: "A verifier sends a challenge link; you answer with a proof link. They learn you hold one token, nothing else.", act: "See it work", run: () => go("verify") },
    { n: "3", title: "Anyone can audit", body: "Every record is rebuilt from the public log and locked on Zcash mainnet. Your browser checks it with no key.", act: "Run the audit", run: runAudit },
  ];
  return (
    <section className="panel intro" aria-label="How Seisin works">
      <div className="panel-head">
        <h2>How Seisin works</h2>
        <button
          className="link"
          onClick={() => {
            try {
              localStorage.setItem(INTRO, "1");
            } catch {}
            setHidden(true);
          }}
        >
          Got it
        </button>
      </div>
      <ol className="intro-steps">
        {steps.map((s) => (
          <li key={s.n}>
            <span className="dot" aria-hidden>
              {s.n}
            </span>
            <strong>{s.title}</strong>
            <p>{s.body}</p>
            <button className="ghost" onClick={s.run}>
              {s.act}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Chain({ view }: { view: RegistryView }) {
  const lockedAt = view.latestAnchored;
  return (
    <ol className="chain" aria-label="Records, oldest first">
      {view.epochs.map((e) => {
        const state = e.anchor ? "anchored" : lockedAt !== null && e.epoch < lockedAt ? "covered" : "open";
        const label = state === "anchored" ? `locked at ${e.anchor!.height}` : state === "covered" ? `locked via record ${lockedAt}` : "not locked yet";
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

/** Which of the vault's tokens can be proved now: held in the newest record that is locked on Zcash. */
function provable(view: RegistryView, log: Log): { state: RegistryState; ids: number[] } {
  const s = stateAt(log, view.latestAnchored ?? view.head);
  return { state: s, ids: s.owners.map((_, id) => id).filter((id) => vault.keyFor(s, id)) };
}

function VaultTab({ view, log, refresh, intent, done }: { view: RegistryView; log: Log; refresh: () => Promise<void>; intent: Intent | null; done: () => void }) {
  const [seeded, setSeeded] = useState(() => vault.seed() !== null);
  const [backed, setBacked] = useState(() => vault.backedUp());
  const [restoring, setRestoring] = useState(false);
  const toast = useToast();
  const forVault = intent && intent.kind !== "check" ? intent : null;
  const wrongCollection = forVault && forVault.collection !== view.collection;

  const request =
    forVault && !wrongCollection ? (
      <p className="notice">
        {forVault.kind === "claim"
          ? `You're claiming token No. ${forVault.tokenId}. Set up your vault first; the claim continues right after.`
          : forVault.kind === "prove"
            ? "A verifier asked you to prove a token. Open your vault first."
            : `Someone sent you a receive code for token No. ${forVault.tokenId}. Open the vault that holds it first.`}
      </p>
    ) : null;

  if (!seeded)
    return (
      <>
        {request}
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
                  setBacked(false);
                }}
              >
                Create a vault
              </button>
              <button className="link" onClick={() => setRestoring(true)}>
                Restore from a backup
              </button>
            </div>
          )}
          {view.demoVault && !restoring && forVault?.kind !== "claim" && (
            <div className="demo-vault">
              <div>
                <strong>Just looking?</strong>
                <p>Open the public demo vault. It already holds a token locked on Zcash, so you can prove it on the Verify tab straight away. Its backup is public, so it can prove but never transfer.</p>
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
      </>
    );

  const head = stateAt(log, view.head);
  const held = head.owners.map((_, id) => ({ id, key: vault.keyFor(head, id) })).filter((h) => h.key);
  const waiting = view.pending.filter((p) => vault.used(view.collection, p.tokenId) >= 0 && !held.some((h) => h.id === p.tokenId));
  const hasToken = held.length + waiting.length > 0;

  const requestCard = backed && forVault ? (
    wrongCollection ? (
      <IntentCard title="This link is for another registry" onDismiss={done}>
        <p className="muted">
          It was made for <code>{forVault.collection}</code>, and this registry is <code>{view.collection}</code>.
        </p>
      </IntentCard>
    ) : forVault.kind === "prove" ? (
      <ProveRequest view={view} log={log} nonce={forVault.nonce} returnUrl={forVault.returnUrl} onDismiss={done} />
    ) : forVault.kind === "claim" ? (
      <ClaimRequest view={view} intent={forVault} refresh={refresh} onDone={done} />
    ) : !held.some((h) => h.id === forVault.tokenId) ? (
      <IntentCard title={`This vault does not hold No. ${forVault.tokenId}`} onDismiss={done}>
        <p className="muted">The receive code asks for token No. {forVault.tokenId}. Open the vault that holds it, or ask the receiver for a code for one of your tokens.</p>
      </IntentCard>
    ) : null
  ) : null;

  // Setup checklist: exactly one next action is open at a time.
  if (!backed || !hasToken)
    return (
      <>
        {request && !backed ? request : requestCard}
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
                {backed ? (
                  <p>You typed it back correctly.</p>
                ) : (
                  <BackupConfirm
                    onDone={() => {
                      setBacked(true);
                      toast(true, "Backup confirmed.");
                    }}
                  />
                )}
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
                    <p>Send a seller the receive link below{view.demoIssuance ? ", or claim a free demo token" : ""}.</p>
                    {view.demoIssuance && <DemoClaim view={view} refresh={refresh} />}
                  </>
                )}
                {backed && !hasToken && <BuyPanel view={view} refresh={refresh} compact />}
              </div>
            </li>
          </ol>
        </Section>
        {backed && <ReceivePanel view={view} />}
      </>
    );

  return (
    <>
      {requestCard}
      {vault.isDemo() && (
        <p className="demo" role="note">
          <strong>Public demo vault.</strong> Anyone can open this vault, so it can prove what it holds but cannot transfer. Remove it under Backup to make your own.
        </p>
      )}
      <Section title="Your tokens" aside={<span className="small">{held.length} held{waiting.length ? ` · ${waiting.length} arriving` : ""}</span>}>
        <ul className="deeds">
          {held.map((h) => (
            <HeldToken key={h.id} id={h.id} view={view} log={log} refresh={refresh} sendTo={forVault?.kind === "send" && forVault.tokenId === h.id && !wrongCollection ? forVault.to : null} onSent={done} />
          ))}
          {waiting.map((p) => (
            <li key={`w${p.tokenId}`} className="deed arriving">
              <div className="deed-head">
                <span className="deed-id">No. {p.tokenId}</span>
                <span className="pill wait">arrives {sealEta(view)}</span>
              </div>
            </li>
          ))}
        </ul>
        {view.demoIssuance && !vault.isDemo() && <DemoClaim view={view} refresh={refresh} />}
      </Section>
      {!vault.isDemo() && <BuyPanel view={view} refresh={refresh} />}
      {!vault.isDemo() && <ReceivePanel view={view} />}
      <Section title="Backup">
        <BackupPanel
          onForget={() => {
            setSeeded(false);
            setBacked(false);
          }}
        />
      </Section>
    </>
  );
}

function IntentCard({ title, children, onDismiss }: { title: string; children: ReactNode; onDismiss: () => void }) {
  return (
    <section className="panel request" aria-live="polite">
      <div className="panel-head">
        <h2>{title}</h2>
        <button className="link" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {children}
    </section>
  );
}

function ProveRequest({ view, log, nonce, returnUrl, onDismiss }: { view: RegistryView; log: Log; nonce: string; returnUrl?: string; onDismiss: () => void }) {
  const [proof, setProof] = useState<{ id: number; link: string; code: string } | null>(null);
  const site = returnUrl ? new URL(returnUrl).host : null;
  const { state, ids } = provable(view, log);
  const record = view.latestAnchored ?? view.head;
  return (
    <IntentCard title={site ? `${site} asks you to prove a token` : "A verifier asked you to prove a token"} onDismiss={onDismiss}>
      {ids.length === 0 ? (
        <p className="muted">This vault has no token in record {record}, the newest one locked on Zcash. A token you received later can be proved once a newer record is locked.</p>
      ) : (
        <>
          <p className="muted">Choose the token to prove. The verifier learns only that you hold it. They do not see your other tokens or anything about your Zcash wallet.</p>
          <div className="row" style={{ marginTop: 14 }}>
            {ids.map((id) => (
              <button
                key={id}
                className={proof?.id === id ? "secondary" : "primary"}
                onClick={() => {
                  const k = vault.keyFor(state, id)!;
                  const p = proveOwnership(state, id, k.secret, nonce);
                  setProof({ id, link: links.proof(p), code: encodeProof(p) });
                }}
              >
                Prove No. {id}
              </button>
            ))}
          </div>
          {proof && returnUrl && (
            <div className="milestone">
              <strong>Proof ready for No. {proof.id}</strong>
              <p>{site} will learn that you hold token No. {proof.id} in {view.collection}. Nothing else about you or your vault leaves this page.</p>
              <div className="row" style={{ marginTop: 12 }}>
                <a
                  className="button primary"
                  href={`${returnUrl.split("#")[0]}#seisin_proof=${proof.code}`}
                  onClick={() => onDismiss()}
                >
                  Return to {site}
                </a>
              </div>
            </div>
          )}
          {proof && !returnUrl && (
            <div className="milestone">
              <strong>Proof ready for No. {proof.id}</strong>
              <ShareLink link={proof.link} note="Send this link back to the verifier. It opens their Verify tab with the answer ready." qrAlt={`Proof link for token No. ${proof.id}`} />
            </div>
          )}
        </>
      )}
    </IntentCard>
  );
}

function ClaimRequest({ view, intent, refresh, onDone }: { view: RegistryView; intent: Extract<Intent, { kind: "claim" }>; refresh: () => Promise<void>; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <IntentCard title={`Claim token No. ${intent.tokenId}`} onDismiss={onDone}>
      <p className="muted">This link was sent privately to the Zcash wallet that bought the token. Claiming moves it to a fresh key in this vault. After that, only this vault can prove or transfer it.</p>
      <div className="row" style={{ marginTop: 14 }}>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const k = vault.fresh(view.collection, intent.tokenId);
              await api.post("/api/claim", { tokenId: intent.tokenId, code: intent.code, to: k.public });
              toast(true, `Token No. ${intent.tokenId} is yours. It arrives ${sealEta(view)}.`);
              onDone();
              await refresh();
            } catch (e) {
              toast(false, (e as Error).message);
            }
            setBusy(false);
          }}
        >
          {busy ? "Claiming…" : `Claim No. ${intent.tokenId}`}
        </button>
      </div>
    </IntentCard>
  );
}

function BackupConfirm({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<"show" | "check" | "file">("show");
  const [tail, setTail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (stage === "file") return <EncryptedBackup onSaved={onDone} onCancel={() => setStage("show")} />;
  return stage === "show" ? (
    <>
      <p>Write this down somewhere offline. Anyone with it can move your tokens, and without it a lost browser means lost tokens.</p>
      <Code>{vault.backup() ?? ""}</Code>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => setStage("check")}>
          I wrote it down
        </button>
        <button className="link" onClick={() => setStage("file")}>
          Download an encrypted backup file instead
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
      <input
        id="tail"
        className="narrow"
        value={tail}
        maxLength={6}
        onChange={(e) => {
          setTail(e.target.value);
          setErr(null);
        }}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!err}
        aria-describedby={err ? "tail-err" : undefined}
      />
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
  const [fromFile, setFromFile] = useState(false);
  if (fromFile) return <RestoreFile onDone={onDone} onCancel={() => setFromFile(false)} />;
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
      <input
        id="restore"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          setErr(null);
        }}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!err}
      />
      {err && <p className="field-err">{err}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={!v.trim()}>
          Restore
        </button>
        <button className="link" type="button" onClick={() => setFromFile(true)}>
          Restore from a backup file
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
            toast(true, `Token No. ${id} is on its way. It arrives ${sealEta(view)}.`);
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

function HeldToken({ id, view, log, refresh, sendTo, onSent }: { id: number; view: RegistryView; log: Log; refresh: () => Promise<void>; sendTo: string | null; onSent: () => void }) {
  const [mode, setMode] = useState<"none" | "prove" | "send">("none");
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [review, setReview] = useState<{ to: string; from: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const demo = vault.isDemo();

  // A receive link for this token opens straight on its review.
  useEffect(() => {
    if (!sendTo || demo) return;
    const k = vault.keyFor(stateAt(log, view.head), id);
    if (k && sendTo !== k.public) {
      setMode("send");
      setReview({ to: sendTo, from: k.public });
    }
  }, [sendTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (m: "prove" | "send") => {
    setMode(mode === m ? "none" : m);
    setInput("");
    setErr(null);
    setOut(null);
    setReview(null);
  };

  const prove = () => {
    const i = parseIntent(input);
    if (!i || i.kind !== "prove") throw new Error("Paste the verifier's challenge link.");
    if (i.collection !== view.collection) throw new Error(`That challenge is for ${i.collection}, not ${view.collection}.`);
    const record = view.latestAnchored ?? view.head;
    const s = stateAt(log, record);
    const k = vault.keyFor(s, id);
    if (!k) throw new Error(`You received this token after record ${record}, the newest one locked on Zcash. You can prove it once a newer record is locked.`);
    setOut(links.proof(proveOwnership(s, id, k.secret, i.nonce)));
  };

  const check = () => {
    const i = parseIntent(input);
    if (!i || i.kind !== "send") throw new Error("Paste the receiver's link.");
    if (i.collection !== view.collection || i.tokenId !== id) throw new Error(`That link is for token No. ${i.tokenId} in ${i.collection}, not this one.`);
    const k = vault.keyFor(stateAt(log, view.head), id)!;
    if (i.to === k.public) throw new Error("That link points back at your own key.");
    setReview({ to: i.to, from: k.public });
  };

  const commit = async () => {
    setBusy(true);
    try {
      const k = vault.keyFor(stateAt(log, view.head), id)!;
      const change = signTransfer(view.collection, view.head, { tokenId: id, from: k.public, to: review!.to, ref: "00".repeat(32) }, k.secret);
      await api.post("/api/transfers", { change });
      toast(true, `Token No. ${id} is signed over. It moves ${sealEta(view)}.`);
      setMode("none");
      setReview(null);
      onSent();
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
          <span className="pill wait">leaves {sealEta(view)}</span>
        ) : (
          <div className="row">
            <button className={mode === "prove" ? "ghost on" : "ghost"} aria-expanded={mode === "prove"} onClick={() => open("prove")}>
              Prove
            </button>
            {!demo && (
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
          <label htmlFor={`in${id}`}>{mode === "prove" ? "Verifier's challenge link" : "Receiver's link"}</label>
          <input
            id={`in${id}`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setErr(null);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!err}
            aria-describedby={err ? `err${id}` : undefined}
          />
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
              <ShareLink link={out} note="Send this link back to the verifier. It shows only that this token's current key answered their challenge." qrAlt={`Proof link for token No. ${id}`} />
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
            <dd>{sealEta(view)}</dd>
          </dl>
          <p className="small">Once published this cannot be undone. Only the new holder can move it after that.</p>
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
  const [link, setLink] = useState<string | null>(null);
  return (
    <Section title="Receive a token">
      <p className="muted">Make a one-time link for the seller. It names a fresh key that has never been used, so the sale cannot be linked to anything else in your vault.</p>
      <form
        className="row"
        style={{ marginTop: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(id);
          if (!Number.isInteger(n) || n < 0 || n >= view.supply) return;
          setLink(links.receive(view.collection, n, vault.fresh(view.collection, n).public));
        }}
      >
        <label htmlFor="recv" className="sr">
          Token number
        </label>
        <input id="recv" className="narrow" type="number" min={0} max={view.supply - 1} placeholder="Token No." value={id} onChange={(e) => setId(e.target.value)} />
        <button className="secondary" type="submit" disabled={id === ""}>
          Make a receive link
        </button>
      </form>
      {link && <ShareLink link={link} note="Send this to the seller. It opens their vault with the transfer ready to review." qrAlt="Receive link" />}
    </Section>
  );
}

function BackupPanel({ onForget }: { onForget: () => void }) {
  const [show, setShow] = useState(false);
  const [file, setFile] = useState(false);
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
            <button
              className="danger"
              onClick={() => {
                vault.forget();
                onForget();
              }}
            >
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
      {file ? (
        <EncryptedBackup onSaved={() => setFile(false)} onCancel={() => setFile(false)} />
      ) : (
        <div className="row">
          <button className="ghost" onClick={() => setFile(true)}>
            Download an encrypted backup file
          </button>
        </div>
      )}
    </div>
  );
}

/** Saves the vault secret as a file sealed with a passphrase the holder types twice. */
function EncryptedBackup({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (a.length < MIN_PASSPHRASE) return setErr(`Use at least ${MIN_PASSPHRASE} characters.`);
        if (a !== b) return setErr("The two passphrases do not match.");
        setBusy(true);
        try {
          const file = await encryptBackup(vault.backup()!, a);
          const url = URL.createObjectURL(new Blob([file], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = `seisin-vault-${new Date().toISOString().slice(0, 10)}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          vault.markBackedUp();
          toast(true, "Encrypted backup downloaded. Keep the file and the passphrase in different places.");
          onSaved();
        } catch (x) {
          setErr((x as Error).message);
        }
        setBusy(false);
      }}
    >
      <p className="small" style={{ margin: 0 }}>
        The file is useless without the passphrase, and the passphrase cannot be recovered. Keep them in different places.
      </p>
      <label htmlFor="bp1">Passphrase</label>
      <input
        id="bp1"
        type="password"
        value={a}
        onChange={(e) => {
          setA(e.target.value);
          setErr(null);
        }}
        autoComplete="new-password"
      />
      <label htmlFor="bp2">Type it again</label>
      <input
        id="bp2"
        type="password"
        value={b}
        onChange={(e) => {
          setB(e.target.value);
          setErr(null);
        }}
        autoComplete="new-password"
        aria-invalid={!!err}
      />
      {err && <p className="field-err">{err}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !a || !b}>
          {busy ? "Encrypting…" : "Download backup file"}
        </button>
        <button className="link" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RestoreFile({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          vault.restore(await decryptBackup(text ?? "", pass));
          onDone();
        } catch (x) {
          setErr((x as Error).message);
        }
        setBusy(false);
      }}
    >
      <label htmlFor="bfile">Backup file</label>
      <input
        id="bfile"
        type="file"
        accept="application/json,.json"
        onChange={async (e) => {
          setText((await e.target.files?.[0]?.text()) ?? null);
          setErr(null);
        }}
      />
      <label htmlFor="bpass">Passphrase</label>
      <input
        id="bpass"
        type="password"
        value={pass}
        onChange={(e) => {
          setPass(e.target.value);
          setErr(null);
        }}
        autoComplete="current-password"
        aria-invalid={!!err}
      />
      {err && <p className="field-err">{err}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !text || !pass}>
          {busy ? "Decrypting…" : "Restore"}
        </button>
        <button className="link" type="button" onClick={onCancel}>
          Back
        </button>
      </div>
    </form>
  );
}

// ---------- Verify ----------

type Result = { ok: boolean; steps: Step[]; p?: OwnershipProof; demo?: boolean };

async function checkProof(view: RegistryView, log: Log, raw: string): Promise<Result> {
  let p: OwnershipProof;
  try {
    p = decodeProof(raw);
  } catch {
    return { ok: false, steps: [{ label: "Readable proof", ok: false, detail: "That is not a Seisin proof link." }] };
  }
  const steps: Step[] = [];
  const target = view.epochs.find((e) => e.epoch === (view.latestAnchored ?? view.head))!;
  if (target.anchor) {
    try {
      const a = await checkAnchorInBrowser(view, target);
      steps.push({ label: "Record is locked on Zcash", ok: true, detail: `record ${target.epoch}, mined at height ${a.height}, checked here with no key` });
    } catch (e) {
      steps.push({ label: "Record is locked on Zcash", ok: false, detail: (e as Error).message });
    }
  } else {
    steps.push({ label: "Record is locked on Zcash", ok: false, detail: `no record is locked yet; record ${target.epoch} is only the operator's word` });
  }
  // the record must also be the one the public log rebuilds
  const rebuilt = stateAt(log, target.epoch).record;
  steps.push({ label: "Record matches the public log", ok: rebuilt.root === target.record.root, detail: `root ${short(target.record.root, 10)}` });
  const why = !challenges.has(p.nonce) ? "this proof answers a challenge that was not created in this browser, so it could be a replay" : verifyOwnership(p, target.record, p.nonce);
  steps.push({ label: "Holder answered your challenge", ok: why === null, detail: why ?? `token No. ${p.tokenId} is held by the key that signed your challenge` });
  return { ok: steps.every((s) => s.ok), steps, p };
}

function VerifyTab({ view, log, intent, done }: { view: RegistryView; log: Log; intent: Extract<Intent, { kind: "check" }> | null; done: () => void }) {
  const [nonce, setNonce] = useState<string | null>(null);
  const [proof, setProof] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (raw: string, demo = false) => {
    setBusy(true);
    const r = await checkProof(view, log, raw);
    setResult({ ...r, demo });
    setBusy(false);
  };

  // A proof link opens here with the answer ready.
  useEffect(() => {
    if (!intent) return;
    setProof(intent.proof);
    run(intent.proof);
    done();
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The whole round in one click, answered by the public demo vault. */
  const seeItWork = async () => {
    const n = randomHex32();
    challenges.add(n);
    setNonce(n);
    const { state } = provable(view, log);
    const seed = hexToBytes(view.demoVault!);
    for (let id = 0; id < state.owners.length; id++)
      for (let k = 0; k < 16; k++) {
        const key = ownerKey(seed, view.collection, id, k);
        if (key.public !== state.owners[id]) continue;
        const link = links.proof(proveOwnership(state, id, key.secret, n));
        setProof(link);
        return run(link, true);
      }
    setResult({ ok: false, demo: true, steps: [{ label: "Demo vault", ok: false, detail: "the public demo vault holds nothing in the newest locked record" }] });
  };

  const at = result ? 2 : nonce || proof ? 1 : 0;

  return (
    <>
      <Stepper steps={["Send a challenge", "Check their proof", "Result"]} at={at} />
      <Section
        title="Send a challenge"
        aside={
          view.demoVault ? (
            <button className="secondary" disabled={busy} onClick={seeItWork}>
              See it work
            </button>
          ) : undefined
        }
      >
        <p className="muted">A fresh challenge stops a holder from reusing an old proof or one made for someone else.{view.demoVault ? " Or press See it work to watch the public demo vault answer one." : ""}</p>
        <div className="row" style={{ marginTop: 16 }}>
          <button
            className={nonce ? "secondary" : "primary"}
            onClick={() => {
              const n = randomHex32();
              challenges.add(n);
              setNonce(n);
              setResult(null);
              setProof("");
            }}
          >
            {nonce ? "New challenge" : "Create a challenge"}
          </button>
        </div>
        {nonce && <ShareLink link={links.challenge(view.collection, nonce)} note="Send this link to the holder. It opens their vault with your request ready, and their answer comes back as a link." qrAlt="Challenge link" />}
      </Section>
      <Section title="Check their proof">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            await run(proof);
          }}
        >
          <label htmlFor="proof">Proof link from the holder</label>
          <textarea id="proof" rows={3} value={proof} onChange={(e) => setProof(e.target.value)} spellCheck={false} placeholder="Opening their link fills this in for you" />
          <div className="row">
            <button className="primary" type="submit" disabled={!proof.trim() || busy}>
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
              <p className="small">
                {result.demo ? "Demo run with the public demo vault. " : ""}
                {result.ok ? "Every check passed." : `${result.steps.filter((s) => !s.ok).length} of ${result.steps.length} checks did not pass.`}
              </p>
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
  const [token, setToken] = useState(() => session("seisin.op") ?? "");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const head = view.epochs[view.epochs.length - 1];
  const needsLock = !head.anchor;

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
        <p className="muted">Publishing, locking and claim codes need the operator token. It cannot sign transfers or proofs; only holders can.</p>
        <input
          type="password"
          aria-label="Operator token"
          value={token}
          autoComplete="off"
          onChange={(e) => {
            setToken(e.target.value);
            session("seisin.op", e.target.value);
          }}
        />
      </Section>
      <Section title="Publish the next record">
        <p className="muted">
          {view.autoSealMinutes > 0 ? `Signed changes are published automatically every ${view.autoSealMinutes} minutes. ` : ""}
          {view.pending.length === 0 ? "No signed changes are waiting." : `${view.pending.length} waiting.`}
        </p>
        {view.pending.length > 0 && (
          <>
            <ul className="plain">
              {view.pending.map((p, i) => (
                <li key={i}>
                  Token No. {p.tokenId} <span className="muted">· {p.note}</span>
                </li>
              ))}
            </ul>
            <button
              className="primary"
              disabled={busy || !token}
              onClick={() =>
                act(async () => {
                  const r = await api.post<{ sealed: number }>("/api/operator/seal", {}, token);
                  return `Published record ${r.sealed}.`;
                })
              }
            >
              Publish now
            </button>
          </>
        )}
      </Section>
      {view.autoLock && <LockerPanel />}
      {needsLock && <LockPanel view={view} record={head.epoch} token={token} busy={busy} act={act} />}
      <ClaimsPanel view={view} token={token} />
      <SalesPanel token={token} />
    </>
  );
}

function LockPanel({ view, record, token, busy, act }: { view: RegistryView; record: number; token: string; busy: boolean; act: (fn: () => Promise<string>) => Promise<void> }) {
  const [req, setReq] = useState<{ memo: string; amount: string; uri: string | null } | null>(null);
  const [txid, setTxid] = useState("");

  useEffect(() => {
    fetch(`/api/anchor-request/${record}`)
      .then((r) => r.json())
      .then(setReq);
  }, [record]);

  return (
    <Section title={`Lock record ${record} on Zcash`}>
      {!view.anchorAddress ? (
        <p className="alert">No lock account is configured. Set ANCHOR_ADDRESS and ANCHOR_UIVK on the service.</p>
      ) : !req ? (
        <p className="muted">Preparing the payment request…</p>
      ) : (
        <div className="anchor">
          {req.uri && <QR value={req.uri} alt="Payment request that locks this record" size={240} />}
          <div className="stack">
            <p className="muted">Pay {req.amount} ZEC to the lock address from a shielded wallet with this memo. Scanning the code fills in both. Locking this record also locks every earlier one.</p>
            <Code>{req.memo}</Code>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const r = await api.post<{ height: number }>("/api/operator/anchor", { epoch: record, txid: txid.trim() }, token);
                  return `Record ${record} locked at height ${r.height}.`;
                });
              }}
            >
              <label htmlFor="txid" className="sr">
                Transaction id
              </label>
              <input id="txid" placeholder="Transaction id once mined" value={txid} onChange={(e) => setTxid(e.target.value)} spellCheck={false} />
              <button className="primary" type="submit" disabled={busy || !token || !/^[0-9a-f]{64}$/.test(txid.trim())}>
                Record the lock
              </button>
            </form>
          </div>
        </div>
      )}
    </Section>
  );
}

type Claim = { tokenId: number; address: string; link: string; memo: string };

function ClaimsPanel({ view, token }: { view: RegistryView; token: string }) {
  const [csv, setCsv] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<{ claims: Claim[]; uri: string; amount: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const parse = () =>
    csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^token/i.test(l))
      .map((l, i) => {
        const [id, address] = l.split(/[,;\s]+/);
        if (!/^\d+$/.test(id ?? "") || !address) throw new Error(`line ${i + 1}: expected "token number, shielded address"`);
        return { tokenId: Number(id), address };
      });

  return (
    <Section title="Bring existing holders in">
      <p className="muted">
        Paste your current ownership list, one <code>token, address</code> per line. Each holder gets a one-time claim link inside the encrypted memo of a small payment to their own shielded address, so nobody else sees it. Seisin keeps only a hash of each code, never the address.
      </p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setBusy(true);
          try {
            const r = await api.post<{ claims: Claim[]; uri: string; amount: string }>("/api/operator/claims", { rows: parse() }, token);
            setOut(r);
            toast(true, `${r.claims.length} claim link${r.claims.length === 1 ? "" : "s"} ready to send.`);
          } catch (x) {
            setErr((x as Error).message);
          }
          setBusy(false);
        }}
      >
        <label htmlFor="csv">Ownership list</label>
        <textarea id="csv" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} placeholder={`5, u1…\n9, u1…`} aria-invalid={!!err} />
        {err && <p className="field-err">{err}</p>}
        <div className="row">
          <button className="primary" type="submit" disabled={busy || !token || !csv.trim()}>
            {busy ? "Making claim links…" : "Make claim links"}
          </button>
        </div>
      </form>
      {out && (
        <div className="milestone">
          <strong>One payment sends every claim link</strong>
          <p>
            Pay this from your shielded wallet: {out.claims.length} output{out.claims.length === 1 ? "" : "s"} of {out.amount} ZEC each, every one carrying its holder's link in the memo. The codes are shown only now.
          </p>
          <div className="anchor" style={{ marginTop: 12 }}>
            <QR value={out.uri} alt="Payment request that delivers every claim link" size={240} />
            <ul className="plain">
              {out.claims.map((c) => (
                <li key={c.tokenId}>
                  No. {c.tokenId} → <code>{short(c.address, 8)}</code>
                </li>
              ))}
            </ul>
          </div>
          <Code>{out.uri}</Code>
          <p className="small">Records publish {view.autoSealMinutes > 0 ? `every ${view.autoSealMinutes} minutes` : "when you press Publish now"}, so a claimed token shows up in the holder's vault soon after they open their link.</p>
        </div>
      )}
    </Section>
  );
}

type LockerStatus = {
  available: boolean;
  reachable?: boolean;
  ok?: boolean;
  address?: string | null;
  spendableZats?: number | null;
  locksLeft?: number | null;
  lastCheck?: string | null;
  nextCheck?: string | null;
  lastLock?: { epoch: number; txid: string; height?: number; at: string } | null;
  inflight?: { epoch: number; txid: string; at: string } | null;
  error?: string | null;
  locksToday?: number;
  limits?: { checkMinutes: number; minHoursBetween: number; maxPerDay: number; minBalanceZats: number };
  dryRun?: boolean;
};

const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** The automatic locker: what it will do next, and anything that needs the operator. */
function LockerPanel() {
  const [s, setS] = useState<LockerStatus | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/locker").then((r) => r.json()).then(setS, () => setS({ available: true, reachable: false }));
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const zec = (z?: number | null) => (z == null ? "unknown" : `${(z / 1e8).toFixed(5)} ZEC`);
  const state = s.reachable === false ? "Unreachable" : s.dryRun ? "Dry run (pays nothing)" : s.inflight ? "Waiting for a lock to be mined" : s.error ? "Needs attention" : "On";
  return (
    <Section title="Automatic locking" aside={<span className={s.error || s.reachable === false ? "pill wait" : "chip gold"}>{state}</span>}>
      <p className="muted">
        A small wallet beside the registry locks a record on Zcash as soon as it is published
        {s.limits ? `, at least ${s.limits.minHoursBetween} hours apart and at most ${s.limits.maxPerDay} times a day, so changes close together share one lock` : ""}. Every lock is still checked in the browser against mainnet, like a lock paid by hand.
      </p>
      {s.error && <p className="alert">{s.error}</p>}
      <dl className="kv">
        <dt>Last lock</dt>
        <dd>{s.lastLock ? <a href={explorer(s.lastLock.txid)} target="_blank" rel="noreferrer">record {s.lastLock.epoch}, {ago(s.lastLock.at)}</a> : "none yet"}</dd>
        {s.inflight && (
          <>
            <dt>Being mined</dt>
            <dd>
              <a href={explorer(s.inflight.txid)} target="_blank" rel="noreferrer">record {s.inflight.epoch}, sent {ago(s.inflight.at)}</a>
            </dd>
          </>
        )}
        <dt>Balance</dt>
        <dd>
          {zec(s.spendableZats)}
          {s.locksLeft != null ? ` · about ${s.locksLeft} lock${s.locksLeft === 1 ? "" : "s"} left` : ""}
          {s.limits && s.spendableZats != null && s.spendableZats < s.limits.minBalanceZats * 2 ? " · low, top up soon" : ""}
        </dd>
        <dt>Last check</dt>
        <dd>{ago(s.lastCheck)}</dd>
        {s.address && (
          <>
            <dt>Top-up address</dt>
            <dd>
              <Code>{s.address}</Code>
            </dd>
          </>
        )}
      </dl>
    </Section>
  );
}

type Sale = { available: boolean; collection?: string; address?: string; priceZats?: number; amount?: string; forSale?: number[] };

/**
 * Buying a token's first transfer with ZEC. The memo carries a fresh key from this vault, so the
 * token goes to a key nobody can link to the paying wallet; only the operator can read the memo.
 */
function BuyPanel({ view, refresh, compact }: { view: RegistryView; refresh: () => Promise<void>; compact?: boolean }) {
  const [sale, setSale] = useState<Sale | null>(null);
  const [id, setId] = useState<number | null>(null);
  const [order, setOrder] = useState<{ id: number; uri: string; memo: string } | null>(null);
  const [txid, setTxid] = useState("");
  const [state, setState] = useState<{ busy: boolean; note: string | null; err: string | null }>({ busy: false, note: null, err: null });
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useToast();

  useEffect(() => {
    fetch("/api/sale")
      .then((r) => r.json())
      .then((s: Sale) => {
        setSale(s);
        if (s.forSale?.length) setId(s.forSale[0]);
      }, () => setSale({ available: false }));
    return () => clearTimeout(retry.current);
  }, []);

  if (!sale?.available || !sale.forSale?.length) return null;

  const start = () => {
    if (id === null) return;
    const key = vault.fresh(view.collection, id).public;
    const memo = `SEISIN-BUY ${view.collection} ${id} ${key}`;
    const b64 = btoa(memo).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    setOrder({ id, memo, uri: `zcash:${sale.address}?amount=${sale.amount}&memo=${b64}` });
  };

  const submit = async (attempt = 0) => {
    setState({ busy: true, note: null, err: null });
    const r = await fetch("/api/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txid: txid.trim() }) });
    const b = await r.json().catch(() => ({}));
    if (r.status === 202) {
      toast(true, `Token No. ${b.tokenId} is yours. It arrives ${sealEta(view)}.`);
      setOrder(null);
      setTxid("");
      setState({ busy: false, note: null, err: null });
      return refresh();
    }
    if (r.status === 425 && attempt < 20) {
      setState({ busy: true, note: "Waiting for your payment to be mined. This page checks again every minute.", err: null });
      retry.current = setTimeout(() => submit(attempt + 1), 60_000);
      return;
    }
    setState({ busy: false, note: null, err: b.error ?? `could not check the payment (${r.status})` });
  };

  const body = !order ? (
    <>
      <p className="muted">
        Buy a token's first transfer for {sale.amount} ZEC. The payment's encrypted memo carries a fresh key from this vault, so the token cannot be linked to the wallet that paid.
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        <label htmlFor="buy-id" className="sr">
          Token to buy
        </label>
        <select id="buy-id" className="narrow" value={id ?? ""} onChange={(e) => setId(Number(e.target.value))}>
          {sale.forSale.map((n) => (
            <option key={n} value={n}>
              No. {n}
            </option>
          ))}
        </select>
        <button className="secondary" onClick={start}>
          Buy No. {id} for {sale.amount} ZEC
        </button>
      </div>
    </>
  ) : (
    <div className="stack">
      <div className="anchor">
        <QR value={order.uri} alt={`Payment request for token No. ${order.id}`} size={220} />
        <div className="stack" style={{ marginTop: 0 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Pay {sale.amount} ZEC from any shielded Zcash wallet. Scanning the code fills in the address, amount and memo. If your wallet does not read the memo from the code, paste it exactly.
          </p>
          <Code>{order.memo}</Code>
          <Code>{sale.address!}</Code>
        </div>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="buy-tx">Transaction id, once you have paid</label>
        <input id="buy-tx" value={txid} onChange={(e) => setTxid(e.target.value)} spellCheck={false} autoComplete="off" aria-invalid={!!state.err} />
        {state.err && <p className="field-err">{state.err}</p>}
        {state.note && <p className="small">{state.note}</p>}
        <div className="row">
          <button className="primary" type="submit" disabled={state.busy || !/^[0-9a-f]{64}$/.test(txid.trim())}>
            {state.busy ? "Checking…" : "Claim my token"}
          </button>
          <button
            className="link"
            type="button"
            onClick={() => {
              clearTimeout(retry.current);
              setOrder(null);
              setState({ busy: false, note: null, err: null });
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );

  return compact ? <div className="buy-compact">{body}</div> : <Section title="Buy a token">{body}</Section>;
}

/** What buyers paid for, and anything owed back because a token was taken before the payment landed. */
function SalesPanel({ token }: { token: string }) {
  const [list, setList] = useState<{ txid: string; tokenId: number; value: number; status: string; at: string }[] | null>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  useEffect(() => {
    fetch("/api/sale").then((r) => r.json()).then(setSale, () => setSale({ available: false }));
  }, []);
  useEffect(() => {
    if (!token) return;
    fetch("/api/operator/purchases", { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { purchases: null }))
      .then((b) => setList(b.purchases), () => setList(null));
  }, [token]);
  if (!sale?.available) return null;
  const refunds = (list ?? []).filter((p) => p.status === "refund-due");
  return (
    <Section title="Sales" aside={refunds.length ? <span className="pill wait">{refunds.length} refund{refunds.length === 1 ? "" : "s"} due</span> : undefined}>
      <p className="muted">
        Tokens sell for {sale.amount} ZEC to <code>{short(sale.address ?? "", 10)}</code>. {sale.forSale?.length ?? 0} still for sale.
      </p>
      {!token ? (
        <p className="small">Enter the operator token to see purchases.</p>
      ) : !list || list.length === 0 ? (
        <p className="small">No purchases yet.</p>
      ) : (
        <ul className="plain">
          {[...refunds, ...list.filter((p) => p.status !== "refund-due")].map((p) => (
            <li key={p.txid}>
              No. {p.tokenId} · {(p.value / 1e8).toFixed(5)} ZEC ·{" "}
              {p.status === "refund-due" ? <strong>refund due</strong> : "issued"} ·{" "}
              <a href={explorer(p.txid)} target="_blank" rel="noreferrer">
                {short(p.txid, 6)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
