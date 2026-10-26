// Saved rep reviews for the Rep Account Review app.
// Storage: Netlify Blobs, store "rep-reviews", one JSON blob per rep.
// Access (header x-access-code):
//   ACCESS_CODE                 -> manager: sees, saves and deletes every rep.
//   REP_CODES (JSON env var)    -> {"code":"rep-id", ...}. A rep code can only read that one rep.
//                                  Use "*" as the rep-id to make another manager code.
//                                  Use "@view" for a view-only code that sees every rep (e.g. the COO).
//   rep-id is the rep name in lowercase with hyphens, e.g. "Christian Kelley" -> "christian-kelley".
//   Manager list responses add hasCode per rep and an x-missing-reps header (rep codes with no saved review).
import { getStore } from "@netlify/blobs";

const json = (data, status = 200, role) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}) },
  });

// Codes are compared ignoring case, spaces and dashes, so "8r2p xd9q" works the same as "8R2P-XD9Q".
const norm = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function repMap() {
  let map = {};
  try { map = JSON.parse(process.env.REP_CODES || "{}"); } catch (e) { map = {}; }
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
  if (!who) return new Response("Unauthorized", { status: 401 });

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
  if (who.role !== "manager") return new Response("This code can view reviews but not change them.", { status: 403 });

  if (req.method === "PUT") {
    const body = await req.json();
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
