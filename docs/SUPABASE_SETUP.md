# Hamly Inventory — Supabase setup and migration

This change is on branch `feature/supabase-inventory`; it does not replace the current UI or the existing `/api/*` sign-in/approval flow.

## 1. Install the database schema
1. Open Supabase Dashboard → your Mumbai project → **SQL Editor** → **New query**.
2. Copy and run `supabase/schema.sql`.
3. In Netlify → Site configuration → Environment variables, set **DATABASE_URL** to the Supabase **Transaction Pooler** connection string (PostgreSQL URI). Keep it marked secret. Do not put this value in HTML, JavaScript, GitHub, or chat.
4. Trigger a new Netlify deploy after the dependency and function files are on the deployed branch.

## 2. API endpoints
All endpoints require the current app's session token in `Authorization: Bearer <token>`; call them from a signed-in client only. Send JSON with POST.
- `/db/health` — checks server-side DB connection.
- `/db/orgs-list` — lists organizations the signed-in user belongs to.
- `/db/orgs-create` with `{"name":"Hamly" }` — creates/returns an organization and makes the signed-in user its organization Admin.
- `/db/orgs-add-member` with `{"orgId":"<uuid>","username":"existing-user","role":"User"}` — organization Admin adds an existing Hamly login.
- `/db/records-list` with `{"orgId":"<uuid>" }` — reads stored records.
- `/db/records-upsert` with `{"orgId":"<uuid>","key":"some-localStorage-key","value":{}}` — inserts/replaces a record.
- `/db/records-delete` with `{"orgId":"<uuid>","key":"some-localStorage-key" }` — deletes a record.
- `/db/migrate-localstorage` with `{"orgId":"<uuid>","records":[{"key":"old-key","value":{}}] }` — imports localStorage records without overwriting keys already present.

The SQL connection string and PostgreSQL credentials are never returned to the browser. Existing login tokens are validated against the current Netlify Blobs auth store.

## 3. Migration strategy (keep a backup)
1. Before migration, open the currently deployed Hamly Inventory app in the browser that contains the original data. Do not clear browser storage.
2. Sign in as the intended Admin. Use `/db/orgs-create` once to create the matching company/organization and save the returned UUID.
3. Use the signed-in app's existing session token for the API request. The token is stored by the current app in browser storage; inspect the app's own auth/session storage in DevTools rather than sending the token to anyone.
4. Export only the Hamly Inventory data keys (for example keys beginning with `hamly-v5-data-`) as JSON. Keep the export as a private backup; it can contain company data.
5. POST the key/value array to `/db/migrate-localstorage`. Split into batches if necessary. The endpoint is idempotent: existing database keys are skipped, not overwritten.
6. Confirm imported/skipped counts and compare the number of records plus sample item, stock-in, stock-out, returns, and disposal records with the original browser. Keep the backup until validation is complete.

**Important limitation:** this foundation provides secure database endpoints and a compatibility migration store, but the current `public/index.html` still reads/writes inventory using synchronous `localStorage`. The existing UI is deliberately unchanged in this first migration-safe step. Inventory screens will not automatically become multi-device/database-backed until their storage calls are switched to the `/db/records-*` API and the organization UUID is wired into the UI. Do not assume data is fully cloud-synced just because the API health check succeeds.

## 4. Test checklist
- [ ] With DATABASE_URL set and schema applied, POST `/db/health` while signed in → `{"ok":true,"database":"connected"}`.
- [ ] Without a token or with an expired/invalid token → HTTP 401.
- [ ] Create an organization; confirm it appears in `/db/orgs-list`.
- [ ] User not in that organization tries to list/write records → HTTP 403.
- [ ] Add a second existing login as a member; verify that member can access the org.
- [ ] Upsert a sample record; list it; update it; delete it.
- [ ] Run migration twice; first run imports new keys, second run skips duplicates.
- [ ] Verify current sign-in, sign-up approval, admin user management, and every existing inventory screen still behave the same.
- [ ] Test from a second browser/computer only after the UI adapter is implemented; this first step alone does not sync localStorage between devices.
