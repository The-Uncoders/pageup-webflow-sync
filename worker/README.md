# Cloudflare Worker — sync-trigger

Proxies POST requests from the dashboard to GitHub Actions `workflow_dispatch`.

## Deployed at

`https://fctg-sync-trigger.wandering-sun-9809.workers.dev`

## Cloudflare account

`Hello@uncoders.co` (account ID `4a6fba0403941f5658f7287a2496ac8c`)

## Environment variables (encrypted, set in Cloudflare dashboard)

| Name | Purpose |
|---|---|
| `SYNC_KEY` | Shared secret — validated against the `?key=…` query param |
| `GITHUB_TOKEN` | Fine-grained PAT with Actions:write on `The-Uncoders/pageup-webflow-sync` |

## How to deploy updates

There's no CI for the worker. To push changes:

1. Edit `sync-trigger.js` in this repo and commit.
2. Open the Cloudflare dashboard → Workers & Pages → `fctg-sync-trigger` → Edit Code.
3. Paste the full contents of `sync-trigger.js` into the editor (replacing the existing code).
4. Click **Save and Deploy**.
5. Verify via a test POST:

   ```bash
   # Normal sync
   curl -X POST "https://fctg-sync-trigger.wandering-sun-9809.workers.dev?key=<SYNC_KEY>"

   # Force-full sync
   curl -X POST "https://fctg-sync-trigger.wandering-sun-9809.workers.dev?key=<SYNC_KEY>&force_full=true"
   ```

   Both should return `{"ok":true,…}` and the workflow run should appear in GitHub Actions.

## Query params accepted

| Param | Required | Notes |
|---|---|---|
| `key` | yes | Auth gate — matches `env.SYNC_KEY` |
| `force_full` | no | When `"true"`, the sync runs in force-full mode (bypasses listing-level diff, scrapes every job) |
