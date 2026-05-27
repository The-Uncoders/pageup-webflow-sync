/**
 * FCTG Careers — script loader (Cloudflare Workers Static Assets)
 *
 * This is the ONLY file Webflow references, via a single stable tag on
 * /jobs and /jobs/{slug}:
 *
 *   <script defer src="https://fctg-careers-code.<subdomain>.workers.dev/loader.js"></script>
 *
 * Everything mutable lives here in git. Add / remove / rename a script?
 * Edit the FILES array, `git push`, deploy — Webflow never changes.
 *
 * Why no SHA-resolving / jsDelivr gymnastics: Cloudflare serves the freshly
 * deployed asset directly, so there's no stale-branch-cache problem to work
 * around. The loader just injects its sibling files from the same origin.
 */
(function () {
  'use strict';

  var FILES = ['jobs-filter.js', 'field-label-cap.js'];

  // Resolve the directory this loader was served from, so siblings load from
  // the same origin regardless of which domain/subdomain serves it.
  var self = document.currentScript;
  var base = self && self.src ? new URL('.', self.src).href : '/';

  FILES.forEach(function (file) {
    var s = document.createElement('script');
    s.src = base + file;
    s.defer = true;
    document.body.appendChild(s);
  });
})();
