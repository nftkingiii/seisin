/*
 * Seisin gate: let visitors prove they hold a token without telling you who they are.
 *
 *   <script src="https://seisin.up.railway.app/gate.js"></script>
 *   <button data-seisin-gate>Verify with Seisin</button>
 *   <script>
 *     addEventListener("seisin:verified", (e) => unlock(e.detail.tokenId));
 *     addEventListener("seisin:failed", (e) => showError(e.detail.reason));
 *   </script>
 *
 * The button asks Seisin for a one-time challenge bound to this site, sends the visitor to
 * their vault to answer it, and checks the answer when they come back. Your site learns which
 * token they hold and that its record is locked on Zcash; nothing about their wallet or other
 * tokens. Each proof works once, and only on the site that asked for it.
 */
(() => {
  const script = document.currentScript;
  const seisin = new URL(script.src).origin;
  const emit = (name, detail) => dispatchEvent(new CustomEvent(name, { detail }));
  const buttons = () => document.querySelectorAll("[data-seisin-gate]");
  const label = (text, busy) =>
    buttons().forEach((b) => {
      b.textContent = text;
      b.disabled = !!busy;
      b.setAttribute("aria-busy", busy ? "true" : "false");
    });

  async function post(path, body) {
    const r = await fetch(seisin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Seisin returned ${r.status}`);
    return j;
  }

  async function start() {
    label("Opening your vault…", true);
    try {
      const here = location.href.split("#")[0];
      const c = await post("/api/gate/challenge", { returnUrl: here });
      location.href = c.proveUrl;
    } catch (e) {
      label("Verify with Seisin", false);
      emit("seisin:failed", { reason: e.message });
    }
  }

  async function finish(proof) {
    // Take the proof out of the address bar so it is not bookmarked or shared by accident.
    history.replaceState(null, "", location.href.split("#")[0]);
    label("Checking your proof…", true);
    try {
      const v = await post("/api/gate/verify", { proof });
      label("Verified", true);
      emit("seisin:verified", v);
    } catch (e) {
      label("Verify with Seisin", false);
      emit("seisin:failed", { reason: e.message });
    }
  }

  function init() {
    buttons().forEach((b) => {
      if (!b.textContent.trim()) b.textContent = "Verify with Seisin";
      b.addEventListener("click", start);
    });
    const m = location.hash.match(/seisin_proof=([^&]+)/);
    if (m) finish(decodeURIComponent(m[1]));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
