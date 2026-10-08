// Hamly shared auth API  (Netlify Function + Netlify Blobs)
// Makes sign-up requests, approvals, users and logins shared by every computer.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const KEY = "db";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9._@-]{3,30}$/;

/* ---------- storage ---------- */
function store() {
  return globalThis.__HAMLY_TEST_STORE__ || getStore({ name: "hamly-auth", consistency: "strong" });
}
const b64u = (b) => Buffer.from(b).toString("base64url");
const randomId = (n = 12) => crypto.randomBytes(n).toString("hex");

function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return { salt, hash };
}
function checkPassword(pw, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const a = Buffer.from(crypto.scryptSync(String(pw), rec.salt, 64).toString("hex"));
  const b = Buffer.from(rec.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function freshDb() {
  const adminPw = process.env.ADMIN_PASSWORD || "admin";
  const { salt, hash } = hashPassword(adminPw);
  return {
    secret: process.env.AUTH_SECRET || randomId(32),
    nextId: 2,
    users: [{ id: 1, username: "admin", role: "Admin", salt, hash, createdAt: new Date().toISOString() }],
    pending: [],
  };
}

/* read-modify-write with optimistic concurrency (etag) */
async function readDb() {
  const s = store();
  const r = await s.getWithMetadata(KEY, { type: "json" });
  if (r && r.data) return { db: r.data, etag: r.etag };
  return { db: null, etag: null };
}
async function loadDb() {
  let { db } = await readDb();
  if (db) return db;
  const created = freshDb();
  const res = await store().setJSON(KEY, created, { onlyIfNew: true });
  if (res && res.modified === false) return (await readDb()).db;
  return created;
}
async function mutate(fn) {
  for (let i = 0; i < 6; i++) {
    let { db, etag } = await readDb();
    let isNew = false;
    if (!db) { db = freshDb(); isNew = true; }
    const out = await fn(db);           // may throw HttpError
    if (out && out.__noWrite) return out.value;
    const opts = isNew ? { onlyIfNew: true } : { onlyIfMatch: etag };
    const res = await store().setJSON(KEY, db, opts);
    if (!res || res.modified !== false) return out;
  }
  throw new HttpError(503, "Server busy, please try again");
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* ---------- tokens ---------- */
const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");
function makeToken(db, user) {
  const body = b64u(JSON.stringify({ u: user.id, exp: Date.now() + TOKEN_TTL_MS }));
  return body + "." + sign(db.secret, "auth:" + body);
}
function verifyToken(db, token) {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const good = sign(db.secret, "auth:" + body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!p || p.exp < Date.now()) return null;
  return db.users.find((u) => u.id === p.u) || null;      // role is always re-read from db
}
const requestToken = (db, id) => id + "." + sign(db.secret, "req:" + id);
function requestIdFromToken(db, tok) {
  if (typeof tok !== "string") return null;
  const i = tok.lastIndexOf(".");
  if (i < 1) return null;
  const id = tok.slice(0, i), sig = tok.slice(i + 1);
  const good = sign(db.secret, "req:" + id);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return id;
}

/* ---------- helpers ---------- */
const pubUser = (u) => ({ id: u.id, username: u.username, role: u.role });
const pubReq = (r) => ({ id: r.id, username: r.username, requestedAt: r.requestedAt, status: r.status });
const lc = (s) => String(s || "").toLowerCase();
const nameTaken = (db, name, exceptId) =>
  db.users.some((u) => lc(u.username) === lc(name) && u.id !== exceptId);

function needUser(db, bearer) {
  const u = verifyToken(db, bearer);
  if (!u) throw new HttpError(401, "Please sign in again");
  return u;
}
function needAdmin(db, bearer) {
  const u = needUser(db, bearer);
  if (u.role !== "Admin") throw new HttpError(403, "Admin only");
  return u;
}
function cleanName(v) {
  const n = String(v || "").trim();
  if (!NAME_RE.test(n)) throw new HttpError(400, "ID name must be 3 to 30 characters: letters, numbers and . _ - @ only");
  return n;
}
function cleanPw(v) {
  const p = String(v || "").trim();
  if (p.length < 1 || p.length > 200) throw new HttpError(400, "Password is required");
  return p;
}
function cleanRole(v) { return v === "Admin" ? "Admin" : "User"; }

/* ---------- actions ---------- */
const actions = {
  async ping() { return { ok: true }; },

  async login({ username, password }) {
    const db = await loadDb();
    const u = db.users.find((x) => lc(x.username) === lc(String(username || "").trim()));
    const pw = String(password || "").trim();
    if (u && checkPassword(pw, u)) return { token: makeToken(db, u), user: pubUser(u) };
    // friendlier message for people still waiting
    const r = db.pending.find((x) => lc(x.username) === lc(String(username || "").trim()));
    if (r && checkPassword(pw, r)) {
      throw new HttpError(403, r.status === "rejected"
        ? "Your sign-up request was not approved by the Admin. Please contact your Admin."
        : "Your request is still waiting for Admin approval. You can sign in once it is approved.");
    }
    throw new HttpError(401, "Invalid username or password");
  },

  async me(_b, bearer) {
    const db = await loadDb();
    return { user: pubUser(needUser(db, bearer)) };
  },

  async signup({ username, password }) {
    const name = cleanName(username), pw = cleanPw(password);
    return mutate(async (db) => {
      if (nameTaken(db, name)) throw new HttpError(409, "This ID name is already taken. Please choose another.");
      const ex = db.pending.find((r) => lc(r.username) === lc(name));
      if (ex && ex.status !== "rejected") throw new HttpError(409, "A request for this ID name is already waiting for Admin approval");
      if (ex) db.pending = db.pending.filter((r) => r !== ex);
      if (db.pending.length >= 200) throw new HttpError(429, "Too many pending requests. Please contact your Admin.");
      const { salt, hash } = hashPassword(pw);
      const rec = { id: "req_" + randomId(8), username: name, salt, hash, requestedAt: new Date().toISOString(), status: "pending" };
      db.pending.push(rec);
      return { requestToken: requestToken(db, rec.id), request: pubReq(rec) };
    });
  },

  // status by requestToken, or by username+password (recovers the token)
  async "signup-status"({ requestToken: tok, username, password }) {
    const db = await loadDb();
    let id = tok ? requestIdFromToken(db, tok) : null;
    let r = id && db.pending.find((x) => x.id === id);
    if (!id && username && password) {
      const name = lc(String(username).trim()), pw = String(password).trim();
      r = db.pending.find((x) => lc(x.username) === name && checkPassword(pw, x));
      if (r) id = r.id;
      else {
        const u = db.users.find((x) => lc(x.username) === name && checkPassword(pw, x));
        if (u) return { state: "approved", username: u.username, requestToken: u.fromRequest ? requestToken(db, u.fromRequest) : undefined };
        return { state: "none" };
      }
    }
    if (!id) return { state: "none" };
    if (r) return { state: r.status === "rejected" ? "rejected" : "pending", username: r.username, requestedAt: r.requestedAt, requestToken: requestToken(db, id) };
    const u = db.users.find((x) => x.fromRequest === id);
    if (u) return { state: "approved", username: u.username, requestToken: requestToken(db, id) };
    return { state: "none" };
  },

  async pending(_b, bearer) {
    const db = await loadDb();
    needAdmin(db, bearer);
    return { pending: db.pending.map(pubReq) };
  },

  async approve({ id }, bearer) {
    return mutate(async (db) => {
      needAdmin(db, bearer);
      const r = db.pending.find((x) => x.id === id);
      if (!r) throw new HttpError(404, "Request no longer exists");
      db.pending = db.pending.filter((x) => x !== r);
      if (nameTaken(db, r.username)) throw new HttpError(409, "@" + r.username + " already exists - request removed");
      const u = { id: db.nextId++, username: r.username, role: "User", salt: r.salt, hash: r.hash, fromRequest: r.id, createdAt: new Date().toISOString() };
      db.users.push(u);
      return { user: pubUser(u) };
    }).catch(async (e) => { throw e; });
  },

  async reject({ id }, bearer) {
    return mutate(async (db) => {
      needAdmin(db, bearer);
      const r = db.pending.find((x) => x.id === id);
      if (!r) throw new HttpError(404, "Request no longer exists");
      r.status = "rejected";
      return { ok: true };
    });
  },

  async "clear-request"({ id }, bearer) {
    return mutate(async (db) => {
      needAdmin(db, bearer);
      db.pending = db.pending.filter((x) => x.id !== id);
      return { ok: true };
    });
  },

  async users(_b, bearer) {
    const db = await loadDb();
    needAdmin(db, bearer);
    return { users: db.users.map(pubUser) };
  },

  async "user-save"({ id, username, password, role }, bearer) {
    return mutate(async (db) => {
      needAdmin(db, bearer);
      const name = cleanName(username), r = cleanRole(role);
      if (id) {
        const u = db.users.find((x) => x.id === id);
        if (!u) throw new HttpError(404, "User not found");
        if (nameTaken(db, name, u.id)) throw new HttpError(409, "Username already exists");
        if (u.role === "Admin" && r !== "Admin" && db.users.filter((x) => x.role === "Admin").length <= 1)
          throw new HttpError(400, "There must be at least one Admin");
        u.username = name; u.role = r;
        if (password && String(password).trim()) Object.assign(u, hashPassword(cleanPw(password)));
        return { user: pubUser(u) };
      }
      if (nameTaken(db, name)) throw new HttpError(409, "Username already exists");
      const u = { id: db.nextId++, username: name, role: r, ...hashPassword(cleanPw(password)), createdAt: new Date().toISOString() };
      db.users.push(u);
      return { user: pubUser(u) };
    });
  },

  async "user-delete"({ id }, bearer) {
    return mutate(async (db) => {
      const me = needAdmin(db, bearer);
      const u = db.users.find((x) => x.id === id);
      if (!u) throw new HttpError(404, "User not found");
      if (u.id === me.id) throw new HttpError(400, "You cannot delete the account you are signed in with");
      if (u.role === "Admin" && db.users.filter((x) => x.role === "Admin").length <= 1)
        throw new HttpError(400, "There must be at least one Admin");
      db.users = db.users.filter((x) => x !== u);
      return { ok: true };
    });
  },

  // one-time import of users that lived only in this browser's localStorage
  async "import-users"({ users }, bearer) {
    return mutate(async (db) => {
      needAdmin(db, bearer);
      let added = 0;
      for (const x of Array.isArray(users) ? users.slice(0, 200) : []) {
        const name = String((x && x.username) || "").trim(), pw = String((x && x.password) || "").trim();
        if (!NAME_RE.test(name) || !pw || nameTaken(db, name)) continue;
        db.users.push({ id: db.nextId++, username: name, role: cleanRole(x.role), ...hashPassword(pw), createdAt: new Date().toISOString() });
        added++;
      }
      return { added };
    });
  },
};

/* ---------- entry ---------- */
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  try {
    const name = new URL(req.url).pathname.replace(/^\/api\//, "").replace(/\/+$/, "");
    const fn = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
    if (!fn) return json({ error: "Not found" }, 404);
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);
    let body = {};
    try { const t = await req.text(); if (t.length > 200000) return json({ error: "Too large" }, 413); body = t ? JSON.parse(t) : {}; }
    catch { return json({ error: "Bad request" }, 400); }
    if (!body || typeof body !== "object") body = {};
    const auth = req.headers.get("authorization") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return json(await fn(body, bearer));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Server error" }, 500);
  }
};
