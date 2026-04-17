# FCTG Careers — PageUp + Webflow Integration

Automated pipeline that keeps Flight Centre Travel Group's careers site in sync with PageUp, their Applicant Tracking System. The public site (fctgcareers.com) is built in Webflow; PageUp is the source of truth for jobs; a GitHub Actions workflow reconciles the two every 20 minutes.

---

## Overview

Three surfaces make up the end-user experience:

| Surface | Served by | Updated via |
|---|---|---|
| `/jobs` — job listings page | Webflow, with a custom client-side filter engine (`jobs-filter.js`) | Fetches `all-jobs.json` from jsDelivr on every page view |
| `/jobs/{slug}` — individual job post | Webflow CMS template | CMS items synced from PageUp every 20 min |
| `careers.pageuppeople.com/889/cw/en/job/{id}` — PageUp apply flow | PageUp | — |

The sync pipeline scrapes PageUp (via Playwright, because the listing sits behind a WAF challenge), diffs against the Webflow CMS, and applies creates/updates/deletes through the Webflow v2 API.

---

## Architecture

```
                          ┌─────────────────────────┐
                          │        PageUp           │
                          │  (source of truth)      │
                          └────────────┬────────────┘
                                       │  Playwright scrape
                                       ▼
              ┌────────────────────────────────────────────────┐
              │  GitHub Actions — runs every 20 min on main   │
              │                                                │
              │  1. Scrape listing page (title + location +    │
              │     brand for every job)                       │
              │  2. Fetch all CMS items                        │
              │  3. Diff:                                       │
              │     - New  → scrape detail, create              │
              │     - Listing-level change → scrape detail,    │
              │       update                                    │
              │     - Unchanged → SKIP detail scrape           │
              │     - Removed → delete CMS item                 │
              │  4. Publish site to custom domain + webflow.io │
              │  5. Regenerate all-jobs.json + filter-counts   │
              │     from /items/live (published only)          │
              │  6. Amend single commit on `data` branch       │
              │  7. Purge jsDelivr CDN for @data URLs          │
              └───────────────┬───────────────────┬────────────┘
                              │                   │
                              ▼                   ▼
              ┌───────────────────────┐  ┌─────────────────────┐
              │   Webflow CMS         │  │  GitHub `data`      │
              │   - Current Jobs      │  │  branch (orphan)    │
              │   - Brands (ref)      │  │  - all-jobs.json    │
              │   - Countries (ref)   │  │  - filter-counts    │
              └───────────┬───────────┘  │  - sync-log.json    │
                          │              └──────────┬──────────┘
                          │ CMS template             │ served via jsDelivr
                          ▼                          ▼
              ┌───────────────────────┐  ┌─────────────────────┐
              │   /jobs/{slug}        │  │   /jobs             │
              │   (Webflow-rendered)  │  │   (jobs-filter.js   │
              │                       │  │    renders cards    │
              │                       │  │    from JSON)       │
              └───────────────────────┘  └─────────────────────┘
```

The key design principle: **code lives on `main`, data lives on `data`**. The sync workflow amends a single commit on `data` every run, so the data branch stays at exactly one commit forever — no history growth, no noise.

---

## Key URLs

| Purpose | URL |
|---|---|
| Production site | https://www.fctgcareers.com/jobs |
| Webflow staging | https://fctg-careers.webflow.io/jobs |
| PageUp production | https://careers.pageuppeople.com/889/cw/en |
| PageUp listing (what the scraper hits) | https://careers.fctgcareers.com/cw/en/listing/?page=1&page-items=500 |
| jobs-filter.js (CDN) | https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/jobs-filter.js |
| all-jobs.json (CDN) | https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/all-jobs.json |
| filter-counts.json (CDN) | https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/filter-counts.json |
| sync-log.json (CDN) | https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/sync-log.json |
| Custom CSS (CDN) | https://cdn.jsdelivr.net/gh/The-Uncoders/fc-careers/pageup.css |
| Sync dashboard | https://www.fctgcareers.com/internal/jobs-dashboard (password protected) |
| Sync trigger (Cloudflare Worker) | https://fctg-sync-trigger.wandering-sun-9809.workers.dev |

