import { getStore } from "@netlify/blobs";

// Saved rep reviews for the Rep Account Review app.
// Storage: Netlify Blobs, store "rep-reviews", one JSON blob per rep.
// Access (header x-access-code):
//   ACCESS_CODE                 -> manager: sees, saves and deletes every rep.
//   REP_CODES (JSON env var)    -> {"code":"rep-id", ...}. A rep code can only read that one rep.
//                                  Use "*" as the rep-id to make another manager code.
//                                  Use "@view" for a view-only code that sees every rep (e.g. the COO).
//   rep-id is the rep name in lowercase with hyphens, e.g. "Christian Kelley" -> "christian-kelley".
//   Manager list responses add hasCode per rep and an x-missing-reps header (rep codes with no saved review).
//   REP_ACCESS_CODES (shared, team-level Netlify variable) -> the same Call Log codes every Aldora app uses:
//     rep -> that rep's review only;  branch manager -> the reviews of their branch's reps (read only);
//     Fred -> every review with manager rights (RAR_MANAGERS); ownership / view-only -> every review, read only.
//     ACCESS_CODE stays a save/upload code too.

// ---- Aldora shared access codes (built into this file, same rules as every Aldora app) ----
//
// One code list for every app: the Netlify environment variable REP_ACCESS_CODES, set once at
// TEAM level (Team settings > Environment variables) so every site reads the same list. Same
// format the Quote Follow-Up / Call Log app already uses, a JSON map of code -> who:
//   "first-last"                         rep: only their own data
//   "@branch:louisville:first-last"      branch manager: that branch's reps
//   "@reps:rep-one+rep-two:first-last"   manager of a hand-picked set of reps
//   "@all:first-last"                    everything
//   "@view:first-last"                   everything, read only
// Codes ignore case, spaces and dashes ("VCDR-TDMR" = "vcdr tdmr").

// Field reps and their branch (same list the hub and Call Log app use)
const REP_BRANCH = {
  "Steve Crum": "Louisville", "Jim Wanamaker": "Louisville", "Christian Kelley": "Louisville",
  "Clarke Haas": "Charleston", "Zachary Mangum": "Charleston",
  "Andrea Harmon": "Atlanta", "Michael Eidson": "Atlanta",
  "Chad Parrish": "Newport News", "Kyle Pitsenberger": "Newport News", "Anthony Ante": "Newport News",
  "Eric Pegouske": "Orlando", "Troy Patnode": "Orlando",
  "Ben Gless": "Coral Springs", "Shawn Levine": "Coral Springs", "Jordan Freeman": "Coral Springs",
  "Mark Williams": "Miami",
  "Adam Tarkenton": "New Angle Beveling",
};
const BRANCHES = ["Atlanta", "Charleston", "Coral Springs", "Louisville", "Miami", "New Angle Beveling", "Newport News", "Orlando"];

const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
const titleName = (slug) => String(slug || "").split(/[-_\s]+/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).map((w) => w.replace(/^(Mc)([a-z])/, (m, a, c) => a + c.toUpperCase())).join(" ");

