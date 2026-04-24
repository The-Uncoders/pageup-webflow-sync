try { require('dotenv').config(); } catch (_) { /* dotenv optional in CI */ }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse: parseHtml } = require('node-html-parser');
const { initBrowser, closeBrowser, fetchAllJobIds, scrapeAllJobs } = require('./scraper');
const { WebflowClient } = require('./webflow');
const { SyncLogger } = require('./sync-logger');
const regionMap = require('../region-map.json');
const locationToCountry = require('../location-to-country.json');

// ── Force-full mode ──
// When SYNC_FORCE_FULL=true, the sync bypasses the listing-level fast-diff
// and re-scrapes every existing job's detail page. Used by the daily 02:00
// UTC cron + the dashboard's "Force Full Rescrape" button to catch PageUp
// edits that don't show up on the listing (category, description, banner,
// closing date, brand). Safe default: false.
const FORCE_FULL = process.env.SYNC_FORCE_FULL === 'true';

// ── Content hash map ──
// Per-job SHA-256 fingerprint of the cleaned CMS fieldData we'd write.
// On each run, after scraping + cleaning, we recompute the hash. If the
// hash matches what we stored last time, the content is genuinely
// unchanged and we skip the Webflow PATCH. Stored in data/sync-hashes.json
// on the `data` branch (same pattern as sync-log.json).
const HASHES_FILE = path.join(__dirname, '..', 'data', 'sync-hashes.json');

function hashFieldData(fieldData) {
  // Canonicalise: sort keys so {a:1,b:2} and {b:2,a:1} hash identically.
  const sortedKeys = Object.keys(fieldData).sort();
  const canonical = JSON.stringify(sortedKeys.reduce((acc, k) => {
    acc[k] = fieldData[k];
    return acc;
  }, {}));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function loadHashes() {
  try {
    if (!fs.existsSync(HASHES_FILE)) return {};
    const raw = fs.readFileSync(HASHES_FILE, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    console.warn(`[sync] Could not load hash map (${err.message}) — treating every job as changed.`);
    return {};
  }
}

function saveHashes(hashes) {
  try {
    const dir = path.dirname(HASHES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = HASHES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hashes, null, 2));
    fs.renameSync(tmp, HASHES_FILE);
  } catch (err) {
    console.warn(`[sync] Could not write hash map: ${err.message}`);
  }
}

/**
 * Safety net for JSON generation: PageUp occasionally surfaces a location
 * with no comma like "New Zealand" or "Missouri". The scraper's comma-split
 * parse then treats the whole string as the city and leaves the country
 * empty — so region falls back to "Multiple Locations" and the value
 * "New Zealand" shows up as a city in the Locations filter.
 *
 * Here we try to recover the country from the city value. If the city is
 * itself a known country name OR a known state/region mapping, we return
 * the resolved country and clear the city (it isn't really a city).
 *
 * Returns { city, countryName } — both strings, either may be empty.
 */
function reconcileCityAndCountry(rawCity, rawCountryName, knownCountryNames) {
  const city = (rawCity || '').trim();
  let countryName = (rawCountryName || '').trim();
  if (countryName || !city) return { city, countryName };

  const cityLower = city.toLowerCase();
  if (knownCountryNames.has(cityLower)) {
    // City is actually a country name (e.g. "New Zealand")
    // Use the canonical casing from the known set by scanning.
    for (const name of knownCountryNames) {
      if (name === cityLower) { countryName = city; break; }
    }
    return { city: '', countryName: city };
  }
  const mapped = locationToCountry[cityLower];
  if (mapped) {
    return { city: '', countryName: mapped };
  }
  return { city, countryName };
}

// Configuration
const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69a6a25d0ee880903952732b';
const BRAND_COLLECTION_ID = process.env.WEBFLOW_BRAND_COLLECTION_ID || '691f361688f213d69817eb0a';
const COUNTRY_COLLECTION_ID = process.env.WEBFLOW_COUNTRY_COLLECTION_ID || '691f361688f213d69817eb56';
const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '691f361688f213d69817ead2';

async function buildReferenceMaps(client) {
  console.log('[sync] Building brand and country reference maps...');

  const brandItems = await client.getAllCollectionItems(BRAND_COLLECTION_ID);
  const brandMap = {};        // lowercased brand name → Webflow item ID
  const brandIdToName = {};   // Webflow item ID → canonical CMS brand name
  const hashtagToBrand = {};  // hashtag (uppercase, e.g. "#FCM") → { id, name }
  for (const item of brandItems) {
    const name = item.fieldData?.name?.trim();
    if (name) {
      brandMap[name.toLowerCase()] = item.id;
      brandIdToName[item.id] = name;
    }

    // Build hashtag → brand mapping from the brand-tag field
    const brandTag = item.fieldData?.['brand-tag']?.trim();
    if (brandTag && name) {
      const tags = brandTag.split(',').map(t => t.trim().toUpperCase());
      for (const tag of tags) {
        if (tag) hashtagToBrand[tag] = { id: item.id, name };
      }
    }
  }

  const countryItems = await client.getAllCollectionItems(COUNTRY_COLLECTION_ID);
  const countryMap = {};
  for (const item of countryItems) {
    const name = item.fieldData?.name?.toLowerCase()?.trim();
    if (name) countryMap[name] = item.id;
  }

  console.log(`[sync] Loaded ${Object.keys(brandMap).length} brands, ${Object.keys(countryMap).length} countries, ${Object.keys(hashtagToBrand).length} brand hashtags.`);
  return { brandMap, brandIdToName, countryMap, hashtagToBrand };
}

function resolveReference(name, map) {
  if (!name) return null;
  const normalized = name.toLowerCase().trim();
  if (map[normalized]) return map[normalized];

  // Try partial matching for common variations
  for (const [key, id] of Object.entries(map)) {
    if (key.includes(normalized) || normalized.includes(key)) return id;
  }
  return null;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 256);
}