### CDN purge endpoints

Replace `cdn.jsdelivr.net` with `purge.jsdelivr.net` on any of the above to force a cache refresh. CI does this automatically after each sync run.

---

## Repository layout

Single GitHub repo `The-Uncoders/pageup-webflow-sync`, two branches:

### `main` branch — code only

| Path | Purpose |
|---|---|
| `src/sync.js` | Main sync orchestrator (scrape → diff → CMS CRUD → publish → JSON regen) |
| `src/scraper.js` | Playwright scraper. `fetchAllJobIds()` gets listing-level data (title + location + brand) for the fast-sync diff; `scrapeAllJobs()` fetches detail pages in parallel |
| `src/webflow.js` | Webflow v2 API client. Rate limit, retry on 5xx, batch ops. `getAllCollectionItems()` for staged reads, `getLiveCollectionItems()` for published-only reads |
| `src/sync-logger.js` | Writes `data/sync-log.json` with per-run stats |
| `jobs-filter.js` | Client-side filter/render engine for `/jobs` and back-button wiring for `/jobs/{slug}` |
| `dashboard/server.js` | Optional local Express dashboard (http://localhost:3456) |
| `dashboard/index.html` | Dashboard UI |
| `.github/workflows/sync-jobs.yml` | 20-minute cron + `workflow_dispatch` |
| `region-map.json` | Country → region display name |
| `location-to-country.json` | Location fragment → country fallback |
| `brand-map.json` | Job title → brand fallback |

**Not on `main`:** `all-jobs.json`, `filter-counts.json`, any sync output. These are gitignored on main and live on the `data` branch instead.

### `data` branch — orphan, JSON artifacts only

| File | Served at | Consumed by |
|---|---|---|
| `all-jobs.json` | `@data/all-jobs.json` | `jobs-filter.js` |
| `filter-counts.json` | `@data/filter-counts.json` | `jobs-filter.js` |
| `sync-log.json` | `@data/sync-log.json` | Dashboard |
| `README.md` | — | Human reference |

The `data` branch is orphan (no shared history with `main`). CI amends its single commit every run rather than creating new ones, so the branch stays at exactly one commit forever.

---

## Webflow site

**Site ID:** `691f361688f213d69817ead2`

### CMS collections

| Collection | ID | Notes |
|---|---|---|
| Current Jobs | `69a6a25d0ee880903952732b` | Sync target |
| Brands | `691f361688f213d69817eb0a` | Reference collection. Entries have a `brand-tag` field for hashtag-based resolution (e.g. `#CTAU,#CTCA`) |
| Countries | `691f361688f213d69817eb56` | Reference collection. 30 entries including "Multiple Locations" |

### Current Jobs — field schema

| Field | Slug | Type | Populated by sync? | Notes |
|---|---|---|---|---|
| Name | `name` | PlainText | ✓ | Job title |
| Slug | `slug` | PlainText | ✓ | URL slug, generated from title |
| Job ID | `job-id` | PlainText | ✓ | **Sync key** — matches PageUp's job ID |
| Location | `location` | PlainText | ✓ | Used for listing-level fast diff |
| City | `city` | PlainText | ✓ | Parsed from location |
| Brand Name | `brand-name` | PlainText | ✓ | Resolved via 3-tier logic |
| Brand | `brand` | Reference | ✓ | → Brands collection |
| Country | `country` | Reference | ✓ | → Countries collection |
| Summary | `summary` | PlainText | ✓ | |
| Description | `description` | RichText | ✓ | Cleaned via `cleanDescription()` |
| Work Type | `work-type` | PlainText | ✓ | |
| Category | `category` | PlainText | ✓ | Comma-separated |
| Job URL | `job-url` | Link | ✓ | |
| Apply URL | `apply-url` | Link | ✓ | |
| Refer URL | `refer-url` | Link | ✓ | |
| Closing Date | `closing-date` | PlainText | ✓ | |
| Hero Image | `hero-image` | Image | ✗ | Manually uploaded only |
| Banner Image Link | `banner-image-link` | Link | ✓ | PageUp banner URL, rendered via code embed |
| Video | `video` | VideoLink | ✓ | YouTube/Vimeo |

### Key pages

| Page | Path | Page ID | Purpose |
|---|---|---|---|
| Jobs listing | `/jobs` | `69a6ff97a01a6236301669bb` | Rendered by `jobs-filter.js` from JSON |
| Current Jobs Template | `/jobs/{slug}` | `69a6a25d0ee8809039527331` | CMS template for individual posts |
| Sync Dashboard | `/internal/jobs-dashboard` | — | Password protected |

### Style pages (CSS-only, scraped by PageUp)

These exist so PageUp can scrape the Webflow-compiled CSS and apply the site's styling to PageUp-rendered pages. They are not HTML templates.

| Page | Path | Page ID |
|---|---|---|
| Job Listing Style | `/page-up/page-up-job-listing-style` | `6994314d6279cd427dce7b08` |
| Job Post Style | `/page-up/job-post-style` | `699451c78916c273f48748c4` |
| Components and Styles | `/page-up/components-and-styles` | `69948acacc21f3070b1225ee` |

### Designer-side requirements

These elements/attributes must exist in the Webflow Designer for the integration to work:

| Requirement | Where | Why |
|---|---|---|
| `id="all-jobs-button"` on the back button | Current Jobs Template (`/jobs/{slug}`) | `setupBackButton()` targets it by ID to wire `href="/jobs#filters"` + sessionStorage-based filter restoration |
| `.career_list` container on `/jobs` page | `/jobs` page | `jobs-filter.js` renders cards into this element |
| Banner image embed with `onerror` fallback | Current Jobs Template | See below |

**Banner image embed** (inside the conditional-visibility container that shows when `banner-image-link` is set):

```html
<img
  src="{{wf {&quot;path&quot;:&quot;banner-image-link&quot;,&quot;type&quot;:&quot;Link&quot;\} }}"
  alt="Job banner"
  onerror="this.onerror=null; this.src='<DEFAULT_BANNER_URL>';"
  style="width: 100%; height: 100%; object-fit: cover; display: block;"
/>
```

The `onerror` swaps in the default banner URL when PageUp's image returns 403 or otherwise fails (Webflow's "is set" conditional can't check URL reachability). Replace `<DEFAULT_BANNER_URL>` with the URL of the default banner asset.

### Page custom code — the loader

The `jobs-filter.js` loader is pasted as custom code on both pages (NOT registered via Scripts API, to avoid site-wide loading and double-init race conditions). **Before `</body>` tag** on:
- `/jobs` (listing)
- `/jobs/{slug}` (template)

```html
<script>
(function(){var e=Math.floor(Date.now()/1200000);var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/jobs-filter.js?b=2&v='+e;s.defer=true;document.body.appendChild(s);})();
</script>
```

- 20-min epoch = cache window matches sync cadence
- `b=2` = static marker; bump this if you need to force an immediate refetch (bypasses cached references to previous loader URLs)
- `defer=true` = runs after HTML parse, doesn't block rendering

`jobs-filter.js` branches internally — on `/jobs` it runs the full filter/render engine; on `/jobs/{slug}` it runs only `setupBackButton()`.

---

## CSS architecture

Two stylesheets work together to style PageUp-rendered pages (the apply flow at `careers.fctgcareers.com`):

### 1. Webflow-native CSS (class-based)

Generated from the three style pages and served with the Webflow site. Covers `.button`, `.apply-link`, `.back-link`, `.employee-referral-link`, `.success`, `.social-share-kit`, `.active`, `.fc-jobs`, `.careers-browse`, `.font-type-1/2/3`.

### 2. Custom CSS (`pageup.css`)

Hosted at `The-Uncoders/fc-careers`, served via jsDelivr. Contains only selectors Webflow can't express natively — ID selectors, positional selectors (`td:nth-child(2)`, `#job-details + p + p`), pseudo-elements, and CSS variables.

```css
:root {
  --hb-bg-1: #f9f9f7;
  --hb-dark1: #000;
  --hb-light: #fff;
  --hb-color1: #000;
  --hb-color1a: rgba(18, 31, 63, 0.5);
  --hb-font1: "Calibri", sans-serif;
}
```

Webflow variable collection ID: `collection-ad2c2ace-c1c3-4e0c-a4ab-6e1a55826a46`

---

## PageUp HTML structure

PageUp generates its own HTML and we can't change it — our CSS targets this fixed structure.

### Listing page

Each job is a row in a table: column 0 contains `.job-link` (title + href), column 1 is location, column 2 is brand. `fetchAllJobIds()` in the scraper reads all three.

### Job post page

```
div#job > div#job-content
  h2                                ← Job title
  p                                 ← Combined buttons + metadata (all in one <p>)
    span                            ← Button wrapper (no class)
      a.employee-referral-link.button
      a.apply-link.button
    b + span (Job no, Work type, Location, Categories)
    b "Brand:" (bare text node)
  div#job-details                   ← Description body
  p                                 ← Dates
  p                                 ← Bottom action buttons
  div.social-share-kit              ← Social sharing
```

A notable quirk: the top-row buttons and metadata share a single `<p>`; buttons are in a `<span>` that PageUp floats right. Our CSS overrides this:

```css
#job #job-content > h2 + p > span:first-child {
  float: none !important;
  display: flex;
  width: 100%;
}
```

---

## Country → region mapping

Defined in `region-map.json`.

| Region | Countries |
|---|---|
| Asia | India, Japan, Vietnam, Thailand, Indonesia, Malaysia, Singapore, China, Cambodia, Hong Kong, Philippines |
| Australia | Australia |
| Canada | Canada |
| Multiple Locations | Multiple Locations |
| New Zealand | New Zealand |
| South Africa | South Africa |
| UAE | UAE |
| UK & Europe | United Kingdom, Spain, Germany, France, Netherlands, Sweden, Norway, Finland, Denmark, Ireland, Switzerland |
| USA | United States, Mexico |

---

## The sync pipeline

### Fast-sync diff (the speed win)

A typical sync run completes in **under a minute** when nothing has changed, down from ~10 minutes previously. The mechanism:

1. **Listing-level scrape.** `fetchAllJobIds()` extracts title, location, and brand for every job in one page load — one Playwright navigation total.
2. **Listing-level diff.** For each existing CMS item, `listingFieldsChanged()` compares the scraped title + location against the CMS values. If both match, the job is flagged as unchanged and skipped.
3. **Detail-page scraping only for jobs that actually need it** — new jobs, plus jobs whose title or location differs at the listing level.

**Known trade-off:** if PageUp edits only a description or closing date on an existing job (without changing title or location), our fast-sync won't detect the change until the title or location also changes. This is an acceptable compromise for the speed improvement. If field-accuracy becomes more important than speed, add a periodic full rescrape (e.g. randomly sample 5% of unchanged jobs per run).

### Brand resolution — 3 tiers

`resolveBrand()` in `src/sync.js`:

1. **PageUp brand field** — exact or partial name match against Webflow Brands collection
2. **Hashtag match** — scrapes `#TAG` patterns from the job post, matches them against `brand-tag` field on Brand CMS entries. Brand tags are comma-separated (e.g. `#CTAU,#CTCA,#CTNZ`)
3. **Default** — `Flight Centre Travel Group` (the holding entity; individual FCTG brands like "Flight Centre" remain separate Brand CMS entries)

Adding or retagging a brand is a CMS-only change — no code edits needed.

### Description cleanup

`cleanDescription()` in `src/sync.js` normalises PageUp's inconsistent HTML:

- Strips PageUp-hosted images (Webflow rejects their `image/x-png` MIME type)
- Removes white-text hashtag lines (LinkedIn tracking tags)
- Strips inline `font-size` / `font-family` so Webflow typography wins
- Removes empty `<p>&nbsp;</p>` spacers
- Consolidates fragmented `<ul>` lists (each bullet arrives wrapped in `<div><ul><li>`)
- Strips all `<div>` tags (Webflow RichText doesn't support them; leftovers break the CMS template grid)
- Collapses multiple consecutive `<br>` tags

### Safety guards

In `runSync()`:

- **Zero-jobs abort:** if PageUp returns 0 jobs, abort before any CMS operations (prevents catastrophic deletion if the scraper or WAF challenge fails)
- **50% deletion guard:** if more than half the CMS items would be deleted, abort
- **Low-count warning:** if fewer than 50 jobs come back, warn but continue

In `src/webflow.js`:

- **Rate limit:** 1.1s between API requests (stays under 60/min)
- **Transient retry:** 502/503/504 errors retry up to 3 times with exponential backoff (5s → 10s → 20s)
- **429 retry:** honors `Retry-After` header
- **publishSite():** throws on failure — prevents JSON regeneration on top of a failed publish (which would otherwise leak unpublished slugs into `all-jobs.json`)

### Publish behaviour — custom domain AND webflow subdomain

`publishSite()` publishes to both the custom domain (production) and the `fctg-careers.webflow.io` subdomain:

```js
await this.request('POST', `/sites/${this.siteId}/publish`, {
  customDomains: domainIds,
  publishToWebflowSubdomain: true,
});
```

Previously only custom domains were published, so staging drifted out of sync and returned 404s for newly-added jobs.

### JSON generation — live items only

`generateAllJobsJson()` and `generateFilterCounts()` call `client.getLiveCollectionItems()`, which hits `/collections/{id}/items/live`. This returns only items that are actually published on the site, so unpublished/staged-only slugs never leak into `all-jobs.json`.

---

## GitHub Actions workflow

`.github/workflows/sync-jobs.yml`:

- **Schedule:** `*/20 * * * *` (every 20 min)
- **Manual trigger:** `workflow_dispatch` (used by the dashboard "Run Sync Now" button)
- **Runtime:** Node 22, Ubuntu
- **Timeout:** 30 min

### Step flow

1. Checkout main
2. Setup Node + install deps
3. Install Playwright Chromium
4. Run `npm run sync` (the whole pipeline described above)
5. **Publish artifacts to data branch** — uses `git worktree add /tmp/data-branch origin/data`, copies generated JSONs in, then:
   - If the last commit on `data` was by `github-actions[bot]`: `git commit --amend --no-edit` + `git push --force-with-lease` (single moving commit)
   - Else: normal commit + push
6. Purge jsDelivr CDN cache for `@data/all-jobs.json`, `@data/filter-counts.json`, `@data/sync-log.json`

### Required secrets

| Secret | Purpose |
|---|---|
| `WEBFLOW_API_TOKEN` | Webflow v2 API token |
| `WEBFLOW_SITE_ID` | `691f361688f213d69817ead2` |
| `WEBFLOW_COLLECTION_ID` | Current Jobs collection ID |
| `WEBFLOW_BRAND_COLLECTION_ID` | Brands collection ID |
| `WEBFLOW_COUNTRY_COLLECTION_ID` | Countries collection ID |

---

## `jobs-filter.js` — the frontend engine

Loaded via the inline snippet in the `/jobs` page's "Before `</body>`" custom code block (same snippet on `/jobs/{slug}` for the back-button wiring).

### On `/jobs`

1. Waits for `.career_list` to exist in the DOM
2. Clones the first CMS-rendered card as a template
3. Removes all CMS cards from the list
4. Fetches `all-jobs.json` (20-min cache-busted)
5. Builds filter counts (regions, cities, brands, categories) from the data
6. Renders cards — if a card has no existing `<a>`, injects an invisible overlay anchor so the whole card is clickable (the Designer template doesn't currently wrap cards in link blocks)
7. Binds search / filter / sort / pagination
8. Restores sessionStorage-saved filter state on return from a detail page

### On `/jobs/{slug}`

1. `setupBackButton()` finds the element with `id="all-jobs-button"` and wires:
   - `href="/jobs#filters"`
   - onclick handler that sets `sessionStorage.fctg_back = '1'` before navigating
2. Main init returns early (no `.career_list` here)

### Compact JSON format (`all-jobs.json`)

Each job uses single-letter keys to minimise file size:

```json
{
  "t": "Job Title",
  "s": "job-slug",
  "ci": "City Name",
  "co": "Country Name",
  "r": "Region",
  "b": "Brand Name",
  "l": "https://brand-logo-url.png",
  "ca": "Category",
  "wt": "Full time",
  "su": "Brief summary...",
  "ju": "https://careers.fctgcareers.com/cw/en/job/12345"
}
```

### Card click behaviour

Current Webflow CMS cards on `/jobs` aren't wrapped in a Link Block. `jobs-filter.js` detects this and injects a full-card overlay anchor per card (`position:absolute; inset:0; z-index:1`) so clicks navigate to `/jobs/{slug}`.

If a Link Block is added around the card in Designer in the future, the script auto-detects it and wires the existing anchor's `href` instead of injecting a new one — no code change required.

---

## Monitoring dashboard

### Webflow-hosted (production)

- **Page:** `/internal/jobs-dashboard` (password protected)
- **Implementation:** single code embed fetching data from jsDelivr
- **URLs the embed reads:** `@data/sync-log.json` and `@data/all-jobs.json`
- **"Run Sync Now" button** → POST to the Cloudflare Worker → workflow_dispatch on GitHub Actions
- **Cache-bust window:** 20 min, matching the sync cadence

### Local (development)

```bash
cd <repo>
cp .env.example .env  # add WEBFLOW_API_TOKEN
npm run dashboard
# http://localhost:3456
```

Shows local sync-log plus CI sync-log (fetched from `@data/sync-log.json`), with a "Run Sync Now" that triggers a local sync.

### Cloudflare Worker — sync trigger

- **Worker:** `fctg-sync-trigger`
- **URL:** `https://fctg-sync-trigger.wandering-sun-9809.workers.dev`
- **Auth:** shared key via `?key=` query parameter (validated against `SYNC_KEY` secret)
- **Action:** proxies POST to GitHub Actions `workflow_dispatch`
- **Secrets (Cloudflare-managed, not in code):**
  - `GITHUB_TOKEN` — fine-grained PAT with Actions write scope for `The-Uncoders/pageup-webflow-sync`
  - `SYNC_KEY` — shared gate for dashboard auth
- **Cloudflare account:** `Hello@uncoders.co` (ID `4a6fba0403941f5658f7287a2496ac8c`)

---

## Deployment workflows

### Making frontend JS changes (`jobs-filter.js`)

1. Edit on `main`, `git push`
2. Purge: `curl https://purge.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/jobs-filter.js`
3. Hard-refresh browser — changes take effect immediately for anyone whose cache-bust window rolls over (max 20 min otherwise)
4. Bump the `b=N` static marker in the loader if you need every visitor to fetch fresh before the 20-min epoch tick

### Making CSS changes (`pageup.css`)

1. Edit `pageup.css` in `The-Uncoders/fc-careers`, push
2. Purge: `curl https://purge.jsdelivr.net/gh/The-Uncoders/fc-careers/pageup.css`
3. Publish Webflow (staging → verify → production)
4. Visit `/refresh` on PageUp template to force its cache refresh
5. Hard-refresh browser (Cmd+Shift+R)

### Making sync changes (`src/sync.js`, `src/scraper.js`, `src/webflow.js`)

1. Edit on `main`, `git push`
2. Next scheduled run (within 20 min) picks up the change. Or trigger manually from the dashboard.

### Making Designer changes

1. Edit in Webflow Designer
2. Publish staging → verify → publish production

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Clicking a job card does nothing | `jobs-filter.js` cached old version without overlay-anchor fix | Hard-refresh. If persistent, bump `b=N` in the loader |
| Job card clicks navigate but destination page is blank | Webflow Designer page-load GSAP interaction broken | Check the Designer's page-load interaction on the CMS template |
| 404 on a job URL | CMS item exists but wasn't published — `publishSite` may have failed | Check Actions log for publish errors; trigger manual sync |
| Stale JSON in `/jobs` | jsDelivr edge cache hasn't expired | `curl https://purge.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/all-jobs.json` |
| Hero banner shows broken image icon | PageUp asset returning 403 or dead | Banner embed's `onerror` should swap to default banner — check the Designer embed is up to date |
| "All jobs" back button does nothing | Loader snippet missing from `/jobs/{slug}` template, or button missing `id="all-jobs-button"` | Verify both |
| Sync run takes >5 min | Either many new jobs or a genuine sync failure | Check the dashboard sync history; inspect Actions log |
| Jobs count drops suddenly | WAF challenge failed; 0-job guard may trigger | Manual trigger from dashboard once PageUp responds normally |

---

## Key change history

### Fresh foundation (April 17, 2026)

Today's consolidation. Everything below describes the current state; previous architecture is archived in git history.

- **Bug fix:** "click does nothing" on `/jobs` cards — `jobs-filter.js` now injects a full-card overlay anchor when the Webflow CMS card has no `<a>` wrapper
- **Bug fix:** "page not found" on staging — `publishSite()` now publishes both custom domain and Webflow subdomain, AND throws on failure. `generateAllJobsJson()` now uses `/items/live` so unpublished slugs can't leak into the JSON
- **Fast sync:** listing-level diff skips detail-page scraping for unchanged jobs. Typical no-op runs finish in ~1 min
- **Cron → 20 min** (from 30 min)
- **Branch split:** JSON artifacts (`all-jobs.json`, `filter-counts.json`, `sync-log.json`) moved from `main` to an orphan `data` branch. CI amends a single commit on `data` each run, so history stays at one commit
- **Loader reorganisation:** Scripts API registrations (`jobsfiltercdn-1.0.0.js`, legacy `jobsfilterv394-3.9.4.js`) deleted. Replaced with page-scoped custom code on `/jobs` and `/jobs/{slug}`. Eliminates site-wide double-loading race condition
- **Dead code removed:** `generate-all-jobs.js`, `generate-filter-counts.js`, `regenerate-json.js`, `brand-counts.json`, `total-jobs.json`, `sample-detail.html`, `getCollectionItems()` alias
- **Banner image resilience:** Designer embed now uses `onerror` to swap to the default banner URL when PageUp returns 403 (Webflow's "is set" conditional can't check URL reachability)
- **Back button selector:** now uses `id="all-jobs-button"` instead of class/text heuristics — stable against Designer restyles

### Earlier milestones

- **Brand hashtag resolution** (April 1, 2026): 3-tier `resolveBrand()` — PageUp brand field → LinkedIn hashtag → `Flight Centre Travel Group` default. Data-driven; adding new brands is CMS-only
- **Description HTML cleanup** (April 1, 2026): `cleanDescription()` normalises PageUp's inconsistent HTML so Webflow RichText renders correctly
- **Banner image link** (April 1, 2026): Workaround for Webflow rejecting PageUp's `image/x-png` MIME type — store URL in a Link field, render via code embed
- **Sync propagation delay** (April 4, 2026): Publish site → wait 10s → regenerate JSON. Prevents "page not found" for newly-added jobs
- **Change detection refinement** (April 4, 2026): Excluded `description` and `banner-image-link` from `hasChanged()` to prevent Webflow's HTML/link normalisation from triggering false updates
- **CSS class migration** (March 4, 2026): `.pup-button` → `.button`, `.job-action-btn` → `.back-link`/`.apply-link`/`.employee-referral-link`, `.success-message` → `.success`
- **CSS separation** (March 4, 2026): Split monolithic `pageup.css` into Webflow-native classes + custom-code-only selectors (IDs, positional, pseudo-elements)
- **Retry logic** (March 24, 2026): Exponential backoff on 502/503/504, DNS/connection retry

---

## Tools & credentials

### GitHub CLI

- Binary: `/Users/hamza/Desktop/Claude Central/tools/gh_2.89.0_macOS_arm64/bin/gh`
- Account: `The-Uncoders`
- Scopes needed: `gist`, `read:org`, `repo`, `workflow`
- Run `gh auth setup-git` once to hook into macOS keychain as a credential helper

### Secret storage

| Secret | Location | Used by |
|---|---|---|
| Webflow API token | GitHub Actions Secrets + local `.env` | Sync pipeline (CI + local) |
| GitHub PAT (fine-grained) | Cloudflare Worker Secrets | Sync trigger proxy |
| Sync trigger key | Cloudflare Worker Secrets + dashboard embed | Dashboard auth |

No secrets are in source code. Local dev uses `.env` (gitignored). CI uses GitHub Secrets. The Worker uses encrypted Cloudflare env vars.

---

*Last rewritten: April 17, 2026 — consolidated documentation after the architectural cleanup. Previous revisions are in git history.*
