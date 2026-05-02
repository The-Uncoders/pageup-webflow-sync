/* ───────────────────────────────────────────────────────────────────
   FCTG Sync Monitor — dashboard JS
   Loaded by Webflow embed-loader.html on /internal/jobs-dashboard
   Served via jsDelivr from main; updates within ~10 min of git push

   Required globals (set by the Webflow loader before this file runs):
     window.__FCTG_SYNC_KEY  — auth gate for the Cloudflare Worker

   Renders the entire dashboard markup into #fctg-dashboard, then
   hooks up data loading, polling, and action handlers.
   ─────────────────────────────────────────────────────────────────── */

(function () {
  // ─────────────── Configuration ───────────────
  var WORKER_URL = 'https://fctg-sync-trigger.wandering-sun-9809.workers.dev';
  var SYNC_KEY = window.__FCTG_SYNC_KEY || '';
  var DATA_BASE_CDN = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data';
  var DATA_BASE_RAW = 'https://raw.githubusercontent.com/The-Uncoders/pageup-webflow-sync/data';
  var WEBFLOW_BASE = 'https://www.fctgcareers.com';
  var PAGEUP_BASE = 'https://careers.fctgcareers.com';
  var SYNC_INTERVAL_MS = 20 * 60 * 1000;

  // ─────────────── Markup ───────────────
  var DASHBOARD_HTML = [
    '<header class="fd-header">',
      '<div><span class="fd-dot" id="fd-dot"></span><h1 style="display:inline">FCTG Careers — Sync Monitor</h1></div>',
      '<div><span class="fd-status-msg" id="fd-status-msg">Loading…</span></div>',
    '</header>',
    '<nav class="fd-tabs">',
      '<button class="fd-tab-btn" data-tab="sync" data-active>Sync Status</button>',
      '<button class="fd-tab-btn" data-tab="jobs">Job Comparison</button>',
      '<button class="fd-tab-btn" data-tab="about">About This App</button>',
    '</nav>',

    // ────────── TAB 1 ──────────
    '<div class="fd-tab-panel" data-tab="sync" data-active>',
      '<div class="fd-cards" id="fd-cards"><div class="fd-loading">Loading…</div></div>',
      '<div class="fd-section">',
        '<h2>📋 Sync History <span class="fd-badge neutral" id="fd-history-count" style="font-weight:500"></span></h2>',
        '<p style="font-size:13px">Click any run with changes to see which jobs were added, updated or removed.</p>',
        '<table class="fd-history">',
          '<thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>PageUp</th><th>Live</th><th>Changes</th><th>Trigger</th></tr></thead>',
          '<tbody id="fd-history-body"><tr><td colspan="7" class="fd-loading">Loading sync history…</td></tr></tbody>',
        '</table>',
      '</div>',
      '<div class="fd-section">',
        '<h2>⚡ Manual Actions</h2>',
        '<p>Use these when content has changed in PageUp and you want the site updated without waiting for the next scheduled run.</p>',
        '<div style="display:flex;gap:12px;flex-wrap:wrap">',
          '<button class="fd-btn primary" id="fd-btn-run-sync">▶ Run Sync Now</button>',
          '<button class="fd-btn dark" id="fd-btn-force-full">🔄 Force Full Rescrape <span class="fd-badge warning" style="margin-left:4px">~10 min</span></button>',
          '<button class="fd-btn" id="fd-btn-purge-cdn">🧹 Purge CDN Cache</button>',
          '<span id="fd-action-msg" style="font-size:13px;color:#6b7280;align-self:center"></span>',
        '</div>',
        '<div class="fd-actions-grid">',
          '<div><div class="fd-action-name">Run Sync Now</div><div class="fd-action-time">~1 minute</div></div>',
          '<div>Adds any newly posted jobs to the site and removes any that were taken down in PageUp. Use it when you\'ve just added or deleted a role and don\'t want to wait for the next automatic check.</div>',
          '<div><div class="fd-action-name">Force Full Rescrape</div><div class="fd-action-time">~10 minutes</div></div>',
          '<div>Re-reads every job from PageUp from scratch and updates the site if anything has changed. Use it when you\'ve edited an existing role — swapped a banner, tweaked the description, changed a category — and that change hasn\'t shown up after a regular sync.</div>',
          '<div><div class="fd-action-name">Purge CDN Cache</div><div class="fd-action-time">a few seconds</div></div>',
          '<div>Clears saved copies of the listings data so the site loads fresh information from scratch. Rarely needed — the system does this automatically after every sync. Use it only if a sync just finished but the listings page still shows old data (for example, a job you removed in PageUp is still appearing on the site).</div>',
        '</div>',
      '</div>',
    '</div>',

    // ────────── TAB 2 ──────────
    '<div class="fd-tab-panel" data-tab="jobs">',
      '<div class="fd-section">',
        '<h2>🔍 Per-job actions <span class="fd-badge neutral" style="font-weight:500" id="fd-jobs-count"></span></h2>',
        '<p>One row per live job. Use <strong>Force re-sync this job</strong> on a single role to push its latest PageUp content to the site without waiting for a full sync (~30–60 seconds per job).</p>',
        '<div class="fd-filter-bar">',
          '<input type="search" id="fd-jobs-search" placeholder="Search by title, brand, or location…">',
          '<select id="fd-jobs-region"><option value="">All regions</option></select>',
          '<select id="fd-jobs-brand"><option value="">All brands</option></select>',
          '<span class="fd-count" id="fd-jobs-shown"></span>',
        '</div>',
        '<div id="fd-jobs-list"><div class="fd-loading">Loading jobs…</div></div>',
      '</div>',
    '</div>',

    // ────────── TAB 3 ──────────
    '<div class="fd-tab-panel" data-tab="about">',
      '<div class="fd-section">',
        '<h2>👋 What this app does</h2>',
        '<p>This app keeps the Flight Centre Careers site (<strong>fctgcareers.com</strong>) in sync with PageUp every 20 minutes. PageUp is the source of truth — recruiters add and edit roles there, and the app pulls those changes onto the public site automatically. It also <strong>cleans up</strong> some of PageUp\'s exported HTML so every job ad displays consistently in the same brand layout, no matter which recruiter set it up or how they styled it.</p>',
        '<p>This page lets you see what\'s been synced, spot any roles that look out of date, and check what cleanup rules are active.</p>',
      '</div>',
      '<div class="fd-section">',
        '<h2>⚙️ Active processing rules</h2>',
        '<p>Each rule below describes one transformation we apply between PageUp and Webflow. Some are structural (always on, would break things if disabled); others are presentational. Get in touch with Singulo if you want any of these flipped — changes need a full rescrape to apply across all jobs.</p>',
        '<table class="fd-rules">',
          '<thead><tr><th>Rule</th><th>What it does</th><th style="text-align:center;width:80px">Status</th></tr></thead>',
          '<tbody>',
            renderRuleRow('Heading consolidation', '', 'PageUp\'s WYSIWYG wraps section headings in &lt;h3&gt; tags but renders them at body size. Webflow renders &lt;h3&gt; at its much larger default size, so we demote H1–H5 to H6 (≈ 16px bold) to match what the recruiter sees in PageUp.'),
            renderRuleRow('Paragraph spacing normalisation', '', 'Different recruiters produce wildly different HTML — some use proper &lt;p&gt; tags, some use &lt;br&gt;&lt;br&gt;, some wrap each line in a &lt;div&gt;. We converge all of these onto one consistent paragraph structure so spacing is uniform across every job.'),
            renderRuleRow('Bullet-list flattening', '', 'PageUp sometimes exports bullet lists as a fragmented mix of bare &lt;li&gt; tags and one-item &lt;ul&gt; blocks. We consolidate these into a single clean &lt;ul&gt; so bullets render properly.'),
            renderRuleRow('Inline font override stripping', '', 'PageUp embeds explicit font-size and font-family on individual lines. We remove these so the Webflow site\'s typography rules apply consistently.'),
            renderRuleRow('PageUp image stripping (in description body)', 'always on', 'Webflow rejects PageUp\'s image format (image/x-png MIME), so any inline images in the description body would break the page. They\'re stripped automatically.'),
            renderRuleRow('LinkedIn tracking hashtag stripping', 'always on', 'Lines like <code>#LI-AV1#FCB#LI-Onsite</code> are LinkedIn job-tracking metadata, hidden in PageUp via white-on-white styling. We remove them entirely so they don\'t appear if a user copies the job text.'),
            renderRuleRow('Banner picker', 'always on', 'When a recruiter stacks multiple banner images in PageUp, some may be revoked or dead. We check each one and pick the first that actually loads, so the site never displays a broken banner when a working one exists.'),
            renderRuleRow('Brand resolution (3-tier)', '', 'Maps PageUp\'s brand text to a Webflow Brand entry: <strong>(1)</strong> exact match against Webflow Brands; <strong>(2)</strong> hashtag match (#CTAU, #FCB, etc.) when the brand text doesn\'t match exactly; <strong>(3)</strong> fall back to "Flight Centre Travel Group" if nothing matches.'),
            renderRuleRow('City / country reconciliation', 'always on', 'When PageUp gives us a single-token location (like "Missouri" or "New Zealand"), we expand it to the right country and clear the misleading city field, so jobs don\'t end up in an "unknown" filter bucket.'),
            renderRuleRow('Slug immutability', 'always on', 'Once a job has a URL slug, we never change it — even if the title is renamed. This keeps bookmarks and SEO links stable. The only thing that changes its slug is being deleted and re-created.'),
          '</tbody>',
        '</table>',
      '</div>',
      '<div class="fd-section">',
        '<h2>📅 Recent improvements</h2>',
        '<table class="fd-history">',
          '<thead><tr><th>Date</th><th>Change</th></tr></thead>',
          '<tbody>',
            '<tr><td style="white-space:nowrap">1 May 2026</td><td><strong>Per-job sync</strong> + <strong>banner picker</strong> + <strong>heading consolidation (H6)</strong> — fixes stacked-broken-banner bug; description headings no longer render at huge default sizes; new "Force re-sync this job" button from Job Comparison tab.</td></tr>',
            '<tr><td style="white-space:nowrap">24 Apr 2026</td><td>Daily force-full rescrape (02:00 UTC) + content-hash gate — banner / description edits now self-propagate instead of needing a manual trigger.</td></tr>',
            '<tr><td style="white-space:nowrap">22 Apr 2026</td><td>Paragraph normalisation: handles every PageUp WYSIWYG export style consistently.</td></tr>',
            '<tr><td style="white-space:nowrap">17 Apr 2026</td><td>Fast-sync: typical sync run dropped from ~10 min to ~1 min when nothing changed.</td></tr>',
          '</tbody>',
        '</table>',
      '</div>',
      '<div class="fd-section">',
        '<h2>📖 Glossary</h2>',
        '<dl class="fd-glossary">',
          '<dt>Sync</dt><dd>The end-to-end pipeline that reads PageUp, transforms the data, and writes it to the Webflow CMS.</dd>',
          '<dt>Fast-sync</dt><dd>Default 20-minute run. Looks at the listing page only. New/removed jobs and renamed/moved jobs are picked up; banner-only or description-only edits are not (those need force-full or per-job).</dd>',
          '<dt>Force-full</dt><dd>Re-reads every job\'s detail page from scratch. Catches edits that fast-sync misses. Runs daily at 02:00 UTC; can be triggered manually from the Sync Status tab.</dd>',
          '<dt>Per-job sync</dt><dd>New: re-reads just one job and updates the CMS for that role only. ~30–60 seconds. Triggered from the Force re-sync this job button in the Job Comparison tab.</dd>',
          '<dt>CMS</dt><dd>The Webflow Content Management System — the database that holds every job listed on the careers site.</dd>',
          '<dt>Hash gate</dt><dd>An efficiency check: we compute a fingerprint of each job\'s cleaned data and only update the CMS when the fingerprint changes, avoiding noisy "ghost edits" that don\'t actually affect content.</dd>',
          '<dt>Backup banner</dt><dd>The default Flight Centre Travel Group banner shown on a job page when the role\'s PageUp banner is missing or returns an error. The banner picker reduces how often this kicks in.</dd>',
        '</dl>',
      '</div>',
      '<div class="fd-section">',
        '<h2>❓ Common scenarios</h2>',
        '<details class="fd-faq"><summary>I\'ve updated a banner in PageUp but the site still shows the old one</summary><p>Hit <strong>Force re-sync this job</strong> on the Job Comparison tab for that role — fastest fix, ~30–60 seconds. Or use <strong>Force Full Rescrape</strong> from the Sync Status tab to catch all banner/description edits at once.</p></details>',
        '<details class="fd-faq"><summary>I\'ve added a category to a job and it\'s not showing up</summary><p>Same as banners — category-only edits need a force-full or per-job sync, not the regular 20-minute one.</p></details>',
        '<details class="fd-faq"><summary>A job\'s still showing on the site but it\'s been deleted in PageUp</summary><p>Wait for the next regular sync (max 20 min). Removals are caught by the fast-sync because the listing page no longer contains the role.</p></details>',
        '<details class="fd-faq"><summary>The brand on the job card is wrong</summary><p>Check the brand field in PageUp first. If that\'s set correctly, check the hashtag at the bottom of the description (e.g. #FCB, #CTAU) — that\'s our fallback when the PageUp brand text doesn\'t match a Webflow Brand exactly. If neither matches, the job falls back to "Flight Centre Travel Group" as a default.</p></details>',
        '<details class="fd-faq"><summary>The site shows the backup banner even though I set up a banner in PageUp</summary><p>Try Force re-sync this job from the Job Comparison tab. If that doesn\'t fix it, the actual asset URL in PageUp may be revoked — re-uploading the banner in PageUp Sourcing will fix it.</p></details>',
      '</div>',
      '<div class="fd-section">',
        '<h2>🔗 Useful links</h2>',
        '<ul style="list-style:none;font-size:14px;padding:0;margin:0">',
          '<li style="padding:5px 0">→ <a href="' + WEBFLOW_BASE + '/jobs">Live careers site</a></li>',
          '<li style="padding:5px 0">→ <a href="' + PAGEUP_BASE + '/cw/en/listing/">PageUp listing (source of truth)</a></li>',
        '</ul>',
      '</div>',
    '</div>',
  ].join('');

  function renderRuleRow(name, alwaysOn, desc) {
    var nameHtml = '<div class="fd-rule-name">' + name + '</div>';
    if (alwaysOn) nameHtml += ' <span class="fd-always-on">' + alwaysOn + '</span>';
    return '<tr><td>' + nameHtml + '</td><td><div class="fd-rule-desc">' + desc + '</div></td>' +
           '<td style="text-align:center"><label class="fd-toggle"><input type="checkbox" checked disabled><span class="fd-slider"></span></label></td></tr>';
  }

  // ─────────────── State ───────────────
  var logs = [];
  var jobs = [];
  var jobIdToSlug = {};

  // ─────────────── Helpers ───────────────
  function $(sel) { return document.querySelector('#fctg-dashboard ' + sel); }
  function $$(sel) { return document.querySelectorAll('#fctg-dashboard ' + sel); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function timeAgo(dateStr) {
    if (!dateStr) return '—';
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm ago';
    return Math.floor(hrs / 24) + 'd ago';
  }
  function timeUntil(dateStr) {
    if (!dateStr) return '—';
    var diff = new Date(dateStr).getTime() - Date.now();
    if (diff <= 0) return 'due now';
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return '< 1m';
    if (mins < 60) return mins + 'm';
    return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  }
  function fmtDuration(ms) {
    if (!ms) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  function fmtTime(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    var hh = ('0' + d.getUTCHours()).slice(-2);
    var mm = ('0' + d.getUTCMinutes()).slice(-2);
    return hh + ':' + mm + ' UTC';
  }
  function cacheBust(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
  }
  function fetchJson(url) {
    return fetch(cacheBust(url)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function postWorker(qs) {
    var url = WORKER_URL + '/?key=' + encodeURIComponent(SYNC_KEY) + (qs || '');
    return fetch(url, { method: 'POST' }).then(function (r) {
      return r.json().catch(function () { return { ok: false, message: 'HTTP ' + r.status }; });
    });
  }
  function actionMsg(text, isError) {
    var el = $('#fd-action-msg');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#991b1b' : '#6b7280';
  }
  function setHeaderStatus(state, msg) {
    var dot = $('#fd-dot');
    var msgEl = $('#fd-status-msg');
    if (dot) dot.className = 'fd-dot ' + state;
    if (msgEl) msgEl.textContent = msg;
  }

  // ─────────────── Renderers ───────────────
  function render() { renderCards(); renderHistory(); renderJobs(); }

  function renderCards() {
    if (!logs.length) {
      $('#fd-cards').innerHTML = '<div class="fd-card"><div class="fd-card-label">Status</div><div class="fd-card-value">No data</div></div>';
      setHeaderStatus('warning', 'No sync history loaded');
      return;
    }
    var last = logs[0];
    var liveCount = (typeof last.liveJobsAfter === 'number' && last.liveJobsAfter > 0) ? last.liveJobsAfter : (last.pageupJobsFound || jobs.length);
    var nextAt = new Date(new Date(last.startedAt).getTime() + SYNC_INTERVAL_MS).toISOString();
    var recentFails = logs.slice(0, 3).filter(function (l) { return l.status !== 'success'; }).length;
    var health = recentFails === 0 ? { label: 'All systems healthy', state: 'healthy' }
                : recentFails <= 1 ? { label: 'Recent issue', state: 'warning' }
                : { label: 'Multiple failures', state: 'error' };
    setHeaderStatus(health.state, health.label + ' · ' + liveCount + ' jobs live');

    var html = '';
    html += '<div class="fd-card"><div class="fd-card-label">Last Sync</div><div class="fd-card-value">' + timeAgo(last.finishedAt || last.startedAt) + '</div><div class="fd-card-sub">' + escapeHtml(last.source || 'scheduled') + ' · ' + escapeHtml(last.status) + ' · ' + fmtDuration(last.durationMs) + '</div></div>';
    html += '<div class="fd-card"><div class="fd-card-label">Jobs Live</div><div class="fd-card-value">' + liveCount + '</div><div class="fd-card-sub">' + (last.pageupJobsFound > 0 ? 'PageUp returned ' + last.pageupJobsFound + ' · ' : '') + summariseChanges(last) + '</div></div>';
    html += '<div class="fd-card"><div class="fd-card-label">Next Scheduled Sync</div><div class="fd-card-value">' + timeUntil(nextAt) + '</div><div class="fd-card-sub">runs every 20 min · daily force-full at 02:00 UTC</div></div>';
    $('#fd-cards').innerHTML = html;
  }

  function summariseChanges(l) {
    var parts = [];
    if (l.created) parts.push('+' + l.created);
    if (l.updated) parts.push(l.updated + ' upd');
    if (l.deleted) parts.push('-' + l.deleted);
    return parts.length ? parts.join(' / ') + ' this run' : '0 changes this run';
  }

  function renderHistory() {
    var tbody = $('#fd-history-body');
    var maxRows = 10;
    if (!logs.length) { tbody.innerHTML = '<tr><td colspan="7">No sync history yet.</td></tr>'; return; }
    var html = '';
    var rows = logs.slice(0, maxRows);
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i];
      var ok = l.status === 'success';
      var hasDetail = (l.created > 0 || l.updated > 0 || l.deleted > 0);
      var badge = ok ? '<span class="fd-badge success">success</span>' : '<span class="fd-badge error">' + escapeHtml(l.status) + '</span>';
      var triggerLabel = (l.source || 'scheduled');
      var triggerCls = triggerLabel === 'manual' ? 'info' : (triggerLabel === 'scheduled' ? 'info' : 'neutral');
      if (l.durationMs > 3 * 60 * 1000 && triggerLabel === 'scheduled') triggerLabel = 'force-full';
      if (triggerLabel === 'force-full') triggerCls = 'warning';
      var changesHtml = '<span style="color:#6b7280">—</span>';
      if (l.created) changesHtml = '<span class="fd-pos">+' + l.created + '</span>';
      else if (l.updated) changesHtml = '<span class="fd-upd">' + l.updated + ' upd</span>';
      else if (l.deleted) changesHtml = '<span class="fd-neg">−' + l.deleted + '</span>';
      var attrs = hasDetail ? ' class="fd-run expandable" onclick="window.__fdToggleDetail(this)"' : ' class="fd-run"';
      html += '<tr' + attrs + '>';
      html += '<td>' + (hasDetail ? '<span class="fd-chev">▶</span>' : '<span class="fd-chev-placeholder"></span>') + escapeHtml(fmtTime(l.startedAt)) + '</td>';
      html += '<td>' + badge + '</td>';
      html += '<td style="color:#6b7280">' + fmtDuration(l.durationMs) + '</td>';
      html += '<td>' + (l.pageupJobsFound || '—') + '</td>';
      html += '<td>' + (l.liveJobsAfter || '—') + '</td>';
      html += '<td>' + changesHtml + '</td>';
      html += '<td><span class="fd-badge ' + triggerCls + '">' + escapeHtml(triggerLabel) + '</span></td>';
      html += '</tr>';
      html += '<tr class="fd-detail"><td colspan="7">' + (hasDetail ? renderDetailContent(l) : '') + '</td></tr>';
    }
    tbody.innerHTML = html;
    $('#fd-history-count').textContent = 'last ' + rows.length + ' runs';
  }

  function renderDetailContent(l) {
    var html = '';
    if (l.createdJobs && l.createdJobs.length) html += renderChangeSection('+' + l.createdJobs.length + ' added', 'fd-pos', l.createdJobs, false);
    if (l.updatedJobs && l.updatedJobs.length) html += renderChangeSection('~' + l.updatedJobs.length + ' updated', 'fd-upd', l.updatedJobs, false);
    if (l.deletedJobs && l.deletedJobs.length) html += renderChangeSection('−' + l.deletedJobs.length + ' removed', 'fd-neg', l.deletedJobs, true);
    return html;
  }

  function renderChangeSection(title, cls, items, isDeleted) {
    var html = '<div class="fd-change-section"><h4><span class="' + cls + '">' + escapeHtml(title) + '</span></h4><ul class="fd-change-list">';
    var max = 8;
    for (var i = 0; i < Math.min(max, items.length); i++) {
      var j = items[i];
      var slug = jobIdToSlug[j.jobId] || (j.slug || '');
      html += '<li><span>' + escapeHtml(j.title || j.jobId) + '</span>';
      if (j.changedFields && j.changedFields.length) {
        html += '<span class="fd-tags">';
        for (var k = 0; k < j.changedFields.length; k++) html += '<span class="fd-tag">' + escapeHtml(j.changedFields[k]) + '</span>';
        html += '</span>';
      }
      if (isDeleted) {
        html += '<span class="fd-deleted-note">no longer in PageUp · removed from the site</span>';
      } else {
        html += '<span class="fd-links">';
        if (slug) html += '<a class="fd-link" href="' + WEBFLOW_BASE + '/jobs/' + encodeURIComponent(slug) + '" target="_blank" rel="noopener">↗ Webflow</a>';
        html += '<a class="fd-link" href="' + PAGEUP_BASE + '/cw/en/job/' + encodeURIComponent(j.jobId) + '/" target="_blank" rel="noopener">↗ PageUp</a>';
        html += '</span>';
      }
      html += '</li>';
    }
    if (items.length > max) html += '<li style="color:#6b7280;font-style:italic">+ ' + (items.length - max) + ' more</li>';
    html += '</ul></div>';
    return html;
  }

  window.__fdToggleDetail = function (runRow) {
    runRow.toggleAttribute('data-open');
    var detail = runRow.nextElementSibling;
    if (detail && detail.classList.contains('fd-detail')) detail.toggleAttribute('data-open');
  };

  function renderJobs() {
    var search = ($('#fd-jobs-search').value || '').trim().toLowerCase();
    var region = $('#fd-jobs-region').value;
    var brand = $('#fd-jobs-brand').value;
    var filtered = jobs.filter(function (j) {
      if (region && j.r !== region) return false;
      if (brand && j.b !== brand) return false;
      if (search) {
        var hay = ((j.t || '') + ' ' + (j.b || '') + ' ' + (j.ci || '') + ' ' + (j.co || '')).toLowerCase();
        if (hay.indexOf(search) === -1) return false;
      }
      return true;
    });
    $('#fd-jobs-shown').textContent = 'Showing ' + filtered.length + ' of ' + jobs.length;
    var maxRows = 100;
    var rows = filtered.slice(0, maxRows);
    var html = '';
    if (!rows.length) {
      html = '<div class="fd-loading">No matching jobs.</div>';
    } else {
      for (var i = 0; i < rows.length; i++) {
        var j = rows[i];
        var jobId = (j.ju || '').match(/\/job\/(\d+)/);
        jobId = jobId ? jobId[1] : '';
        html += '<div class="fd-job-row">';
        html += '<div><div class="fd-job-title">' + escapeHtml(j.t || '') + '</div>';
        html += '<div class="fd-job-meta">' + escapeHtml(j.b || '—') + ' · ' + escapeHtml(j.ci || j.co || '—') + ' · ' + escapeHtml(j.r || '—') + (jobId ? ' · Job #' + escapeHtml(jobId) : '') + '</div></div>';
        html += '<div class="fd-job-actions">';
        if (j.s) html += '<a class="fd-btn small" href="' + WEBFLOW_BASE + '/jobs/' + encodeURIComponent(j.s) + '" target="_blank" rel="noopener">↗ Webflow</a>';
        if (jobId) html += '<a class="fd-btn small" href="' + PAGEUP_BASE + '/cw/en/job/' + encodeURIComponent(jobId) + '/" target="_blank" rel="noopener">↗ PageUp</a>';
        if (jobId) html += '<button class="fd-btn small primary" data-job-id="' + escapeHtml(jobId) + '" onclick="window.__fdResyncJob(this)">🔄 Force re-sync this job</button>';
        html += '</div></div>';
      }
      if (filtered.length > maxRows) html += '<div class="fd-loading">+ ' + (filtered.length - maxRows) + ' more — refine your search to narrow down.</div>';
    }
    $('#fd-jobs-list').innerHTML = html;
    $('#fd-jobs-count').textContent = jobs.length + ' total';
  }

  function populateFilters() {
    var regions = {}, brands = {};
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (j.r) regions[j.r] = true;
      if (j.b) brands[j.b] = true;
    }
    var regionEl = $('#fd-jobs-region'), brandEl = $('#fd-jobs-brand');
    var regionVal = regionEl.value, brandVal = brandEl.value;
    var rOpts = '<option value="">All regions</option>';
    Object.keys(regions).sort().forEach(function (r) { rOpts += '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>'; });
    regionEl.innerHTML = rOpts; regionEl.value = regionVal;
    var bOpts = '<option value="">All brands</option>';
    Object.keys(brands).sort().forEach(function (b) { bOpts += '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + '</option>'; });
    brandEl.innerHTML = bOpts; brandEl.value = brandVal;
  }

  // ─────────────── Action handlers ───────────────
  window.__fdResyncJob = function (btn) {
    var jobId = btn.getAttribute('data-job-id');
    if (!jobId) return;
    btn.disabled = true; btn.textContent = '⏳ syncing…';
    postWorker('&job_id=' + encodeURIComponent(jobId)).then(function (r) {
      if (r.ok) {
        btn.textContent = '✓ triggered';
        actionMsg('Per-job sync triggered for job ' + jobId + ' — should complete in ~30–60 seconds. The dashboard auto-refreshes when the run lands.');
        scheduleRefresh();
      } else {
        btn.disabled = false; btn.textContent = '🔄 Force re-sync this job';
        actionMsg('Failed to trigger per-job sync: ' + (r.message || 'unknown error'), true);
      }
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '🔄 Force re-sync this job';
      actionMsg('Failed to trigger per-job sync: ' + e.message, true);
    });
  };

  function bindActionButtons() {
    $('#fd-btn-run-sync').addEventListener('click', function () {
      var b = this; b.disabled = true; var orig = b.innerHTML; b.textContent = '⏳ triggering…';
      postWorker('').then(function (r) {
        b.disabled = false; b.innerHTML = orig;
        if (r.ok) { actionMsg('Sync triggered — typical completion under a minute.'); scheduleRefresh(); }
        else actionMsg('Failed: ' + (r.message || 'unknown'), true);
      }).catch(function (e) { b.disabled = false; b.innerHTML = orig; actionMsg('Failed: ' + e.message, true); });
    });
    $('#fd-btn-force-full').addEventListener('click', function () {
      if (!window.confirm('Trigger a force-full rescrape? This re-reads every job and takes ~10–15 minutes.')) return;
      var b = this; b.disabled = true; var orig = b.innerHTML; b.textContent = '⏳ triggering…';
      postWorker('&force_full=true').then(function (r) {
        b.disabled = false; b.innerHTML = orig;
        if (r.ok) { actionMsg('Force-full sync triggered — runs through every job, ~10–15 minutes.'); scheduleRefresh(); }
        else actionMsg('Failed: ' + (r.message || 'unknown'), true);
      }).catch(function (e) { b.disabled = false; b.innerHTML = orig; actionMsg('Failed: ' + e.message, true); });
    });
    $('#fd-btn-purge-cdn').addEventListener('click', function () {
      var b = this; b.disabled = true; var orig = b.innerHTML; b.textContent = '⏳ purging…';
      var urls = [
        'https://purge.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/all-jobs.json',
        'https://purge.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/filter-counts.json',
        'https://purge.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@data/sync-log.json',
      ];
      Promise.all(urls.map(function (u) { return fetch(u).catch(function () {}); })).then(function () {
        b.disabled = false; b.innerHTML = orig;
        actionMsg('CDN cache cleared. Hard-refresh the listings page to load the latest data.');
      });
    });
  }

  function bindFilterInputs() {
    var debounce;
    $('#fd-jobs-search').addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(renderJobs, 150); });
    $('#fd-jobs-region').addEventListener('change', renderJobs);
    $('#fd-jobs-brand').addEventListener('change', renderJobs);
  }

  function bindTabs() {
    $$('.fd-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('.fd-tab-btn').forEach(function (b) { b.removeAttribute('data-active'); });
        $$('.fd-tab-panel').forEach(function (p) { p.removeAttribute('data-active'); });
        btn.setAttribute('data-active', '');
        var panel = document.querySelector('#fctg-dashboard .fd-tab-panel[data-tab="' + btn.dataset.tab + '"]');
        if (panel) panel.setAttribute('data-active', '');
      });
    });
  }

  // ─────────────── Data loading ───────────────
  function loadAll(useRaw) {
    var base = useRaw ? DATA_BASE_RAW : DATA_BASE_CDN;
    return Promise.all([
      fetchJson(base + '/sync-log.json').catch(function () { return []; }),
      fetchJson(base + '/all-jobs.json').catch(function () { return []; }),
    ]).then(function (results) {
      logs = Array.isArray(results[0]) ? results[0] : [];
      jobs = Array.isArray(results[1]) ? results[1] : [];
      jobIdToSlug = {};
      for (var i = 0; i < jobs.length; i++) {
        var j = jobs[i];
        var idMatch = (j.ju || '').match(/\/job\/(\d+)/);
        if (idMatch && j.s) jobIdToSlug[idMatch[1]] = j.s;
      }
      populateFilters();
      render();
    });
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    var attempts = 0;
    var firstId = logs[0] && logs[0].id;
    refreshTimer = setInterval(function () {
      attempts++;
      loadAll(true).then(function () {
        if ((logs[0] && logs[0].id) !== firstId || attempts >= 30) {
          clearInterval(refreshTimer); refreshTimer = null;
        }
      });
    }, 10000);
  }

  setInterval(function () { loadAll(false); }, 60000);

  // ─────────────── Init ───────────────
  function init() {
    var root = document.getElementById('fctg-dashboard');
    if (!root) {
      console.error('[fctg-dashboard] No #fctg-dashboard root element found on page.');
      return;
    }
    if (!SYNC_KEY) {
      console.warn('[fctg-dashboard] window.__FCTG_SYNC_KEY not set — action buttons will fail.');
    }
    root.innerHTML = DASHBOARD_HTML;
    bindTabs();
    bindActionButtons();
    bindFilterInputs();
    loadAll(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
