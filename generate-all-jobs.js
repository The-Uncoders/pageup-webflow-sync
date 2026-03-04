/**
 * Generate all-jobs.json from the current CMS data.
 * This file is fetched by the v3.0 frontend for data-driven filtering/rendering.
 *
 * Output: all-jobs.json with all job data needed for client-side filtering.
 */
try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const path = require('path');
const regionMap = require('./region-map.json');

const API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69a6a25d0ee880903952732b';
const COUNTRY_COLLECTION_ID = process.env.WEBFLOW_COUNTRY_COLLECTION_ID || '691f361688f213d69817eb56';

async function fetchAllItems(collectionId) {
  let items = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100&offset=${offset}`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } }
    );
    const data = await res.json();
    items.push(...data.items);
    if (items.length >= data.pagination.total) break;
    offset += 100;
  }
  return items;
}

async function main() {
  console.log('[all-jobs] Fetching CMS data...');

  // Fetch country items to build ID → name map
  const countryItems = await fetchAllItems(COUNTRY_COLLECTION_ID);
  const countryIdToName = {};
  for (const item of countryItems) {
    countryIdToName[item.id] = item.fieldData?.name || '';
  }

  // Fetch all job items
  const jobItems = await fetchAllItems(COLLECTION_ID);
  console.log(`[all-jobs] Processing ${jobItems.length} job items...`);

  const allJobs = [];

  for (const item of jobItems) {
    const fd = item.fieldData || {};

    // Resolve country reference to region
    const countryRef = fd.country;
    const countryName = countryRef ? (countryIdToName[countryRef] || '') : '';
    let region = '';
    if (countryName) {
      region = regionMap[countryName.toLowerCase()] || 'Multiple Locations';
    } else {
      region = 'Multiple Locations';
    }

    const brand = (fd['brand-name'] || '').trim();

    allJobs.push({
      t: (fd.name || '').trim(),           // title
      s: (fd.slug || ''),                  // slug
      ci: (fd.city || '').trim(),          // city
      co: countryName,                     // country name
      r: region,                           // region
      b: brand,                            // brand
      ca: (fd.category || '').trim(),      // category (may be comma-separated)
      wt: (fd['work-type'] || '').trim(),  // work type
      su: (fd.summary || '').trim(),       // summary
      ju: (fd['job-url'] || ''),           // job URL
    });
  }

  const outPath = path.join(__dirname, 'all-jobs.json');
  fs.writeFileSync(outPath, JSON.stringify(allJobs));
  console.log(`[all-jobs] Written ${allJobs.length} jobs to ${outPath}`);
  console.log(`[all-jobs] File size: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
}

main().catch(e => console.error(e));
