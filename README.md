# `data` branch

This branch holds the JSON artifacts consumed by the public site and the sync dashboard. It is **orphan** (no shared history with `main`) and written exclusively by the sync workflow.

## Contents

| File | Served at | Consumed by |
|------|-----------|-------------|
| `all-jobs.json` | `cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/all-jobs.json` | `jobs-filter.js` on the `/jobs` page |
| `filter-counts.json` | `cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/filter-counts.json` | `jobs-filter.js` (filter counts) |
| `sync-log.json` | `cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/sync-log.json` | Dashboard (CI history) |

## Write discipline

The sync workflow on `main` amends the previous commit on this branch rather than creating a new one — so this branch is a single moving commit, not a growing history. Do not push to this branch manually.

Code changes (sync logic, workflow, scripts) live on `main`. This branch is data-only.