// Default brand name used when no recognized brand or hashtag is found
const FCTG_DEFAULT_BRAND = 'Flight Centre Travel Group';

/**
 * Resolve brand using 3-tier logic:
 *   1. PageUp brand field → match against Webflow Brands CMS by name
 *   2. Hashtags in job post → match against Webflow Brands CMS brand-tag field
 *   3. Default to Flight Centre Travel Group
 *
 * Returns { id: Webflow item ID, name: brand display name }
 */
function resolveBrand(jobDetail, brandMap, brandIdToName, hashtagToBrand) {
  // Tier 1: Try the PageUp brand field (exact/partial name match against
  // Webflow Brands CMS). We always return the CANONICAL CMS brand name,
  // never the raw PageUp text — otherwise PageUp's inconsistent naming
  // (e.g. "Flight Centre Brand" vs CMS "Flight Centre") creates spurious
  // filter buckets on the site.
  if (jobDetail.brandName) {
    const brandRef = resolveReference(jobDetail.brandName, brandMap);
    if (brandRef) {
      const canonical = brandIdToName[brandRef] || jobDetail.brandName;
      return { id: brandRef, name: canonical };
    }
  }

  // Tier 2: Try hashtags from the job post against brand-tag mappings.
  // hashtagToBrand.name is already the canonical CMS name (populated from
  // item.fieldData.name when the map was built), so nothing to convert.
  const hashtags = jobDetail.hashtags || [];
  if (hashtags.length > 0) {
    for (const tag of hashtags) {
      const match = hashtagToBrand[tag];
      if (match) {
        console.log(`[sync] Brand resolved via hashtag ${tag} → "${match.name}" for job ${jobDetail.jobId}`);
        return { id: match.id, name: match.name };
      }
    }
  }

  // Tier 3: Default to Flight Centre Travel Group (also canonical — it's
  // a CMS entry name).
  const fctgRef = resolveReference(FCTG_DEFAULT_BRAND, brandMap);
  const fctgName = (fctgRef && brandIdToName[fctgRef]) || FCTG_DEFAULT_BRAND;
  return { id: fctgRef, name: fctgName };
}

// Unique marker used internally during cleaning to mark paragraph boundaries
// that originated as "pseudo breaks" (e.g. <p>&nbsp;</p>, <br><br>, nbsp×2).
// Chosen so it never collides with anything a recruiter would paste.
const PARAGRAPH_BREAK = '⟪FCTG_BREAK⟫';

// Block-level tags preserved as-is during orphan wrapping. Anything else at
// the top level (text nodes, spans, strong, em, a, br) gets grouped into a
// <p> block — with PARAGRAPH_BREAK markers splitting each group into
// separate paragraphs.
const BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'figure', 'table', 'pre', 'hr'
]);

/**
 * Wrap top-level inline content into <p> blocks, respecting PARAGRAPH_BREAK
 * markers as paragraph boundaries. Block-level elements already present at
 * the top level are preserved verbatim.
 *
 * The goal: whatever PageUp exports — proper <p> structure, inline-only text
 * with <br>/&nbsp; separators, or a messy mix — converge on a consistent
 * <p>…</p><p>…</p> layout that Webflow's RichText renders with uniform
 * paragraph spacing.
 */
function wrapOrphanContent(html) {
  const root = parseHtml('<fctg-root>' + html + '</fctg-root>');
  const container = root.querySelector('fctg-root');
  if (!container) return html;

  const output = [];
  let buffer = '';

  // Split on either PARAGRAPH_BREAK markers or 2+ consecutive <br> tags
  // (double-br at top level = paragraph break, inside a <p> it's handled
  // separately in the residual cleanup pass).
  const SPLIT_REGEX = new RegExp(
    PARAGRAPH_BREAK + '|(?:<br\\s*\\/?\\s*>\\s*){2,}',
    'g'
  );

  const flushBuffer = () => {
    if (!buffer) return;
    const parts = buffer.split(SPLIT_REGEX);
    for (const part of parts) {
      const trimmed = part
        // Trim leading/trailing whitespace, nbsp entities, and bare <br>s
        .replace(/^(?:\s|&nbsp;|\u00A0|<br\s*\/?\s*>)+/gi, '')
        .replace(/(?:\s|&nbsp;|\u00A0|<br\s*\/?\s*>)+$/gi, '')
        .trim();
      if (trimmed) output.push(`<p>${trimmed}</p>`);
    }
    buffer = '';
  };

  for (const child of container.childNodes) {
    if (child.nodeType === 3) {
      // Text node
      buffer += child.rawText || '';
    } else if (child.nodeType === 1) {
      const tag = (child.tagName || '').toLowerCase();
      if (BLOCK_TAGS.has(tag)) {
        flushBuffer();
        output.push(child.toString());
      } else {
        // Inline element (span, strong, em, a, br, etc.) — accumulate
        buffer += child.toString();
      }
    }
  }
  flushBuffer();

  return output.join('');
}

