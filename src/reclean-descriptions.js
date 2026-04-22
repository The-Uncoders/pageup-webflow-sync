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
 *   node src/reclean-descriptions.js              # dry-run — prints diff summary
 *   node src/reclean-descriptions.js --apply      # writes PATCHes + publishes
 *   node src/reclean-descriptions.js --limit 5    # only process first N items
 *   node src/reclean-descriptions.js --sample 3   # show before/after snippets
 *   node src/reclean-descriptions.js --restore <path>
 *                                                 # restore descriptions from
 *                                                 # a backup JSON file
 *
 * Safety:
 *   - Dry-run is the default. --apply is required to write anything.
 *   - Before any --apply run, writes a full backup of the current
 *     description for every live item to backups/reclean-backup-<ts>.json.
 *     If anything looks wrong, restore with:
 *         node src/reclean-descriptions.js --restore backups/reclean-backup-<ts>.json
 *   - Reads LIVE items (/items/live) so we see what visitors actually see.
 *   - PATCHes `description` only. Never touches slug or any other field.
 *   - Rate-limited by the WebflowClient's built-in 1.1s throttle.
 *   - After PATCHing, publishes to both custom domains + Webflow subdomain.
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const fs = require('fs');
const path = require('path');
const { WebflowClient } = require('./webflow');

// Expose cleanDescription from sync.js by temporarily monkey-requiring it.
function loadCleanDescription() {
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
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
  }
}

const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69a6a25d0ee880903952732b';
const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '691f361688f213d69817ead2';
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function parseArgs(argv) {
  const args = { apply: false, limit: Infinity, sample: 3, restore: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (a === '--restore') args.restore = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node src/reclean-descriptions.js [--apply] [--limit N] [--sample N] [--restore <path>]');
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

function writeBackup(items) {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `reclean-backup-${ts}.json`);
  const payload = {
    timestamp: new Date().toISOString(),
    siteId: WEBFLOW_SITE_ID,
    collectionId: COLLECTION_ID,
    itemCount: items.length,
    items: items.map((it) => ({
      id: it.id,
      slug: it.fieldData?.slug || '',
      name: it.fieldData?.name || '',
      description: it.fieldData?.description || '',
    })),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function runRestore(restorePath) {
  if (!WEBFLOW_API_TOKEN) {
    console.error('ERROR: WEBFLOW_API_TOKEN required');
    process.exit(1);
  }
  if (!fs.existsSync(restorePath)) {
    console.error(`ERROR: backup file not found: ${restorePath}`);
    process.exit(1);
  }
  const backup = JSON.parse(fs.readFileSync(restorePath, 'utf8'));
  if (!backup.items || !Array.isArray(backup.items)) {
    console.error('ERROR: backup file malformed — no items[] array');
    process.exit(1);
  }

  console.log('─'.repeat(72));
  console.log(`RESTORE from ${restorePath}`);
  console.log(`Backup timestamp:  ${backup.timestamp}`);
  console.log(`Backup items:      ${backup.itemCount}`);
  console.log('─'.repeat(72));

  const client = new WebflowClient(WEBFLOW_API_TOKEN, backup.siteId || WEBFLOW_SITE_ID);

  // Get current items to only PATCH items whose description differs from the backup
  console.log('Fetching current live items to diff against backup…');
  const current = await client.getLiveCollectionItems(backup.collectionId || COLLECTION_ID);
  const currentById = new Map(current.map((i) => [i.id, i]));

  const toPatch = [];
  let missing = 0;
  let identical = 0;
  for (const b of backup.items) {
    const cur = currentById.get(b.id);
    if (!cur) { missing++; continue; }
    const now = cur.fieldData?.description || '';
    if (now === b.description) { identical++; continue; }
    toPatch.push({ id: b.id, fieldData: { description: b.description } });
  }

  console.log(`Matched to current CMS: ${backup.itemCount - missing}`);
  console.log(`Already match backup:   ${identical}`);
  console.log(`Would restore:          ${toPatch.length}`);
  if (missing > 0) console.log(`Missing (no longer in CMS): ${missing}`);

  if (toPatch.length === 0) {
    console.log('Nothing to restore.');
    return;
  }

  console.log(`Restoring ${toPatch.length} items…`);
  const updated = await client.updateItems(backup.collectionId || COLLECTION_ID, toPatch);
  console.log(`Webflow confirmed ${updated.length} restores.`);

  console.log('Publishing site…');
  await client.publishSite();
  console.log('Restore complete.');
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.restore) {
    return runRestore(args.restore);
  }

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

  // Always write a backup when we're about to --apply, before anything else
  let backupPath = null;
  if (args.apply) {
    backupPath = writeBackup(items);
    console.log(`Backup written to: ${backupPath}`);
    console.log(`  → to rollback: node src/reclean-descriptions.js --restore ${path.relative(path.join(__dirname, '..'), backupPath)}`);
    console.log('');
  }

  const limitN = Math.min(items.length, args.limit);
  let changedCount = 0;
  let unchangedCount = 0;
  let emptyCount = 0;
  const diffs = [];
  const toPatch = [];

  for (let i = 0; i < limitN; i++) {
    const item = items[i];
    const fd = item.fieldData || {};
    const name = fd.name || '(no title)';
    const original = fd.description || '';

    if (!original.trim()) { emptyCount++; continue; }

    const cleaned = cleanDescription(original);
    if (cleaned === original) { unchangedCount++; continue; }

    changedCount++;
    diffs.push({ id: item.id, title: name, before: original, after: cleaned });
    toPatch.push({ id: item.id, fieldData: { description: cleaned } });
  }

  console.log(`Checked:        ${limitN} items`);
  console.log(`Would change:   ${changedCount}`);
  console.log(`Already clean:  ${unchangedCount}`);
  console.log(`Empty:          ${emptyCount}`);
  console.log('');

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
  console.log('');
  console.log(`If anything looks wrong, rollback with:`);
  console.log(`    node src/reclean-descriptions.js --restore ${path.relative(path.join(__dirname, '..'), backupPath)}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
