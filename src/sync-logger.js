const fs = require('fs');
const path = require('path');

// Persistent data directory — iCloud-synced project folder (works across Macs)
// Falls back to repo-local data/ in CI or if project folder doesn't exist
const ICLOUD_DATA_DIR = path.join(
  process.env.HOME || '/tmp',
  'Desktop', 'Claude Central', 'Page Up Styling', 'data'
);
const LOCAL_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = fs.existsSync(path.dirname(ICLOUD_DATA_DIR)) ? ICLOUD_DATA_DIR : LOCAL_DATA_DIR;
const LOG_FILE = path.join(DATA_DIR, 'sync-log.json');
const MAX_ENTRIES = 100;

// Derive sync source from the CI environment so the dashboard can
// distinguish automatic (cron) from manual (dashboard/API) runs.
function detectSource() {
  var event = process.env.GITHUB_EVENT_NAME;
  if (event === 'schedule') return 'scheduled';
  if (event === 'workflow_dispatch' || event === 'repository_dispatch') return 'manual';
  if (process.env.GITHUB_ACTIONS === 'true') return 'ci'; // unknown CI trigger
  return 'local';
}

class SyncLogger {
  constructor() {
    this.record = {
      id: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      durationMs: 0,
      status: 'running',
      error: null,
      source: detectSource(),
      pageupJobsFound: 0,
      cmsItemsBefore: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      createdJobs: [],
      updatedJobs: [],
      deletedJobs: [],
      scrapeErrors: [],
      published: false,
    };
  }

  start() {
    this.record.startedAt = new Date().toISOString();
    console.log(`[logger] Sync run started: ${this.record.id}`);
  }

  recordPageupScrape(count) {
    this.record.pageupJobsFound = count;
  }

  recordCmsState(count) {
    this.record.cmsItemsBefore = count;
  }

  recordDiff({ newJobs = [], removedJobs = [], existingCount = 0 }) {
    this.record.created = newJobs.length;
    this.record.deleted = removedJobs.length;
    // unchanged will be calculated at finish
    this._pendingNewJobs = newJobs;
    this._pendingRemovedJobs = removedJobs;
    this._existingCount = existingCount;
  }

  recordCreated(items) {
    this.record.createdJobs = items.map(i => ({
      jobId: i.jobId || i.fieldData?.['job-id'] || 'unknown',
      title: i.title || i.fieldData?.name || 'Unknown',
    }));
    this.record.created = this.record.createdJobs.length;
  }

  recordUpdated(items) {
    this.record.updatedJobs = items.map(i => ({
      jobId: i.jobId || i.fieldData?.['job-id'] || 'unknown',
      title: i.title || i.fieldData?.name || 'Unknown',
      changedFields: i.changedFields || [],
    }));
    this.record.updated = this.record.updatedJobs.length;
  }

  recordDeleted(items) {
    this.record.deletedJobs = items.map(i => ({
      jobId: i.jobId || i['job-id'] || 'unknown',
      title: i.title || i.name || 'Unknown',
    }));
    this.record.deleted = this.record.deletedJobs.length;
  }

  recordScrapeError(jobId, error) {
    this.record.scrapeErrors.push({ jobId, error: String(error) });
  }

  recordPublished(success) {
    this.record.published = success;
  }

  async finish(status = 'success', error = null) {
    this.record.finishedAt = new Date().toISOString();
    this.record.durationMs = new Date(this.record.finishedAt) - new Date(this.record.startedAt);
    this.record.status = status;
    this.record.error = error;

    // Calculate unchanged
    this.record.unchanged = Math.max(
      0,
      this.record.cmsItemsBefore - this.record.deleted - this.record.updated
    );

    // Determine warning status
    if (status === 'success' && this.record.scrapeErrors.length > 0) {
      this.record.status = 'warning';
    }

    console.log(`[logger] Sync finished: ${status} (${this.record.durationMs}ms) — ` +
      `+${this.record.created} -${this.record.deleted} ~${this.record.updated}`);

    await this._writeLog();
  }

  async _writeLog() {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      // Read existing log
      let logs = [];
      if (fs.existsSync(LOG_FILE)) {
        try {
          logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        } catch (_) {
          logs = [];
        }
      }

      // Prepend new record (newest first)
      logs.unshift(this.record);

      // Trim to max entries
      if (logs.length > MAX_ENTRIES) {
        logs = logs.slice(0, MAX_ENTRIES);
      }

      // Write atomically
      const tmpFile = LOG_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(logs, null, 2));
      fs.renameSync(tmpFile, LOG_FILE);
    } catch (err) {
      // Silently skip in CI or if data dir is not writable
      console.warn(`[logger] Could not write sync log: ${err.message}`);
    }
  }
}

module.exports = { SyncLogger };
