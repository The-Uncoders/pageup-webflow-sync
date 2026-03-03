const { initBrowser, closeBrowser, fetchAllJobIds, fetchJobDetails } = require('./scraper');

async function testScraper() {
  console.log('=== Testing PageUp Scraper ===\n');

  // Step 1: Initialize browser (solves WAF challenge)
  console.log('Step 1: Solving WAF challenge...');
  await initBrowser();
  console.log('Browser initialized.\n');

  // Step 2: Fetch all job IDs from listing page
  console.log('Step 2: Fetching listing page...');
  const jobs = await fetchAllJobIds();
  console.log(`Found ${jobs.length} jobs.\n`);

  // Show first 5 jobs
  console.log('Sample jobs:');
  for (const job of jobs.slice(0, 5)) {
    console.log(`  - [${job.jobId}] ${job.title}`);
  }
  console.log();

  // Step 3: Scrape a single job detail page
  if (jobs.length > 0) {
    const testJob = jobs[0];
    console.log(`Step 3: Scraping detail page for: ${testJob.title} (${testJob.jobId})...`);
    const detail = await fetchJobDetails(testJob.jobId, testJob.slug);

    console.log('\nJob detail:');
    console.log(`  Title:      ${detail.title}`);
    console.log(`  Job ID:     ${detail.jobId}`);
    console.log(`  Brand:      ${detail.brandName}`);
    console.log(`  Work Type:  ${detail.workType}`);
    console.log(`  Location:   ${detail.location}`);
    console.log(`  City:       ${detail.city}`);
    console.log(`  Country:    ${detail.country}`);
    console.log(`  Categories: ${detail.categories}`);
    console.log(`  Summary:    ${detail.summary?.substring(0, 100)}...`);
    console.log(`  Apply URL:  ${detail.applyUrl ? 'Yes' : 'No'}`);
    console.log(`  Refer URL:  ${detail.referUrl ? 'Yes' : 'No'}`);
    console.log(`  Closing:    ${detail.closingDate || 'Not specified'}`);
    console.log(`  Hero Image: ${detail.heroImage ? 'Yes' : 'No'}`);
    console.log(`  Video:      ${detail.videoUrl || 'None'}`);
    console.log(`  Desc HTML:  ${detail.descriptionHtml ? `${detail.descriptionHtml.length} chars` : 'None'}`);
  }

  await closeBrowser();
  console.log('\n=== Test complete ===');
}

testScraper().catch(err => {
  console.error('Test failed:', err);
  closeBrowser().finally(() => process.exit(1));
});
