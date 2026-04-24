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
              ┌──────────────────────────────────────────────────┐
              │  GitHub Actions — runs every 20 min on main     │
              │                                                  │
              │  0. Seed local sync-log.json from data branch    │
              │  1. Scrape listing page (title + location +      │
              │     brand for every job)                         │
              │  2. Fetch all CMS items                          │
              │  3. Diff:                                         │
              │     - New  → scrape detail, create                │
              │     - Listing-level change → scrape detail,      │
              │       update (slug NOT re-written — immutable)   │
              │     - Unchanged → SKIP detail scrape             │
              │     - Removed → delete CMS item                   │
              │  4. Publish site to custom domain + webflow.io   │
              │  5. Wait 30s for /items/live to propagate        │
              │  6. Regenerate all-jobs.json + filter-counts     │
              │     from /items/live (published only),           │
              │     dedup by job-id, drop items without job-id,  │
              │     reconcile city/country for orphan regions    │
              │  7. Record liveJobsAfter + source in sync-log    │
              │  8. Amend single commit on `data` branch         │
              │  9. Purge jsDelivr CDN for @data URLs            │
              └───────────────┬───────────────────┬──────────────┘
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

### Slug immutability on updates

`buildCmsFieldData()` generates a slug from the title on every call, but the update flow in `runSync()` explicitly deletes `newFieldData.slug` before sending a PATCH. Rationale: if PageUp renames a job into a title whose slugified form collides with another CMS item (e.g. two jobs ending up as `sales-travel-consultant-cairns-qld`), Webflow rejects the whole PATCH with a slug-collision error. The symptom is an infinite update loop — every sync detects the name change, tries to patch, Webflow rejects, next sync tries again forever.

Keeping slugs immutable once created also gives us stable URLs for bookmarks and SEO. Webflow auto-disambiguates on create (appending `-2`, `-3`, etc.) if a brand new item would collide.

### City/country reconciliation in JSON generation

PageUp occasionally surfaces a job with a location string that has no comma (e.g. just `"New Zealand"` or `"Missouri"`). The scraper's comma-split parse stores the whole string as `city` and leaves `country` empty. On the dashboard this used to show up as orphan checkboxes at the top of the Locations filter because the JSON had `ci="New Zealand"`, `co=""`, `r="Multiple Locations"`.

