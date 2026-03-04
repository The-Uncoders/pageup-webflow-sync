/**
 * Regenerate all-jobs.json from current Webflow CMS data.
 * Standalone script — no Puppeteer or PageUp scraping required.
 * Usage: node regenerate-json.js
 */
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { WebflowClient } = require('./src/webflow');
const regionMap = require('./region-map.json');

const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69a6a25d0ee880903952732b';
const BRAND_COLLECTION_ID = process.env.WEBFLOW_BRAND_COLLECTION_ID || '691f361688f213d69817eb0a';
const COUNTRY_COLLECTION_ID = process.env.WEBFLOW_COUNTRY_COLLECTION_ID || '691f361688f213d69817eb56';
const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '691f361688f213d69817ead2';

async function main() {
  if (!WEBFLOW_API_TOKEN) {
    console.error('Missing WEBFLOW_API_TOKEN in .env');
    process.exit(1);
  }

  const client = new WebflowClient(WEBFLOW_API_TOKEN, WEBFLOW_SITE_ID);

  // 1. Build country ID → name map
  console.log('[regen] Fetching countries...');
  const countryItems = await client.getAllCollectionItems(COUNTRY_COLLECTION_ID);
  const countryIdToName = {};
  for (const item of countryItems) {
    const name = item.fieldData?.name;
    if (name) countryIdToName[item.id] = name;
  }
  console.log(`[regen] ${Object.keys(countryIdToName).length} countries loaded`);

  // 2. Build brand ID → logo URL map
  console.log('[regen] Fetching brands...');
  const brandItems = await client.getAllCollectionItems(BRAND_COLLECTION_ID);
  const brandIdToLogo = {};
  for (const item of brandItems) {
    const logo = item.fieldData?.logo;
    if (logo) {
      const logoUrl = typeof logo === 'string' ? logo : (logo.url || '');
      if (logoUrl) brandIdToLogo[item.id] = logoUrl;
    }
  }
  console.log(`[regen] ${Object.keys(brandIdToLogo).length} brands with logos`);

  // 3. Fetch all job items
  console.log('[regen] Fetching all job items...');
  const jobItems = await client.getAllCollectionItems(COLLECTION_ID);
  console.log(`[regen] ${jobItems.length} jobs fetched from CMS`);

  const allJobs = [];
  for (const item of jobItems) {
    const fd = item.fieldData || {};
    const countryRef = fd.country;
    const countryName = countryRef ? (countryIdToName[countryRef] || '') : '';
    let region = '';
    if (countryName) {
      region = regionMap[countryName.toLowerCase()] || 'Multiple Locations';
    } else {
      region = 'Multiple Locations';
    }

    const brand = (fd['brand-name'] || '').trim();
    const brandRef = fd.brand;
    const logoUrl = brandRef ? (brandIdToLogo[brandRef] || '') : '';

    allJobs.push({
      t: (fd.name || '').trim(),
      s: (fd.slug || ''),
      ci: (fd.city || '').trim(),
      co: countryName,
      r: region,
      b: brand,
      ca: (fd.category || '').trim(),
      wt: (fd['work-type'] || '').trim(),
      su: (fd.summary || '').trim(),
      ju: (fd['job-url'] || ''),
      l: logoUrl,
    });
  }

  const outPath = path.join(__dirname, 'all-jobs.json');
  fs.writeFileSync(outPath, JSON.stringify(allJobs));
  console.log(`[regen] all-jobs.json written (${allJobs.length} jobs, ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  console.error('[regen] Fatal:', err);
  process.exit(1);
});
