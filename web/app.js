/* Maretha Ops — NOC dashboard SPA.
   Cognito Hosted UI (Google) OAuth2 Authorization Code + PKCE, then calls the
   API with the Cognito ID token as a Bearer JWT. No build step. */
(() => {
  const cfg = window.OPS_CONFIG;
  const $ = (id) => document.getElementById(id);
  const TOKKEY = "ops_tokens";

  // ===================== auth (unchanged plumbing) =====================
  const loadTokens = () => { try { return JSON.parse(sessionStorage.getItem(TOKKEY)); } catch { return null; } };
  const saveTokens = (t) => sessionStorage.setItem(TOKKEY, JSON.stringify({ ...t, exp: Date.now() + (t.expires_in - 60) * 1000 }));
  const clearTokens = () => sessionStorage.removeItem(TOKKEY);
  function emailFromIdToken(idt) {
    try { return JSON.parse(atob(idt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email; } catch { return ""; }
  }
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function randomVerifier() { const a = new Uint8Array(48); crypto.getRandomValues(a); return b64url(a); }
  async function challenge(verifier) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)); return b64url(d); }

  async function signIn() {
    const verifier = randomVerifier();
    sessionStorage.setItem("pkce_verifier", verifier);
    const url = new URL(cfg.cognitoDomain + "/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
      scope: "openid email profile", identity_provider: "Google",
      code_challenge_method: "S256", code_challenge: await challenge(verifier),
    }).toString();
    location.assign(url.toString());
  }
  function signOut() {
    clearTokens();
    const url = new URL(cfg.cognitoDomain + "/logout");
    url.search = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri }).toString();
    location.assign(url.toString());
  }
  async function exchangeCode(code) {
    const verifier = sessionStorage.getItem("pkce_verifier");
    const res = await fetch(cfg.cognitoDomain + "/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: cfg.clientId, code, redirect_uri: cfg.redirectUri, code_verifier: verifier || "" }),
    });
    if (!res.ok) throw new Error("token exchange failed: " + (await res.text()));
    saveTokens(await res.json());
    sessionStorage.removeItem("pkce_verifier");
  }
  async function refreshIfNeeded() {
    const t = loadTokens();
    if (!t) return null;
    if (Date.now() < t.exp) return t;
    if (!t.refresh_token) { clearTokens(); return null; }
    const res = await fetch(cfg.cognitoDomain + "/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.clientId, refresh_token: t.refresh_token }),
    });
    if (!res.ok) { clearTokens(); return null; }
    saveTokens({ refresh_token: t.refresh_token, ...(await res.json()) });
    return loadTokens();
  }
  async function api(path, { method = "GET", body } = {}) {
    const t = await refreshIfNeeded();
    if (!t) { showLogin(); throw new Error("not signed in"); }
    const res = await fetch(cfg.apiBase + path, {
      method,
      headers: { authorization: "Bearer " + t.id_token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { clearTokens(); showLogin(); throw new Error("session expired"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${method} ${path} → ${res.status}`);
    return data;
  }

  // ===================== helpers =====================
  const showLogin = () => { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); };
  const showApp = () => { $("login").classList.add("hidden"); $("app").classList.remove("hidden"); };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let toastTimer;
  function toast(msg, kind = "ok") {
    const el = $("toast"); el.textContent = msg; el.className = "toast " + kind;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = "toast hidden"), 4000);
  }
  function ago(iso) {
    if (!iso) return "—";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  // map a run/workflow state → signal class
  function stateOf(w) {
    w = w || {};
    if (w.status === "in_progress" || w.status === "queued" || w.status === "pending" || w.busy) return "warn";
    const c = w.conclusion;
    if (c === "success") return "ok";
    if (c === "failure" || c === "timed_out" || c === "startup_failure") return "err";
    if (c === "cancelled" || c === "skipped") return "idle";
    if (w.status === "completed") return "ok";
    return "idle";
  }
  const upper = (s) => String(s || "").toUpperCase().replace(/_/g, " ");
  const pill = (state, label) => `<span class="pill pill--${state}"><i></i>${esc(label)}</span>`;
  const chip = (label, mod) => `<span class="chip${mod ? " chip--" + mod : ""}">${esc(label)}</span>`;

  // ===================== health strip =====================
  let lastStatus = null, lastInstalled = null;
  function tile(id, k, state, v, sub, titleText) {
    const el = $(id); if (!el) return;
    el.className = "stat stat--" + state;
    el.title = titleText || "";
    el.innerHTML =
      `<div class="stat-k">${esc(k)}</div>` +
      `<div class="stat-v"><span class="dot"></span><span>${esc(v)}</span></div>` +
      `<div class="stat-sub">${esc(sub || "")}</div>`;
  }
  function renderHealth() {
    const s = lastStatus || {}, ins = lastInstalled || {};
    const r = s.runner || {}; const dep = (s.workflows || {}).deploy || {};
    // demo3
    const up = ins.reachable;
    tile("stat-demo3", "demo3", up ? "ok" : (ins.configured === false ? "idle" : "err"),
      up ? "ONLINE" : (ins.configured === false ? "N/A" : "OFFLINE"), up ? (ins.distribution || "reachable") : "unreachable");
    // runner — "unknown" (e.g. token can't query runners) shows a calm N/A, not red ERROR
    const rstate = r.busy ? "warn" : r.status === "online" ? "ok" : r.status === "error" ? "err" : "idle";
    const rval = r.busy ? "BUSY" : (r.status === "unknown" ? "N/A" : upper(r.status || "unknown"));
    const rsub = r.status === "unknown" ? "state unavailable" : (r.name || "hetzner-prod");
    tile("stat-runner", "runner", rstate, rval, rsub, r.note || r.error || "");
    // last deploy
    const dstate = stateOf(dep);
    tile("stat-deploy", "last deploy", dstate, upper(dep.conclusion || dep.status || "none"), dep.created_at ? ago(dep.created_at) : "—");
    // studio
    tile("stat-studio", "studio", ins.studioLoaded ? "ok" : "idle", (ins.studioVersion || "master-SNAPSHOT"), ins.studioLoaded ? "loaded" : "—");
    // bundles loaded in demo3 — a quick integrity signal (a sudden drop ⇒ broken deploy)
    tile("stat-bundles", "OSGi bundles", "gold",
      ins.bundleCount != null ? String(ins.bundleCount) : "—",
      ins.bundleCount != null ? `loaded · web-ui ${ins.webUiLoaded ? "✓" : "✗"}` : "—",
      "Total OSGi bundles active in the running demo3 server. A health/integrity signal — a sudden drop usually means a broken deploy. Not the same as uploaded add-ons.");
  }

  async function refreshStatus() { try { lastStatus = await api("/status"); renderHealth(); } catch (e) { console.warn(e); } }
  async function loadInstalled() {
    try { lastInstalled = await api("/installed"); } catch (e) { lastInstalled = { reachable: false }; }
    renderHealth(); renderInstalled();
  }

  // ===================== installed =====================
  let bundleFilter = "";
  function renderInstalled() {
    const ins = lastInstalled || {};
    if (ins.configured === false) { $("ins-summary").innerHTML = `<span class="muted">${esc(ins.note || "not configured")}</span>`; }
    else if (ins.reachable === false) { $("ins-summary").innerHTML = `<span class="muted">demo3 unreachable</span>`; }
    else {
      $("ins-summary").innerHTML =
        chip(ins.distribution || "Nuxeo") +
        chip(ins.bundleCount + " bundles") +
        chip("Studio " + (ins.studioLoaded ? "✓" : "✗"), ins.studioLoaded ? "ok" : "err") +
        chip("web-ui " + (ins.webUiLoaded ? "✓" : "✗"), ins.webUiLoaded ? "ok" : "err");
    }
    const all = ins.all || [];
    const f = bundleFilter.toLowerCase();
    const rows = f ? all.filter((b) => b.name.toLowerCase().includes(f)) : all;
    $("ins-count").textContent = all.length ? `${rows.length}/${all.length}` : "";
    $("ins-list").innerHTML = rows.length
      ? rows.map((b) => `<li class="kv"><span class="kv-k mono" title="${esc(b.name)}">${esc(b.name)}</span><span class="kv-v mono">${esc(b.version || "")}</span></li>`).join("")
      : `<li class="muted">no match</li>`;
    const ph = $("ins-search"); if (ph && all.length) ph.placeholder = `filter ${all.length} bundles…`;
  }

  // ===================== uploaded add-ons =====================
  async function loadAddons() {
    try {
      const { addons } = await api("/addons");
      $("addons").innerHTML = addons.length
        ? addons.map((a) => `<li><span class="nm" title="${esc(a.name)}">${esc(a.name)}</span><span class="muted small mono">${(a.size / 1024).toFixed(0)} KB</span><button class="rm" data-name="${esc(a.name)}">remove</button></li>`).join("")
        : '<li class="muted">none staged</li>';
      document.querySelectorAll(".rm").forEach((b) => (b.onclick = () => removeAddon(b.dataset.name)));
    } catch (e) { $("addons").innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
  }

  // ===================== studio versions =====================
  async function loadStudio() {
    try {
      const { versions, latest } = await api("/studio/versions");
      const pick = ["master-SNAPSHOT", ...(versions || []).filter((v) => v !== "master-SNAPSHOT")];
      $("studio").innerHTML = pick.map((v) => `<option value="${esc(v)}">${esc(v)}${v === latest ? " (latest release)" : ""}</option>`).join("");
    } catch { $("studio").innerHTML = '<option value="master-SNAPSHOT">master-SNAPSHOT</option>'; }
  }

  // ===================== activity & logs =====================
  let lastRuns = null, lastAudit = null, lastLogs = null, actTab = "live";
  async function loadActivity() {
    try { lastRuns = await api("/runs"); } catch { lastRuns = { runs: [], latest: null }; }
    try { lastAudit = await api("/audit"); } catch { lastAudit = { events: [] }; }
    renderActivity();
  }
  // demo3 server logs from CloudWatch — fetched lazily (only when the tab is open)
  // so we don't poll CloudWatch on the global interval.
  async function loadLogs() {
    try { lastLogs = await api("/logs"); } catch (e) { lastLogs = { events: [], note: e.message }; }
    if (actTab === "server") renderActivity();
  }
  function setTab(t) {
    actTab = t;
    ["live", "runs", "audit", "server"].forEach((x) => $("tab-" + x).classList.toggle("on", x === t));
    if (t === "server" && !lastLogs) loadLogs();
    renderActivity();
  }
  const actionLabel = (a) => ({ "addon.upload": "uploaded add-on", "addon.remove": "removed add-on", "deploy": "redeploy", "deploy.base": "rebuild base", "rollback": "rollback" }[a] || a);
  function detailLabel(e) {
    const d = e.detail || {};
    if (d.name) return d.name;
    if (d.studio_version) return "studio " + d.studio_version;
    if (d.revision) return "→ rev " + d.revision;
    return "";
  }
  const stepState = (s) => s.conclusion === "success" ? "ok" : (s.conclusion === "failure" ? "err" : (s.status === "in_progress" ? "warn" : (s.status === "completed" ? "ok" : "idle")));
  const stepIcon = (st) => ({ ok: "✓", err: "✕", warn: "◐", idle: "·" }[st]);

  function renderActivity() {
    const pane = $("act-pane"), meta = $("act-meta");
    if (actTab === "live") {
      const l = (lastRuns || {}).latest;
      meta.textContent = l ? upper(l.conclusion || l.status) : "";
      if (!l) { pane.innerHTML = '<div class="muted pad">no deploy runs yet</div>'; return; }
      const hdr = `<div class="loghdr">${pill(stateOf(l), upper(l.conclusion || l.status))}<a class="mono small" href="${esc(l.url)}" target="_blank" rel="noopener">open run ↗</a></div>`;
      const steps = (l.steps || []).length
        ? `<ol class="steps">` + l.steps.map((s) => { const st = stepState(s); return `<li class="step step--${st}"><span class="step-ic">${stepIcon(st)}</span><span class="step-nm" title="${esc(s.name)}">${esc(s.name)}</span></li>`; }).join("") + `</ol>`
        : '<div class="muted pad">no step detail</div>';
      pane.innerHTML = hdr + steps;
    } else if (actTab === "runs") {
      const runs = (lastRuns || {}).runs || [];
      meta.textContent = runs.length ? runs.length + " recent" : "";
      pane.innerHTML = runs.length
        ? `<ul class="runs">` + runs.map((r) => `<li><a class="run" href="${esc(r.url)}" target="_blank" rel="noopener">${pill(stateOf(r), upper(r.conclusion || r.status))}<span class="run-t" title="${esc(r.title)}">#${esc(r.runNumber)} ${esc(r.title)}</span><span class="run-m muted mono">${esc(r.event)} · ${esc(r.actor || "—")} · ${ago(r.created_at)}</span></a></li>`).join("") + `</ul>`
        : '<div class="muted pad">no runs</div>';
    } else if (actTab === "audit") {
      const ev = (lastAudit || {}).events || [];
      meta.textContent = ev.length ? ev.length + " events" : "";
      pane.innerHTML = ev.length
        ? `<ul class="audit">` + ev.map((e) => `<li><span class="aud-a">${esc(actionLabel(e.action))}</span><span class="aud-d muted" title="${esc(detailLabel(e))}">${esc(detailLabel(e))}</span><span class="aud-m muted mono">${esc((e.actor || "").split("@")[0])} · ${ago(e.time)}</span></li>`).join("") + `</ul>`
        : '<div class="muted pad">no activity recorded yet</div>';
    } else {
      // server log — direct demo3 Nuxeo logs shipped to CloudWatch
      const lg = lastLogs;
      if (!lg) { meta.textContent = ""; pane.innerHTML = '<div class="muted pad">loading…</div>'; return; }
      if (lg.configured === false) { meta.textContent = ""; pane.innerHTML = `<div class="muted pad">${esc(lg.note || "server logs not configured")}</div>`; return; }
      const evs = lg.events || [];
      meta.innerHTML = `<a class="mono small" id="logs-refresh" href="#" title="reload">↻ ${evs.length} lines · ${lg.minutes || 30}m</a>`;
      pane.innerHTML = evs.length
        ? `<div class="logz">` + evs.map((e) => `<div class="logln"><span class="logt mono">${esc((e.time || "").slice(11, 19))}</span><span class="logm mono">${esc(e.message)}</span></div>`).join("") + `</div>`
        : `<div class="muted pad">${esc(lg.note || "no log lines in the last " + (lg.minutes || 30) + "m")}</div>`;
      const rb = $("logs-refresh"); if (rb) rb.onclick = (e) => { e.preventDefault(); lastLogs = null; pane.innerHTML = '<div class="muted pad">loading…</div>'; loadLogs(); };
      const box = pane.querySelector(".logz"); if (box) box.scrollTop = box.scrollHeight; // tail: newest at bottom
    }
  }

  // ===================== actions =====================
  async function uploadFile(file) {
    if (!file) return;
    if (!/\.(zip|jar)$/i.test(file.name)) return toast("Pick a .zip or .jar", "err");
    const bar = $("upbar"), fill = $("upfill"); bar.classList.remove("hidden"); fill.style.width = "0%";
    try {
      const pre = await api("/addons/presign", { method: "POST", body: { filename: file.name, contentLength: file.size } });
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", pre.url);
        xhr.setRequestHeader("content-type", pre.contentType);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) fill.style.width = ((e.loaded / e.total) * 100).toFixed(0) + "%"; };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error("S3 upload " + xhr.status)));
        xhr.onerror = () => reject(new Error("S3 upload failed"));
        xhr.send(file);
      });
      await api("/addons/confirm", { method: "POST", body: { key: pre.key } });
      toast(`Uploaded ${file.name} — deploy started`);
      loadAddons(); refreshStatus(); setTimeout(loadActivity, 1500);
    } catch (e) { toast(e.message, "err"); }
    finally { setTimeout(() => bar.classList.add("hidden"), 900); }
  }
  async function removeAddon(name) {
    if (!confirm(`Remove ${name} and redeploy?`)) return;
    try { await api(`/addons/${encodeURIComponent(name)}`, { method: "DELETE" }); toast(`Removed ${name} — deploy started`); loadAddons(); refreshStatus(); setTimeout(loadActivity, 1500); }
    catch (e) { toast(e.message, "err"); }
  }
  async function doAction(label, fn) {
    try { await fn(); toast(label + " started"); refreshStatus(); setTimeout(loadActivity, 1500); }
    catch (e) { toast(e.message, "err"); }
  }

  // ===================== wire-up =====================
  function refreshAll() { refreshStatus(); loadInstalled(); loadAddons(); loadActivity(); loadStudio(); }
  function bind() {
    $("signin").onclick = signIn;
    $("signout").onclick = signOut;
    $("refresh").onclick = refreshAll;
    $("file").onchange = (e) => uploadFile(e.target.files[0]);
    $("deploy").onclick = () => doAction("Deploy", () => api("/deploy", { method: "POST", body: { studio_version: $("studio").value } }));
    $("base").onclick = () => { if (confirm("Rebuild the base image from source? ~45–60 min.")) doAction("Base rebuild", () => api("/deploy/base", { method: "POST" })); };
    $("rollback").onclick = () => { if (confirm("Roll back to the previous deployed image?")) doAction("Rollback", () => api("/rollback", { method: "POST", body: {} })); };
    ["live", "runs", "audit", "server"].forEach((t) => ($("tab-" + t).onclick = () => setTab(t)));
    $("ins-search").oninput = (e) => { bundleFilter = e.target.value; renderInstalled(); };

    const drop = $("drop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));
  }
  function startClock() {
    const el = $("clock");
    const tick = () => { el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " UTC" + (-new Date().getTimezoneOffset() / 60 >= 0 ? "+" : "") + (-new Date().getTimezoneOffset() / 60); };
    tick(); setInterval(tick, 1000);
  }

  async function start() {
    bind();
    const params = new URLSearchParams(location.search);
    if (params.get("error")) { showLogin(); toast(params.get("error_description") || params.get("error"), "err"); history.replaceState({}, "", cfg.redirectUri); return; }
    if (params.get("code")) {
      try { await exchangeCode(params.get("code")); } catch (e) { showLogin(); toast(e.message, "err"); return; }
      history.replaceState({}, "", cfg.redirectUri);
    }
    const t = await refreshIfNeeded();
    if (!t) return showLogin();
    showApp();
    $("who").textContent = emailFromIdToken(t.id_token);
    startClock();
    refreshAll();
    setInterval(() => { refreshStatus(); loadActivity(); if (actTab === "server") loadLogs(); }, 12000);
  }

  start();
})();
