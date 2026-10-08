// Saved rep reviews for the Rep Account Review app.
// Storage: Netlify Blobs, store "rep-reviews", one JSON blob per rep.
// Access: every request must send header x-access-code matching the ACCESS_CODE environment variable.
import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const expected = process.env.ACCESS_CODE;
  if (!expected) return new Response("ACCESS_CODE is not set on this Netlify site.", { status: 401 });
  if (req.headers.get("x-access-code") !== expected) return new Response("Unauthorized", { status: 401 });

  const store = getStore("rep-reviews");
  const id = new URL(req.url).searchParams.get("id");

  if (req.method === "GET" && !id) {
    const { blobs } = await store.list();
    const items = await Promise.all(
      blobs.map(async (b) => {
        const m = await store.getMetadata(b.key);
        return { id: b.key, ...(m?.metadata || {}) };
      })
    );
    return json(items);
  }

  if (!id || !/^[a-z0-9-]{1,80}$/.test(id)) return new Response("Bad id", { status: 400 });

  if (req.method === "GET") {
    const data = await store.get(id, { type: "json" });
    return data ? json(data) : new Response("Not found", { status: 404 });
  }
  if (req.method === "PUT") {
    const body = await req.json();
    await store.setJSON(id, body, {
      metadata: { name: body.name, savedAt: body.savedAt, summary: body.summary },
    });
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    await store.delete(id);
    return json({ ok: true });
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/reps" };