// "louisville", "Newport-News", "Miami (Peterson)", "LPG", "NN VA" -> canonical branch name
function canonBranch(b) {
  const t = String(b || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (/newport|^nn\b/.test(t)) return "Newport News";
  if (/coral|^cs\b/.test(t)) return "Coral Springs";
  if (/louis|^lpg\b/.test(t)) return "Louisville";
  if (/orlan|^orl\b/.test(t)) return "Orlando";
  if (/atlan|^atl\b/.test(t)) return "Atlanta";
  if (/charl|^chs\b/.test(t)) return "Charleston";
  if (/miami|peterson/.test(t)) return "Miami";
  if (/angle|bevel/.test(t)) return "New Angle Beveling";
  return BRANCHES.find((x) => x.toLowerCase() === t) || titleName(t);
}

// Rep name as it appears anywhere ("Mccall", "christian-kelley") -> the roster spelling when known
const ROSTER_BY_KEY = Object.fromEntries(Object.keys(REP_BRANCH).map((n) => [nameKey(n), n]));
const ALIASES = { "jim wannamaker": "Jim Wanamaker", "jim wannmaker": "Jim Wanamaker", "clark haas": "Clarke Haas", "chad parish": "Chad Parrish",
  "christian kelly": "Christian Kelley", "kyle pitzenberger": "Kyle Pitsenberger", "benjamin gless": "Ben Gless", "mike eidson": "Michael Eidson" };
function canonRep(name) {
  const k = nameKey(name);
  return ALIASES[k] || ROSTER_BY_KEY[k] || titleName(k);
}

let BAD = false;
function codeMap() {
  const raw = String(process.env.REP_ACCESS_CODES || process.env.ACCESS_CODES || "{}")
    .replace(/[“”„″]/g, '"').replace(/[‘’]/g, "'").replace(/[\r\n]+/g, " ").trim();
  try { const m = JSON.parse(raw); BAD = false; return m && typeof m === "object" ? m : {}; }
  catch { BAD = true; return {}; }
}
const listIsBad = () => BAD;
const listIsSet = () => !!(process.env.REP_ACCESS_CODES || process.env.ACCESS_CODES);

// Code -> who, or null.  { role: "all"|"branch"|"team"|"rep", readOnly, name, rep, branch, reps, label }
function sharedWho(code) {
  const c = normCode(code);
  if (!c) return null;
  const m = codeMap();
  const hit = Object.keys(m).find((k) => normCode(k) === c);
  if (!hit) return null;
  const v = String(m[hit] || "").trim();
  if (!v) return null;
  let x = v.match(/^@(view|all|owner|ownership|admin)(?::(.+))?$/i);
  if (x) {
    const name = x[2] ? titleName(x[2]) : x[1].toLowerCase() === "view" ? "View-only" : "Ownership";
    return { role: "all", readOnly: x[1].toLowerCase() === "view", name, label: name + " · All branches" };
  }
  x = v.match(/^@reps:([^:]+)(?::(.+))?$/i);
  if (x) {
    const reps = x[1].split("+").map((s) => canonRep(s)).filter(Boolean);
    const name = x[2] ? titleName(x[2]) : "Manager";
    return { role: "team", readOnly: false, name, reps, label: name + " · " + reps.join(", ") };
  }
  x = v.match(/^@branch:([^:]+)(?::(.+))?$/i);
  if (x) {
    const branch = canonBranch(x[1]);
    const name = x[2] ? titleName(x[2]) : branch + " manager";
    return { role: "branch", readOnly: false, name, branch, label: name + " · " + branch + " reps" };
  }
  const rep = canonRep(v);
  return { role: "rep", readOnly: false, name: rep, rep, branch: REP_BRANCH[rep] || "", label: rep };
}

// Reps this person may see: null = everyone, otherwise a Set of roster names
function repsFor(who) {
  if (!who || who.role === "all") return null;
  if (who.role === "rep") return new Set([who.rep]);
  if (who.role === "team") return new Set(who.reps);
  return new Set(Object.keys(REP_BRANCH).filter((r) => REP_BRANCH[r] === who.branch));
}
function canSeeRep(who, repName) {
  const s = repsFor(who);
  return !s || s.has(canonRep(repName));
}

const json = (data, status = 200, role) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}) },
  });

