try { require('dotenv').config(); } catch (_) { /* dotenv optional in CI */ }

const fs = require('fs');
const path = require('path');
const { initBrowser, closeBrowser, fetchAllJobIds, scrapeAllJobs } = require('./scraper');
const { WebflowClient } = require('./webflow');
const regionMap = require('../region-map.json');

// Configuration
const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69a6a25d0ee880903952732b';
const BRAND_COLLECTION_ID = process.env.WEBFLOW_BRAND_COLLECTION_ID || '691f361688f213d69817eb0a';
const COUNTRY_COLLECTION_ID = process.env.WEBFLOW_COUNTRY_COLLECTION_ID || '691f361688f213d69817eb56';
const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '691f361688f213d69817ead2';

async function buildReferenceMaps(client) {
  console.log('[sync] Building brand and country reference maps...');

  const brandItems = await client.getAllCollectionItems(BRAND_COLLECTION_ID);
  const brandMap = {};
  for (const item of brandItems) {
    const name = item.fieldData?.name?.toLowerCase()?.trim();
    if (name) brandMap[name] = item.id;
  }

  const countryItems = await client.getAllCollectionItems(COUNTRY_COLLECTION_ID);
  const countryMap = {};
  for (const item of countryItems) {
    const name = item.fieldData?.name?.toLowerCase()?.trim();
    if (name) countryMap[name] = item.id;
  }

  console.log(`[sync] Loaded ${Object.keys(brandMap).length} brands, ${Object.keys(countryMap).length} countries.`);
  return { brandMap, countryMap };
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

function buildCmsFieldData(jobDetail, brandMap, countryMap) {
  const fieldData = {
    name: jobDetail.title.substring(0, 256),
    slug: slugify(jobDetail.title),
    'job-id': jobDetail.jobId,
    'location': jobDetail.location || '',
    'brand-name': jobDetail.brandName || '',
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

  // Description (RichText) - strip images that Webflow can't import (pageuppeople.com serves image/x-png)
  if (jobDetail.descriptionHtml) {
    let cleanHtml = jobDetail.descriptionHtml
      .replace(/<img[^>]*src="[^"]*pageuppeople\.com[^"]*"[^>]*\/?>/gi, '')
      .replace(/<img[^>]*src="[^"]*publicstorage[^"]*"[^>]*\/?>/gi, '');
    fieldData['description'] = cleanHtml;
  }

  // Hero image - skip ALL PageUp-sourced images as they serve image/x-png which Webflow rejects
  // Only include images from standard web hosts (not pageuppeople.com or publicstorage)
  if (jobDetail.heroImage &&
      !jobDetail.heroImage.includes('pageuppeople.com') &&
      !jobDetail.heroImage.includes('publicstorage') &&
      !jobDetail.heroImage.includes('pageup')) {
    fieldData['hero-image'] = { url: jobDetail.heroImage };
  }

  // Video
  if (jobDetail.videoUrl) {
    fieldData['video'] = jobDetail.videoUrl;
  }

  // Brand reference
  const brandRef = resolveReference(jobDetail.brandName, brandMap);
  if (brandRef) {
    fieldData['brand'] = brandRef;
  }

  // Country reference
  const countryRef = resolveReference(jobDetail.country, countryMap);
  if (countryRef) {
    fieldData['country'] = countryRef;
  }

  return fieldData;
}

function hasChanged(existing, newData) {
  // Compare key fields to detect real content changes
  // Exclude 'summary' and 'description' since they may differ between imports
  const fieldsToCompare = ['name', 'location', 'work-type', 'category', 'brand-name', 'closing-date'];
  const existingFields = existing.fieldData || {};

  for (const field of fieldsToCompare) {
    const existingVal = (existingFields[field] || '').toString().trim();
    const newVal = (newData[field] || '').toString().trim();
    if (existingVal !== newVal) return true;
  }
  return false;
}

async function runSync() {
  console.log('=== PageUp → Webflow Job Sync ===');
  console.log(`Started at: ${new Date().toISOString()}`);

  if (!WEBFLOW_API_TOKEN) {
    throw new Error('WEBFLOW_API_TOKEN environment variable is required');
  }

  const client = new WebflowClient(WEBFLOW_API_TOKEN, WEBFLOW_SITE_ID);

  // Step 1: Initialize browser and fetch all job IDs
  await initBrowser();
  const pageupJobs = await fetchAllJobIds();

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

  // Step 4: Build reference maps
  const { brandMap, countryMap } = await buildReferenceMaps(client);

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
    if (!pageupJobMap.has(jobId)) removedJobIds.push({ jobId, cmsId: item.id });
  }
  const existingJobs = pageupJobs.filter(j => cmsJobMap.has(j.jobId));

  console.log(`\n[sync] Diff results:`);
  console.log(`  New jobs: ${newJobs.length}`);
  console.log(`  Removed jobs: ${removedJobIds.length}`);
  console.log(`  Existing jobs: ${existingJobs.length}`);

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
      fieldData: buildCmsFieldData(detail, brandMap, countryMap),
      isArchived: false,
      isDraft: false,
    }));

    if (itemsToCreate.length > 0) {
      const created = await client.createItems(COLLECTION_ID, itemsToCreate);
      console.log(`[sync] Created ${created.length} new CMS items.`);
      changedIds.push(...created.map(c => c.id));
    }
  }

  // Step 8: Update existing jobs (scrape all and check for changes)
  if (existingJobs.length > 0) {
    console.log(`\n[sync] Checking ${existingJobs.length} existing jobs for changes...`);
    const { results: existingDetails } = await scrapeAllJobs(existingJobs);

    const itemsToUpdate = [];
    for (const detail of existingDetails) {
      const cmsItem = cmsJobMap.get(detail.jobId);
      if (!cmsItem) continue;

      const newFieldData = buildCmsFieldData(detail, brandMap, countryMap);

      if (hasChanged(cmsItem, newFieldData)) {
        itemsToUpdate.push({
          id: cmsItem.id,
          fieldData: newFieldData,
        });
      }
    }

    if (itemsToUpdate.length > 0) {
      console.log(`[sync] Updating ${itemsToUpdate.length} changed CMS items...`);
      const updated = await client.updateItems(COLLECTION_ID, itemsToUpdate);
      console.log(`[sync] Updated ${updated.length} items.`);
      changedIds.push(...updated.map(u => u.id));
    } else {
      console.log('[sync] No existing jobs have changed.');
    }
  }

  // Step 9: Remove deleted jobs
  if (removedJobIds.length > 0) {
    console.log(`\n[sync] Removing ${removedJobIds.length} deleted jobs from CMS...`);
    const cmsIdsToDelete = removedJobIds.map(r => r.cmsId);
    const deleted = await client.deleteItems(COLLECTION_ID, cmsIdsToDelete);
    console.log(`[sync] Deleted ${deleted.length} items.`);
  }

  // Step 10: Regenerate filter-counts.json (used by frontend for accurate filter badges)
  console.log(`\n[sync] Regenerating filter-counts.json...`);
  await generateFilterCounts(client, countryMap);

  // Step 11: Publish site if any changes were made
  const hasChanges = changedIds.length > 0 || removedJobIds.length > 0;
  if (hasChanges) {
    console.log(`\n[sync] Publishing site...`);
    await client.publishSite();
  }

  // Cleanup browser
  await closeBrowser();

  console.log(`\n=== Sync complete at ${new Date().toISOString()} ===`);
  const updatedCount = Math.max(0, changedIds.length - newJobs.length);
  console.log(`Summary: ${newJobs.length} created, ${removedJobIds.length} removed, ${updatedCount} updated`);
}

// Run if called directly
if (require.main === module) {
  runSync().catch(async (err) => {
    console.error('[sync] Fatal error:', err);
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

  // Fetch all current CMS job items
  const jobItems = await client.getAllCollectionItems(COLLECTION_ID);

  const regions = {};
  const cities = {};
  const categories = {};
  const cityToRegion = {};
  const cityDisplay = {};
  const categoryDisplay = {};

  for (const item of jobItems) {
    const fd = item.fieldData || {};

    // Resolve country reference to region
    const countryRef = fd.country;
    const countryName = countryRef ? (countryIdToName[countryRef] || '') : '';
    let regionName = '';
    if (countryName) {
      regionName = regionMap[countryName.toLowerCase()] || 'Multiple Locations';
    } else {
      regionName = 'Multiple Locations';
    }

    const rk = regionName.toLowerCase();
    regions[rk] = (regions[rk] || 0) + 1;

    // City
    const city = (fd.city || '').trim();
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

module.exports = { runSync };
