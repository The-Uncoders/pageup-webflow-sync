const { chromium } = require('playwright');
const { parse } = require('node-html-parser');
const locationToCountry = require('../location-to-country.json');

const BASE_URL = 'https://careers.fctgcareers.com';
const LISTING_URL = `${BASE_URL}/cw/en/listing/?page=1&page-items=500`;
const DETAIL_URL = (id, slug) => `${BASE_URL}/cw/en/job/${id}/${slug}`;
const CONCURRENCY = 3;
const REQUEST_DELAY_MS = 500;

// Shared browser context for WAF-authenticated requests
let _browserContext = null;
let _browser = null;

async function initBrowser(maxAttempts = 3) {
  if (_browser) return;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[scraper] Launching browser to solve WAF challenge (attempt ${attempt}/${maxAttempts})...`);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
      await page.goto(LISTING_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForFunction(
        () => document.querySelectorAll('.job-link').length > 0,
        { timeout: 30000 }
      );

      // Wait for all cookies to be set
      await sleep(3000);

      // Verify: use the browser's fetch to confirm cookies work
      const testOk = await page.evaluate(async (url) => {
        try {
          const res = await fetch(url);
          const text = await res.text();
          return !text.includes('challenge.js') && text.length > 5000;
        } catch { return false; }
      }, LISTING_URL);

      const cookies = await context.cookies();
      console.log(`[scraper] Got ${cookies.length} cookies. Verification: ${testOk ? 'PASS' : 'FAIL'}`);

      if (testOk) {
        await page.close();
        _browser = browser;
        _browserContext = context;
        return;
      }

      // Verification failed - close and retry
      await browser.close();
      if (attempt < maxAttempts) {
        console.warn('[scraper] WAF cookies not working, retrying...');
        await sleep(5000);
      }
    } catch (err) {
      await browser.close();
      if (attempt < maxAttempts) {
        console.warn(`[scraper] Browser init failed: ${err.message}, retrying...`);
        await sleep(5000);
      } else {
        throw err;
      }
    }
  }

  throw new Error('Failed to solve WAF challenge after all attempts');
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _browserContext = null;
  }
}

// Use full page navigation to fetch content (WAF requires real browser navigation)
async function fetchPage(url) {
  const page = await _browserContext.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    const html = await page.content();

    if (html.includes('challenge.js') && html.length < 5000) {
      throw new Error('Got WAF challenge page instead of content');
    }
    return html;
  } finally {
    await page.close();
  }
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchPage(url);
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[scraper] Retry ${attempt}/${retries} for ${url}: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllJobIds() {
  await initBrowser();
  console.log('[scraper] Fetching listing page via full navigation...');

  // Use page.goto() + DOM extraction instead of fetch() to ensure
  // the page fully renders with .job-link elements (WAF + JS rendering)
  const page = await _browserContext.newPage();
  try {
    await page.goto(LISTING_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.job-link').length > 0,
      { timeout: 30000 }
    );

    // Extract job links directly from the rendered DOM
    const jobs = await page.evaluate(() => {
      const links = document.querySelectorAll('.job-link');
      const seen = new Set();
      const results = [];
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/job\/(\d+)\/(.+)/);
        if (match && !seen.has(match[1])) {
          seen.add(match[1]);
          results.push({
            jobId: match[1],
            slug: match[2],
            title: link.textContent.trim(),
            href: href,
          });
        }
      }
      return results;
    });

    // Add full URL
    for (const job of jobs) {
      job.url = `${BASE_URL}${job.href}`;
      delete job.href;
    }

    console.log(`[scraper] Found ${jobs.length} unique jobs on listing page.`);
    return jobs;
  } finally {
    await page.close();
  }
}

function extractJobDetails(html, jobId) {
  const root = parse(html);
  const fcJobs = root.querySelector('.fc-jobs') || root;

  // Title - the job title is the h2 inside #job-content (not #pup-aside which has "Already Applied?")
  const jobContentEl = fcJobs.querySelector('#job-content');
  let title = '';
  if (jobContentEl) {
    const titleEl = jobContentEl.querySelector('h2') || jobContentEl.querySelector('h1');
    title = titleEl?.textContent?.trim() || '';
  }
  if (!title) {
    // Fallback: find first h2 that isn't a known non-title
    const skipTexts = ['already applied?', 'search results', 'current opportunities'];
    const allH2 = fcJobs.querySelectorAll('h2');
    for (const h2 of allH2) {
      const text = h2.textContent.trim();
      if (text && !skipTexts.includes(text.toLowerCase())) {
        title = text;
        break;
      }
    }
  }

  // Work type
  const workType = fcJobs.querySelector('.work-type')?.textContent?.trim() || '';

  // Location
  const location = fcJobs.querySelector('.location')?.textContent?.trim() || '';

  // Categories
  const categories = fcJobs.querySelector('.categories')?.textContent?.trim() || '';

  // Summary - from search results table
  const summaryRow = fcJobs.querySelector('tr.summary td');
  const summary = summaryRow?.textContent?.trim() || '';

  // Apply URL
  const applyEl = fcJobs.querySelector('.apply-link');
  const applyUrl = applyEl?.getAttribute('href') || '';

  // Refer URL
  const referEl = fcJobs.querySelector('.employee-referral-link');
  const referUrl = referEl?.getAttribute('href') || '';

  // Brand - from the search results table (3rd column)
  let brandName = '';
  const tables = fcJobs.querySelectorAll('table');
  for (const table of tables) {
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        // Check if this row contains the current job
        const link = row.querySelector('.job-link');
        if (link) {
          brandName = cells[2]?.textContent?.trim() || '';
          break;
        }
      }
    }
    if (brandName) break;
  }

  // Closing date - check multiple patterns:
  // 1. Text after "Applications close:" in the parent element
  // 2. A <time> element near "Applications close"
  // 3. The closing date from raw HTML (sometimes in a comment with a <time> tag)
  let closingDate = '';
  const allBold = fcJobs.querySelectorAll('b');
  for (const b of allBold) {
    if (b.textContent.includes('Applications close')) {
      const parent = b.parentNode;
      // Check for text content after the bold tag
      const fullText = parent.textContent;
      const match = fullText.match(/Applications close:\s*(.+)/);
      if (match && match[1].trim()) {
        closingDate = match[1].trim();
      }
      // Check for a <time> element in the parent
      if (!closingDate) {
        const timeEl = parent.querySelector('time');
        if (timeEl) {
          closingDate = timeEl.textContent.trim() || timeEl.getAttribute('datetime') || '';
        }
      }
      break;
    }
  }
  // Fallback: extract closing date from raw HTML comment pattern
  if (!closingDate) {
    const closingMatch = html.match(/Applications close:<\/b>\s*(?:<[^>]*>)*\s*(\d{1,2}\s+\w+\s+\d{4})/);
    if (closingMatch) closingDate = closingMatch[1].trim();
  }

  // Description HTML - the job details div content
  const jobDetails = fcJobs.querySelector('#job-details') || fcJobs.querySelector('.job-details');
  let descriptionHtml = '';
  if (jobDetails) {
    descriptionHtml = jobDetails.innerHTML.trim();
  } else {
    // Fallback: get content between the metadata and the "Applications close" section
    const summaryEl = fcJobs.querySelector('.summary');
    if (summaryEl) {
      // The summary div often IS the description container in PageUp
      descriptionHtml = summaryEl.innerHTML.trim();
    }
  }

  // Hero image
  let heroImage = '';
  const images = fcJobs.querySelectorAll('img');
  for (const img of images) {
    const src = img.getAttribute('src') || '';
    if (src.includes('pageuppeople.com') || src.includes('publicstorage')) {
      heroImage = src;
      break;
    }
  }

  // Video
  let videoUrl = '';
  const iframes = fcJobs.querySelectorAll('iframe');
  for (const iframe of iframes) {
    const src = iframe.getAttribute('src') || '';
    if (src.includes('youtube.com') || src.includes('vimeo.com')) {
      // Convert embed URL to watch URL
      const embedMatch = src.match(/youtube\.com\/embed\/([^?&]+)/);
      if (embedMatch) {
        videoUrl = `https://www.youtube.com/watch?v=${embedMatch[1]}`;
      } else {
        videoUrl = src;
      }
      break;
    }
  }

  // Parse city and country from location
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

  // Fallback: resolve country from location-to-country mapping
  // This handles locations that are states/territories/provinces/cities without country names
  // (e.g. "New South Wales" → Australia, "California" → United States)
  const _knownCountries = new Set(Object.values(locationToCountry).map(c => c.toLowerCase()));
  if (location && (!country || !_knownCountries.has(country.toLowerCase()))) {
    let resolved = null;

    // Try the full location string first (handles single-value like "Queensland")
    resolved = locationToCountry[location.toLowerCase().trim()] || null;

    // Try each comma-separated part (handles "ACT, NSW, NT, ..." multi-location strings)
    if (!resolved && location.includes(',')) {
      for (const part of location.split(',').map(p => p.trim())) {
        const match = locationToCountry[part.toLowerCase()];
        if (match) { resolved = match; break; }
      }
    }

    // Try the city value (handles cases where city was extracted from "City, Suburb")
    if (!resolved && city) {
      resolved = locationToCountry[city.toLowerCase().trim()] || null;
    }

    if (resolved) {
      country = resolved;
    }
  }

  // Extract hashtags from the job post (typically white text at the bottom of the description)
  // These are LinkedIn tracking tags used to identify brands, e.g. #FCM, #CTAU, #DSVA
  const hashtags = [];
  const fullText = fcJobs.textContent || '';
  const hashtagMatches = fullText.match(/#[A-Za-z0-9]+/g);
  if (hashtagMatches) {
    for (const tag of hashtagMatches) {
      const upper = tag.toUpperCase();
      if (!hashtags.includes(upper)) hashtags.push(upper);
    }
  }

  return {
    jobId,
    title,
    workType,
    location,
    city,
    country,
    categories: categories.split(',').map(c => c.trim()).filter(Boolean).join(', '),
    summary,
    applyUrl,
    referUrl,
    brandName,
    closingDate,
    descriptionHtml,
    heroImage,
    videoUrl,
    hashtags,
  };
}