/**
 * Clean up PageUp description HTML for consistent display in Webflow.
 *
 * PageUp's WYSIWYG export is wildly inconsistent — some recruiters end up
 * with proper <p> paragraph structure, others get inline spans separated
 * by `&nbsp; &nbsp;` or `<br><br>` "pseudo paragraphs". Our job is to
 * converge these into uniform <p>-wrapped blocks so Webflow RichText
 * renders every job with the same spacing.
 *
 * Pipeline:
 *   1. Remove content the CMS can't handle (PageUp images, LinkedIn white
 *      hashtag lines, <div> wrappers, inline font overrides).
 *   2. Drop empty <span> wrappers left behind after style stripping.
 *   3. Detect "pseudo paragraph break" patterns and replace them with a
 *      unique marker:
 *        - <p>&nbsp;</p> (spacer paragraph)
 *        - <p><span>&nbsp;</span></p> (spacer wrapped in span)
 *        - <br>&nbsp;<br> (inline spacer)
 *        - 2+ consecutive &nbsp; entities
 *        - 2+ consecutive <br> tags
 *   4. Walk the HTML with node-html-parser: preserve existing block
 *      elements (<p>, <ul>, <h1-6>, etc.) verbatim, and wrap any orphan
 *      text/inline runs into fresh <p> blocks, splitting at the markers.
 *   5. Clean up residual empty paragraphs.
 *
 * Idempotent: already-clean HTML (Ballarat-style with proper <p>/<ul>/<li>)
 * passes through unchanged.
 */
function cleanDescription(html) {
  let clean = html;

  // ── 1. Strip content that Webflow can't store or shouldn't render ──
  // PageUp-sourced images (serve image/x-png which Webflow rejects)
  clean = clean.replace(/<img[^>]*src="[^"]*pageuppeople\.com[^"]*"[^>]*\/?>/gi, '');
  clean = clean.replace(/<img[^>]*src="[^"]*publicstorage[^"]*"[^>]*\/?>/gi, '');

  // White-text LinkedIn hashtag lines (#LI-ME1, #MTEV, etc.) meant to be hidden
  clean = clean.replace(/<span[^>]*color:\s*#(?:FFF(?:FFF)?|fff(?:fff)?|FFFFFF|ffffff)\b[^>]*>[^<]*<\/span>/gi, '');

  // Inline font-size / font-family — let Webflow's typography apply
  clean = clean.replace(/\s*style="([^"]*)"/gi, (match, styleContent) => {
    let cleaned = styleContent
      .replace(/\s*font-size:\s*[^;]+;?/gi, '')
      .replace(/\s*font-family:\s*[^;"]+;?/gi, '')
      .replace(/^\s*;\s*/, '')
      .replace(/;\s*$/, '')
      .replace(/;\s*;/g, ';')
      .trim();
    return cleaned ? ` style="${cleaned}"` : '';
  });

  // ── 2. Drop empty span wrappers (repeat until stable for nested cases) ──
  let prev;
  do {
    prev = clean;
    clean = clean.replace(/<span>([^<]*)<\/span>/gi, '$1');
    clean = clean.replace(/<span>\s*<\/span>/gi, '');
    clean = clean.replace(/<span>\s*<(strong|em|b|i)>\s*<\/\1>\s*<\/span>/gi, '');
  } while (clean !== prev);

  // ── 3. Consolidate fragmented PageUp list structures ──
  //
  // Wrap bare <li>...</li> (not inside <ul>/<ol>, not a sibling of another
  // <li>) in its own <ul>. PageUp's WYSIWYG sometimes exports bullet lists
  // as an alternating pattern of bare <li> and <ul><li></li></ul> blocks —
  // browsers render bare <li>s without bullets or indent, visually breaking
  // the list. Wrapping each bare <li> then letting the adjacent-<ul> merge
  // below collapse everything into one clean <ul> is the fix.
  //
  // Iterate to handle back-to-back bare <li>s (after wrapping the first,
  // the second is no longer preceded by </li> so the next pass catches it).
  let liPrev;
  do {
    liPrev = clean;
    clean = clean.replace(
      /(?<!<ul[^>]*>\s*|<ol[^>]*>\s*|<\/li>\s*)<li(\s[^>]*|)>([\s\S]*?)<\/li>/gi,
      '<ul><li$1>$2</li></ul>'
    );
  } while (clean !== liPrev);

  clean = clean.replace(/<div[^>]*>\s*<ul/gi, '<ul');
  clean = clean.replace(/<\/ul>\s*<\/div>/gi, '</ul>');
  // Merge adjacent <ul>s by dropping the </ul><ul...> boundary entirely.
  // (Previously this was </ul>\s*<ul → <ul which caused NESTED lists
  // instead of a merged flat list.)
  clean = clean.replace(/<\/ul>\s*<ul[^>]*>/gi, '');
  clean = clean.replace(/<div[^>]*>\s*(<p[^>]*>)/gi, '$1');
  clean = clean.replace(/(<\/p>)\s*<\/div>/gi, '$1');

  // Convert any remaining <div>inline-content</div> to <p>inline-content</p>.
  // PageUp's WYSIWYG often wraps each line in its own bare <div> (e.g. the
  // emoji-bulleted benefits list we hit on the BSP Creditor job). Stripping
  // those divs without replacing them destroys the only paragraph signal
  // and flattens every line into one inline blob.
  //
  // We iterate to handle nested divs: each pass converts the innermost
  // divs whose content has no other div inside them. Converged within a
  // few passes for any real PageUp payload.
  let divPrev;
  do {
    divPrev = clean;
    clean = clean.replace(
      /<div[^>]*>((?:(?!<\/?div)[\s\S])*?)<\/div>/gi,
      '<p>$1</p>'
    );
  } while (clean !== divPrev);

  // Any stray <div> tags that couldn't be paired (malformed HTML) — strip
  clean = clean.replace(/<\/?div[^>]*>/gi, '');

  // ── 4. Convert "pseudo paragraph break" patterns to markers ──
  // Note: we deliberately DON'T replace <br><br>+ here. Those get handled
  // inside wrapOrphanContent so they only split when they appear at the
  // top level — inside existing <p> they're kept and later collapsed to
  // a single <br> (so "Line1<br><br>Line2" stays visually broken, just
  // with normal line-height instead of a bogus paragraph).

  // Empty <p>/span paragraphs used as visual spacers
  clean = clean.replace(/<p[^>]*>\s*(?:&nbsp;|\u00A0)?\s*<\/p>/gi, PARAGRAPH_BREAK);
  clean = clean.replace(/<p[^>]*>\s*<span[^>]*>\s*(?:&nbsp;|\u00A0)?\s*<\/span>\s*<\/p>/gi, PARAGRAPH_BREAK);
  // Inline spacer: <br>(&nbsp;)+<br>
  clean = clean.replace(/<br\s*\/?\s*>\s*(?:(?:&nbsp;|\u00A0)\s*)+<br\s*\/?\s*>/gi, PARAGRAPH_BREAK);
  // "Blank line" separator: newline, lone &nbsp;, newline (common PageUp
  // WYSIWYG export pattern — the benefits list in Cris's Senior AI example)
  clean = clean.replace(/\n[ \t]*(?:&nbsp;|\u00A0)[ \t]*\n/gi, PARAGRAPH_BREAK);
  // Double (or more) newlines — generic blank-line separator
  clean = clean.replace(/\n[ \t]*\n+/g, PARAGRAPH_BREAK);
  // Two or more consecutive &nbsp; entities (with optional whitespace between)
  clean = clean.replace(/(?:\s*(?:&nbsp;|\u00A0)\s*){2,}/gi, PARAGRAPH_BREAK);

  // ── 5. Wrap orphan top-level inline runs into <p>, splitting at markers
  //       OR at <br><br>+ sequences that appear at the top level ──
  clean = wrapOrphanContent(clean);

  // ── 6. Residual cleanup ──
  // Markers that somehow ended up inside an existing block — strip them
  clean = clean.split(PARAGRAPH_BREAK).join('');
  // Collapse <br><br>+ remaining inside blocks to a single <br> (best-effort
  // visual line break when we can't split the containing <p>)
  clean = clean.replace(/(?:<br\s*\/?\s*>\s*){2,}/gi, '<br>');
  // Empty <p>s
  clean = clean.replace(/<p[^>]*>\s*(?:&nbsp;|\u00A0)?\s*<\/p>/gi, '');

  return clean.trim();
}

