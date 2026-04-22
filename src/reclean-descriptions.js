#!/usr/bin/env node
/**
 * One-shot: re-clean description HTML for existing CMS items.
 *
 * Fast-sync skips detail-scraping for unchanged jobs, so improvements to
 * cleanDescription() only get applied to NEW jobs. This script back-fills
 * the existing catalog by running the current cleanDescription() against
 * each CMS item's stored `description` and PATCHing only items that
 * actually change.
 *
 * Usage:
 *   node src/reclean-descriptions.js              # dry-run — prints diff summary, no writes
 *   node src/reclean-descriptions.js --apply      # writes PATCHes + publishes
 *   node src/reclean-descriptions.js --limit 5    # only process first N items
 *   node src/reclean-descriptions.js --sample 3   # show before/after snippets for N items
 *
 * Safety:
 *   - Dry-run is the default. --apply is required to write anything.
 *   - Reads LIVE items (/items/live) so we see what visitors actually see.
 *   - Patches via PATCH /items — description only, never touches slug or
 *     any other field.
 *   - Rate-limited by the WebflowClient's built-in 1.1s throttle.
 *   - After PATCHing, publishes to both custom domains + subdomain.
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const path = require('path');
const { WebflowClient } = require('./webflow');

// Expose cleanDescription from sync.js by temporarily monkey-requiring it.
// sync.js doesn't export it, so we use the trick of loading the file and
// grabbing the function from its internal scope via a re-require with an
// augmented module.exports.
function loadCleanDescription() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8');
  const tmpPath = path.join(__dirname, '_sync_reclean_tmp.js');
  const augmented = src.replace(
    'module.exports = { runSync };',
    'module.exports = { runSync, cleanDescription };'
  );
  fs.writeFileSync(tmpPath, augmented);
  try {
    return require(tmpPath).cleanDescription;
  } finally {
    // Clean up temp file immediately — module is cached in memory
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
  }
}

const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69a6a25d0ee880903952732b';
const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '691f361688f213d69817ead2';

function parseArgs(argv) {
  const args = { apply: false, limit: Infinity, sample: 3 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node src/reclean-descriptions.js [--apply] [--limit N] [--sample N]`);
      process.exit(0);
    }
  }
  return args;
}

function truncate(s, n = 220) {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : flat.slice(0, n) + '…';
}

async function main() {
  const args = parseArgs(process.argv);

  if (!WEBFLOW_API_TOKEN) {
    console.error('ERROR: WEBFLOW_API_TOKEN environment variable is required');
    process.exit(1);
  }

  const cleanDescription = loadCleanDescription();
  if (typeof cleanDescription !== 'function') {
    console.error('ERROR: could not load cleanDescription from sync.js');
    process.exit(1);
  }

  const client = new WebflowClient(WEBFLOW_API_TOKEN, WEBFLOW_SITE_ID);

  console.log('─'.repeat(72));
  console.log(`reclean-descriptions — mode: ${args.apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log('─'.repeat(72));

  console.log('Fetching live CMS items…');
  const items = await client.getLiveCollectionItems(COLLECTION_ID);
  console.log(`Fetched ${items.length} live items.`);

  const limitN = Math.min(items.length, args.limit);
  let changedCount = 0;
  let unchangedCount = 0;
  let emptyCount = 0;
  const diffs = []; // { id, title, before, after }
  const toPatch = [];

  for (let i = 0; i < limitN; i++) {
    const item = items[i];
    const fd = item.fieldData || {};
    const name = fd.name || '(no title)';
    const original = fd.description || '';

    if (!original.trim()) {
      emptyCount++;
      continue;
    }

    const cleaned = cleanDescription(original);
    if (cleaned === original) {
      unchangedCount++;
      continue;
    }

    changedCount++;
    diffs.push({ id: item.id, title: name, before: original, after: cleaned });
    toPatch.push({
      id: item.id,
      fieldData: { description: cleaned },
    });
  }

  console.log('');
  console.log(`Checked:        ${limitN} items`);
  console.log(`Would change:   ${changedCount}`);
  console.log(`Already clean:  ${unchangedCount}`);
  console.log(`Empty:          ${emptyCount}`);
  console.log('');

  // Sample a few diffs for eyeballing
  const toShow = diffs.slice(0, Math.max(0, args.sample));
  if (toShow.length) {
    console.log(`Showing ${toShow.length} sample diff${toShow.length === 1 ? '' : 's'}:`);
    console.log('');
    for (const d of toShow) {
      console.log('  ╭─ ' + d.title);
      console.log('  │ BEFORE: ' + truncate(d.before, 260));
      console.log('  │ AFTER:  ' + truncate(d.after, 260));
      console.log('  ╰─');
      console.log('');
    }
  }

  if (!args.apply) {
    console.log('DRY-RUN complete. Re-run with --apply to PATCH the CMS.');
    return;
  }

  if (toPatch.length === 0) {
    console.log('Nothing to patch.');
    return;
  }

  console.log(`Applying ${toPatch.length} PATCHes…`);
  const updated = await client.updateItems(COLLECTION_ID, toPatch);
  console.log(`Webflow confirmed ${updated.length} updates.`);

  console.log('Publishing site to propagate changes to /items/live…');
  await client.publishSite();
  console.log('Publish requested.');

  console.log('');
  console.log('Done. Allow ~30s for /items/live to reflect the publish.');
  console.log('The next regular sync will purge the jsDelivr CDN caches.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
