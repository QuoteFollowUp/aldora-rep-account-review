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
function whoIs(code) {
  const c = norm(code);
  if (!c) return null;
  const admin = norm(process.env.ACCESS_CODE);
  if (admin && c === admin) return { role: "manager" };
  const rep = repMap()[c];
  if (!rep) return null;
  if (rep === "*") return { role: "manager" };
  if (rep === "@view") return { role: "viewer" };
  return { role: "rep", rep };
}

export default async (req) => {
  if (!process.env.ACCESS_CODE && !process.env.REP_CODES)
    return new Response("ACCESS_CODE is not set on this Netlify site.", { status: 401 });
  const who = whoIs((req.headers.get("x-access-code") || "").trim());
  if (!who) {
    repMap();
    return new Response(MAP_BAD ? "REP_CODES in Netlify is not valid JSON. Re-paste it exactly as one line." : "Unauthorized", { status: 401, headers: MAP_BAD ? { "x-codes-bad": "1" } : {} });
  }

  const store = getStore("rep-reviews");
  const id = new URL(req.url).searchParams.get("id");
  const isRep = who.role === "rep";

  if (req.method === "GET" && !id) {
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key).filter((k) => !isRep || k === who.rep);
    const coded = new Set(Object.values(repMap()).filter((v) => v !== "*" && v !== "@view"));
    const items = await Promise.all(
      keys.map(async (k) => {
        const m = await store.getMetadata(k);
        return { id: k, ...(m?.metadata || {}), ...(isRep ? {} : { hasCode: coded.has(k) }) };
      })
    );
    const res = json(items, 200, who.role);
    if (!isRep) {
      const have = new Set(blobs.map((b) => b.key));
      res.headers.set("x-missing-reps", [...coded].filter((k) => !have.has(k)).join(","));
    }
    return res;
  }

  if (!id || !/^[a-z0-9-]{1,80}$/.test(id)) return new Response("Bad id", { status: 400 });
  if (isRep && id !== who.rep) return new Response("Forbidden", { status: 403 });

  if (req.method === "GET") {
    const data = await store.get(id, { type: "json" });
    return data ? json(data, 200, who.role) : new Response("Not found", { status: 404 });
  }
  // Reps (their own review) and managers can add or remove accounts picked from the call log.
  if (req.method === "PATCH") {
    if (who.role === "viewer") return new Response("This code can view reviews but not change them.", { status: 403 });
    const body = await req.json().catch(() => ({}));
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
    await store.setJSON(id, data, { metadata: { name: data.name, savedAt: data.savedAt, summary: data.summary } });
    return json({ ok: true, acctAdds: adds }, 200, who.role);
  }
  if (who.role !== "manager") return new Response("This code can view reviews but not change them.", { status: 403 });

  if (req.method === "PUT") {
    const body = await req.json();
    // Keep accounts a rep added since the manager last loaded this review.
    const prev = await store.get(id, { type: "json" }).catch(() => null);
    if (prev && Array.isArray(prev.acctAdds)) {
      const k = (x) => String((x && x.name) || "").trim().toLowerCase();
      const have = new Set((body.acctAdds || []).map(k));
      body.acctAdds = [...(body.acctAdds || []), ...prev.acctAdds.filter((x) => !have.has(k(x)))];
    }
    if (prev && prev.aliases && typeof prev.aliases === "object") body.aliases = { ...prev.aliases, ...(body.aliases || {}) };
    await store.setJSON(id, body, {
      metadata: { name: body.name, savedAt: body.savedAt, summary: body.summary },
    });
    return json({ ok: true }, 200, who.role);
  }
  if (req.method === "DELETE") {
    await store.delete(id);
    return json({ ok: true }, 200, who.role);
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/reps" };
