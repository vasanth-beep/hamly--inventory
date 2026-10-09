// Hamly Inventory database API. All PostgreSQL access stays server-side.
import { getStore } from "@netlify/blobs";
import { Pool } from "pg";
import crypto from "node:crypto";

export const config = { path: "/db/*" };

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
let pool;
function dbPool() {
  if (!process.env.DATABASE_URL) throw new HttpError(503, "Database is not configured. Set DATABASE_URL in Netlify.");
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const lc = (s) => String(s || "").toLowerCase();
const safeName = (v) => {
  const s = String(v || "").trim();
  if (!s || s.length > 120) throw new HttpError(400, "Organization name must be 1–120 characters");
  return s;
};
function verifyToken(db, token) {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !db?.secret || !Array.isArray(db.users)) return null;
  const expected = crypto.createHmac("sha256", db.secret).update("auth:" + body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!payload || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
  return db.users.find((u) => u.id === payload.u) || null;
}
async function currentUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new HttpError(401, "Please sign in again");
  const result = await getStore({ name: "hamly-auth", consistency: "strong" }).get("db", { type: "json" });
  const user = verifyToken(result, token);
  if (!user) throw new HttpError(401, "Session expired. Please sign in again");
  return user;
}
async function requireMembership(sql, orgId, user) {
  if (typeof orgId !== "string" || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new HttpError(400, "Valid orgId is required");
  const r = await sql.query(
    "select member_role from public.hamly_org_members where org_id=$1 and user_id=$2",
    [orgId, user.id]
  );
  if (!r.rowCount) throw new HttpError(403, "You do not have access to this organization");
  return r.rows[0].member_role;
}
const actions = {
  async health(_body, _user, sql) {
    await sql.query("select 1");
    return { ok: true, database: "connected" };
  },
  async "orgs-list"(_body, user, sql) {
    const r = await sql.query(
      "select o.id, o.name, m.member_role as role from public.hamly_organizations o join public.hamly_org_members m on m.org_id=o.id where m.user_id=$1 order by o.name",
      [user.id]
    );
    return { organizations: r.rows };
  },
  async "orgs-create"(body, user, sql) {
    const name = safeName(body.name);
    const client = await sql.connect();
    try {
      await client.query("begin");
      const created = await client.query(
        "insert into public.hamly_organizations(name, created_by) values($1,$2) on conflict(created_by,name) do update set name=excluded.name returning id,name",
        [name, user.id]
      );
      const org = created.rows[0];
      await client.query(
        "insert into public.hamly_org_members(org_id,user_id,member_role) values($1,$2,'Admin') on conflict(org_id,user_id) do update set member_role='Admin'",
        [org.id, user.id]
      );
      await client.query("commit");
      return { organization: { ...org, role: "Admin" } };
    } catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }
  },
  async "orgs-add-member"(body, user, sql) {
    const orgId = body.orgId;
    const role = body.role === "Admin" ? "Admin" : "User";
    const existingRole = await requireMembership(sql, orgId, user);
    if (existingRole !== "Admin" && user.role !== "Admin") throw new HttpError(403, "Organization Admin only");
    const username = String(body.username || "").trim();
    if (!username || username.length > 30) throw new HttpError(400, "Valid username is required");
    const authDb = await getStore({ name: "hamly-auth", consistency: "strong" }).get("db", { type: "json" });
    const target = authDb?.users?.find((u) => lc(u.username) === lc(username));
    if (!target) throw new HttpError(404, "User not found");
    await sql.query(
      "insert into public.hamly_org_members(org_id,user_id,member_role) values($1,$2,$3) on conflict(org_id,user_id) do update set member_role=excluded.member_role",
      [orgId, target.id, role]
    );
    return { ok: true, username: target.username, role };
  },
  async "records-list"(body, user, sql) {
    await requireMembership(sql, body.orgId, user);
    const r = await sql.query(
      "select record_key as key, record_value as value, updated_at as \"updatedAt\" from public.hamly_inventory_records where org_id=$1 order by record_key",
      [body.orgId]
    );
    return { records: r.rows };
  },
  async "records-upsert"(body, user, sql) {
    await requireMembership(sql, body.orgId, user);
    const key = String(body.key || "");
    if (!key || key.length > 240) throw new HttpError(400, "Record key must be 1–240 characters");
    if (!Object.prototype.hasOwnProperty.call(body, "value")) throw new HttpError(400, "value is required");
    const encoded = JSON.stringify(body.value);
    if (encoded.length > 500000) throw new HttpError(413, "Record value is too large (500 KB maximum)");
    await sql.query(
      "insert into public.hamly_inventory_records(org_id,record_key,record_value,updated_by,updated_at) values($1,$2,$3::jsonb,$4,now()) on conflict(org_id,record_key) do update set record_value=excluded.record_value,updated_by=excluded.updated_by,updated_at=now()",
      [body.orgId, key, encoded, user.id]
    );
    return { ok: true, key };
  },
  async "records-delete"(body, user, sql) {
    await requireMembership(sql, body.orgId, user);
    const key = String(body.key || "");
    if (!key || key.length > 240) throw new HttpError(400, "Valid record key is required");
    await sql.query("delete from public.hamly_inventory_records where org_id=$1 and record_key=$2", [body.orgId, key]);
    return { ok: true };
  },
  async "migrate-localstorage"(body, user, sql) {
    await requireMembership(sql, body.orgId, user);
    if (!Array.isArray(body.records) || body.records.length > 1000) throw new HttpError(400, "records must be an array (maximum 1000)");
    let imported = 0, skipped = 0;
    const client = await sql.connect();
    try {
      await client.query("begin");
      for (const rec of body.records) {
        const key = String(rec?.key || "");
        if (!key || key.length > 240 || !Object.prototype.hasOwnProperty.call(rec, "value")) { skipped++; continue; }
        const encoded = JSON.stringify(rec.value);
        if (encoded.length > 500000) { skipped++; continue; }
        const result = await client.query(
          "insert into public.hamly_inventory_records(org_id,record_key,record_value,updated_by) values($1,$2,$3::jsonb,$4) on conflict(org_id,record_key) do nothing",
          [body.orgId, key, encoded, user.id]
        );
        if (result.rowCount) imported++; else skipped++;
      }
      await client.query("commit");
      return { ok: true, imported, skipped, note: "Existing database records were not overwritten." };
    } catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }
  }
};

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);
    const path = new URL(req.url).pathname.replace(/^\/db\//, "").replace(/\/+$/, "");
    const action = actions[path];
    if (!action) return json({ error: "Not found" }, 404);
    const textBody = await req.text();
    if (textBody.length > 2000000) return json({ error: "Request too large" }, 413);
    let body = {};
    try { body = textBody ? JSON.parse(textBody) : {}; } catch { return json({ error: "Bad JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "JSON object required" }, 400);
    const user = await currentUser(req);
    const result = await action(body, user, dbPool());
    return json(result);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("Hamly DB API error:", e?.message || e);
    return json({ error: "Server error" }, 500);
  }
};
