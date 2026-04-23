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

    // Optional force-full flag. When true, the workflow skips the
    // listing-level fast-diff and re-scrapes every existing job.
    const forceFull = url.searchParams.get('force_full') === 'true';

    const dispatchBody = { ref: 'main' };
    if (forceFull) {
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
      return Response.json(
        {
          ok: true,
          forceFull,
          message: forceFull
            ? 'Force-full sync triggered — runs through every job, ~10-15 minutes.'
            : 'Sync triggered — typical completion under a minute.',
        },
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
