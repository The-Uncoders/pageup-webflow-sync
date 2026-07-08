/**
 * Feed shadow parity harness — READ-ONLY. No Webflow writes, no data-branch
 * pushes; safe to run alongside production at any time.
 *
 * Purpose: prove (or disprove) that the PageUp JSON feed can replace the
 * HTML scraper with exact fidelity, before any cutover. Each run:
 *
 *   1. Fetches the feed and builds jobDetails via src/feed.js.
 *   2. Runs the EXACT production transform (buildCmsFieldData + the same
 *      reference maps from the live Webflow CMS) on every feed job.
 *   3. Compares the result against what production actually published:
 *      per-job content hashes (sync-hashes.json from the data branch) and
 *      the live CMS items' fieldData.
 *   4. Writes feed-parity.json (uploaded as a workflow artifact) and prints
 *      a summary. Exit code is always 0 — this is instrumentation, not a
 *      gate; read the report.
 *
 * Set-difference entries double as the latency signal: a job present in the
 * feed but not yet in the CMS means the feed is AHEAD of the site (fine);
 * present in the CMS but missing from the feed means the feed LAGS the
 * listing the scraper reads — the thing that would block a cutover. A week
 * of reports answers Hamza's determining question (feed freshness vs the
 * current 10-min/4-h system).
 *
 * Known advisory diffs (do not block cutover):
 *   - description: Webflow normalises stored HTML, so string equality with
 *     the CMS is not expected; we compare collapsed text content instead.
 *   - slug: production never re-sends slug on updates, so long-lived jobs
 *     can legitimately differ from slugify(title) after a title edit.
 */

const fs = require('fs');
const path = require('path');
const { parse: parseHtml } = require('node-html-parser');
const { buildFeedJobDetails } = require('../src/feed');
const { buildCmsFieldData, buildReferenceMaps, hashFieldData } = require('../src/sync');
const { WebflowClient } = require('../src/webflow');

const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69a6a25d0ee880903952732b';
const HASHES_URL =
  'https://raw.githubusercontent.com/The-Uncoders/pageup-webflow-sync/data/sync-hashes.json';

// Text-level comparison for RichText fields where Webflow normalises the
// stored HTML: strip tags, collapse whitespace, compare content only.
function collapsedText(html) {
  if (!html) return '';
  return (parseHtml(String(html)).textContent || '').replace(/\s+/g, ' ').trim();
}

