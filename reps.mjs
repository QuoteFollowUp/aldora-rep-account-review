// Saved rep reviews for the Rep Account Review app.
// Storage: Netlify Blobs, store "rep-reviews", one JSON blob per rep.
// Access (header x-access-code):
//   ACCESS_CODE                 -> manager: sees, saves and deletes every rep.
//   REP_CODES (JSON env var)    -> {"code":"rep-id", ...}. A rep code can only read that one rep.
//                                  Use "*" as the rep-id to make another manager code.
//   rep-id is the rep name in lowercase with hyphens, e.g. "Christian Kelley" -> "christian-kelley".
import { getStore } from "@netlify/blobs";

const json = (data, status = 200, role) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}) },
  });

function whoIs(code) {
  if (!code) return null;
  const admin = process.env.ACCESS_CODE;
  if (admin && code === admin) return { role: "manager" };
  let map = {};
  try { map = JSON.parse(process.env.REP_CODES || "{}"); } catch (e) { map = {}; }
  const rep = map[code];
  if (!rep) return null;
  return rep === "*" ? { role: "manager" } : { role: "rep", rep: String(rep).toLowerCase() };
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
    const items = await Promise.all(
      keys.map(async (k) => {
        const m = await store.getMetadata(k);
        return { id: k, ...(m?.metadata || {}) };
      })
    );
    return json(items, 200, who.role);
  }

  if (!id || !/^[a-z0-9-]{1,80}$/.test(id)) return new Response("Bad id", { status: 400 });
  if (isRep && id !== who.rep) return new Response("Forbidden", { status: 403 });

  if (req.method === "GET") {
    const data = await store.get(id, { type: "json" });
    return data ? json(data, 200, who.role) : new Response("Not found", { status: 404 });
  }
  if (isRep) return new Response("Reps can view their review but not change it.", { status: 403 });

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
