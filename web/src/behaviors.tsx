import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCross } from "./icons";

// ---------- toasts: results of an action, announced politely and dismissed on their own ----------

type Toast = { id: number; ok: boolean; text: string };
const ToastCtx = createContext<(ok: boolean, text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const next = useRef(0);
  const push = useCallback((ok: boolean, text: string) => {
    const id = ++next.current;
    setList((l) => [...l.slice(-2), { id, ok, text }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), ok ? 5000 : 8000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={t.ok ? "toast ok" : "toast bad"}>
            <span className="toast-mark" aria-hidden>
              {t.ok ? <IconCheck /> : <IconCross />}
            </span>
            <span>{t.text}</span>
            <button className="toast-x" aria-label="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>
              <IconCross />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- hold to commit: for actions that cannot be taken back ----------

/*
 * The action fires only after the button has been held for `ms`. Pointer and
 * keyboard (Space or Enter held down) both work; letting go early cancels.
 */
export function HoldButton({ label, doneLabel, ms = 1200, disabled, onCommit }: { label: string; doneLabel: string; ms?: number; disabled?: boolean; onCommit: () => void }) {
  const [p, setP] = useState(0);
  const start = useRef<number | null>(null);
  const raf = useRef(0);
  const fired = useRef(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    start.current = null;
    if (!fired.current) setP(0);
  }, []);

  const tick = useCallback(() => {
    if (start.current === null) return;
    const v = Math.min(1, (performance.now() - start.current) / ms);
    setP(v);
    if (v >= 1) {
      fired.current = true;
      start.current = null;
      onCommit();
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [ms, onCommit]);

  const begin = () => {
    if (disabled || fired.current || start.current !== null) return;
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <button
      type="button"
      className={`hold ${p >= 1 ? "done" : ""}`}
      disabled={disabled}
      style={{ ["--p" as string]: p }}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      aria-label={`${label}. Press and hold to confirm.`}
    >
      <span className="hold-fill" aria-hidden />
      <span className="hold-label">{p >= 1 ? doneLabel : p > 0 ? "Keep holding…" : label}</span>
    </button>
  );
}

// ---------- stepper: where the person is in a multi-step job ----------

export function Stepper({ steps, at }: { steps: string[]; at: number }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} className={i < at ? "done" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>
          <span className="dot" aria-hidden>
            {i < at ? <IconCheck /> : i + 1}
          </span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}