const asSet = v => (Array.isArray(v) ? v.slice().sort().join(',') : '');
const trunc = (v, n = 120) => {
  const s = String(v == null ? '' : v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

// Webflow's Video field stores an object ({url, metadata…}); the pipeline
// writes a plain URL string. Normalise both to the URL for comparison.
const videoUrlOf = v => {
  if (v && typeof v === 'object') return String(v.url || '');
  return String(v == null ? '' : v);
};

// Production's refer-url carries an &sHome=… return param (built from the
// job's Cloud Careers page URL) that the feed's EmployeeReferralUrl lacks
// and that can't be reconstructed from the title (PageUp slugs differ from
// ours 12/340). Hard-compare everything BEFORE the sHome param; report the
// sHome tail separately as advisory — it's a cutover decision (drop it, or
// repoint it at fctgcareers.com), not a data-fidelity gap.
const stripSHome = u => String(u == null ? '' : u).replace(/&sHome=.*$/i, '');

async function main() {
  if (!process.env.WEBFLOW_API_TOKEN) {
    throw new Error('WEBFLOW_API_TOKEN environment variable is required');
  }
  const client = new WebflowClient(process.env.WEBFLOW_API_TOKEN, process.env.WEBFLOW_SITE_ID);

  console.log('=== Feed shadow parity run (read-only) ===');
  const startedAt = new Date().toISOString();

  // Production reference maps — the same call runSync() makes.
  const refs = await buildReferenceMaps(client);

  // Feed side: full production transform per job.
  const { details, errors } = await buildFeedJobDetails();
  const feedJobs = new Map();
  for (const detail of details) {
    const fieldData = buildCmsFieldData(detail, refs);
    feedJobs.set(detail.jobId, { fieldData, hash: hashFieldData(fieldData) });
  }

  // Production side: live CMS items + last-written content hashes.
  const cmsItems = await client.getAllCollectionItems(COLLECTION_ID);
  const cmsByJobId = new Map();
  for (const item of cmsItems) {
    const jid = item.fieldData && item.fieldData['job-id'];
    if (jid && !cmsByJobId.has(String(jid))) cmsByJobId.set(String(jid), item);
  }
  let storedHashes = {};
  try {
    const res = await fetch(HASHES_URL);
    if (res.ok) storedHashes = await res.json();
  } catch (err) {
    console.warn(`[shadow] Could not load sync-hashes.json (${err.message}) — hash comparison skipped.`);
  }

  // ── Compare ──
  const onlyFeed = [...feedJobs.keys()].filter(id => !cmsByJobId.has(id));
  const onlyCms = [...cmsByJobId.keys()].filter(id => !feedJobs.has(id));

  const SCALARS = ['name', 'summary', 'category', 'closing-date', 'job-url',
    'apply-url', 'banner-image-link', 'brand', 'country'];
  const SETS = ['regions', 'locations', 'work-types'];

  const fieldMismatchCounts = {};
  const advisoryCounts = { description: 0, slug: 0, 'refer-url-shome': 0 };
  const mismatchedJobs = [];
  let hashMatches = 0;
  let hashComparable = 0;

  for (const [jobId, feedSide] of feedJobs) {
    const cmsItem = cmsByJobId.get(jobId);
    if (!cmsItem) continue;
    const cms = cmsItem.fieldData || {};
    const fd = feedSide.fieldData;
    const diffs = [];

    for (const f of SCALARS) {
      const a = (cms[f] == null ? '' : String(cms[f])).trim();
      const b = (fd[f] == null ? '' : String(fd[f])).trim();
      if (a !== b) diffs.push({ field: f, cms: trunc(a), feed: trunc(b) });
    }
    for (const f of SETS) {
      if (asSet(cms[f]) !== asSet(fd[f])) {
        diffs.push({ field: f, cms: trunc(asSet(cms[f])), feed: trunc(asSet(fd[f])) });
      }
    }

    // video: unwrap Webflow's stored object to its URL
    if (videoUrlOf(cms['video']) !== videoUrlOf(fd['video'])) {
      diffs.push({ field: 'video', cms: trunc(videoUrlOf(cms['video'])), feed: trunc(videoUrlOf(fd['video'])) });
    }

    // refer-url: hard-compare without the sHome tail; tail delta is advisory
    const cmsRefer = String(cms['refer-url'] == null ? '' : cms['refer-url']).trim();
    const fdRefer = String(fd['refer-url'] == null ? '' : fd['refer-url']).trim();
    if (stripSHome(cmsRefer) !== stripSHome(fdRefer)) {
      diffs.push({ field: 'refer-url', cms: trunc(cmsRefer), feed: trunc(fdRefer) });
    } else if (cmsRefer !== fdRefer) {
      advisoryCounts['refer-url-shome']++;
    }

    // Advisory comparisons — reported separately, expected to differ for
    // benign reasons (see header).
    const advisory = [];
    if (collapsedText(cms['description']) !== collapsedText(fd['description'])) {
      advisory.push('description');
      advisoryCounts.description++;
    }
    if ((cms['slug'] || '') !== (fd['slug'] || '')) {
      advisory.push('slug');
      advisoryCounts.slug++;
    }

    if (storedHashes[jobId]) {
      hashComparable++;
      if (storedHashes[jobId] === feedSide.hash) hashMatches++;
    }

    if (diffs.length) {
      for (const d of diffs) {
        fieldMismatchCounts[d.field] = (fieldMismatchCounts[d.field] || 0) + 1;
      }
      mismatchedJobs.push({ jobId, name: fd.name, diffs, advisory });
    }
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    feedCount: feedJobs.size,
    cmsCount: cmsByJobId.size,
    feedConversionErrors: errors,
    onlyInFeed: onlyFeed,      // feed ahead of site (new-job latency signal)
    onlyInCms: onlyCms,        // feed BEHIND the listing — cutover blocker if persistent
    hashComparable,
    hashMatches,
    fieldMismatchCounts,       // hard mismatches by field
    advisoryCounts,            // expected-noise comparisons (description/slug)
    mismatchedJobs,            // per-job detail, hard mismatches only
  };

  const outPath = path.join(__dirname, '..', 'feed-parity.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== Parity summary ===');
  console.log(`Jobs: feed ${report.feedCount} / CMS ${report.cmsCount}` +
    ` | only-in-feed ${onlyFeed.length} | only-in-CMS ${onlyCms.length}`);
  console.log(`Content-hash matches: ${hashMatches}/${hashComparable}` +
    (hashComparable === 0 ? ' (prod hash map empty — the CMS field diff is authoritative)' : ''));
  console.log(`Hard field mismatches: ${JSON.stringify(fieldMismatchCounts)}`);
  console.log(`Advisory (expected noise): ${JSON.stringify(advisoryCounts)}`);
  console.log(`Report written to ${outPath}`);
}

main().catch(err => {
  console.error('[shadow] Run failed:', err);
  process.exit(1);
});
