/**
 * fctg-sync-trigger
 *
 * Deployed as a Cloudflare Worker at:
 *   https://fctg-sync-trigger.wandering-sun-9809.workers.dev
 *
 * Purpose: triggers the sync-jobs.yml workflow on the
 * The-Uncoders/pageup-webflow-sync repo via GitHub Actions
 * `workflow_dispatch`. Two entry points:
 *   - fetch()     — on-demand POSTs from the sync dashboard (Run Sync Now,
 *                   Force Full Rescrape, per-job re-sync).
 *   - scheduled() — Cloudflare Cron Triggers fire this on a guaranteed
 *                   cadence and dispatch the routine syncs. This is the
 *                   reliable scheduler that REPLACES the GitHub Actions
 *                   `schedule:` crons, which GitHub runs best-effort and
 *                   drops under load (observed ~10 runs/day vs a 20-min
 *                   target, gaps up to 5 hours). Crons configured in this
 *                   Worker's wrangler.jsonc: an every-10-minutes fast-sync
 *                   (listing-level diff) plus a daily 02:00 UTC force-full
 *                   rescrape.
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
 * Secrets (stored on the Worker, not in code; persist across deploys):
 *   SYNC_KEY     — shared gate for authorised callers
 *   GITHUB_TOKEN — fine-grained PAT with Actions:write for the repo
 *
 * Deploy: wrangler-managed via worker/wrangler.jsonc (code + cron triggers
 *   in one deploy) — see that file's header for the exact command.
 */

/**
 * POST a workflow_dispatch to the sync-jobs.yml workflow.
 * `inputs` is optional — omit for a normal fast-sync, or pass
 * { force_full: 'true' } / { job_id: '123' } for the other modes.
 * Returns the raw fetch Response (204 = accepted).
 */
async function dispatchWorkflow(env, inputs) {
  const body = inputs ? { ref: 'main', inputs } : { ref: 'main' };
  return fetch(
    'https://api.github.com/repos/The-Uncoders/pageup-webflow-sync/actions/workflows/sync-jobs.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'fctg-sync-trigger',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}

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

    // GitHub workflow_dispatch expects boolean inputs as string "true"/"false".
    let inputs;
    if (jobId) {
      inputs = { job_id: jobId };
    } else if (forceFull) {
      inputs = { force_full: 'true' };
    }

    const res = await dispatchWorkflow(env, inputs);

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

  /**
   * Cloudflare Cron Triggers fire here on a guaranteed cadence. This is the
   * authoritative scheduler for the routine syncs — the GitHub Actions
   * `schedule:` crons are removed because GitHub runs them best-effort and
   * drops most of them under load. `event.cron` is the matched expression.
   */
  async scheduled(event, env, ctx) {
    // The daily 02:00 UTC tick re-scrapes every job's detail page to catch
    // edits that don't surface on the listing (category, banner, closing
    // date, description). Every other tick is a normal listing-level fast-sync.
    const inputs = event.cron === '0 2 * * *' ? { force_full: 'true' } : undefined;
    ctx.waitUntil(
      dispatchWorkflow(env, inputs).then(async (res) => {
        if (res.status !== 204) {
          const detail = await res.text().catch(() => '');
          console.error(`[scheduled] dispatch failed: ${res.status} ${detail.slice(0, 200)}`);
        }
      })
    );
  },
};
