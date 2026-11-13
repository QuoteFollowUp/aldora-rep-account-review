/* Aldora Sales Hub bridge for Rep Account Review.
   Lives in its own file so a new index.html export from Claude Design never removes it.
   An edge function (netlify/edge-functions/hub-bridge.mjs) adds it to the page on every load.
   1. Sign-in from the hub: turns #ac=CODE into #c=CODE before the page reads it.
   2. Dormant accounts: after a review builds, sends that rep's dormant list to the hub.
      Rule (same as the Revenue Report's "dropped"): bought in 2+ earlier months, no invoice in the
      last two full months or the current partial month. */
(function () {
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
})();
