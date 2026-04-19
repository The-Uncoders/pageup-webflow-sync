try { require('dotenv').config(); } catch (_) { /* dotenv optional in CI */ }

const fs = require('fs');
const path = require('path');
const { initBrowser, closeBrowser, fetchAllJobIds, scrapeAllJobs } = require('./scraper');
const { WebflowClient } = require('./webflow');
const { SyncLogger } = require('./sync-logger');
const regionMap = require('../region-map.json');
const locationToCountry = require('../location-to-country.json');

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
  const brandMap = {};       // brand name (lowercase) → Webflow item ID
  const hashtagToBrand = {}; // hashtag (uppercase, e.g. "#FCM") → { id, name }
  for (const item of brandItems) {
    const name = item.fieldData?.name?.trim();
    if (name) brandMap[name.toLowerCase()] = item.id;

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
  return { brandMap, countryMap, hashtagToBrand };
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
function resolveBrand(jobDetail, brandMap, hashtagToBrand) {
  // Tier 1: Try the PageUp brand field (exact/partial name match)
  if (jobDetail.brandName) {
    const brandRef = resolveReference(jobDetail.brandName, brandMap);
    if (brandRef) {
      return { id: brandRef, name: jobDetail.brandName };
    }
  }

  // Tier 2: Try hashtags from the job post against brand-tag mappings
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

  // Tier 3: Default to Flight Centre Travel Group
  const fctgRef = resolveReference(FCTG_DEFAULT_BRAND, brandMap);
  return { id: fctgRef, name: FCTG_DEFAULT_BRAND };
}

/**
 * Clean up PageUp description HTML for consistent display in Webflow.
 * PageUp descriptions come with inconsistent formatting across regions:
 *   - Empty <p>&nbsp;</p> paragraphs creating double/triple spacing
 *   - Whitespace-only spans and paragraphs
 *   - Each bullet in its own <div><ul><li> wrapper (causes extra gaps)
 *   - White-text hashtag lines (#LI-xxx, brand tags) meant to be hidden
 *   - Inline font-size/font-family styles overriding site typography
 *   - PageUp-sourced images that Webflow can't import
 */
function cleanDescription(html) {
  let clean = html;

  // Strip PageUp-sourced images (serve image/x-png which Webflow rejects)
  clean = clean.replace(/<img[^>]*src="[^"]*pageuppeople\.com[^"]*"[^>]*\/?>/gi, '');
  clean = clean.replace(/<img[^>]*src="[^"]*publicstorage[^"]*"[^>]*\/?>/gi, '');

  // Remove white-text hashtag lines (LinkedIn tracking tags like #LI-ME1#MTEV#LI-Onsite)
  clean = clean.replace(/<span[^>]*color:\s*#(?:FFF(?:FFF)?|fff(?:fff)?|FFFFFF|ffffff)\b[^>]*>[^<]*<\/span>/gi, '');

  // Strip inline font-size and font-family from style attributes so Webflow's typography applies.
  // Do this BEFORE empty-element removal so stripped spans get cleaned up properly.
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

  // Remove empty <span> wrappers (no attributes left after style stripping)
  clean = clean.replace(/<span>([^<]*)<\/span>/gi, '$1');

  // Remove empty paragraphs: <p>&nbsp;</p>, <p> </p>, <p></p>
  clean = clean.replace(/<p>\s*(?:&nbsp;|\u00A0)?\s*<\/p>/gi, '');

  // Remove paragraphs that only contain a whitespace-only span
  clean = clean.replace(/<p>\s*<span[^>]*>\s*(?:&nbsp;|\u00A0)?\s*<\/span>\s*<\/p>/gi, '');

  // Consolidate fragmented lists: merge adjacent <div><ul>...</ul></div> blocks
  clean = clean.replace(/<div>\s*<ul>/gi, '<ul>');
  clean = clean.replace(/<\/ul>\s*<\/div>/gi, '</ul>');
  clean = clean.replace(/<\/ul>\s*<ul>/gi, '');

  // Unwrap unnecessary nested <div> wrappers around paragraphs
  clean = clean.replace(/<div>\s*(<p[^>]*>)/gi, '$1');
  clean = clean.replace(/(<\/p>)\s*<\/div>/gi, '$1');

  // Collapse multiple consecutive <br> tags into one
  clean = clean.replace(/(<br\s*\/?\s*>\s*){2,}/gi, '<br>');

  // Strip ALL remaining <div> tags (opening and closing).
  // Webflow rich text only supports p, ul, ol, h1-h6, blockquote, figure.
  // Leftover <div> elements break Webflow's CMS template DOM structure,
  // causing the brand sidebar to get swallowed into the content column.
  clean = clean.replace(/<\/?div[^>]*>/gi, '');

  return clean.trim();
}

function buildCmsFieldData(jobDetail, brandMap, countryMap, hashtagToBrand) {
  // Resolve brand using 3-tier logic
  const resolvedBrand = resolveBrand(jobDetail, brandMap, hashtagToBrand);

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

  if (!WEBFLOW_API_TOKEN) {
    throw new Error('WEBFLOW_API_TOKEN environment variable is required');
  }

  const client = new WebflowClient(WEBFLOW_API_TOKEN, WEBFLOW_SITE_ID);

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
  const { brandMap, countryMap, hashtagToBrand } = await buildReferenceMaps(client);

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

    const itemsToCreate = newDetails.map(detail => ({
      fieldData: buildCmsFieldData(detail, brandMap, countryMap, hashtagToBrand),
      isArchived: false,
      isDraft: false,
    }));

    if (itemsToCreate.length > 0) {
      const created = await client.createItems(COLLECTION_ID, itemsToCreate);
      console.log(`[sync] Created ${created.length} new CMS items.`);
      changedIds.push(...created.map(c => c.id));
      logger.recordCreated(newDetails.map(d => ({ jobId: d.jobId, title: d.title })));
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
    let skippedCount = 0;

    for (const pageupJob of existingJobs) {
      const cmsItem = cmsJobMap.get(pageupJob.jobId);
      if (!cmsItem) continue;

      const listingChanged = listingFieldsChanged(cmsItem, pageupJob);
      if (listingChanged) {
        jobsNeedingRescrape.push(pageupJob);
      } else {
        skippedCount++;
      }
    }

    console.log(
      `\n[sync] Existing jobs: ${skippedCount} unchanged (skipping detail fetch), ` +
      `${jobsNeedingRescrape.length} changed at listing level (re-scraping).`
    );

    if (jobsNeedingRescrape.length > 0) {
      const { results: existingDetails } = await scrapeAllJobs(jobsNeedingRescrape);

      const itemsToUpdate = [];
      for (const detail of existingDetails) {
        const cmsItem = cmsJobMap.get(detail.jobId);
        if (!cmsItem) continue;

        const newFieldData = buildCmsFieldData(detail, brandMap, countryMap, hashtagToBrand);

        // Slugs are immutable once created. If PageUp renames a job into a
        // title whose slugified form collides with another CMS item, Webflow
        // rejects the entire PATCH — causing an update loop where every
        // sync detects the same change and fails to persist it. Strip slug
        // from updates so the original URL stays stable and the rest of the
        // fields can update cleanly.
        delete newFieldData.slug;

        const changedFields = hasChanged(cmsItem, newFieldData);
        if (changedFields) {
          itemsToUpdate.push({
            id: cmsItem.id,
            fieldData: newFieldData,
            _jobId: detail.jobId,
            _title: detail.title,
            _changedFields: changedFields,
          });
        }
      }

      if (itemsToUpdate.length > 0) {
        console.log(`[sync] Updating ${itemsToUpdate.length} changed CMS items...`);
        logger.recordUpdated(itemsToUpdate.map(i => ({
          jobId: i._jobId, title: i._title, changedFields: i._changedFields,
        })));
        const updated = await client.updateItems(COLLECTION_ID, itemsToUpdate);
        console.log(`[sync] Updated ${updated.length} items.`);
        changedIds.push(...updated.map(u => u.id));
      } else {
        console.log('[sync] Listing-level changes detected but detail-level fields matched — no CMS updates needed.');
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
  }

  // Step 10: Publish site if any changes were made
  const hasChanges = changedIds.length > 0 || removedJobIds.length > 0;
  if (hasChanges) {
    console.log(`\n[sync] Publishing site...`);
    await client.publishSite();
    logger.recordPublished(true);

    // Wait for CMS changes to propagate in the Webflow API before regenerating JSON.
    // Without this delay, getAllCollectionItems may return stale data that excludes
    // newly created items, causing them to be missing from all-jobs.json.
    console.log('[sync] Waiting 10s for CMS changes to propagate...');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // Step 11: Regenerate all-jobs.json + filter-counts.json
  console.log(`\n[sync] Regenerating all-jobs.json and filter-counts.json...`);
  await generateAllJobsJson(client, countryMap);
  await generateFilterCounts(client, countryMap);

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

  for (const item of jobItems) {
    const fd = item.fieldData || {};

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

  const outPath = path.join(__dirname, '..', 'all-jobs.json');
  fs.writeFileSync(outPath, JSON.stringify(allJobs));
  console.log(`[sync] all-jobs.json written (${allJobs.length} jobs)`);
}

module.exports = { runSync };