function buildCmsFieldData(jobDetail, brandMap, brandIdToName, countryMap, hashtagToBrand) {
  // Resolve brand using 3-tier logic — returns the CANONICAL CMS brand
  // name in `.name` (never the raw PageUp text).
  const resolvedBrand = resolveBrand(jobDetail, brandMap, brandIdToName, hashtagToBrand);

  const fieldData = {
    name: jobDetail.title.substring(0, 256),
    slug: slugify(jobDetail.title),
    'job-id': jobDetail.jobId,
    'location': jobDetail.location || '',
    'brand-name': resolvedBrand.name,
    'summary': jobDetail.summary || '',
    'work-type': jobDetail.workType || '',
    'city': jobDetail.city || '',
    'category': jobDetail.categories || '',
    'closing-date': jobDetail.closingDate || '',
  };

  // Job URL
  if (jobDetail.applyUrl) {
    const jobUrl = `https://careers.fctgcareers.com/cw/en/job/${jobDetail.jobId}`;
    fieldData['job-url'] = jobUrl;
  }

  // Apply URL
  if (jobDetail.applyUrl) {
    fieldData['apply-url'] = jobDetail.applyUrl;
  }

  // Refer URL
  if (jobDetail.referUrl) {
    fieldData['refer-url'] = jobDetail.referUrl;
  }

  // Description (RichText) - clean up PageUp HTML for uniform display
  if (jobDetail.descriptionHtml) {
    fieldData['description'] = cleanDescription(jobDetail.descriptionHtml);
  }

  // Banner image link — store the PageUp banner URL in a Link field
  // (Webflow's Image field rejects PageUp's image/x-png MIME type,
  // so we store the URL and render it via a code embed on the template)
  if (jobDetail.heroImage) {
    fieldData['banner-image-link'] = jobDetail.heroImage;
  }

  // Video
  if (jobDetail.videoUrl) {
    fieldData['video'] = jobDetail.videoUrl;
  }

  // Brand reference (already resolved)
  if (resolvedBrand.id) {
    fieldData['brand'] = resolvedBrand.id;
  }

  // Country reference
  const countryRef = resolveReference(jobDetail.country, countryMap);
  if (countryRef) {
    fieldData['country'] = countryRef;
  }

  return fieldData;
}

