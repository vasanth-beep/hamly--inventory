# Supabase API smoke tests

Run these against your deployed Netlify site after applying `supabase/schema.sql` and setting the secret `DATABASE_URL`.

Replace `SITE` with the site origin and `TOKEN` with your own current session token. Never commit or share the token.

```bash
# 1. Database connectivity
curl -i -X POST "$SITE/db/health" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

# 2. Create / retrieve your organization
curl -i -X POST "$SITE/db/orgs-create" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Hamly"}'

# 3. List organizations
curl -i -X POST "$SITE/db/orgs-list" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

# 4. Insert a test record (replace ORG_UUID with returned id)
curl -i -X POST "$SITE/db/records-upsert" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"orgId":"ORG_UUID","key":"__supabase_smoke_test__","value":{"ok":true,"source":"manual-test"}}'

# 5. Read then delete the test record
curl -i -X POST "$SITE/db/records-list" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"orgId":"ORG_UUID"}'
curl -i -X POST "$SITE/db/records-delete" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"orgId":"ORG_UUID","key":"__supabase_smoke_test__"}'
```

Expected: health returns HTTP 200 and database connected; valid authorized operations return HTTP 200; missing/invalid session returns 401; a non-member accessing an organization returns 403.

Also verify no `DATABASE_URL` value is present in `public/index.html`, built assets, or Git history. If the secret was ever committed, rotate the database password in Supabase immediately.
