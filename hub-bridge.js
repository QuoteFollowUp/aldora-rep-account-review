/* Aldora Sales Hub bridge for Rep Account Review.
   Lives in its own file so a new index.html export from Claude Design never removes it.
   An edge function (netlify/edge-functions/hub-bridge.mjs) adds it to the page on every load.
   1. Sign-in from the hub: turns #ac=CODE into #c=CODE before the page reads it.
   2. Dormant accounts: after a review builds, sends that rep's dormant list to the hub.
      Rule (same as the Revenue Report's "dropped"): bought in 2+ earlier months, no invoice in the
      last two full months or the current partial month. */
(function () {
  // 3. Open one account from the hub (Dormant accounts): #c=CODE&go=acct&rep=REP&a=CUSTOMER
  //    Kept here because the page strips the # part as it signs in. Handled further down.
  window.__rarStartHash = location.hash || "";
  try {
    var h = location.hash || "";
    if (/(?:^#|&)ac=/.test(h)) history.replaceState(null, "", location.pathname + location.search + h.replace(/(^#|&)ac=/, "$1c="));
  } catch (e) {}

  var g = function (expr) { try { return (0, eval)(expr); } catch (e) { return undefined; } };

  function dormantList(M) {
    if (!M || !M.hasMonths || !Array.isArray(M.accounts) || !Array.isArray(M.months)) return null;
    var now = new Date(), curM = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    var ms = M.months.slice(0, M.months.indexOf(M.latest) + 1), partial = null;
    if (ms[ms.length - 1] === curM && ms.length > 1) partial = ms.pop();
    if (ms.length < 4) return null;
    var recent = ms.slice(-2), earlier = ms.slice(0, -2), last12 = ms.slice(-12), out = [];
    var sum = function (m, ks) { return Math.round(ks.reduce(function (s, k) { return s + (m[k] || 0); }, 0)); };
    M.accounts.forEach(function (a) {
      var m = a.m || {};
      var nE = earlier.filter(function (k) { return (m[k] || 0) > 0; }).length;
      var r = sum(m, recent) + (partial ? (m[partial] || 0) : 0);
      if (nE < 2 || r > 0) return;
      var last = "";
      for (var i = ms.length - 1; i >= 0; i--) if ((m[ms[i]] || 0) > 0) { last = ms[i]; break; }
      out.push({ name: String(a.name || ""), code: String(a.code || ""), tier: a.tier || "", last: last, sales12: sum(m, last12), sales: sum(m, ms) });
    });
    out.sort(function (x, y) { return y.sales - x.sales || y.sales12 - x.sales12; });
    var rn = document.querySelector("#repName");
    return { v: 1, rep: M.rep || (rn ? rn.value.trim() : ""), from: ms[0], through: ms[ms.length - 1], count: out.length,
      value: out.reduce(function (s, x) { return s + x.sales; }, 0), list: out.slice(0, 60) };
  }

  var lastModel = null;
  function tick() {
    try {
      if (typeof window.hubDormantSync === "function") return; // this page already has it built in
      var M = g('typeof MODEL !== "undefined" ? MODEL : null');
      if (!M || M === lastModel) return;
      var S = g('typeof STORE !== "undefined" ? STORE : null');
      var id = g('typeof CURRENT_ID !== "undefined" ? CURRENT_ID : ""');
      if (!S || S.mode !== "cloud" || !id || typeof S.call !== "function") return;
      lastModel = M;
      var d = dormantList(M);
      if (!d) return;
      var key = "rar-dorm:" + id;
      var sig = JSON.stringify([d.from, d.through, d.count, d.list.map(function (x) { return x.name + "|" + x.last + "|" + x.sales; })]);
      try { if (localStorage.getItem(key) === sig) return; } catch (e) {}
      S.call("PATCH", id, { dormant: d }).then(function () { try { localStorage.setItem(key, sig); } catch (e) {} }).catch(function () {});
    } catch (e) {}
  }
  setInterval(tick, 2000);
})();

/* 3. Weekly update from the Sales Hub.
   The hub opens this page in a hidden frame (signed in with Fred's code) and posts the weekly files.
   This runs the page's own "Update every rep" with them, so every saved review is rebuilt exactly as
   if the files were loaded here, then sends each rep's accounts (name and monthly sales) back so the
   hub's "Year at a glance" uses the same account set the review shows.
   Only the Aldora Sales Hub (aldora*.netlify.app) can ask, and only a manager code can run it. */
(function () {
  var HUB = /^https:\/\/(?:[a-z0-9-]+--)?aldora[a-z0-9-]*\.netlify\.app$/i;
  var g = function (expr) { try { return (0, eval)(expr); } catch (e) { return undefined; } };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var busy = false;

  async function ready() {
    for (var i = 0; i < 80; i++) {
      var S = g('typeof STORE !== "undefined" ? STORE : null');
      if (S && S.mode === "cloud" && S.role) return S;
      if (S && S.mode === "local" && i > 20) return S;
      await sleep(250);
    }
    return g('typeof STORE !== "undefined" ? STORE : null');
  }
  function text(sel) { var e = document.querySelector(sel); return e ? e.innerText.trim() : ""; }

  window.addEventListener("message", async function (ev) {
    var d = ev.data;
    if (!d || d.type !== "aldora-weekly-update") return;
    var reply = function (m) { try { ev.source.postMessage(Object.assign({ type: "aldora-weekly-update", id: d.id }, m), ev.origin); } catch (e) {} };
    if (!HUB.test(ev.origin) || ev.source !== window.parent) { reply({ ok: false, error: "Rep Account Review only takes updates from the Aldora Sales Hub." }); return; }
    if (busy) { reply({ ok: false, error: "An update is already running." }); return; }
    busy = true;
    var S = null, putOrig = null, confOrig = window.confirm, timer = null;
    try {
      S = await ready();
      if (!S || S.mode !== "cloud") throw new Error("Rep Account Review couldn't connect to the saved reps. Open it once from the hub and sign in.");
      if (S.role !== "manager") throw new Error("Only a manager code can update every rep in Rep Account Review.");
      g("clearAll")();

      var sales = Array.isArray(d.sales) ? d.sales : [], other = Array.isArray(d.other) ? d.other : [];
      if (sales.length) {
        await g("onSalesFiles")(sales);
        var bad = (g("SFILES") || []).filter(function (f) { return f.kind === "error"; });
        if (bad.length) throw new Error("Revenue file: " + bad.map(function (f) { return f.file + ": " + f.msg; }).join("; "));
      }
      var used = [];
      for (var i = 0; i < other.length; i++) {
        var f = other[i], wb = await g("readFile")(f);
        var head = (g("XLSX").utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" })[0] || []).join("|").toLowerCase();
        if (/sales rep/.test(head) && /barrier|biggest product|contact name|immediate attention/.test(head)) {
          await g("onCallsFile")(f);
          if (!g("CALLS")) throw new Error(f.name + ": " + (text("#stCalls") || "not a Call Log export"));
          used.push(f.name + " (call log)");
        } else {
          var q = null;
          try { q = g("parseQuotesWb")(wb); } catch (e) { q = null; }
          if (!q) { used.push(f.name + " (skipped, not a file Rep Account Review reads)"); continue; }
          await g("loadQuoteFile")(f, q.hasOutcome ? "fu" : "open");
          used.push(f.name + (q.hasOutcome ? " (follow-ups)" : " (open quotes)"));
        }
      }

      // Capture each rep's accounts as the review saves them
      var reps = [];
      putOrig = S.put;
      S.put = function (id, v) {
        try {
          var M = g('typeof MODEL !== "undefined" ? MODEL : null');
          if (M && Array.isArray(M.accounts)) reps.push({ id: id, name: v && v.name, months: M.months || [], latest: M.latest || "",
            accounts: M.accounts.map(function (a) { return { name: a.name, code: a.code || "", m: a.m || {} }; }) });
        } catch (e) {}
        return putOrig.call(S, id, v);
      };
      window.confirm = function () { return true; };
      timer = setInterval(function () { reply({ progress: text("#stAll").split("\n")[0] }); }, 1500);
      await g("applyAll")();
      clearInterval(timer); timer = null;
      reply({ ok: true, reps: reps, files: used, status: text("#stAll") });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    } finally {
      if (timer) clearInterval(timer);
      if (S && putOrig) S.put = putOrig;
      window.confirm = confOrig;
      busy = false;
    }
  });

  // ---- 3. Open one account (see top): loads that rep's review (the territory the account is in),
  //      then opens the account sheet.
  var readGo = function (hash) {
    try {
      var p = new URLSearchParams(String(hash == null ? location.hash : hash).replace(/^#/, ""));
      return p.get("go") === "acct" && p.get("a") ? { rep: p.get("rep") || "", a: p.get("a") } : null;
    } catch (e) { return null; }
  };
  var GO = readGo(window.__rarStartHash);
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var nameKey = function (s) { return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\bisland glass\s*,?\s*ltd\b/g, " island glass limited ").replace(/\b(inc|llc|co|corp|corporation|company|ltd|the)\b/g, " ").replace(/\s+/g, " ").trim(); };
  function sameRep(a, b) {
    var t = function (x) { x = String(x || ""); if (x.indexOf(",") >= 0) x = x.split(",").reverse().join(" "); return x.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean); };
    var A = t(a), B = t(b);
    if (!A.length || !B.length) return false;
    if (A.join(" ") === B.join(" ")) return true;
    return A[0][0] === B[0][0] && A[A.length - 1] === B[B.length - 1];
  }
  var opening = false;
  async function openAccount(go) {
    if (!go || opening) return;
    opening = true;
    try {
      // Wait for sign-in and the first load to settle
      for (var i = 0; i < 120; i++) { var S = g("STORE"); if (S && S.mode && (S.mode !== "cloud" || S.role)) break; await sleep(250); }
      var S2 = g("STORE");
      if (!S2) return;
      await sleep(400);
      var items = [];
      try { items = await S2.list(); } catch (e) {}
      var it = items.find(function (x) { return sameRep(x.name, go.rep); }) || (items.length === 1 ? items[0] : null);
      if (it && g("CURRENT_ID") !== it.id) {
        var sel = document.querySelector("#repSel"); if (sel) sel.value = it.id;
        await g("loadRep")(it.id);
      }
      // Wait for the review to build, then open the account
      for (var j = 0; j < 80; j++) { var M = g("MODEL"); if (M && Array.isArray(M.accounts) && M.accounts.length) break; await sleep(250); }
      var M2 = g("MODEL");
      if (!M2 || !Array.isArray(M2.accounts)) return;
      var k = nameKey(go.a);
      var a = M2.accounts.find(function (x) { return x.name === go.a; }) || M2.accounts.find(function (x) { return nameKey(x.name) === k; });
      if (a) { g("openAcct")(a.name); return; }
      // Not in this review: search for it so the rep sees the closest names
      var fi = document.querySelector("#findIn");
      if (fi) { fi.value = go.a; fi.dispatchEvent(new Event("input", { bubbles: true })); fi.focus(); }
    } catch (e) {
    } finally { opening = false; }
  }
  if (GO) openAccount(GO);
  // The hub reuses the open frame and changes only the # part on later clicks
  window.addEventListener("hashchange", function () {
    var go = readGo();
    if (!go) return;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    openAccount(go);
  });
})();

/* 4. Trip -> My Territory route (Nov 15 2026).
   When My Territory is open for this code (/api/territory-status on the Sales Hub), the trip panel gets a
   "Map this trip" button, and adding an account to a trip shows a short prompt to build the route.
   The trip's account names go to My Territory in the address (#trip=), where they are matched to the
   rep's mapped accounts and routed: grouped into days, ordered to cut driving. */
(function () {
  var HUB = "https://aldora-sales-hub.netlify.app";
  var g = function (expr) { try { return (0, eval)(expr); } catch (e) { return undefined; } };
  var open = null, asked = "", toastT = null;

  function code() { var S = g('typeof STORE !== "undefined" ? STORE : null'); return S && S.code ? S.code : ""; }
  function trip() {
    var M = g('typeof MODEL !== "undefined" ? MODEL : null'), T = g('typeof TRIP !== "undefined" ? TRIP : null');
    if (!M || !T || !M.accounts) return null;
    var names = M.accounts.filter(function (a) { return T.has(a.name); }).map(function (a) { return a.name; });
    var rn = document.querySelector("#repName");
    return { rep: M.rep || (rn ? rn.value.trim() : ""), names: names };
  }
  function url() {
    var t = trip(); if (!t || !t.names.length) return "";
    return HUB + "/territory/#ac=" + encodeURIComponent(code()) + "&rep=" + encodeURIComponent(t.rep) +
      "&trip=" + encodeURIComponent(t.names.join("|"));
  }
  async function check() {
    var c = code();
    if (!c || c === asked) return;
    asked = c;
    try {
      var r = await fetch(HUB + "/api/territory-status", { headers: { "x-hub-code": c } });
      var d = await r.json(); open = !!d.open;
    } catch (e) { open = false; }
    addButton();
  }
  function css() {
    if (document.getElementById("terr-css")) return;
    var s = document.createElement("style"); s.id = "terr-css";
    s.textContent = ".terr-map{display:inline-flex;align-items:center;gap:6px}" +
      ".terr-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;display:flex;gap:12px;align-items:center;" +
      "background:#243947;color:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:15px;max-width:calc(100vw - 24px)}" +
      ".terr-toast a{background:#6A9E39;color:#fff;border-radius:8px;padding:8px 12px;font-weight:700;text-decoration:none;white-space:nowrap}" +
      ".terr-toast button{background:none;border:0;color:#cfd8dc;font-size:20px;cursor:pointer;line-height:1}" +
      "@media print{.terr-map,.terr-toast{display:none!important}}";
    document.head.appendChild(s);
  }
  function addButton() {
    if (!open) return;
    var row = document.querySelector('[data-panel=trip] .tripbar .row');
    if (!row || row.querySelector(".terr-map")) return;
    css();
    var b = document.createElement("button");
    b.type = "button"; b.className = "primary terr-map";
    b.innerHTML = "Map this trip &#8599;";
    b.title = "Open these accounts in My Territory and build the driving route";
    b.onclick = function () { var u = url(); if (u) window.open(u, "_blank", "noopener"); };
    row.insertBefore(b, row.firstChild);
  }
  function toast(n) {
    if (!open) return;
    css();
    var t = document.querySelector(".terr-toast");
    if (!t) { t = document.createElement("div"); t.className = "terr-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.innerHTML = "<span>" + n + " account" + (n > 1 ? "s" : "") + " on this trip. Build the route?</span>" +
      '<a href="#" id="terr-go">Map this trip &#8599;</a><button type="button" aria-label="Close">&times;</button>';
    t.querySelector("#terr-go").onclick = function (e) { e.preventDefault(); var u = url(); if (u) window.open(u, "_blank", "noopener"); t.remove(); };
    t.querySelector("button").onclick = function () { t.remove(); };
    clearTimeout(toastT); toastT = setTimeout(function () { if (t.parentNode) t.remove(); }, 7000);
  }
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.matches || !el.matches("[data-trip]") || !el.checked) return;
    setTimeout(function () { var t = trip(); if (t && t.names.length) toast(t.names.length); }, 0);
  });
  // the trip panel is redrawn on every change: put the button back right away
  new MutationObserver(function () { if (open) addButton(); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(check, 1500);
})();

/* 5. "Not my account" flags (Nov 15 2026), shared with the Sales Hub (/api/account-flags).
   Pending flags show red here and in My Territory until Fred decides. When Fred confirms a removal, the
   account is hidden from this review (cards, tables, trip) for that rep. Each account card gets a
   "Not my account" button. Shown only when My Territory is open for the signed-in code. */
(function () {
  var HUB = "https://aldora-sales-hub.netlify.app";
  var g = function (expr) { try { return (0, eval)(expr); } catch (e) { return undefined; } };
  var key = function (s) { return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
    .replace(/\bisland glass\s*,?\s*ltd\b/g, " island glass limited ").replace(/\b(inc|llc|co|corp|corporation|company|ltd|the)\b/g, " ").replace(/\s+/g, " ").trim(); };
  var state = { open: false, code: "", pend: {}, gone: {}, at: 0 };

  function code() { var S = g('typeof STORE !== "undefined" ? STORE : null'); return S && S.code ? S.code : ""; }
  function rep() { var M = g('typeof MODEL !== "undefined" ? MODEL : null'); var rn = document.querySelector("#repName"); return (M && M.rep) || (rn ? rn.value.trim() : ""); }
  function repKey(r) { return String(r || "").toLowerCase().replace(/[^a-z]+/g, ""); }
  async function refresh(force) {
    var c = code(); if (!c) return;
    if (!force && c === state.code && Date.now() - state.at < 60000) return;
    state.code = c; state.at = Date.now();
    try {
      var s = await (await fetch(HUB + "/api/territory-status", { headers: { "x-hub-code": c } })).json();
      state.open = !!s.open;
      if (!state.open) { paint(); return; }
      var d = await (await fetch(HUB + "/api/account-flags", { headers: { "x-hub-code": c } })).json();
      state.pend = {}; state.gone = {};
      (d.flags || []).forEach(function (f) {
        if (f.kind === "add") return; // new-account requests are not "not mine" flags
        var k = repKey(f.rep) + "|" + key(f.account);
        if (f.status === "removed") state.gone[k] = f; else if (f.status === "pending") state.pend[k] = f;
      });
      // every confirmed removal, including ones the rep did not ask for (the hub lists them without details)
      (d.gone || []).forEach(function (g) { var k = repKey(g.rep) + "|" + key(g.account); if (!state.gone[k]) state.gone[k] = { rep: g.rep, account: g.account, status: "removed" }; });
    } catch (e) {}
    paint();
  }
  function css() {
    if (document.getElementById("flag-css")) return;
    var s = document.createElement("style"); s.id = "flag-css";
    s.textContent = ".acct.flag-pend{outline:3px solid #D32F2F;outline-offset:-3px;background:#FFF5F5}" +
      "tr.flag-pend td{background:#FFF0F0}" +
      ".flag-tag{display:inline-block;background:#FBE3E3;color:#A33A3A;font-weight:700;font-size:.75rem;padding:2px 8px;border-radius:99px;margin-left:6px;white-space:nowrap}" +
      ".flag-btn{border:1px solid #A33A3A;color:#A33A3A;background:#fff;border-radius:6px;padding:2px 8px;font-size:.78rem;font-weight:600;cursor:pointer;margin-left:6px}" +
      ".flag-hide{display:none!important}@media print{.flag-btn{display:none!important}}";
    document.head.appendChild(s);
  }
  function paint() {
    var r = repKey(rep()), T = g('typeof TRIP !== "undefined" ? TRIP : null'), tripChanged = false;
    if (!state.open || !r) return;
    css();
    document.querySelectorAll("[data-trip]").forEach(function (i) {
      var name = i.dataset.trip, k = r + "|" + key(name), card = i.closest(".acct");
      if (!card) return;
      var gone = !!state.gone[k], pend = !!state.pend[k];
      card.classList.toggle("flag-hide", gone);
      card.classList.toggle("flag-pend", pend);
      if (gone && T && T.has(name)) { T.delete(name); tripChanged = true; }
      var top = card.querySelector(".top");
      if (!top) return;
      var tag = top.querySelector(".flag-tag"), btn = top.querySelector(".flag-btn");
      if (pend && !tag) { tag = document.createElement("span"); tag.className = "flag-tag"; tag.textContent = "Flagged: waiting for Fred"; top.appendChild(tag); }
      if (!pend && tag) tag.remove();
      if (!pend && !gone && !btn) {
        btn = document.createElement("button"); btn.type = "button"; btn.className = "flag-btn"; btn.textContent = "Not my account";
        btn.onclick = function () { flag(name); }; top.appendChild(btn);
      }
      if (pend && btn) btn.remove();
    });
    document.querySelectorAll("[data-pc]").forEach(function (i) {
      var k = r + "|" + key(i.dataset.pc), tr = i.closest("tr"); if (!tr) return;
      tr.classList.toggle("flag-hide", !!state.gone[k]);
      tr.classList.toggle("flag-pend", !!state.pend[k]);
    });
    if (tripChanged) { try { g("saveTrip()"); g("syncTrip()"); } catch (e) {} }
  }
  function dialog() {
    var d = document.getElementById("flag-dlg");
    if (d) return d;
    d = document.createElement("dialog"); d.id = "flag-dlg";
    d.style.cssText = "border:0;border-radius:14px;padding:20px 22px;max-width:440px;width:calc(100vw - 32px);box-shadow:0 12px 40px rgba(0,0,0,.3);font:15px/1.4 system-ui,sans-serif;color:#243947";
    d.innerHTML = '<form method="dialog"><h2 style="margin:0 0 4px;font-size:1.2rem">Not my account</h2><div id="flag-what" style="color:#5E6E78;font-size:.9rem"></div>' +
      '<label style="display:block;margin:14px 0 6px;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:#5E6E78">Why</label>' +
      '<select id="flag-why" style="width:100%;padding:8px;border:1px solid #D9E2E3;border-radius:8px;font:inherit"></select>' +
      '<label style="display:block;margin:14px 0 6px;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:#5E6E78">Note (optional)</label>' +
      '<textarea id="flag-note" rows="3" maxlength="300" placeholder="Who you think it belongs to, or anything Fred should know" style="width:100%;padding:8px;border:1px solid #D9E2E3;border-radius:8px;font:inherit;box-sizing:border-box"></textarea>' +
      '<p style="color:#5E6E78;font-size:.85rem;margin:12px 0 0">Fred will work with Niall and your branch manager, and approve once confirmed. Until then it shows red. Once approved, it comes off your list in every app.</p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button value="cancel" style="padding:8px 14px;border-radius:8px;border:1px solid #115E67;background:#fff;color:#115E67;font-weight:600;cursor:pointer">Cancel</button>' +
      '<button value="ok" style="padding:8px 14px;border-radius:8px;border:1px solid #A33A3A;background:#A33A3A;color:#fff;font-weight:600;cursor:pointer">Send flag</button></div></form>';
    document.body.appendChild(d);
    d.querySelector("#flag-why").innerHTML = ["Not my territory", "Belongs to another rep", "Out of business", "Not a customer", "Other"].map(function (x) { return "<option>" + x + "</option>"; }).join("");
    return d;
  }
  function flag(name) {
    var d = dialog();
    d.querySelector("#flag-what").textContent = name + " · on " + rep() + "'s list";
    d.querySelector("#flag-note").value = "";
    d.onclose = async function () {
      if (d.returnValue !== "ok") return;
      try {
        var r = await fetch(HUB + "/api/account-flags", { method: "POST", headers: { "x-hub-code": code(), "content-type": "application/json" },
          body: JSON.stringify({ action: "flag", rep: rep(), account: name, reason: d.querySelector("#flag-why").value, note: d.querySelector("#flag-note").value }) });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || r.status);
        await refresh(true);
      } catch (e) { alert("Could not send the flag (" + (e.message || e) + "). Try again or tell Fred."); }
    };
    d.showModal();
  }
  var t = null;
  new MutationObserver(function () { if (!state.open) return; clearTimeout(t); t = setTimeout(paint, 150); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(function () { refresh(false); }, 3000);
})();

/* 6. Print this rep's account list and compare it with My Territory.
   Adds a "Print / compare list" button beside "Download this rep's list". It prints the rep's list as this app
   has it (assigned list plus accounts added here, minus removals Fred confirmed) in the same layout as the
   Account list tab in My Territory, and lines it up against My Territory's list: on both, only here, only there. */
(function () {
  var HUB = "https://aldora-sales-hub.netlify.app";
  var g = function (expr) { try { return (0, eval)(expr); } catch (e) { return undefined; } };
  var key = function (s) { return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
    .replace(/\bisland glass\s*,?\s*ltd\b/g, " island glass limited ").replace(/\b(inc|llc|co|corp|corporation|company|ltd|the|dba)\b/g, " ").replace(/\s+/g, ""); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var money = function (n) { return n ? "$" + Math.round(n).toLocaleString() : ""; };

  async function rarList() {
    var S = g('typeof STORE !== "undefined" ? STORE : null'), id = g('typeof CURRENT_ID !== "undefined" ? CURRENT_ID : ""');
    var M = g('typeof MODEL !== "undefined" ? MODEL : null'), rn = document.querySelector("#repName");
    var d = S && id ? await S.get(id) : null;
    var rep = (d && d.name) || (M && M.rep) || (rn ? rn.value.trim() : "");
    var set = (d && d.settings) || {}, listText = String(set.acctList || (document.querySelector("#acctList") || {}).value || "");
    var ytd = {}; ((M && M.accounts) || []).forEach(function (a) { ytd[key(a.name)] = a.ytd || 0; });
    var rows = [], seen = {};
    listText.split(/\r?\n/).forEach(function (l) { var x = l.split("\t"), n = (x[0] || "").trim(); if (!n || seen[key(n)]) return; seen[key(n)] = 1; rows.push({ a: n, code: (x[1] || "").trim(), src: "Assigned list" }); });
    ((d && d.acctAdds) || []).forEach(function (a) { if (!a || !a.name || seen[key(a.name)]) return; seen[key(a.name)] = 1; rows.push({ a: a.name, code: a.code || "", src: "Added in Rep Account Review" }); });
    rows.forEach(function (r) { r.ytd = ytd[key(r.a)] || 0; });
    return { rep: rep, rows: rows };
  }
  async function territoryList(rep) {
    var S = g('typeof STORE !== "undefined" ? STORE : null'), c = S && S.code;
    if (!c) return { error: "No access code" };
    try {
      var r = await fetch(HUB + "/api/territory?rep=" + encodeURIComponent(rep), { headers: { "x-hub-code": c } });
      var j = await r.json();
      if (!r.ok || !j.plan) return { error: j.error === "locked" ? "My Territory is not open for this code yet" : j.error === "hidden" ? "My Territory is not open for this team yet" : "Could not read My Territory (" + (j.error || r.status) + ")" };
      var p = j.plan, out = [];
      (p.accounts || []).forEach(function (a) { out.push({ a: a[0], city: [a[2], a[3]].filter(Boolean).join(", "), ytd: a[7] || 0 }); });
      ["outside", "phone", "unmapped"].forEach(function (k) { (p[k] || []).forEach(function (x) { out.push({ a: x.a, city: [x.city, x.st].filter(Boolean).join(", "), ytd: x.ytd || 0 }); }); });
      if (j.plan.rep && j.plan.rep.replace(/[^a-z]/gi, "").toLowerCase().replace(/(.)\1+/g, "$1") !== rep.replace(/[^a-z]/gi, "").toLowerCase().replace(/(.)\1+/g, "$1"))
        return { error: "My Territory has no list for " + rep };
      return { rep: p.rep, rows: out };
    } catch (e) { return { error: "Could not reach My Territory" }; }
  }
  async function run(btn) {
    var w = window.open("", "_blank");
    if (!w) { alert("Allow pop-ups for this site to print the list."); return; }
    w.document.write("<p style='font:16px sans-serif;padding:24px'>Building the list\u2026</p>");
    btn.disabled = true;
    try {
      var R = await rarList();
      if (!R.rep || !R.rows.length) { w.document.body.innerHTML = "<p style='font:16px sans-serif;padding:24px'>Open a saved rep with an account list first.</p>"; return; }
      var T = await territoryList(R.rep);
      var tk = {}, rk = {};
      (T.rows || []).forEach(function (x) { tk[key(x.a)] = x; });
      R.rows.forEach(function (x) { rk[key(x.a)] = x; x.inT = !!tk[key(x.a)]; if (x.inT && !x.ytd) x.ytd = tk[key(x.a)].ytd; });
      var onlyR = R.rows.filter(function (x) { return !x.inT; }), onlyT = (T.rows || []).filter(function (x) { return !rk[key(x.a)]; });
      var both = R.rows.length - onlyR.length;
      R.rows.sort(function (a, b) { return (b.ytd - a.ytd) || a.a.localeCompare(b.a); });
      var today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      var tbl = function (head, rows) { return "<table><thead><tr>" + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table>"; };
      var cmp = T.error ? "<div class='warn'>" + esc(T.error) + ". The list below is Rep Account Review only.</div>" :
        "<div class='kpis'><div><b>" + R.rows.length + "</b>in Rep Account Review</div><div><b>" + T.rows.length + "</b>in My Territory</div><div class='ok'><b>" + both + "</b>on both</div>" +
        "<div class='" + (onlyR.length ? "bad" : "ok") + "'><b>" + onlyR.length + "</b>only in Rep Account Review</div><div class='" + (onlyT.length ? "bad" : "ok") + "'><b>" + onlyT.length + "</b>only in My Territory</div></div>" +
        (onlyR.length || onlyT.length ? "<h2>Lists that do not match</h2>" +
          (onlyR.length ? "<h3>Only in Rep Account Review (" + onlyR.length + ")</h3>" + tbl(["Account", "Cust #", "Source", "Sales this year"], onlyR.map(function (x) { return "<tr><td><b>" + esc(x.a) + "</b></td><td>" + esc(x.code) + "</td><td>" + esc(x.src) + "</td><td class=n>" + money(x.ytd) + "</td></tr>"; })) : "") +
          (onlyT.length ? "<h3>Only in My Territory (" + onlyT.length + ")</h3>" + tbl(["Account", "City", "Sales this year"], onlyT.map(function (x) { return "<tr><td><b>" + esc(x.a) + "</b></td><td>" + esc(x.city) + "</td><td class=n>" + money(x.ytd) + "</td></tr>"; })) : "") +
          "<p class='note'>Names are matched ignoring punctuation, spacing and Inc, LLC or Co. A spelling difference shows up here as a mismatch on both sides.</p>"
          : "<p class='good'>Both lists match.</p>");
      var html = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + esc(R.rep) + " account list " + today + "</title><style>" +
        "@page{size:letter landscape;margin:.5in}body{font:10pt/1.4 'IBM Plex Sans',Arial,sans-serif;color:#243947;margin:0;padding:24px}" +
        ".top{display:flex;justify-content:space-between;align-items:flex-end;border-top:6px solid #115E67;padding-top:14px;margin-bottom:14px}.top img{height:40px}" +
        "h1{font:800 18pt Archivo,Arial,sans-serif;color:#0B434A;margin:0;text-align:right}.sub{color:#5E6E78;font-size:9pt;text-align:right}" +
        "h2{font:800 13pt Archivo,Arial,sans-serif;color:#0B434A;margin:18px 0 6px}h3{font:700 11pt Arial,sans-serif;color:#A33A3A;margin:12px 0 4px}" +
        ".kpis{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}.kpis div{border:1px solid #D9E2E3;border-radius:6px;padding:8px 12px;min-width:120px;font-size:9pt;color:#5E6E78}.kpis b{display:block;font-size:16pt;color:#0B434A}" +
        ".kpis .ok{border-left:4px solid #6A9E39}.kpis .bad{border-left:4px solid #A33A3A}.good{color:#4E7A2B;font-weight:700}" +
        ".warn{background:#FFF4E5;border-left:4px solid #E0A33A;padding:8px 12px;margin:8px 0}.note{color:#5E6E78;font-size:8.5pt}" +
        "table{width:100%;border-collapse:collapse;font-size:9pt;margin-bottom:6px}th{background:#115E67;color:#fff;text-align:left;padding:5px 8px}td{padding:4px 8px;border-bottom:1px solid #D9E2E3}" +
        "tbody tr:nth-child(even) td{background:#F4F8F8}td.n,th.n{text-align:right}tr{break-inside:avoid}thead{display:table-header-group}" +
        ".x{color:#A33A3A;font-weight:700}.y{color:#4E7A2B}.bar{margin-bottom:12px}.bar button{font:600 11pt Arial;padding:8px 16px;border-radius:6px;border:1px solid #115E67;background:#115E67;color:#fff;cursor:pointer}@media print{.bar{display:none}}" +
        "</style></head><body><div class='bar'><button onclick='window.print()'>Print or save as PDF</button></div>" +
        "<div class='top'><img src='" + HUB + "/aldora-logo.png' alt='Aldora'><div><h1>" + esc(R.rep) + " \u00B7 Account list</h1><div class='sub'>From Rep Account Review \u00B7 compared with My Territory \u00B7 " + today + "</div></div></div>" +
        cmp + "<h2>Rep Account Review list (" + R.rows.length + ")</h2>" +
        tbl(["#", "Account", "Cust #", "Source", "Sales this year", "In My Territory"], R.rows.map(function (x, i) {
          return "<tr><td class=note>" + (i + 1) + "</td><td><b>" + esc(x.a) + "</b></td><td>" + esc(x.code) + "</td><td class=note>" + esc(x.src) + "</td><td class=n>" + money(x.ytd) + "</td><td>" +
            (T.error ? "" : x.inT ? "<span class=y>Yes</span>" : "<span class=x>No</span>") + "</td></tr>"; })) +
        "<p class='note'>Aldora Sales Hub \u00B7 Rep Account Review. Sales this year come from the sales file loaded in Rep Account Review, or from My Territory when it is not loaded.</p></body></html>";
      w.document.open(); w.document.write(html); w.document.close();
      setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 700);
    } finally { btn.disabled = false; }
  }
  function add() {
    if (document.getElementById("printList")) return;
    var one = document.getElementById("dlOne"); if (!one) return;
    var b = document.createElement("button"); b.type = "button"; b.id = "printList"; b.textContent = "Print / compare list";
    b.title = "Print this rep's list and check it against My Territory";
    b.onclick = function () { run(b); };
    one.insertAdjacentElement("afterend", b);
    var sync = function () { b.disabled = !g('typeof CURRENT_ID !== "undefined" ? CURRENT_ID : ""') && !(document.querySelector("#acctList") || {}).value; };
    sync(); setInterval(sync, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();
