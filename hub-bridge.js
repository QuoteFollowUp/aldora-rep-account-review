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
