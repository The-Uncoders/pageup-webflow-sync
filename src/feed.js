/**
 * PageUp JSON feed adapter — the scraper's designated successor.
 *
 * Reads the official jobs feed PageUp supplied on 2026-07-11 (survives the
 * Cloud Careers decommission) and converts each feed entry into the SAME
 * jobDetail shape `extractJobDetails()` produces from a scraped detail page,
 * so `buildCmsFieldData()` consumes either source interchangeably.
 *
 * Field mapping notes (all verified against the live pipeline 2026-07-11 —
 * see PROJECT-DOCUMENTATION.md § "PageUp JSON feed"):
 *   - The feed's `Brand` field is PageUp's internal DIVISION
 *     (Leisure/Corporate/…). The brand label the careers site displays
 *     travels as `Department` — equal to the listing's brand column
 *     340/340 verbatim. So brandName ← Department.
 *   - `LocationList` entries are "Region|City" pairs; the cities joined
 *     with ", " reproduce the scraped location string 340/340.
 *   - `Overview` is the full rich-HTML description, carrying the banner
 *     <img> assets and the #LI-… brand hashtags the resolver relies on.
 *   - `ClosingDateUtc` is a .NET JSON date (/Date(ms)/) in UTC;
 *     `ClosingDateUtcOffset` (hours) shifts it to the job's local date.
 */

const { parse: parseHtml } = require('node-html-parser');
const { pickLiveBanner } = require('./scraper');
const locationToCountry = require('../location-to-country.json');

const FEED_URL = process.env.FEED_URL ||
  'https://careers.pageuppeople.com/889/cw/en/jobs.json';

// Matches the scraper's detail-page concurrency ethos; banner HEAD-probing
// is the only network work per job here, so a little higher is fine.
const CONCURRENCY = 10;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The feed ships plain-text fields with HTML entities still encoded
 * (e.g. "&#128674;" for 🚢 in summaries) — the scraper never saw those
 * because the browser's textContent decoded them. node-html-parser's
 * textContent performs the same decoding.
 */
function decodeText(value) {
  const s = String(value == null ? '' : value);
  if (!s) return '';
  return parseHtml(s).textContent.trim();
}

/**
 * Format the feed's .NET-style closing date the way the careers site
 * renders it (and production stores it): "21 Jul 2026  Romance Daylight
 * Time" — local calendar date (UTC instant shifted by the job's offset
 * hours), two spaces, then the timezone display name when present.
 */
function formatClosingDate(job) {
  const m = /\/Date\((-?\d+)\)\//.exec(job.ClosingDateUtc || '');
  if (!m) return '';
  const offsetHours = Number(job.ClosingDateUtcOffset) || 0;
  const shifted = new Date(Number(m[1]) + offsetHours * 3600 * 1000);
  const dateStr = `${String(shifted.getUTCDate()).padStart(2, '0')} ${MONTHS[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}`;
  const tz = (job.ClosingDateTimeZone || '').trim();
  return tz ? `${dateStr}  ${tz}` : dateStr;
}

/**
 * City/country derivation — copied verbatim from extractJobDetails() so a
 * feed-sourced job resolves its Country reference identically to a scraped
 * one (same split rules, same location-to-country fallback map).
 */
function parseCityCountry(location) {
  let city = '';
  let country = '';
  if (location) {
    const parts = location.split(',').map(p => p.trim());
    if (parts.length >= 2) {
      city = parts[0];
      country = parts[parts.length - 1];
    } else {
      city = location;
    }
  }

  const _knownCountries = new Set(Object.values(locationToCountry).map(c => c.toLowerCase()));
  if (location && (!country || !_knownCountries.has(country.toLowerCase()))) {
    let resolved = null;
    resolved = locationToCountry[location.toLowerCase().trim()] || null;
    if (!resolved && location.includes(',')) {
      for (const part of location.split(',').map(p => p.trim())) {
        const match = locationToCountry[part.toLowerCase()];
        if (match) { resolved = match; break; }
      }
    }
    if (!resolved && city) {
      resolved = locationToCountry[city.toLowerCase().trim()] || null;
    }
    if (resolved) country = resolved;
  }

  return { city, country };
}