function hasChanged(existing, newData) {
  // Compare key fields to detect real content changes.
  // Note: description and banner-image-link are intentionally excluded — Webflow
  // normalizes HTML and link values on storage, causing false diffs every sync.
  // These fields are still written correctly for new jobs and on every update.
  const fieldsToCompare = ['name', 'location', 'work-type', 'category', 'brand-name', 'closing-date'];
  const existingFields = existing.fieldData || {};

  const changed = [];
  for (const field of fieldsToCompare) {
    const existingVal = (existingFields[field] || '').toString().trim();
    const newVal = (newData[field] || '').toString().trim();
    if (existingVal !== newVal) changed.push(field);
  }

  return changed.length > 0 ? changed : false;
}

/**
 * Quick listing-level comparison that avoids an expensive detail-page scrape.
 * Returns true if the PageUp listing row's stable fields differ from the CMS
 * item. "Stable" means fields that come straight from the listing table and
 * aren't transformed by our resolvers:
 *   - title  → matches fieldData.name exactly
 *   - location → matches fieldData.location exactly
 *
 * Brand is intentionally NOT compared here: our resolveBrand() uses hashtags
 * as a fallback, so the CMS brand-name may legitimately differ from the raw
 * listing brand text every sync. Comparing it would cause 100% of jobs to
 * re-scrape and defeat the purpose of this check.
 *
 * Empty PageUp values are not treated as changes — some listing rows don't
 * populate every cell.
 */
function listingFieldsChanged(cmsItem, pageupJob) {
  const fd = cmsItem.fieldData || {};
  const norm = (s) => (s || '').toString().trim();

  if (pageupJob.title && norm(fd.name) !== norm(pageupJob.title)) return true;
  if (pageupJob.location && norm(fd.location) !== norm(pageupJob.location)) return true;

  return false;
}

