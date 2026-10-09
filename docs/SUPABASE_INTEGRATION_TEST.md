# Supabase shared inventory integration test

This branch is a test candidate only. It is not merged into `main`; do not publish it to production until the checklist below passes.

## Required Netlify setup
- Keep `DATABASE_URL` in Netlify environment variables only. Never paste it into HTML, GitHub, or chat.
- Ensure Netlify production/deploy-preview builds install dependencies from `package.json` (`pg` is required).
- Confirm the Supabase SQL in `supabase/schema.sql` has run successfully.

## Test plan (use two test accounts and non-critical sample data)
1. Deploy this branch as a Netlify Deploy Preview, not the production branch.
2. Sign in as Admin on Computer A and confirm the database API is reachable.
3. Open the intended organization. The first Admin session initializes its shared inventory record from that browser's current organization data.
4. Use **Share Organization** (bottom-right) and enter the exact existing User username. Sharing only grants membership; it does not create a user account.
5. Sign in as that User on Computer B. Confirm the shared organization appears and its item/stock data loads.
6. Create a clearly marked test item on Computer A. Wait about 10 seconds and confirm it appears on Computer B.
7. Add a test stock-in/out record on Computer B and confirm it appears on Computer A.
8. Verify the User cannot read an organization they were not invited to (the server must return 403).
9. Test refresh, sign-out/sign-in, and a brief network interruption.
10. If both computers edit the same inventory at the same time, the client pauses syncing and displays a conflict warning rather than silently overwriting local edits. Refresh only after preserving any unsynced work.

## Important behavior and limitations
- Existing local data is not automatically bulk-migrated or overwritten by schema setup. The first Admin session initializes a missing shared inventory record from the selected local organization. Review the data before testing.
- Organization membership is enforced server-side for every inventory request.
- The browser never receives `DATABASE_URL`; database access stays in the Netlify Function.
- Current implementation syncs the main inventory data object. Other browser-only preferences and custom-category settings may remain local.
- The sync polling interval is about 8 seconds; allow a short delay between computers.
- Do not merge until the test plan passes and the live-data initialization is reviewed.