// Codes are compared ignoring case, spaces and dashes, so "8r2p xd9q" works the same as "8R2P-XD9Q".
const norm = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
let MAP_BAD = false;
function repMap() {
  let map = {};
  // Tolerate smart quotes and stray line breaks pasted into the Netlify field.
  const raw = String(process.env.REP_CODES || "{}").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/[\r\n]+/g, " ").trim();
  try { map = JSON.parse(raw); MAP_BAD = false; } catch (e) { map = {}; MAP_BAD = !!process.env.REP_CODES; }
  const out = {};
  for (const [k, v] of Object.entries(map)) out[norm(k)] = String(v).trim().toLowerCase();
  return out;
}
// A REP_CODES value in the shared format, read with the shared rules
function legacyShared(code) {
  const v = repMap()[norm(code)];
  if (!v || !v.startsWith("@")) return null;
  const saved = process.env.REP_ACCESS_CODES;
  process.env.REP_ACCESS_CODES = JSON.stringify({ [norm(code)]: v });
  try { return sharedWho(code); } finally { if (saved === undefined) delete process.env.REP_ACCESS_CODES; else process.env.REP_ACCESS_CODES = saved; }
}
function whoIs(code) {
  const c = norm(code);
  if (!c) return null;
  const admin = norm(process.env.ACCESS_CODE);
  if (admin && c === admin) return { role: "manager" };
  let rep = repMap()[c];
  if (rep === "*") return { role: "manager" };
  if (rep === "@view") return { role: "viewer" };
  // Values in the shared format ("@all:fred-haas", "@branch:charleston:john-rittenberry") use the shared rules
  if (rep && rep.startsWith("@")) rep = null;
  if (!rep) {
    const s = sharedWho(code) || legacyShared(code);
    if (!s) return null;
    const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (s.role === "rep") return { role: "rep", rep: slug(s.rep) };
    if (s.role === "all") {
      // Named people with full manager rights here (save, upload, remove accounts). Everyone else
      // with a company-wide code reads only. Set RAR_MANAGERS in Netlify to change the names.
      const mgrs = String(process.env.RAR_MANAGERS || "Fred Haas").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
      return !s.readOnly && mgrs.includes(String(s.name).toLowerCase()) ? { role: "manager" } : { role: "viewer" };
    }
    return { role: "branch", reps: new Set([...repsFor(s)].map(slug)) };
  }
  if (rep === "*") return { role: "manager" };
  if (rep === "@view") return { role: "viewer" };
  return { role: "rep", rep };
}