async function fetchFeedJobs() {
  const res = await fetch(FEED_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Feed fetch failed: HTTP ${res.status}`);
  const jobs = await res.json();
  if (!Array.isArray(jobs)) throw new Error('Feed did not return a JSON array');
  console.log(`[feed] Fetched ${jobs.length} jobs from ${FEED_URL}`);
  return jobs;
}

/**
 * Convert one feed entry into the jobDetail shape extractJobDetails()
 * returns. `heroImage` is set to the first candidate here; callers that
 * want the validated banner run pickLiveBanner() (see buildFeedJobDetails).
 */
function feedJobToDetail(job) {
  const jobId = String(job.Id);
  const overview = (job.Overview || '').trim();
  const root = parseHtml(overview);

  // Location string: LocationList "Region|City" → cities joined ", "
  // (== the listing page's location cell, verified 340/340).
  const location = (job.LocationList || [])
    .map(p => decodeText(String(p).split('|').pop()))
    .filter(Boolean)
    .join(', ');
  const { city, country } = parseCityCountry(location);

  // Same normalisation the scraper applies to the .categories cell.
  const categories = decodeText(job.Categories)
    .split(',').map(c => c.trim()).filter(Boolean).join(', ');

  // Banner candidates: PageUp-hosted images in document order, exactly as
  // the scraper collects them from #job-details.
  const heroImageCandidates = [];
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (src.includes('publicstorage') && src.match(/\.(png|jpg|jpeg|gif|webp)/i)) {
      heroImageCandidates.push(src);
    }
  }

  // Video: first YouTube/Vimeo iframe, embed URL converted to watch URL.
  let videoUrl = '';
  for (const iframe of root.querySelectorAll('iframe')) {
    const src = iframe.getAttribute('src') || '';
    if (src.includes('youtube.com') || src.includes('vimeo.com')) {
      const embedMatch = src.match(/youtube\.com\/embed\/([^?&]+)/);
      videoUrl = embedMatch ? `https://www.youtube.com/watch?v=${embedMatch[1]}` : src;
      break;
    }
  }

  // Brand hashtags (#FCM, #CTAU, …) — same regex the scraper runs over the
  // rendered page text; on the feed side they live in the Overview HTML.
  const hashtags = [];
  const hashtagMatches = (root.textContent || '').match(/#[A-Za-z0-9]+/g);
  if (hashtagMatches) {
    for (const tag of hashtagMatches) {
      const upper = tag.toUpperCase();
      if (!hashtags.includes(upper)) hashtags.push(upper);
    }
  }

  return {
    jobId,
    title: decodeText(job.Title),
    workType: decodeText(job.WorkType),
    location,
    city,
    country,
    categories,
    summary: decodeText(job.Summary),
    // NOTE: production's refer-url additionally carries an &sHome=… return
    // param pointing at the job's Cloud Careers page (PageUp's own slug,
    // which is NOT derivable from the title — 12/340 differ). The gateway
    // URL and IDs are identical; at cutover, decide whether to keep sHome
    // (needs the RSS <link> for the slug) or drop/repoint it.
    applyUrl: (job.ApplyUrl || '').trim(),
    referUrl: (job.EmployeeReferralUrl || '').trim(),
    brandName: decodeText(job.Department),
    closingDate: formatClosingDate(job),
    descriptionHtml: overview,
    heroImage: heroImageCandidates[0] || '',
    heroImageCandidates,
    videoUrl,
    hashtags,
  };
}

/**
 * Convert one feed entry into the listing-row shape fetchAllJobIds()
 * returns ({ jobId, slug, title, location, brand, url }). This is what the
 * sync's diff layer consumes; in feed mode `slug`/`url` are unused (no
 * detail page to fetch) and left empty.
 */
function feedJobToListing(job) {
  return {
    jobId: String(job.Id),
    slug: '',
    title: decodeText(job.Title),
    location: (job.LocationList || [])
      .map(p => decodeText(String(p).split('|').pop()))
      .filter(Boolean)
      .join(', '),
    brand: decodeText(job.Department),
    url: '',
  };
}

/**
 * Build fully-validated jobDetails for a set of raw feed entries (banners
 * HEAD-probed via pickLiveBanner, batched). Mirrors scrapeAllJobs()'s
 * result contract: { results, errors }.
 */
async function buildDetailsForFeedJobs(feedJobs) {
  const results = [];
  const errors = [];

  for (let i = 0; i < feedJobs.length; i += CONCURRENCY) {
    const batch = feedJobs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (job) => {
      const detail = feedJobToDetail(job);
      detail.heroImage = await pickLiveBanner(detail.heroImageCandidates, detail.jobId);
      return detail;
    }));
    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === 'fulfilled') {
        results.push(settled[j].value);
      } else {
        errors.push({ jobId: String(batch[j].Id), error: String(settled[j].reason) });
      }
    }
  }

  if (errors.length) {
    console.warn(`[feed] ${errors.length} job(s) failed to convert:`,
      errors.map(e => e.jobId).join(', '));
  }
  return { results, errors };
}

/**
 * Fetch the feed and build details for every job. Kept for the shadow
 * harness; returns { details, errors }.
 */
async function buildFeedJobDetails() {
  const feedJobs = await fetchFeedJobs();
  const { results, errors } = await buildDetailsForFeedJobs(feedJobs);
  return { details: results, errors };
}

module.exports = {
  FEED_URL,
  fetchFeedJobs,
  feedJobToDetail,
  feedJobToListing,
  buildDetailsForFeedJobs,
  buildFeedJobDetails,
  formatClosingDate,
};