async function runSync() {
  const logger = new SyncLogger();
  logger.start();
  console.log('=== PageUp → Webflow Job Sync ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Mode: ${FORCE_FULL ? 'FORCE FULL (every existing job re-scraped)' : 'fast-sync (listing-level diff)'}`);

  if (!WEBFLOW_API_TOKEN) {
    throw new Error('WEBFLOW_API_TOKEN environment variable is required');
  }

  const client = new WebflowClient(WEBFLOW_API_TOKEN, WEBFLOW_SITE_ID);

  // Load stored content-hash map. On first run or after the file is wiped,
  // this returns {} — every job will look "changed" at the hash layer and
  // get hashed + PATCHed as normal, populating the map.
  const hashes = loadHashes();
  const hashesBefore = Object.keys(hashes).length;
  console.log(`[sync] Loaded ${hashesBefore} stored content hashes.`);

  // Step 1: Initialize browser and fetch all job IDs
  await initBrowser();
  const pageupJobs = await fetchAllJobIds();
  logger.recordPageupScrape(pageupJobs.length);

  // SAFETY GUARD: Abort if PageUp returns 0 jobs to prevent catastrophic deletion
  if (pageupJobs.length === 0) {
    throw new Error('PageUp returned 0 jobs - aborting sync to prevent data loss. This likely indicates a scraping failure.');
  }

  // Additional safety: warn if job count drops dramatically
  const MIN_EXPECTED_JOBS = 50;
  if (pageupJobs.length < MIN_EXPECTED_JOBS) {
    console.warn(`[sync] WARNING: Only ${pageupJobs.length} jobs found on PageUp (expected ${MIN_EXPECTED_JOBS}+). Proceeding with caution.`);
  }

  // Step 2: Fetch existing CMS items
  const cmsItems = await client.getAllCollectionItems(COLLECTION_ID);
  logger.recordCmsState(cmsItems.length);

  // Step 4: Build reference maps (includes hashtag → brand mapping)
  const { brandMap, brandIdToName, countryMap, hashtagToBrand } = await buildReferenceMaps(client);

  // Step 5: Build maps for diffing
  const cmsJobMap = new Map(); // jobId → CMS item
  for (const item of cmsItems) {
    const jobId = item.fieldData?.['job-id'];
    if (jobId) cmsJobMap.set(jobId, item);
  }

  const pageupJobMap = new Map(); // jobId → listing data
  for (const job of pageupJobs) {
    pageupJobMap.set(job.jobId, job);
  }

  // Step 6: Diff
  const newJobs = pageupJobs.filter(j => !cmsJobMap.has(j.jobId));
  const removedJobIds = [];
  for (const [jobId, item] of cmsJobMap) {
    if (!pageupJobMap.has(jobId)) removedJobIds.push({ jobId, cmsId: item.id, title: item.fieldData?.name || jobId });
  }
  const existingJobs = pageupJobs.filter(j => cmsJobMap.has(j.jobId));

  console.log(`\n[sync] Diff results:`);
  console.log(`  New jobs: ${newJobs.length}`);
  console.log(`  Removed jobs: ${removedJobIds.length}`);
  console.log(`  Existing jobs: ${existingJobs.length}`);

  logger.recordDiff({
    newJobs: newJobs.map(j => ({ jobId: j.jobId, title: j.title })),
    removedJobs: removedJobIds.map(r => ({ jobId: r.jobId })),
    existingCount: existingJobs.length,
  });

  // SAFETY GUARD: Prevent mass deletion (>50% of CMS items)
  if (cmsJobMap.size > 0 && removedJobIds.length > cmsJobMap.size * 0.5) {
    throw new Error(
      `Mass deletion guard triggered: ${removedJobIds.length} of ${cmsJobMap.size} CMS items would be deleted (>50%). ` +
      `This likely indicates a scraping failure. Aborting sync.`
    );
  }

  const changedIds = [];

  // Step 7: Scrape and create new jobs
  if (newJobs.length > 0) {
    console.log(`\n[sync] Scraping ${newJobs.length} new job detail pages...`);
    const { results: newDetails } = await scrapeAllJobs(newJobs);

    // Build fieldData for each new job, keeping track of the content hash
    // keyed by the PageUp job-id so we can record hashes for successfully-
    // created items only.
    const itemsToCreate = [];
    const hashByJobId = {};
    for (const detail of newDetails) {
      const fieldData = buildCmsFieldData(detail, brandMap, brandIdToName, countryMap, hashtagToBrand);
      itemsToCreate.push({ fieldData, isArchived: false, isDraft: false });
      if (detail.jobId) hashByJobId[detail.jobId] = hashFieldData(fieldData);
    }

    if (itemsToCreate.length > 0) {
      const created = await client.createItems(COLLECTION_ID, itemsToCreate);
      console.log(`[sync] Created ${created.length} new CMS items.`);
      changedIds.push(...created.map(c => c.id));
      logger.recordCreated(newDetails.map(d => ({ jobId: d.jobId, title: d.title })));

      // Record hashes only for items Webflow confirmed — failed creations
      // won't pollute the hash map and will be re-attempted next run.
      for (const c of created) {
        const jobId = c.fieldData && c.fieldData['job-id'];
        if (jobId && hashByJobId[jobId]) hashes[jobId] = hashByJobId[jobId];
      }
    }
  }

  // Step 8: Update existing jobs — but ONLY scrape detail pages for jobs
  // whose listing-level fields (title, location) changed. This is the main
  // speed-up: a typical "no changes" run skips ~350 detail-page fetches and
  // finishes in seconds rather than minutes.
  //
  // Fields that only live on detail pages (description, closing-date,
  // banner-image, video, categories) are re-scraped only when the listing
  // signals a change. We accept that an isolated description edit on PageUp
  // won't be picked up until the job's listing also changes — tradeoff
  // agreed with the client for sync speed.
  if (existingJobs.length > 0) {
    const jobsNeedingRescrape = [];
    let listingSkippedCount = 0;

    if (FORCE_FULL) {
      // Bypass the listing diff entirely — every existing job gets scraped.
      jobsNeedingRescrape.push(...existingJobs);
    } else {
      for (const pageupJob of existingJobs) {
        const cmsItem = cmsJobMap.get(pageupJob.jobId);
        if (!cmsItem) continue;
        if (listingFieldsChanged(cmsItem, pageupJob)) {
          jobsNeedingRescrape.push(pageupJob);
        } else {
          listingSkippedCount++;
        }
      }
    }

    console.log(
      FORCE_FULL
        ? `\n[sync] FORCE FULL: scraping all ${jobsNeedingRescrape.length} existing jobs.`
        : `\n[sync] Existing jobs: ${listingSkippedCount} unchanged (skipping detail fetch), ` +
          `${jobsNeedingRescrape.length} changed at listing level (re-scraping).`
    );

    if (jobsNeedingRescrape.length > 0) {
      const { results: existingDetails } = await scrapeAllJobs(jobsNeedingRescrape);

      const itemsToUpdate = [];
      // Map cmsItemId → { jobId, newHash } for items we're about to PATCH.
      // After updateItems returns, we only record hashes for items Webflow
      // confirmed as updated.
      const pendingHashUpdates = {};
      let hashSkippedCount = 0;

      for (const detail of existingDetails) {
        const cmsItem = cmsJobMap.get(detail.jobId);
        if (!cmsItem) continue;

        const newFieldData = buildCmsFieldData(detail, brandMap, brandIdToName, countryMap, hashtagToBrand);

        // Slugs are immutable once created. If PageUp renames a job into a
        // title whose slugified form collides with another CMS item, Webflow
        // rejects the entire PATCH — causing an update loop where every
        // sync detects the same change and fails to persist it. Strip slug
        // from updates so the original URL stays stable and the rest of the
        // fields can update cleanly.
        delete newFieldData.slug;

        // Content-hash gate: if the cleaned fieldData hashes to the same
        // value we stored last time, skip the PATCH entirely. This catches
        // the case where a recruiter re-saves a PageUp job without changing
        // anything visible — previously we'd PATCH it every time due to
        // Webflow normalising the description; now we don't.
        const newHash = hashFieldData(newFieldData);
        if (hashes[detail.jobId] === newHash) {
          hashSkippedCount++;
          continue;
        }

        // Hash differs → actual change. hasChanged() still populates the
        // changedFields list for the log (it excludes description and
        // banner-image-link because Webflow normalises those; when hash
        // differs but hasChanged returns false, the change is in one of
        // those excluded fields — most often description).
        const changedFields = hasChanged(cmsItem, newFieldData)
          || ['description-or-banner'];

        itemsToUpdate.push({
          id: cmsItem.id,
          fieldData: newFieldData,
          _jobId: detail.jobId,
          _title: detail.title,
          _changedFields: changedFields,
        });
        pendingHashUpdates[cmsItem.id] = { jobId: detail.jobId, hash: newHash };
      }

      if (hashSkippedCount > 0) {
        console.log(`[sync] Hash unchanged for ${hashSkippedCount} scraped jobs — no PATCH needed.`);
      }

      if (itemsToUpdate.length > 0) {
        console.log(`[sync] Updating ${itemsToUpdate.length} changed CMS items...`);
        logger.recordUpdated(itemsToUpdate.map(i => ({
          jobId: i._jobId, title: i._title, changedFields: i._changedFields,
        })));
        const updated = await client.updateItems(COLLECTION_ID, itemsToUpdate);
        console.log(`[sync] Updated ${updated.length} items.`);
        changedIds.push(...updated.map(u => u.id));

        // Record new hashes ONLY for items Webflow confirmed updated.
        // Items that failed individually don't get their hash bumped, so
        // they'll be re-attempted next sync.
        for (const u of updated) {
          const pending = pendingHashUpdates[u.id];
          if (pending) hashes[pending.jobId] = pending.hash;
        }
      } else if (hashSkippedCount === existingDetails.length) {
        console.log('[sync] All scraped jobs matched their stored hashes — nothing to update.');
      } else {
        console.log('[sync] No CMS updates needed.');
      }
    } else {
      console.log('[sync] No existing jobs have changed at listing level.');
    }
  }

  // Step 9: Remove deleted jobs
  if (removedJobIds.length > 0) {
    console.log(`\n[sync] Removing ${removedJobIds.length} deleted jobs from CMS...`);
    logger.recordDeleted(removedJobIds.map(r => ({ jobId: r.jobId, title: r.title })));
    const cmsIdsToDelete = removedJobIds.map(r => r.cmsId);
    const deleted = await client.deleteItems(COLLECTION_ID, cmsIdsToDelete);
    console.log(`[sync] Deleted ${deleted.length} items.`);
    // Drop hashes for removed jobs so the map doesn't grow unbounded.
    for (const r of removedJobIds) delete hashes[r.jobId];
  }

  // Step 10: Publish site if any changes were made
  const hasChanges = changedIds.length > 0 || removedJobIds.length > 0;
  if (hasChanges) {
    console.log(`\n[sync] Publishing site...`);
    await client.publishSite();
    logger.recordPublished(true);

    // Wait for the /items/live endpoint to reflect the publish before
    // regenerating JSON. 10s was not always enough — observed at 21:30
    // UTC 2026-04-19 where a newly-created item didn't appear in live
    // until well after a 10s wait. 30s is a safer default; still a
    // rounding error compared to the sync's overall duration.
    console.log('[sync] Waiting 30s for CMS changes to propagate to live endpoint...');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }

  // Step 11: Regenerate all-jobs.json + filter-counts.json
  console.log(`\n[sync] Regenerating all-jobs.json and filter-counts.json...`);
  const liveJobsCount = await generateAllJobsJson(client, countryMap);
  await generateFilterCounts(client, countryMap);
  logger.recordLiveJobsAfter(liveJobsCount);

  // Step 12: Persist updated hash map. CI copies this file to the `data`
  // branch alongside the JSON artefacts so future runs can read it back.
  saveHashes(hashes);
  const hashesAfter = Object.keys(hashes).length;
  console.log(`[sync] Saved ${hashesAfter} content hashes (delta: ${hashesAfter - hashesBefore >= 0 ? '+' : ''}${hashesAfter - hashesBefore}).`);

  // Cleanup browser
  await closeBrowser();

  console.log(`\n=== Sync complete at ${new Date().toISOString()} ===`);
  const updatedCount = Math.max(0, changedIds.length - newJobs.length);
  console.log(`Summary: ${newJobs.length} created, ${removedJobIds.length} removed, ${updatedCount} updated`);

  await logger.finish('success');
}

// Run if called directly
if (require.main === module) {
  runSync().catch(async (err) => {
    console.error('[sync] Fatal error:', err);
    // Try to log the error
    try {
      const errorLogger = new SyncLogger();
      errorLogger.start();
      await errorLogger.finish('error', err.message);
    } catch (_) { /* best effort */ }
    await closeBrowser();
    process.exit(1);
  });
}

async function generateFilterCounts(client, countryMap) {
  // Build country ID → name map (inverse of the reference map)
  const countryItems = await client.getAllCollectionItems(COUNTRY_COLLECTION_ID);
  const countryIdToName = {};
  for (const item of countryItems) {
    const name = item.fieldData?.name;
    if (name) countryIdToName[item.id] = name;
  }

  // Fetch only LIVE (published) job items so filter counts match what
  // visitors actually see on the site.
  const jobItems = await client.getLiveCollectionItems(COLLECTION_ID);

  // Set of known country names (lowercase) for the city/country reconciliation
  const knownCountryNames = new Set(
    Object.values(countryIdToName).map(n => (n || '').toLowerCase())
  );

  const regions = {};
  const cities = {};
  const categories = {};
  const cityToRegion = {};
  const cityDisplay = {};
  const categoryDisplay = {};

  for (const item of jobItems) {
    const fd = item.fieldData || {};

    // Resolve country reference to region, with a safety net: if the CMS
    // country is empty but the city value is itself a country/state name,
    // recover the country from that.
    const countryRef = fd.country;
    const rawCountryName = countryRef ? (countryIdToName[countryRef] || '') : '';
    const { city, countryName } = reconcileCityAndCountry(
      fd.city, rawCountryName, knownCountryNames
    );

    let regionName = '';
    if (countryName) {
      regionName = regionMap[countryName.toLowerCase()] || 'Multiple Locations';
    } else {
      regionName = 'Multiple Locations';
    }

    const rk = regionName.toLowerCase();
    regions[rk] = (regions[rk] || 0) + 1;

    // City — only counted if we have a real city (reconcile clears it when
    // the CMS city value was actually a country or state name)
    if (city) {
      const ck = city.toLowerCase();
      cities[ck] = (cities[ck] || 0) + 1;
      if (regionName && !cityToRegion[ck]) cityToRegion[ck] = regionName;
      if (!cityDisplay[ck]) cityDisplay[ck] = city;
    }

    // Category
    const cat = (fd.category || '').trim();
    if (cat) {
      const catParts = cat.split(',').map(c => c.trim()).filter(Boolean);
      for (const cp of catParts) {
        const catk = cp.toLowerCase();
        categories[catk] = (categories[catk] || 0) + 1;
        if (!categoryDisplay[catk]) categoryDisplay[catk] = cp;
      }
    }
  }

  const counts = { regions, cities, categories, cityToRegion, cityDisplay, categoryDisplay };
  const outPath = path.join(__dirname, '..', 'filter-counts.json');
  fs.writeFileSync(outPath, JSON.stringify(counts, null, 2));
  console.log(`[sync] filter-counts.json written (${Object.keys(regions).length} regions, ${Object.keys(cities).length} cities, ${Object.keys(categories).length} categories)`);
}

async function generateAllJobsJson(client, countryMap) {
  // Build country ID → name map (inverse of the reference map).
  // Country and Brand reference collections are fetched via the staged
  // endpoint because their entries rarely change and are always published.
  const countryItems = await client.getAllCollectionItems(COUNTRY_COLLECTION_ID);
  const countryIdToName = {};
  for (const item of countryItems) {
    const name = item.fieldData?.name;
    if (name) countryIdToName[item.id] = name;
  }

  // Build brand ID → logo URL map
  const brandItems = await client.getAllCollectionItems(BRAND_COLLECTION_ID);
  const brandIdToLogo = {};
  for (const item of brandItems) {
    const logo = item.fieldData?.logo;
    if (logo) {
      // Webflow Image fields return { url, alt } or sometimes just a URL string
      const logoUrl = typeof logo === 'string' ? logo : (logo.url || '');
      if (logoUrl) brandIdToLogo[item.id] = logoUrl;
    }
  }
  console.log(`[sync] Brand logo map: ${Object.keys(brandIdToLogo).length} brands with logos`);

  // Fetch only LIVE (published) job items — guarantees every slug we emit
  // actually resolves on the site. Prevents the "page not found" bug where
  // unpublished CMS items leaked into all-jobs.json.
  const jobItems = await client.getLiveCollectionItems(COLLECTION_ID);
  const allJobs = [];

  // Set of known country names (lowercase) for city/country reconciliation
  const knownCountryNames = new Set(
    Object.values(countryIdToName).map(n => (n || '').toLowerCase())
  );

  // Defensive: skip items without a valid job-id and deduplicate by job-id
  // so the public JSON is always a clean 1:1 of unique PageUp jobs.
  const seenJobIds = new Set();
  let skippedNoId = 0;
  let skippedDupe = 0;

  for (const item of jobItems) {
    const fd = item.fieldData || {};
    const jobId = (fd['job-id'] || '').toString().trim();
    if (!jobId) { skippedNoId++; continue; }
    if (seenJobIds.has(jobId)) { skippedDupe++; continue; }
    seenJobIds.add(jobId);

    // Resolve country reference to region, with a safety net that recovers
    // the country from the city value when the CMS country is empty but
    // the city text is itself a country name (e.g. "New Zealand") or a
    // mapped state (e.g. "Missouri" → United States).
    const countryRef = fd.country;
    const rawCountryName = countryRef ? (countryIdToName[countryRef] || '') : '';
    const { city, countryName } = reconcileCityAndCountry(
      fd.city, rawCountryName, knownCountryNames
    );

    let region = '';
    if (countryName) {
      region = regionMap[countryName.toLowerCase()] || 'Multiple Locations';
    } else {
      region = 'Multiple Locations';
    }

    const brand = (fd['brand-name'] || '').trim();

    // Resolve brand reference to logo URL
    const brandRef = fd.brand;
    const logoUrl = brandRef ? (brandIdToLogo[brandRef] || '') : '';

    allJobs.push({
      t: (fd.name || '').trim(),           // title
      s: (fd.slug || ''),                  // slug
      ci: city,                            // city (reconciled — empty when
                                           //   the raw city was actually a
                                           //   country/state name)
      co: countryName,                     // country name
      r: region,                           // region
      b: brand,                            // brand
      ca: (fd.category || '').trim(),      // category (may be comma-separated)
      wt: (fd['work-type'] || '').trim(),  // work type
      su: (fd.summary || '').trim(),       // summary
      ju: (fd['job-url'] || ''),           // job URL
      l: logoUrl,                          // brand logo URL
    });
  }

  if (skippedNoId > 0) {
    console.warn(`[sync] WARNING: ${skippedNoId} CMS item(s) skipped during JSON generation — missing job-id field. These are "ghost" items that aren't in PageUp sync; consider cleaning them up in the CMS.`);
  }
  if (skippedDupe > 0) {
    console.warn(`[sync] WARNING: ${skippedDupe} CMS item(s) skipped during JSON generation — duplicate job-id. Two CMS items share the same PageUp job ID; consider cleaning up the older duplicate.`);
  }

  const outPath = path.join(__dirname, '..', 'all-jobs.json');
  fs.writeFileSync(outPath, JSON.stringify(allJobs));
  console.log(`[sync] all-jobs.json written (${allJobs.length} jobs)`);
  return allJobs.length;
}

module.exports = { runSync };