export default async (req) => {
  if (!process.env.ACCESS_CODE && !process.env.REP_CODES && !listIsSet())
    return new Response("ACCESS_CODE is not set on this Netlify site.", { status: 401 });
  const who = whoIs((req.headers.get("x-access-code") || "").trim());
  if (!who) {
    repMap();
    return new Response(MAP_BAD ? "REP_CODES in Netlify is not valid JSON. Re-paste it exactly as one line." : "Unauthorized", { status: 401, headers: MAP_BAD ? { "x-codes-bad": "1" } : {} });
  }

  const store = getStore("rep-reviews");
  const id = new URL(req.url).searchParams.get("id");
  const isRep = who.role === "rep";
  // Which reviews this code may open: null = all
  const allowed = who.role === "rep" ? new Set([who.rep]) : who.role === "branch" ? who.reps : null;
  // The page only knows manager / viewer / rep. A branch manager browses like a viewer.
  const uiRole = who.role === "branch" ? "viewer" : who.role;

  if (req.method === "GET" && !id) {
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key).filter((k) => !allowed || allowed.has(k));
    const coded = new Set(Object.values(repMap()).filter((v) => v !== "*" && v !== "@view"));
    const items = await Promise.all(
      keys.map(async (k) => {
        const m = await store.getMetadata(k);
        return { id: k, ...(m?.metadata || {}), ...(who.role === "manager" ? { hasCode: coded.has(k) } : {}) };
      })
    );
    const res = json(items, 200, uiRole);
    if (who.role === "manager") {
      const have = new Set(blobs.map((b) => b.key));
      res.headers.set("x-missing-reps", [...coded].filter((k) => !have.has(k)).join(","));
    }
    return res;
  }

  if (!id || !/^[a-z0-9-]{1,80}$/.test(id)) return new Response("Bad id", { status: 400 });
  if (allowed && !allowed.has(id)) return new Response("Forbidden", { status: 403 });

  const sp = new URL(req.url).searchParams;
  if (req.method === "GET" && who.role === "manager" && (sp.get("backups") || sp.get("backup"))) {
    const bak = getStore("rep-reviews-backup");
    if (sp.get("backup")) {
      const key = String(sp.get("backup"));
      if (!key.startsWith(id + "/")) return new Response("Bad backup", { status: 400 });
      const d = await bak.get(key, { type: "json" });
      return d ? json(d, 200, who.role) : new Response("Not found", { status: 404 });
    }
    const { blobs } = await bak.list({ prefix: id + "/" });
    const items = await Promise.all(blobs.map(async (b) => ({ key: b.key, ...((await bak.getMetadata(b.key))?.metadata || {}) })));
    items.sort((a, b) => String(b.savedAt || b.key).localeCompare(String(a.savedAt || a.key)));
    return json(items, 200, who.role);
  }
  if (req.method === "GET") {
    const data = await store.get(id, { type: "json" });
    return data ? json(data, 200, uiRole) : new Response("Not found", { status: 404 });
  }
  // Reps (their own review) and managers can add or remove accounts picked from the call log.
  if (req.method === "PATCH") {
    if (who.role === "viewer" || who.role === "branch") return new Response("This code can view reviews but not change them.", { status: 403 });
    const body = await req.json().catch(() => ({}));
    // Dormant accounts for the Sales Hub, sent by the page after it builds a review. Kept in its own
    // small store so the hub can read it fast. Does not touch the review itself.
    if (body.dormant && !body.add && !body.remove && !body.aliases) {
      await saveDormant(id, body.dormant);
      return json({ ok: true }, 200, who.role);
    }
    if (body.dormant) await saveDormant(id, body.dormant);
    const data = await store.get(id, { type: "json" });
    if (!data) return new Response("Not found", { status: 404 });
    const k = (x) => String((x && x.name) || x || "").trim().toLowerCase();
    let adds = Array.isArray(data.acctAdds) ? data.acctAdds : [];
    for (const a of (Array.isArray(body.add) ? body.add : []).slice(0, 200)) {
      if (!a || !a.name || adds.some((x) => k(x) === k(a))) continue;
      adds.push({ name: String(a.name).slice(0, 200), code: String(a.code || "").slice(0, 40), call: String(a.call || "").slice(0, 200), prospect: !!a.prospect, by: who.role, at: new Date().toISOString() });
    }
    const rm = new Set((Array.isArray(body.remove) ? body.remove : []).map(k));
    adds = adds.filter((x) => !rm.has(k(x)));
    data.acctAdds = adds;
    if (body.aliases && typeof body.aliases === "object") {
      const al = data.aliases && typeof data.aliases === "object" ? data.aliases : {};
      for (const [k, v] of Object.entries(body.aliases).slice(0, 500)) { const key = String(k).slice(0, 200); if (!v) delete al[key]; else al[key] = String(v).slice(0, 200); }
      data.aliases = al;
    }
    const now = new Date().toISOString(), what = [];
    (Array.isArray(body.add) ? body.add : []).forEach((a) => a && a.name && what.push("Added " + a.name + (a.call && a.call !== a.name ? " (logged as " + a.call + ")" : "")));
    (Array.isArray(body.remove) ? body.remove : []).forEach((n) => what.push("Removed " + n));
    if (body.aliases && typeof body.aliases === "object") Object.entries(body.aliases).forEach(([k2, v]) => {
      if (Array.isArray(body.remove) && !v) return;
      const k3 = String(k2);
      if (k3.startsWith("excl:")) { what.push((v ? "Removed from list (not my account): " : "Restored to list: ") + k3.slice(5)); return; }
      if (v === "__hide") { what.push("Removed from consideration (not my account): " + k3); return; }
      what.push((k3.startsWith("call:") ? "Moved one call" : "Linked calls for " + k3) + (v === "__none" ? " to not on this list" : v ? " to " + v : " (link cleared)"));
    });
    data.log = [...(Array.isArray(data.log) ? data.log : []), ...what.slice(0, 50).map((w) => ({ at: now, by: who.role, what: String(w).slice(0, 240) }))].slice(-300);
    data.changedAt = now; data.changedBy = who.role;
    await store.setJSON(id, data, { metadata: { name: data.name, savedAt: data.savedAt, summary: data.summary, changedAt: now, changedBy: who.role } });
    return json({ ok: true, acctAdds: adds, changedAt: now }, 200, who.role);
  }
  if (who.role !== "manager") return new Response("This code can view reviews but not change them.", { status: 403 });

  if (req.method === "PUT") {
    const body = await req.json();
    // Keep accounts a rep added since the manager last loaded this review.
    const prev = await store.get(id, { type: "json" }).catch(() => null);
    // The server copy is the record for accounts added and calls linked in the app (those are saved as they happen),
    // so a manager save of new files never overwrites what a rep did on their phone.
    // Keep the last 15 saves of every rep so a bad upload can be undone ("Restore an earlier save").
    if (prev) {
      try {
        const bak = getStore("rep-reviews-backup"), at = new Date().toISOString();
        await bak.setJSON(id + "/" + at, prev, { metadata: { savedAt: prev.savedAt || "", replacedAt: at, summary: prev.summary || null } });
        const { blobs } = await bak.list({ prefix: id + "/" });
        const old = blobs.map((b) => b.key).sort().reverse().slice(15);
        await Promise.all(old.map((k) => bak.delete(k)));
      } catch (e) {}
    }
    if (body.dormant) await saveDormant(id, body.dormant);
    if (prev && Array.isArray(prev.acctAdds)) body.acctAdds = prev.acctAdds;
    if (prev && prev.aliases && typeof prev.aliases === "object") body.aliases = { ...(body.aliases || {}), ...prev.aliases };
    body.log = [...(prev && Array.isArray(prev.log) ? prev.log : []), { at: body.savedAt || new Date().toISOString(), by: who.role, what: "Saved review with new files" }].slice(-300);
    body.changedAt = body.savedAt; body.changedBy = who.role;
    await store.setJSON(id, body, {
      metadata: { name: body.name, savedAt: body.savedAt, summary: body.summary, changedAt: body.changedAt, changedBy: who.role },
    });
    return json({ ok: true }, 200, who.role);
  }
  if (req.method === "DELETE") {
    await store.delete(id);
    try { await getStore("rep-dormant").delete(id); } catch (e) {}
    return json({ ok: true }, 200, who.role);
  }
  return new Response("Method not allowed", { status: 405 });
};

// Dormant list the Sales Hub reads (store "rep-dormant", one entry per rep id)
async function saveDormant(id, d) {
  try {
    if (!d || typeof d !== "object") return;
    const list = (Array.isArray(d.list) ? d.list : []).slice(0, 60).map((x) => ({
      name: String((x && x.name) || "").slice(0, 160), code: String((x && x.code) || "").slice(0, 40), tier: String((x && x.tier) || "").slice(0, 2),
      last: String((x && x.last) || "").slice(0, 7), sales12: Math.round(Number(x && x.sales12) || 0), sales: Math.round(Number(x && x.sales) || 0),
    })).filter((x) => x.name);
    await getStore("rep-dormant").setJSON(id, { v: 1, rep: String(d.rep || "").slice(0, 80), from: String(d.from || "").slice(0, 7), through: String(d.through || "").slice(0, 7),
      count: Math.max(0, Math.round(Number(d.count) || 0)), value: Math.round(Number(d.value) || 0), list, at: new Date().toISOString() });
  } catch (e) {}
}

export const config = { path: "/api/reps" };
