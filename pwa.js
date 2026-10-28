// Forbrug phone app runtime: keeps data in localStorage and syncs it with a private GitHub repo.
// Loaded before the main UI script; the UI calls window.fbApi / window.fbInit when they exist.
(() => {
  const C = window.ForbrugCore;
  const LS_STATE = "fb-state", LS_SYNC = "fb-sync";
  const DEFAULT_REPO = "line-kirstine/forbrug-data";
  let notify = () => {};
  let syncing = null, again = false, timer = null, busy = false;

  const load = () => { try { return C.normalize(JSON.parse(localStorage.getItem(LS_STATE) || "{}")); } catch { return C.emptyState(); } };
  const persist = (st) => localStorage.setItem(LS_STATE, JSON.stringify(C.normalize(st)));
  const cfg = () => { try { return { repo: DEFAULT_REPO, ...JSON.parse(localStorage.getItem(LS_SYNC) || "{}") }; } catch { return { repo: DEFAULT_REPO }; } };
  const setCfg = (patch) => localStorage.setItem(LS_SYNC, JSON.stringify({ ...cfg(), ...patch }));
  const clone = (x) => JSON.parse(JSON.stringify(x));

  window.fbApi = async (path, method = "GET", body) => {
    const st = load();
    try {
      const { result, mutated } = C.route(st, method, path, body || {});
      if (mutated) { persist(st); notify(load()); requestSync(800); }
      return clone(result);
    } catch (e) { throw new Error(e.message || "Noget gik galt"); }
  };

  function friendly(e) {
    const m = String(e && e.message || e);
    if (/401/.test(m)) return "Adgangsnøglen virker ikke længere. Lav en ny og indsæt den her.";
    if (/403|404/.test(m)) return "Nøglen har ikke adgang til repoet. Tjek at den giver adgang til " + cfg().repo + ".";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Ingen forbindelse lige nu. Dine ændringer gemmes og sendes senere.";
    return m;
  }

  async function runSync() {
    const c = cfg();
    if (!c.token) return;
    busy = true; paint();
    try {
      await C.syncOnce({ token: c.token, repo: c.repo }, {
        who: "telefon",
        readLocal: async () => load(),
        writeLocal: async (merged) => { const m = C.merge(load(), merged); persist(m); notify(m); },
      });
      setCfg({ lastOk: new Date().toISOString(), lastErr: null });
    } catch (e) {
      setCfg({ lastErr: friendly(e) });
    } finally { busy = false; paint(); }
  }

  function requestSync(delay = 0) {
    clearTimeout(timer);
    if (delay) { timer = setTimeout(() => requestSync(0), delay); return; }
    if (syncing) { again = true; return syncing; }
    syncing = (async () => { do { again = false; await runSync(); } while (again); syncing = null; })();
    return syncing;
  }

  // ---- Sync button + dialog ----
  const $ = (id) => document.getElementById(id);
  const ico = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const time = (iso) => new Date(iso).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function statusText() {
    const c = cfg();
    if (!c.token) return { icon: "cloud-off", short: "Ikke forbundet", long: "Ikke forbundet. Dine data gemmes kun på denne telefon, indtil du indsætter en adgangsnøgle." };
    if (busy) return { icon: "sync", short: "Synkroniserer", long: "Synkroniserer…" };
    if (c.lastErr) return { icon: "cloud-off", short: "Fejl i synkronisering", long: c.lastErr };
    if (c.lastOk) return { icon: "cloud", short: "Synkroniseret", long: "Synkroniseret med din Mac " + time(c.lastOk) + "." };
    return { icon: "cloud", short: "Forbundet", long: "Forbundet. Synkroniserer snart." };
  }

  function paint() {
    const s = statusText(), btn = $("syncBtn");
    if (btn) { btn.innerHTML = ico(s.icon); btn.setAttribute("aria-label", "Synkronisering: " + s.short); btn.title = s.short; }
    const st = $("syncStatus");
    if (st) st.textContent = s.long;
    const has = !!cfg().token;
    if ($("syncNow")) $("syncNow").hidden = !has;
    if ($("syncForget")) $("syncForget").hidden = !has;
  }

  function mountUi() {
    const actions = document.querySelector(".top .actions");
    actions.insertAdjacentHTML("afterbegin", `<button class="round" id="syncBtn" type="button"></button>`);
    document.body.insertAdjacentHTML("beforeend", `
<dialog id="syncDlg" aria-labelledby="syncTitle">
  <form id="syncForm" autocomplete="off">
    <div class="dlg-head"><h2 id="syncTitle">Synkronisering</h2><button type="button" class="ghost" id="syncClose" aria-label="Luk">${ico("close")}</button></div>
    <p class="note" id="syncStatus" role="status"></p>
    <label class="f">Adgangsnøgle fra GitHub<input id="syncToken" type="password" placeholder="github_pat_…" autocapitalize="off" spellcheck="false"></label>
    <p class="small muted" style="margin:0">Lav nøglen på <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>: vælg kun repoet <strong id="syncRepoName"></strong> og giv <em>Contents: Read and write</em>.</p>
    <details><summary class="small muted">Avanceret</summary><label class="f" style="margin-top:8px">Repo<input id="syncRepo" autocapitalize="off" spellcheck="false"></label></details>
    <div class="err" id="syncErr" role="alert"></div>
    <button class="btn brand" type="submit" style="min-height:48px">Gem og synkronisér</button>
    <button class="btn" type="button" id="syncNow" style="min-height:48px">${ico("sync")} Synkronisér nu</button>
    <button class="btn" type="button" id="syncForget" style="min-height:48px">Fjern forbindelse</button>
  </form>
</dialog>`);
    const open = () => { $("syncToken").value = ""; $("syncRepo").value = cfg().repo; $("syncRepoName").textContent = cfg().repo; $("syncErr").textContent = ""; paint(); $("syncDlg").showModal(); };
    $("syncBtn").onclick = open;
    $("syncClose").onclick = () => $("syncDlg").close();
    $("syncDlg").addEventListener("click", (e) => { if (e.target === $("syncDlg")) $("syncDlg").close(); });
    $("syncForm").onsubmit = async (e) => {
      e.preventDefault();
      const token = $("syncToken").value.trim(), repo = $("syncRepo").value.trim() || DEFAULT_REPO;
      if (!token && !cfg().token) { $("syncErr").textContent = "Indsæt din adgangsnøgle først."; return; }
      setCfg({ repo, ...(token ? { token } : {}), lastErr: null });
      $("syncToken").value = "";
      await requestSync(0);
      paint();
      if (!cfg().lastErr) $("syncDlg").close();
    };
    $("syncNow").onclick = () => requestSync(0);
    $("syncForget").onclick = () => { if (confirm("Fjern forbindelsen? Dine data bliver på telefonen.")) { setCfg({ token: null, lastOk: null, lastErr: null }); paint(); } };
    paint();
    if (!cfg().token) open();
  }

  window.fbInit = (cb) => {
    notify = cb;
    cb(load());
    mountUi();
    requestSync(0);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestSync(0); });
    addEventListener("online", () => requestSync(0));
    setInterval(() => { if (document.visibilityState === "visible") requestSync(0); }, 60_000);
  };

  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