`reconcileCityAndCountry()` in `src/sync.js` is a safety net applied during `generateAllJobsJson` and `generateFilterCounts`. If the CMS country is empty but the city value is a known country name OR a mapped state in `location-to-country.json`, it:
- Recovers the country (e.g. `"Missouri"` → `"United States"`)
- Clears the city field (because the raw value wasn't really a city)

This fixes existing orphaned CMS items at JSON-generation time without needing to re-scrape.

### Brand resolution — 3 tiers

`resolveBrand()` in `src/sync.js`, in priority order:

1. **PageUp brand field → strict match** — lowercase exact-match against Webflow Brands CMS, OR an explicit entry in `BRAND_ALIASES` (a hard-coded map in `src/sync.js`). Partial/fuzzy matching is deliberately OFF for brands to avoid strings like "Flight Centre Business Travel (FCBT)" being routed to the "Flight Centre" CMS entry just because the string contains "flight centre". Current aliases:
   - `"flight centre brand"` → `"flight centre"` (PageUp's naming convention vs CMS's)
2. **Hashtag match** — scrapes `#TAG` patterns from the job-post HTML and matches them against the `brand-tag` field on each Brand CMS entry. Brand tags are comma-separated (e.g. `#CTAU,#CTCA,#CTNZ`). This is the safety net for PageUp brand text that doesn't exact-match — e.g. if PageUp sends "Corporate Traveler (US)" (with suffix) but the CMS's "Corporate Traveler" entry has `#CTUS` in its brand-tag, tier 2 catches it.
3. **Default** — `Flight Centre Travel Group` (the holding entity; individual FCTG brands like "Flight Centre" remain separate CMS entries).

On a match, `brand-name` is always written as the **canonical CMS entry name**, never the raw PageUp text — so the `/jobs` brand filter always groups by a value that corresponds to a real CMS brand.

Adding a new brand or hashtag mapping is a Webflow CMS change (add entry, set `brand-tag`) — no code edits needed. Adding a new PageUp→CMS alias requires editing `BRAND_ALIASES` in `src/sync.js` plus a force-full rescrape to back-fill.

### Description cleanup and paragraph normalisation

`cleanDescription()` in `src/sync.js` does two jobs:

**1. Strip content Webflow can't handle:**
- PageUp-hosted images (Webflow rejects their `image/x-png` MIME type)
- White-text LinkedIn hashtag lines (`#LI-xxx`, brand tags)
- Inline `font-size` / `font-family` styles (so Webflow typography wins)
- `<div>` wrappers after paragraph conversion (Webflow RichText doesn't support them)

**2. Converge on consistent `<p>`-block structure:**
PageUp's WYSIWYG export is wildly inconsistent across recruiters. Some produce proper `<p>` structure; others produce inline spans with `&nbsp;` separators; others wrap every line in its own bare `<div>`. `cleanDescription()` detects the "pseudo paragraph break" patterns below, converts them to an internal marker, then uses `node-html-parser` to walk the HTML and wrap every orphan inline run into a proper `<p>` block. Already-structured blocks (`<p>`, `<ul>`, `<h1-6>`, `<blockquote>`, `<figure>`, `<table>`, `<pre>`, `<hr>`) pass through unchanged.

Patterns treated as paragraph breaks:
- `<p>&nbsp;</p>` and `<p><span>&nbsp;</span></p>` (spacer paragraphs)
- `<br>(&nbsp;)+<br>` (inline spacer)
- Line containing only `&nbsp;` between newlines (`\n&nbsp;\n` — common PageUp export)
- 2+ consecutive newlines
- 2+ consecutive `&nbsp;` entities
- 2+ consecutive `<br>` tags (at top level only; inside existing `<p>` they collapse to a single `<br>`)

`<div>` wrappers get special treatment: `<div>...<ul>...</ul>...</div>` consolidates to just the `<ul>`; `<div>...<p>...</p>...</div>` unwraps to the `<p>`; any remaining `<div>inline</div>` becomes `<p>inline</p>` (iterative, innermost first, so nested divs collapse predictably). This handles PageUp's "one line per bare div" export pattern that would otherwise flatten into one inline blob when divs were stripped.

The function is **idempotent** — running it twice on any input produces the same output. New jobs and rescrapes both converge on the same canonical HTML.

### Back-filling existing descriptions after cleanDescription changes

Fast-sync skips detail-scraping for unchanged jobs, so improvements to `cleanDescription()` don't automatically propagate to existing CMS items. When you change the cleanup logic in a way that needs to reach the existing catalog, use the one-shot `src/rescrape-descriptions.js`:

```bash
# Dry-run — logs what would change, no writes
node src/rescrape-descriptions.js

# Apply — writes a backup, PATCHes changed items, publishes
node src/rescrape-descriptions.js --apply

# Restore from a backup (idempotent — only PATCHes items that drifted from backup)
node src/rescrape-descriptions.js --restore backups/rescrape-backup-<timestamp>.json
```

The script:
1. Fetches all live CMS items
2. Writes a backup of current descriptions to `backups/rescrape-backup-<timestamp>.json` (gitignored)
3. Uses the existing scraper to pull fresh HTML from PageUp for each job
4. Runs the current `cleanDescription()` against the fresh HTML
5. PATCHes only items whose cleaned output differs from the current CMS
6. Publishes to both custom domains + Webflow subdomain

Why rescrape and not re-clean in place? Each run of `cleanDescription()` can strip information that later improvements need (e.g. `<div>` wrappers that signal paragraph boundaries). Once stripped, a pure re-clean can't recover it. Going back to PageUp's source HTML is always correct.

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

### JSON generation — live items only, defensively cleaned

`generateAllJobsJson()` and `generateFilterCounts()` call `client.getLiveCollectionItems()`, which hits `/collections/{id}/items/live`. This returns only items that are actually published on the site, so unpublished/staged-only slugs never leak into `all-jobs.json`.

The regeneration happens **30 seconds** after a publish (bumped from 10s after observing `/items/live` lag behind a publish by ~9 minutes in one case). `all-jobs.json` is additionally hardened against dirty CMS state:

- Items without a `job-id` field are skipped (shouldn't exist, but logged as a warning so operators can clean up)
- Items are deduplicated by `job-id` so two CMS rows sharing the same PageUp job ID only produce one entry

### `liveJobsAfter` — recorded per sync run

Each sync log entry records two counts:

- `pageupJobsFound` — what PageUp's listing returned at scrape time (can drift from run to run)
- `liveJobsAfter` — the final count in `all-jobs.json` after this run completed

The dashboard shows both in the history table ("PageUp" and "Live" columns) so the distinction is explicit — no more confusion when PageUp had a transient hiccup and its snapshot didn't match what ended up live on the site.

---

## Propagation beyond the listing diff — force-full + hashing

Fast-sync only looks at the listing page (title + location) to decide which jobs need re-scraping. That misses edits to categories, descriptions, banners, closing dates, or brand fields on PageUp — those only surface on the detail page. Two mechanisms cover that blind spot:

### Force-full mode

`SYNC_FORCE_FULL=true` makes `runSync()` bypass the listing diff and scrape every existing job. Triggered three ways:

| When | How | Propagation delay |
|---|---|---|
| Daily 02:00 UTC | Second `cron` in `sync-jobs.yml` | Worst case 24 hours |
| On demand | Dashboard "Force Full Rescrape" button → Cloudflare Worker → `workflow_dispatch` with `force_full=true` input | Immediate (run takes ~10–15 min) |
| Local | `SYNC_FORCE_FULL=true npm run sync` | Immediate |

The 20-minute fast-sync cron continues in parallel — listing-level changes (title/location, new jobs, removed jobs) still propagate within a minute.

### Content-hash gate

Every Webflow PATCH is gated on SHA-256 of the cleaned fieldData we'd write, stored as `sync-hashes.json` on the `data` branch. On each run:

1. Scrape PageUp, apply `cleanDescription()`, build the CMS fieldData
2. `hashFieldData()` — sorted-keys canonical JSON → SHA-256 hex
3. Compare to stored hash for this job-id
4. Identical → skip the PATCH (content truly unchanged)
5. Different → PATCH + record the new hash (only after Webflow confirms the update)

Why this exists in addition to `hasChanged()`: `hasChanged()` excludes `description` and `banner-image-link` to avoid Webflow's HTML/link normalisation causing false diffs. Hashing catches changes in ANY cleaned field without that problem — `cleanDescription` is deterministic, so the hash is stable when PageUp's content is stable.

Failed PATCHes do NOT update the stored hash — the next run re-attempts. Deleted jobs have their hashes dropped from the map.

**Rollback:** if hashing misbehaves, delete `sync-hashes.json` on the `data` branch and trigger a sync — every job looks "changed" at the hash layer and the map repopulates cleanly.

---

## Back-filling existing CMS items after sync-logic changes

Fast-sync + hashing skip most jobs, so improvements to `cleanDescription()` or `resolveBrand()` don't automatically reach existing CMS items. When a change needs to apply retroactively:

- **Programmatic (targeted):** `node src/rescrape-descriptions.js --apply`. Backs up → rescrapes → PATCHes only items that differ → publishes. See the script's header comment for `--dry-run`, `--limit`, `--restore` flags.
- **Interactive (preferred):** click **Force Full Rescrape** in the dashboard. Same effect, runs on CI, no local setup.

Both preserve the safety rails: backup before writes, `--restore` for rollback.

---

## GitHub Actions workflow

`.github/workflows/sync-jobs.yml`:

- **Schedules:** `*/20 * * * *` (fast-sync) + `0 2 * * *` (daily force-full)
- **Manual trigger:** `workflow_dispatch` with `force_full` boolean input
- **Runtime:** Node 22, Ubuntu
- **Timeout:** 30 min

### Step flow

1. Checkout main
2. Setup Node + install deps
3. Install Playwright Chromium
4. **Seed local data from data branch** — `curl` `data/sync-log.json` and `data/sync-hashes.json` from the `data` branch into the workspace. Lets the logger append to real history and the sync see the stored hash map
5. Run `npm run sync` with `SYNC_FORCE_FULL` derived from `github.event.schedule == '0 2 * * *'` OR `github.event.inputs.force_full == 'true'`
6. **Publish artifacts to data branch** — `git worktree add /tmp/data-branch origin/data`, copy `all-jobs.json`, `filter-counts.json`, `sync-log.json`, `sync-hashes.json` in, then:
   - Last commit by `github-actions[bot]`? `git commit --amend --no-edit` + `git push --force-with-lease` (single moving commit)
   - Else: normal commit + push
7. Purge jsDelivr CDN cache for `@data/all-jobs.json`, `@data/filter-counts.json`, `@data/sync-log.json`

### Scheduled-run caveat — GitHub Actions cron is best-effort

The cron is set to `*/20 * * * *` but GitHub Actions explicitly does not guarantee on-time delivery of scheduled workflows. During high-load periods the scheduler skips runs entirely. In practice this site sees 15–25 scheduled runs per day instead of the targeted ~72 — roughly one per hour. If guaranteed cadence becomes important, migrate the trigger source to Cloudflare Cron Triggers (using the existing Worker) or another scheduler. Manual triggers via the dashboard and API dispatch always run on-demand.

### Sync source detection

`src/sync-logger.js` reads `GITHUB_EVENT_NAME` and records a `source` field on every run:

| Trigger | `source` value |
|---|---|
| `schedule` (cron) | `"scheduled"` |
| `workflow_dispatch` (dashboard / API) | `"manual"` |
| `repository_dispatch` | `"manual"` |
| Other CI events | `"ci"` |
| No CI env (local) | `"local"` |

The dashboard's history table uses this to show a "Trigger" badge per run (Scheduled / Manual / Local).

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
- **Implementation:** single code embed (HTML + CSS + inline script) on that page's custom code
- **Data sources:**
  - Initial load & refresh button: `@data/sync-log.json` + `@data/all-jobs.json` via jsDelivr (fast-cached)
  - Background poller and post-sync refresh: **raw.githubusercontent.com** (bypasses CDN, always fresh)
  - Run status polling: public GitHub Actions API (`/repos/{...}/actions/runs?event=workflow_dispatch`) — no auth needed since the repo is public

**UI features:**
- Status cards: Health / Total Jobs / Last Sync / Next Sync — updated live as new sync log entries land
- **Run tracker panel** (visible only while a manual sync is in flight) — shows real phase transitions (`Triggering` → `Queued` → `Running for 0:42 (typical ~1:15)` → `Sync complete` / `Sync failed`). Progress bar fills proportionally to the median of the last 15 successful runs; switches to an animated striped pattern if the run exceeds the median.
- **Background polling every 60 seconds** — detects new automatic (cron) syncs and refreshes the dashboard without user action. Pauses while a manual sync is being tracked to avoid conflicts.
- **Sync history table** — seven columns: Time, Status, Duration, **PageUp** (scrape-time count), **Live** (post-sync `liveJobsAfter`), Changes (+N / N upd / -N), Trigger (Scheduled / Manual / Local)
- Click an "active" row to expand created/updated/deleted job titles

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
- **Source:** `worker/sync-trigger.js` in the repo (tracked for auditability)
- **Auth:** shared key via `?key=` query parameter (validated against `SYNC_KEY` secret)
- **Action:** proxies POST to GitHub Actions `workflow_dispatch` on `sync-jobs.yml`
- **Query params accepted:**
  - `key` (required) — matches `SYNC_KEY`
  - `force_full` (optional) — when `true`, sets the `force_full` workflow input so the sync bypasses the listing-level fast-diff and rescrapes every job. Used by the dashboard's "Force Full Rescrape" button.
- **Secrets (Cloudflare-managed, not in code):**
  - `GITHUB_TOKEN` — fine-grained PAT with Actions write scope for `The-Uncoders/pageup-webflow-sync`
  - `SYNC_KEY` — shared gate for dashboard auth
- **Cloudflare account:** `Hello@uncoders.co` (ID `4a6fba0403941f5658f7287a2496ac8c`)
- **Deploy:** no CI — edit `worker/sync-trigger.js` in the repo, paste into Cloudflare dashboard → Workers & Pages → `fctg-sync-trigger` → Edit Code → Save and Deploy. See `worker/README.md` for the smoke-test curls.

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
| Dashboard "PageUp" and "Live" columns differ | Normal — PageUp had a transient hiccup at scrape time, or a publish is still propagating | Resolves on the next sync. If persistent, inspect the CMS for an orphan item with no matching PageUp job-id |
| Same job shows as "updated" every sync | Slug collision — two CMS items produce the same slug after `slugify()` | Already handled (updates don't send slug). If still recurring, dig into the duplicate CMS entry manually |
| A location appears ungrouped at the top of the Locations filter | CMS item's `city` field is a country/state name; country ref is empty | Reconciliation runs at JSON generation time — should self-heal on the next sync. If not, add the value to `location-to-country.json` |
| Sync history has gaps / fewer runs than expected | GitHub Actions scheduled cron is best-effort — skips runs under load | Expected behaviour. To get guaranteed cadence, migrate trigger to Cloudflare Cron |
| Sync log shows "Scheduled" for a manual run | Run happened before commit `dc55f97` (source-tracking) landed in main | One-time artifact. Newer runs record source correctly |

---

## Key change history

### Dashboard & robustness pass (April 19–20, 2026)

- **Slug immutability on updates:** PATCHes no longer send the `slug` field, eliminating an infinite update-loop bug triggered by title changes whose slugified form collides with another CMS item (real case: job 528880 renamed into the slug already owned by 530625).
- **City/country reconciliation:** new `reconcileCityAndCountry()` safety net in `generateAllJobsJson` / `generateFilterCounts`. Fixes jobs whose PageUp location was a bare country/state name (e.g. `"New Zealand"`, `"Missouri"`) and ended up orphaned in the Locations filter. `missouri` added to `location-to-country.json`.
- **Sync-log fix:** `data/sync-log.json` was still tracked on main from the pre-split era, so every CI run was appending to a stale April-17 base instead of the real history. File untracked from main; workflow now pulls the live `sync-log.json` from the `data` branch via `raw.githubusercontent.com` **before** running the sync so the logger appends cleanly.
- **Source field:** `SyncLogger` records a `source` from `GITHUB_EVENT_NAME` — `scheduled`, `manual`, `ci`, or `local`. Dashboard shows distinct badges per trigger type.
- **Defensive JSON gen:** `generateAllJobsJson` skips items missing a `job-id` and dedupes by `job-id`, with warnings when either case is hit — prevents a single dirty CMS row from inflating the public count.
- **Propagation wait 10s → 30s:** `/items/live` can lag behind a publish; 30s covers the vast majority of cases.
- **`liveJobsAfter`** field added to each sync log entry — the post-sync live count, independent of PageUp's scrape-time snapshot. Dashboard shows it as a "Live" column alongside "PageUp" for per-row clarity.
- **Dashboard rewrite:** Run Sync Now now polls the public GitHub Actions API for real run status (`queued` → `in_progress` → `completed`). Background poller (60s) auto-refreshes the dashboard when any sync — automatic or manual — lands. Progress bar calibrated to the median duration of the last 15 successful runs. All GitHub-facing copy removed from the UI.

### Propagation + filter-URL pass (April 23–24, 2026)

- **Filter-URL sync:** `jobs-filter.js` reads filters from URL query params on load and writes them back via `history.replaceState()` on every change. Enables shareable filtered links (e.g. `/jobs?region=south%20africa&category=digital%20and%20technology`). URL params: `q`, `region`, `city`, `brand`, `category`, `type`, `sort`. URL takes precedence over sessionStorage on cold load.
- **Bullet-point normalisation:** `cleanDescription()` wraps bare `<li>` (outside any `<ul>`/`<ol>`) in its own `<ul>` using a negative-lookbehind regex; the adjacent-list merge then consolidates fragments into one cohesive `<ul>`. Also fixed a regex bug where the merge was producing nested `<ul>`s instead of merged flat lists.
- **Force-full mode:** `SYNC_FORCE_FULL=true` bypasses the listing-level diff. Triggered by a new daily 02:00 UTC cron and by the dashboard's new "Force Full Rescrape" button (via the existing Cloudflare Worker, which now forwards a `force_full` query param as a `workflow_dispatch` input).
- **Content-hash gate:** SHA-256 of cleaned fieldData per job, stored as `sync-hashes.json` on the `data` branch. Skips Webflow PATCH when the hash matches the stored one — zero API writes for unchanged content. Catches changes to fields `hasChanged()` excludes (description, banner-image-link).
- **Canonical brand names:** `resolveBrand()` now writes the Webflow Brands CMS entry name to `brand-name` instead of the raw PageUp text. Fixes the spurious filter buckets created by PageUp's inconsistent naming. Largely resolves the "brands out of alphabetical order" filter UI issue too.
- **Strict brand matching + aliases:** Removed the partial/fuzzy matching from brand resolution (kept for country). Exact match or explicit `BRAND_ALIASES` entry only — anything else falls through to hashtag tier 2, then to FCTG default. Prevents PageUp strings like "Flight Centre Business Travel (FCBT)" fuzzy-matching to unrelated CMS entries. Adding a new alias is a one-line code change + force-full rescrape.
- **Cloudflare Worker in repo:** `worker/sync-trigger.js` is now tracked so future changes are diffable. Deploy flow documented in `worker/README.md`.

### Fresh foundation (April 17, 2026)

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
- **Paragraph normalisation for PageUp descriptions** (April 20-22, 2026): `cleanDescription()` converges inconsistent PageUp HTML exports onto a uniform `<p>`-block structure — handles inline spans separated by `&nbsp;`, `\n&nbsp;\n` blank-line separators, `<br><br>` at the top level, and (April 22) bare `<div>` per line (the BSP Creditor benefits-list pattern). Idempotent. Back-fill of existing CMS items via `src/rescrape-descriptions.js`.
- **Description HTML cleanup** (April 1, 2026): First pass of `cleanDescription()` — strips PageUp images, LinkedIn tracking hashtags, inline fonts, and `<div>` tags
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

*Last updated: April 24, 2026 — added force-full mode (daily cron + dashboard button), content-hash gate for sync, shareable filtered URLs, bullet-point list normalisation, and Cloudflare Worker tracked in repo. Previous revisions are in git history.*
