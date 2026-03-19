const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'sync-log.json');
const FIELD_CONFIG = path.join(DATA_DIR, 'field-config.json');
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// --- Helpers ---

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
  } catch (_) {}
  return [];
}

function readFieldConfig() {
  try {
    if (fs.existsSync(FIELD_CONFIG)) {
      return JSON.parse(fs.readFileSync(FIELD_CONFIG, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function writeFieldConfig(config) {
  ensureDataDir();
  fs.writeFileSync(FIELD_CONFIG, JSON.stringify(config, null, 2));
}

// --- Routes ---

// Serve dashboard HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// GET /api/status — health and timing
app.get('/api/status', (req, res) => {
  const logs = readLogs();
  const latest = logs[0] || null;

  let health = 'unknown';
  let nextRunAt = null;

  if (latest) {
    const lastRunTime = new Date(latest.finishedAt || latest.startedAt).getTime();
    const msSinceLastRun = Date.now() - lastRunTime;

    if (latest.status === 'error') {
      health = 'error';
    } else if (latest.status === 'warning' || msSinceLastRun > 65 * 60 * 1000) {
      health = 'warning';
    } else if (latest.status === 'success' && msSinceLastRun <= 35 * 60 * 1000) {
      health = 'healthy';
    } else {
      health = 'warning';
    }

    // Estimate next run (last run + 30 min)
    nextRunAt = new Date(lastRunTime + SYNC_INTERVAL_MS).toISOString();
  }

  res.json({
    health,
    lastRun: latest,
    nextRunAt,
    totalRuns: logs.length,
  });
});

// GET /api/logs — all sync runs
app.get('/api/logs', (req, res) => {
  const logs = readLogs();
  res.json(logs);
});

// GET /api/logs/:id — single run detail
app.get('/api/logs/:id', (req, res) => {
  const logs = readLogs();
  const log = logs.find(l => l.id === req.params.id);
  if (!log) return res.status(404).json({ error: 'Log not found' });
  res.json(log);
});

// GET /api/fields — field mapping with config
app.get('/api/fields', (req, res) => {
  const config = readFieldConfig();
  res.json(config);
});

// PUT /api/fields/:slug — toggle a field
app.put('/api/fields/:slug', (req, res) => {
  const config = readFieldConfig();
  const slug = req.params.slug;

  if (!config[slug]) {
    return res.status(404).json({ error: `Field "${slug}" not found` });
  }

  // Prevent disabling required fields
  if (config[slug].required && req.body.enabled === false) {
    return res.status(400).json({ error: `Field "${slug}" is required and cannot be disabled` });
  }

  config[slug].enabled = req.body.enabled;
  writeFieldConfig(config);
  res.json(config[slug]);
});

// --- Start ---

const PORT = process.env.DASHBOARD_PORT || 3456;
app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  FCTG Careers — Sync Monitor Dashboard  │`);
  console.log(`  │  http://localhost:${PORT}                  │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
});
