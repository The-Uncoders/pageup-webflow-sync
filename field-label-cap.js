/**
 * FCTG Careers — Field Label Cap ("+N more") v1.0
 *
 * Display-only enhancement for the job cards (/jobs) and the job detail page
 * (/jobs/{slug}). PageUp jobs can carry long location / region / work-type
 * lists; rendered in full they look comical. This caps each field's visible
 * labels and appends a "+N more" pill that expands to show the rest.
 *
 * ── Attribute contract (targets attributes, never design classes) ──
 *   label-cap="5"   On each label Collection List wrapper. Value = how many
 *                   labels to show before the "+N more" pill. Falls back to
 *                   the `.job-post_field-label_wrapper` class with a default of
 *                   5 if the attribute isn't present yet.
 *
 * Structure it expects (Webflow nested Collection List):
 *   [label-cap]  (.w-dyn-list)
 *     └ .w-dyn-items
 *         └ .w-dyn-item            ← one per value
 *             └ .job-post_field-label [filter="..."]   ← the styled pill + text
 *
 * The "+N more" pill is a CLONE of a real item, so it inherits the exact pill
 * styling. Its `filter` attribute is stripped so the job filter engine never
 * reads "+N more" as a phantom location/work-type value. The hidden items keep
 * their `filter` attributes, so a 20-location job still matches all 20 in the
 * filter even though only 5 show — the engine reads textContent regardless of
 * `display:none`.
 *
 * Expand is one-way (no collapse-back), per design.
 */
(function () {
  'use strict';

  if (window._fctgLabelCapLoaded) return;
  window._fctgLabelCapLoaded = true;

  var DEFAULT_CAP = 5;
  var WRAPPER_SELECTOR = '[label-cap], .job-post_field-label_wrapper';
  var ITEM_SELECTOR = ':scope > .w-dyn-items > .w-dyn-item';
  var PILL_SELECTOR = '.job-post_field-label';   // the styled inner element
  var DONE_ATTR = 'data-label-capped';

  function capWrapper(wrap) {
    if (wrap.hasAttribute(DONE_ATTR)) return;

    var capAttr = parseInt(wrap.getAttribute('label-cap'), 10);
    var cap = (capAttr > 0) ? capAttr : DEFAULT_CAP;

    var items = wrap.querySelectorAll(ITEM_SELECTOR);
    if (items.length <= cap) { wrap.setAttribute(DONE_ATTR, '1'); return; }

    wrap.setAttribute(DONE_ATTR, '1');

    var hidden = [];
    for (var i = cap; i < items.length; i++) {
      items[i].style.display = 'none';
      hidden.push(items[i]);
    }

    // Build the "+N more" pill by cloning a real item so styling matches.
    var pill = items[items.length - 1].cloneNode(true);
    pill.style.display = '';
    pill.setAttribute('data-label-more', '1');
    pill.style.cursor = 'pointer';

    // Strip filter attributes so the clone is never read as a filter value.
    if (pill.hasAttribute('filter')) pill.removeAttribute('filter');
    pill.querySelectorAll('[filter]').forEach(function (el) { el.removeAttribute('filter'); });

    // Set the visible text on the styled inner element (fall back to the item).
    var labelEl = pill.querySelector(PILL_SELECTOR) || pill;
    labelEl.textContent = '+' + hidden.length + ' more';

    pill.addEventListener('click', function () {
      for (var j = 0; j < hidden.length; j++) hidden[j].style.display = '';
      pill.style.display = 'none';
    });

    items[items.length - 1].parentNode.appendChild(pill);
  }

  function process() {
    var wraps = document.querySelectorAll(WRAPPER_SELECTOR);
    for (var i = 0; i < wraps.length; i++) capWrapper(wraps[i]);
  }

  // Run now, and re-run when more cards arrive (the jobs page merges paginated
  // pages into the DOM after load). A debounced MutationObserver keeps it
  // self-contained — no coupling to the filter script.
  function start() {
    process();
    var t;
    var obs = new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(process, 200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
