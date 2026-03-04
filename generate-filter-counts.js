/**
 * Generate filter-counts.json from the current CMS data.
 * This file is fetched by the frontend to display accurate filter counts
 * without relying on DOM parsing (which only sees 30 items).
 *
 * Output: filter-counts.json with regions, cities, categories, and lookup maps.
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
  console.log('[filter-counts] Fetching CMS data...');

  // Fetch country items to build ID → name map
  const countryItems = await fetchAllItems(COUNTRY_COLLECTION_ID);
  const countryIdToName = {};
  for (const item of countryItems) {
    countryIdToName[item.id] = item.fieldData?.name || '';
  }

  // Fetch all job items
  const jobItems = await fetchAllItems(COLLECTION_ID);
  console.log(`[filter-counts] Processing ${jobItems.length} job items...`);

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

    // Count region
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
      // Split comma-separated categories
      const catParts = cat.split(',').map(c => c.trim()).filter(Boolean);
      for (const cp of catParts) {
        const catk = cp.toLowerCase();
        categories[catk] = (categories[catk] || 0) + 1;
        if (!categoryDisplay[catk]) categoryDisplay[catk] = cp;
      }
    }
  }

  const counts = {
    regions,
    cities,
    categories,
    cityToRegion,
    cityDisplay,
    categoryDisplay,
  };

  const outPath = path.join(__dirname, 'filter-counts.json');
  fs.writeFileSync(outPath, JSON.stringify(counts, null, 2));
  console.log(`[filter-counts] Written to ${outPath}`);
  console.log('[filter-counts] Regions:', JSON.stringify(regions));
}

main().catch(e => console.error(e));
