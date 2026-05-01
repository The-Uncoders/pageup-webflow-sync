/**
 * fctg-sync-trigger
 *
 * Deployed as a Cloudflare Worker at:
 *   https://fctg-sync-trigger.wandering-sun-9809.workers.dev
 *
 * Purpose: proxies POST requests from the sync dashboard to GitHub Actions
 * `workflow_dispatch`, which triggers the sync-jobs.yml workflow on the
 * The-Uncoders/pageup-webflow-sync repo.
 *
 * Query params:
 *   key        (required) — shared secret validated against env.SYNC_KEY
 *   force_full (optional) — when "true", passes a force_full=true input
 *                           to the workflow so the sync bypasses the
 *                           listing-level fast-diff and re-scrapes every
 *                           existing job's detail page.
 *   job_id     (optional) — when set to a numeric PageUp job ID, switches
 *                           the workflow into single-job mode (sync only
 *                           that one job, ~30-60s). Used by the dashboard's
 *                           "Force re-sync this job" button. Mutually
 *                           exclusive with force_full — if both are sent,
 *                           job_id wins.
 *
 * Environment variables (encrypted in Cloudflare dashboard, not in code):
 *   SYNC_KEY     — shared gate for authorised callers
 *   GITHUB_TOKEN — fine-grained PAT with Actions:write for the repo
 *
 * Deploy: paste this file's content into the Cloudflare dashboard →
 *   Workers & Pages → fctg-sync-trigger → Edit Code → Save & Deploy.
 */

export default {
  async fetch(request, env) {
    // CORS preflight — dashboard embed is cross-origin
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    // Auth gate
    const key = url.searchParams.get('key');
    if (key !== env.SYNC_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Optional flags. job_id wins over force_full if both are sent — the
    // dashboard never sends both, this is just defensive ordering.
    const rawJobId = (url.searchParams.get('job_id') || '').trim();
    const jobId = /^[0-9]+$/.test(rawJobId) ? rawJobId : '';
    if (rawJobId && !jobId) {
      return Response.json(
        { ok: false, message: 'job_id must be numeric' },
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
    const forceFull = !jobId && url.searchParams.get('force_full') === 'true';

    const dispatchBody = { ref: 'main' };
    if (jobId) {
      dispatchBody.inputs = { job_id: jobId };
    } else if (forceFull) {
      // GitHub workflow_dispatch expects boolean inputs as string "true"/"false".
      dispatchBody.inputs = { force_full: 'true' };
    }

    const res = await fetch(
      'https://api.github.com/repos/The-Uncoders/pageup-webflow-sync/actions/workflows/sync-jobs.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'fctg-sync-trigger',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchBody),
      }
    );

    const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

    if (res.status === 204) {
      let message;
      if (jobId) {
        message = `Single-job sync triggered for job ${jobId} — typically completes in 30-60 seconds.`;
      } else if (forceFull) {
        message = 'Force-full sync triggered — runs through every job, ~10-15 minutes.';
      } else {
        message = 'Sync triggered — typical completion under a minute.';
      }
      return Response.json(
        { ok: true, mode: jobId ? 'single-job' : (forceFull ? 'force-full' : 'fast-sync'), jobId: jobId || null, message },
        { headers: corsHeaders }
      );
    }

    const errText = await res.text().catch(() => '');
    return Response.json(
      { ok: false, message: 'GitHub API error: ' + res.status, detail: errText.slice(0, 200) },
      { status: 502, headers: corsHeaders }
    );
  },
};