async function fetchJobDetails(jobId, slug) {
  const url = DETAIL_URL(jobId, slug);
  const html = await fetchWithRetry(url);
  return extractJobDetails(html, jobId);
}

async function scrapeAllJobs(jobsToScrape) {
  await initBrowser();
  console.log(`[scraper] Scraping ${jobsToScrape.length} job detail pages (concurrency: ${CONCURRENCY})...`);
  const results = [];
  const errors = [];

  // Process in batches for controlled concurrency
  for (let i = 0; i < jobsToScrape.length; i += CONCURRENCY) {
    const batch = jobsToScrape.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(job => fetchJobDetails(job.jobId, job.slug))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const job = batch[j];
        console.error(`[scraper] Failed to scrape job ${job.jobId}: ${result.reason.message}`);
        errors.push({ jobId: job.jobId, error: result.reason.message });
      }
    }

    if (i + CONCURRENCY < jobsToScrape.length) {
      await sleep(REQUEST_DELAY_MS);
    }

    // Progress logging
    const done = Math.min(i + CONCURRENCY, jobsToScrape.length);
    if (done % 50 === 0 || done === jobsToScrape.length) {
      console.log(`[scraper] Progress: ${done}/${jobsToScrape.length} detail pages scraped.`);
    }
  }

  console.log(`[scraper] Scraping complete. ${results.length} succeeded, ${errors.length} failed.`);
  return { results, errors };
}

module.exports = {
  initBrowser,
  closeBrowser,
  fetchAllJobIds,
  fetchJobDetails,
  scrapeAllJobs,
  extractJobDetails,
};
