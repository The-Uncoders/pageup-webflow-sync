/**
 * FCTG Careers — Job Filter & Sort System v4.0
 * Webflow renders the cards; this script only filters them.
 *
 * Architecture (May 2026 rewrite):
 *   - Webflow Collection List renders all cards (100/page + pagination enabled).
 *   - On boot, the script fetches additional paginated pages and merges their
 *     cards into the visible Collection List, so all 300+ cards are in the DOM.
 *   - Each card carries Designer-bound `filter="<dimension>"` attributes on
 *     dedicated child elements; the element's text content is the filterable
 *     value. Dimensions: name, location, country, region, brand, category,
 *     work-type, job-id, summary.
 *   - The filter engine reads those attributes via `[filter="X"]` selectors
 *     and toggles `display` on each card. No template cloning, no JSON fetch,
 *     no slot-position assumptions — Designer changes the layout freely.
 *
 * Multi-location: location values may be comma-separated (e.g. "New South
 * Wales, Queensland, Victoria"). The location matcher splits and any-matches
 * so multi-location jobs surface under every constituent city checkbox.
 *
 * Search-by-job-number: job-id is hidden on the card via the `card-detail
 * hidden` combo class but lives in the DOM and contributes to the keyword
 * haystack. Recruiters can paste a job number into search.
 *
 * v4.0   – MAJOR rewrite. Removed JSON fetch + template cloning + slot-by-
 *           position rendering (Tokyo bug class). Webflow now owns the layout
 *           entirely. Smaller (~500 lines vs 1450), no template coupling.
 *           Drives off Designer-bound `filter="<dimension>"` attributes.
 *           Multi-location split + job-id search retained.
 *           See PROJECT-DOCUMENTATION.md for the architecture rationale.
 * v3.1   – (legacy) Multi-location + search-by-job-number support over JSON.
 * v3.0   – (legacy) Data-driven filtering against ALL jobs, JS-rendered cards.
 */
(function () {
  'use strict';

  if (window._fctgFilterLoaded) return;
  window._fctgFilterLoaded = true;

  // ── Config ────────────────────────────────
  var DEBOUNCE = 250;
  var INIT_DELAY = 300;
  var PAGE_SIZE = 30;            // Show More step
  var BACK_KEY = 'fctg_back';
  var STATE_KEY = 'fctg_filter_state';

  var URL_PARAM = {
    keyword: 'q', region: 'region', city: 'city', brand: 'brand',
    category: 'category', workType: 'type', sortMode: 'sort'
  };

  // ── State ─────────────────────────────────
  var keyword = '';
  var activeCities = {};
  var activeRegions = {};
  var activeBrands = {};
  var activeCategories = {};
  var workType = '';
  var sortMode = 'default';
  var visibleLimit = PAGE_SIZE;

  // Cached element refs
  var _listEl = null;
  var _rcEl = null, _icEl = null, _emptyEl = null, _allRadio = null;
  var _allCards = [];          // every card in the list (after paginate-merge)
  var _initialised = false;

  // ── Boot ──────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, INIT_DELAY); });
  } else {
    setTimeout(init, INIT_DELAY);
  }

  function init() {
    setupBackButton();
    if (_initialised) return;

    _listEl = document.querySelector('.career_list');
    if (!_listEl) return;     // not on /jobs page (e.g. on /jobs/{slug})
    _initialised = true;

    // Cache filter-counter refs BEFORE Finsweet attributes are stripped
    // Filter UI controls — prefer the new `filter-ui` attribute convention.
    // Fall back to id-based shortcuts for elements the Designer commonly
    // marks (e.g. #fctg-job-count) and to legacy Finsweet selectors so any
    // page that hasn't been re-attributed yet keeps working.
    _rcEl = document.querySelector('[filter-ui="count"]') ||
            document.getElementById('fctg-job-count') ||
            document.querySelector('[fs-cmsfilter-element="results-count"]');
    _emptyEl = document.querySelector('[filter-ui="empty"]') ||
               document.getElementById('fctg-empty') ||
               document.querySelector('[fs-cmsfilter-element="empty"]');
    _allRadio = document.querySelector('label[fs-cmsfilter-element="reset"] input[type="radio"]');
    var resetEls = document.querySelectorAll('[filter-ui="clear"], a[fs-cmsfilter-element="reset"]');

    injectStyles();
    neutraliseFinsweet();
    preventFormSubmits();

    function bindEverything() {
      // For any filter group with `filter-source="cards"`, auto-populate
      // checkboxes from unique values found in card data. The first existing
      // checkbox in the group is used as a Designer-styled template; JS
      // clones it for each unique value. Useful when there's no clean CMS
      // collection for that dimension (region, location with multi-strings).
      autoPopulateFromCards('region', 'region');
      autoPopulateFromCards('location', 'location');
      autoPopulateFromCards('city', 'location');
      autoPopulateFromCards('brand', 'brand');
      autoPopulateFromCards('category', 'category');

      bindSearch();
      bindFilterGroup('city', activeCities);
      bindFilterGroup('region', activeRegions);
      bindFilterGroup('brand', activeBrands);
      bindFilterGroup('category', activeCategories);
      bindWorkTypeRadios();
      bindSort();
      bindClear(resetEls);
      bindShowMore();

      var urlApplied = applyFiltersFromURL();
      if (!urlApplied) restoreFilterState();

      applyFilters();
      handleBackNavigation();
    }

    // Load remaining pages, then bind UI + apply filters
    loadAllPages().then(function () {
      hidePaginationControls();
      _allCards = collectCards();
      bindEverything();
    }).catch(function (err) {
      console.warn('[fctg-filter] paginate-load failed, falling back to first page only:', err);
      _allCards = collectCards();
      bindEverything();
    });
  }

  // ── Filter-panel selector helpers ─────────
  // Prefer the `filter-group="X"` Designer convention (a container element
  // with this attribute, holding the dimension's checkboxes). Falls back to
  // the legacy `input[name="X"]` direct selector for sites that haven't
  // re-attributed yet. JS also supports a Webflow-rendered Collection List
  // inside the group (each .w-dyn-item containing a checkbox).
  //
  // The location dimension accepts either `filter-group="location"` (the
  // canonical PageUp terminology) or `filter-group="city"` (legacy alias)
  // — both bind to the same internal store.
  function groupAliases(group) {
    if (group === 'city' || group === 'location') return ['location', 'city'];
    return [group];
  }

  function findGroupCheckboxes(group) {
    var aliases = groupAliases(group);
    for (var i = 0; i < aliases.length; i++) {
      var container = document.querySelector('[filter-group="' + aliases[i] + '"]');
      if (container) return container.querySelectorAll('input[type="checkbox"]');
    }
    return document.querySelectorAll('input[name="' + group + '"]');
  }

  function findGroupRadios(group) {
    var aliases = groupAliases(group);
    for (var i = 0; i < aliases.length; i++) {
      var container = document.querySelector('[filter-group="' + aliases[i] + '"]');
      if (container) return container.querySelectorAll('input[type="radio"]');
    }
    return [];
  }

  // Read a checkbox/radio's user-visible label text. Tries Webflow's
  // .w-form-label first; falls back to the parent label's textContent.
  function getOptionLabel(input) {
    var label = input.closest('.w-checkbox, .w-radio, label');
    if (!label) return '';
    var span = label.querySelector('.w-form-label');
    if (span) return (span.textContent || '').trim();
    return (label.textContent || '').trim();
  }

  // Opt-in dynamic checkbox population. When a `[filter-group="X"]` container
  // also has `filter-source="cards"`, JS replaces its existing checkboxes
  // with one per unique value found in the cards' `[filter="<dim>"]` element.
  // The first existing checkbox is used as a Designer-styled template (so the
  // generated checkboxes inherit your visual styling).
  //
  // Useful when there's no clean CMS collection for a dimension — e.g. the
  // Region field where values come from sync (FCTG region map), or Location
  // where the multi-location strings make a CMS-rendered list incomplete.
  function autoPopulateFromCards(groupName, cardDimension) {
    var aliases = groupAliases(groupName);
    var container = null;
    for (var i = 0; i < aliases.length; i++) {
      var c = document.querySelector('[filter-group="' + aliases[i] + '"][filter-source="cards"]');
      if (c) { container = c; break; }
    }
    if (!container) return;

    // Find the first existing checkbox + the item template that wraps it.
    // Prefer the .filters1_item / .w-dyn-item wrapper if present (so the
    // clone preserves Designer styling); fall back to the bare label.
    var firstCheckbox = container.querySelector('input[type="checkbox"]');
    if (!firstCheckbox) return;
    var itemTemplate = firstCheckbox.closest('.filters1_item, .w-dyn-item')
                    || firstCheckbox.closest('.w-checkbox, label');
    if (!itemTemplate) return;

    // The list parent is the container that holds all the items.
    // Clearing only this parent's children preserves the heading + accordion
    // icon + filter-options wrapper (which sit higher up in the tree).
    var listParent = itemTemplate.parentNode;
    if (!listParent) return;

    // Collect unique values from cards (case-insensitive dedup, preserving
    // first-seen casing for display)
    var seen = {};
    for (var j = 0; j < _allCards.length; j++) {
      var raw = dimValue(_allCards[j], cardDimension);
      if (!raw) continue;
      raw.split(',').forEach(function (v) {
        var t = v.trim();
        if (!t) return;
        var k = t.toLowerCase();
        if (!seen[k]) seen[k] = t;
      });
    }
    var values = Object.keys(seen).sort().map(function (k) { return seen[k]; });
    if (values.length === 0) return;

    // Clear only the list parent's children (existing items). Heading +
    // accordion icon + outer wrappers stay intact.
    while (listParent.firstChild) listParent.removeChild(listParent.firstChild);

    // Generate one item per unique value, cloning the item template to
    // inherit Designer styling.
    values.forEach(function (val) {
      var clone = itemTemplate.cloneNode(true);
      // Strip any subheading inside the cloned item (subheadings only make
      // sense for the location dimension, not for region etc.)
      var sub = clone.querySelector('.filters1_filter-group-subheading');
      if (sub) sub.remove();

      var labelSpan = clone.querySelector('.filters1_form-checkbox1-label, .w-form-label');
      if (labelSpan) labelSpan.textContent = val;
      else {
        // No label span found — set on the closest label as fallback
        var fallbackLabel = clone.querySelector('.w-checkbox, label');
        if (fallbackLabel) fallbackLabel.textContent = val;
      }
      var cb = clone.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = false;
        cb.removeAttribute('id');
      }
      // Reset count badge if present
      var badge = clone.querySelector('.filter-count, .filter-count .text-size-regular');
      if (badge) badge.textContent = '0';
      listParent.appendChild(clone);
    });
  }

  // Legacy escapeHtml kept for fallback paths (no longer reached after the
  // template-based rewrite above).
  // eslint-disable-next-line no-unused-vars

  function escapeHtmlSimple(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Inject scoped styles ──────────────────
  // Hides the `.hidden` combo-class elements that hold filter-only data
  // (job-id, region, brand-name) inside cards. Also pre-hides cards beyond
  // the Show More limit so there's no flash before the first applyFilters().
  function injectStyles() {
    if (document.getElementById('fctg-filter-styles')) return;
    var s = document.createElement('style');
    s.id = 'fctg-filter-styles';
    s.textContent =
      '.career_list .hidden { display: none !important; }' +
      '.career_list .w-pagination-wrapper, ' +
      '.career_list ~ .w-pagination-wrapper, ' +
      '.w-pagination-wrapper { display: none !important; }';
    document.head.appendChild(s);
  }

  function hidePaginationControls() {
    var pags = document.querySelectorAll('.w-pagination-wrapper');
    for (var i = 0; i < pags.length; i++) pags[i].style.display = 'none';
  }

  function preventFormSubmits() {
    var form = document.querySelector('.filters1_form-block form') ||
               document.querySelector('.filters1_form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });
  }

  // Removes Finsweet's filter/sort attributes so leftover script (if any
  // ever loaded) doesn't fight us. Matches v3 behaviour.
  function neutraliseFinsweet() {
    window.fsAttributes = window.fsAttributes || [];
    window.fsAttributes.push(['cmsfilter', function (fi) {
      if (fi && fi.length) fi.forEach(function (inst) {
        try { if (typeof inst.destroy === 'function') inst.destroy(); } catch (e) {}
      });
    }]);
    var attrs = ['fs-cmsfilter-element', 'fs-cmsfilter-field', 'fs-cmssort-element', 'fs-cmssort-field'];
    [0, 200, 1000, 3000].forEach(function (delay) {
      setTimeout(function () {
        for (var a = 0; a < attrs.length; a++) {
          var els = document.querySelectorAll('[' + attrs[a] + ']');
          for (var i = 0; i < els.length; i++) els[i].removeAttribute(attrs[a]);
        }
      }, delay);
    });
  }

  // ── Paginate-load: bypass Webflow's 100-item Collection List cap ──
  // Webflow renders the first page (up to 100 items) on initial load.
  // Subsequent pages are reachable via `?<hash>_page=N` URLs derived from
  // the Next pagination link. We fetch pages 2..MAX in parallel and merge
  // their cards into the live `.career_list`.
  //
  // We don't rely on `.w-page-count` to know the total — that element only
  // appears on certain Webflow pagination styles. Instead we probe up to
  // MAX_PAGES in parallel and stop appending the moment a page returns
  // zero items (signal that we've passed the last real page).
  //
  // Deduplicates by `[filter="job-id"]` value as a defensive safety net
  // against shuffled-sort or other duplicate sources.
  var MAX_PAGES_TO_PROBE = 20;   // hard ceiling: 100 × 20 = 2000 items

  function loadAllPages() {
    return new Promise(function (resolve, reject) {
      var nextLink = document.querySelector('.w-pagination-next');
      if (!nextLink) return resolve();   // single-page list — nothing to fetch

      var paramName = readPageParamName(nextLink);
      if (!paramName) return resolve();

      // Track job-ids already in the DOM (page 1) to dedupe subsequent pages.
      var seen = {};
      collectCards().forEach(function (c) {
        var idEl = c.querySelector('[filter="job-id"]');
        var jid = idEl ? (idEl.textContent || '').trim() : '';
        if (jid) seen[jid] = true;
      });

      var basePath = location.pathname;
      var urls = [];
      for (var p = 2; p <= MAX_PAGES_TO_PROBE; p++) {
        urls.push({ p: p, url: basePath + '?' + encodeURIComponent(paramName) + '=' + p });
      }

      // Fetch all probe URLs in parallel. Each resolves to { p, items[] }
      // (items already DOM-parsed). 404s and non-OK responses resolve with
      // empty items so we don't reject the whole batch.
      var fetches = urls.map(function (entry) {
        return fetch(entry.url, { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) return { p: entry.p, items: [] };
          return r.text().then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            return { p: entry.p, items: doc.querySelectorAll('.career_list > .w-dyn-item') };
          });
        }).catch(function () { return { p: entry.p, items: [] }; });
      });

      Promise.all(fetches).then(function (results) {
        // Append in page order. Stop the moment we hit an empty page
        // (signals we've gone past the last real page — anything beyond
        // would either also be empty or be a duplicated wrap-around).
        results.sort(function (a, b) { return a.p - b.p; });
        var dupesSkipped = 0;
        var noIdSkipped = 0;
        var pagesAppended = 0;
        var lastPage = 1;
        for (var i = 0; i < results.length; i++) {
          var page = results[i];
          if (!page.items || page.items.length === 0) break;   // past end
          pagesAppended++;
          lastPage = page.p;
          for (var j = 0; j < page.items.length; j++) {
            var item = page.items[j];
            var idEl = item.querySelector('[filter="job-id"]');
            var jobId = idEl ? (idEl.textContent || '').trim() : '';
            if (!jobId) { noIdSkipped++; continue; }
            if (seen[jobId]) { dupesSkipped++; continue; }
            seen[jobId] = true;
            _listEl.appendChild(document.adoptNode(item));
          }
        }
        if (pagesAppended > 0) {
          console.log('[fctg-filter] paginate-load: merged pages 2..' + lastPage +
            ' (' + Object.keys(seen).length + ' unique cards in DOM)');
        }
        if (dupesSkipped > 0) {
          console.warn('[fctg-filter] paginate-load skipped ' + dupesSkipped +
            ' duplicate card(s). Likely cause: Designer Collection List sort = "Random shuffle". ' +
            'Switch to Default / Closing Date / Name for stable pagination.');
        }
        if (noIdSkipped > 0) {
          console.warn('[fctg-filter] paginate-load skipped ' + noIdSkipped +
            ' card(s) missing [filter="job-id"] attribute.');
        }
        resolve();
      }).catch(reject);
    });
  }

  function readPageParamName(nextLink) {
    try {
      var u = new URL(nextLink.href, location.origin);
      var keys = [];
      u.searchParams.forEach(function (_, k) { if (/_page$/.test(k)) keys.push(k); });
      return keys[0] || null;
    } catch (e) { return null; }
  }

  // ── Card cache ────────────────────────────
  function collectCards() {
    return Array.prototype.slice.call(_listEl.querySelectorAll(':scope > .w-dyn-item'));
  }

  // Pulls the value of a single filter dimension from a card. The card
  // template embeds it via Webflow custom attributes: `filter="<dim>"` on
  // a child element, with the element's text content bound to a CMS field.
  function dimValue(card, dim) {
    var el = card.querySelector('[filter="' + dim + '"]');
    return el ? (el.textContent || '').trim() : '';
  }

  function locationParts(card) {
    var raw = dimValue(card, 'location');
    if (!raw) return [];
    var parts = raw.split(',');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i].trim();
      if (s) out.push(s);
    }
    return out;
  }

  // Search haystack — combines all filterable dimensions plus the visible
  // text. Cached per-card so we only build it once. Includes job-id so
  // recruiters can paste a job number and find the listing immediately.
  function haystack(card) {
    if (!card._fctgHay) {
      card._fctgHay = [
        dimValue(card, 'name'),
        dimValue(card, 'job-id'),
        dimValue(card, 'location'),
        dimValue(card, 'country'),
        dimValue(card, 'region'),
        dimValue(card, 'brand'),
        dimValue(card, 'category'),
        dimValue(card, 'work-type'),
        dimValue(card, 'summary')
      ].join(' ').toLowerCase();
    }
    return card._fctgHay;
  }

  // ── Filter engine ─────────────────────────
  function applyFilters() {
    var kw = keyword.toLowerCase();
    var hasCities = objSize(activeCities) > 0;
    var hasRegions = objSize(activeRegions) > 0;
    var hasBrands = objSize(activeBrands) > 0;
    var hasCategories = objSize(activeCategories) > 0;
    var wt = workType.toLowerCase();

    var visible = [];
    for (var i = 0; i < _allCards.length; i++) {
      var card = _allCards[i];
      var show = true;

      if (show && kw) show = haystack(card).indexOf(kw) !== -1;
      if (show && hasCities) {
        var locs = locationParts(card);
        var any = false;
        for (var j = 0; j < locs.length; j++) {
          if (activeCities[locs[j].toLowerCase()]) { any = true; break; }
        }
        show = any;
      }
      if (show && hasRegions) {
        show = !!activeRegions[dimValue(card, 'region').toLowerCase()];
      }
      if (show && hasBrands) {
        show = !!activeBrands[dimValue(card, 'brand').toLowerCase()];
      }
      if (show && hasCategories) {
        show = matchesCategory(card, activeCategories);
      }
      if (show && wt) {
        show = dimValue(card, 'work-type').toLowerCase() === wt;
      }

      if (show) visible.push(card); else card.style.display = 'none';
    }

    sortVisible(visible);
    applyShowMoreLimit(visible);
    setCount(visible.length);
    setEmpty(visible.length === 0);
    updateCrossFilterCounts();
    renderTags();
    saveFilterState();
    serializeFiltersToURL();
  }

  function matchesCategory(card, activeMap) {
    var raw = dimValue(card, 'category');
    if (!raw) return false;
    var parts = raw.split(',');
    for (var i = 0; i < parts.length; i++) {
      if (activeMap[parts[i].trim().toLowerCase()]) return true;
    }
    return false;
  }

  // Sort + Show More ──
  // Sort is applied to the filtered set, then the first `visibleLimit`
  // cards are shown and the rest hidden. Cards are repositioned via
  // appendChild so their DOM order matches the sort.
  function sortVisible(visible) {
    if (sortMode === 'Name: A to Z') {
      visible.sort(function (a, b) { return dimValue(a, 'name').localeCompare(dimValue(b, 'name')); });
    } else if (sortMode === 'Name: Z to A') {
      visible.sort(function (a, b) { return dimValue(b, 'name').localeCompare(dimValue(a, 'name')); });
    }
    // For non-default sort, reposition in DOM so visible cards appear in
    // sorted order. For default, we leave existing DOM order alone.
    if (sortMode !== 'default') {
      var frag = document.createDocumentFragment();
      for (var i = 0; i < visible.length; i++) frag.appendChild(visible[i]);
      _listEl.appendChild(frag);
    }
  }

  function applyShowMoreLimit(visible) {
    for (var i = 0; i < visible.length; i++) {
      visible[i].style.display = (i < visibleLimit) ? '' : 'none';
    }
    updateShowMoreButton(visible.length > visibleLimit, visible.length - visibleLimit);
  }

  // ── Cross-filter counts (cascading) ───────
  // For each filter dimension, count jobs that pass ALL other filters
  // (so users see how many results each option would yield if added).
  function updateCrossFilterCounts() {
    var kw = keyword.toLowerCase();
    var hasCities = objSize(activeCities) > 0;
    var hasRegions = objSize(activeRegions) > 0;
    var hasBrands = objSize(activeBrands) > 0;
    var hasCategories = objSize(activeCategories) > 0;
    var wt = workType.toLowerCase();

    var regionCounts = {}, cityCounts = {}, brandCounts = {}, categoryCounts = {};

    for (var i = 0; i < _allCards.length; i++) {
      var card = _allCards[i];

      if (kw && haystack(card).indexOf(kw) === -1) continue;
      if (wt && dimValue(card, 'work-type').toLowerCase() !== wt) continue;

      var locs = locationParts(card);
      var matchCity = !hasCities || (function () {
        for (var j = 0; j < locs.length; j++) if (activeCities[locs[j].toLowerCase()]) return true;
        return false;
      })();
      var region = dimValue(card, 'region').toLowerCase();
      var matchRegion = !hasRegions || !!activeRegions[region];
      var brand = dimValue(card, 'brand').toLowerCase();
      var matchBrand = !hasBrands || !!activeBrands[brand];
      var matchCategory = !hasCategories || matchesCategory(card, activeCategories);

      // Region counts: apply all EXCEPT region filter
      if (matchCity && matchBrand && matchCategory) {
        if (region) regionCounts[region] = (regionCounts[region] || 0) + 1;
      }
      // City counts: apply all EXCEPT city filter (each location part)
      if (matchRegion && matchBrand && matchCategory) {
        for (var k = 0; k < locs.length; k++) {
          var ck = locs[k].toLowerCase();
          cityCounts[ck] = (cityCounts[ck] || 0) + 1;
        }
      }
      // Brand counts: apply all EXCEPT brand filter
      if (matchCity && matchRegion && matchCategory) {
        if (brand) brandCounts[brand] = (brandCounts[brand] || 0) + 1;
      }
      // Category counts: apply all EXCEPT category filter
      if (matchCity && matchRegion && matchBrand) {
        var rawCat = dimValue(card, 'category');
        if (rawCat) {
          var cats = rawCat.split(',');
          for (var c = 0; c < cats.length; c++) {
            var catk = cats[c].trim().toLowerCase();
            if (catk) categoryCounts[catk] = (categoryCounts[catk] || 0) + 1;
          }
        }
      }
    }

    updateFilterPanel('region', regionCounts);
    updateFilterPanel('city', cityCounts);
    updateFilterPanel('brand', brandCounts);
    updateFilterPanel('category', categoryCounts);
  }

  // Hide/show the WHOLE filter option element. When the checkbox lives
  // inside a Webflow CMS Collection Item (.filters1_item / .w-dyn-item),
  // we hide the entire item so any sibling content (e.g. subheadings,
  // count badges) disappears with it. Falls back to hiding just the label
  // when there's no item wrapper.
  function hideOption(label) {
    var wrapper = label.closest('.filters1_item, .w-dyn-item') || label;
    wrapper.style.display = 'none';
  }
  function showOption(label) {
    var wrapper = label.closest('.filters1_item, .w-dyn-item') || label;
    wrapper.style.display = '';
  }

  // Updates badge counts AND deduplicates by label. When a Webflow CMS
  // Collection List is bound to Job→Reference (e.g. one checkbox per Job's
  // Country), the same label can appear many times (Australia × 8 because
  // 8 jobs are Australian). We keep the first occurrence visible, hide the
  // rest. Zero-count options are also hidden unless the user has them
  // already checked. Filter state stores the label key, not the specific
  // checkbox, so check/uncheck still works correctly across dedup.
  function updateFilterPanel(groupName, counts) {
    var inputs = findGroupCheckboxes(groupName);
    var seen = {};
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var label = cb.closest('.w-checkbox, label');
      if (!label) continue;
      var key = getOptionLabel(cb).toLowerCase();
      var count = counts[key] || 0;

      // Dedup: only the first checkbox per label gets shown. Subsequent
      // duplicates are hidden regardless of count.
      if (seen[key]) { hideOption(label); continue; }
      seen[key] = true;

      var badge = label.querySelector('.filter-count');
      if (badge) badge.textContent = count;

      if (count > 0 || cb.checked) showOption(label);
      else hideOption(label);
    }
    if (groupName === 'city' || groupName === 'location') updateLocationSubheadings();
  }

  // Show subheadings as section headers, one per region. The Designer
  // structure (CMS Collection List of Locations) puts a subheading INSIDE
  // each item — repeating per row. We walk visible items in DOM order and
  // show only the FIRST subheading per unique region; the rest are hidden.
  // Items hidden by dedup or zero-count automatically suppress their own
  // subheadings (they're inside the hidden item wrapper).
  //
  // For this to look "grouped", the Locations CMS Collection List should
  // be sorted by Region in Designer (Sort: Region A→Z). Without that, you
  // get partial grouping — first occurrence of each region acts as a
  // section header but items below may belong to a different region.
  function updateLocationSubheadings() {
    var loc = document.querySelector('[filter-group="location"]')
           || document.querySelector('[filter-group="city"]');
    if (!loc) return;

    var seenRegions = {};
    var items = loc.querySelectorAll('.filters1_item, .w-dyn-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var subheading = item.querySelector('.filters1_filter-group-subheading');
      if (!subheading) continue;

      // If the item itself is hidden (dedup or zero count), nothing to do —
      // the subheading is inside the hidden wrapper so it's already invisible.
      if (item.style.display === 'none') continue;

      var region = (subheading.textContent || '').trim();
      if (!seenRegions[region]) {
        subheading.style.display = '';
        seenRegions[region] = true;
      } else {
        subheading.style.display = 'none';
      }
    }
  }

  // ── Counts + empty state ──────────────────
  // Writes "Showing X of Y Jobs" into the [filter-ui="count"] element.
  // Falls back to the legacy two-span Finsweet pattern if that's all the
  // page has.
  function setCount(n) {
    var total = _allCards.length;
    if (_rcEl) {
      // Simple single-element: just replace text content.
      _rcEl.textContent = 'Showing ' + n + ' of ' + total + ' Jobs';
    }
  }

  function setEmpty(flag) {
    if (_emptyEl) _emptyEl.style.display = flag ? 'flex' : 'none';
  }

  // ── Show More button ──────────────────────
  // Prefers a Designer-styled button with [filter-ui="show-more"] (or
  // legacy id="fctg-show-more"). If neither exists, JS injects a minimal
  // pill button so the feature still works out of the box.
  function findShowMoreButton() {
    return document.querySelector('[filter-ui="show-more"]') ||
           document.getElementById('fctg-show-more');
  }

  function bindShowMore() {
    var btn = findShowMoreButton();
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'fctg-show-more';
      btn.type = 'button';
      btn.textContent = 'Show more jobs';
      btn.style.cssText = 'display:none;margin:24px auto;padding:12px 24px;background:#000;color:#fff;border:none;border-radius:8px;font:600 14px/1 inherit;cursor:pointer;';
      if (_listEl.parentElement) _listEl.parentElement.appendChild(btn);
    }
    btn.addEventListener('click', function (e) {
      if (btn.tagName === 'A') e.preventDefault();
      visibleLimit += PAGE_SIZE;
      applyFilters();
    });
  }

  function updateShowMoreButton(hasMore, remaining) {
    var btn = findShowMoreButton();
    if (!btn) return;
    if (hasMore) {
      btn.style.display = '';
      // Only update text if Designer hasn't provided a custom label inside.
      // We treat the button text as Designer-owned if it has child elements;
      // otherwise we set "Show more (N remaining)".
      if (btn.children.length === 0) btn.textContent = 'Show more (' + remaining + ' remaining)';
    } else {
      btn.style.display = 'none';
    }
  }

  // ── Filter UI bindings ────────────────────
  function findSearchInput() {
    // Prefer the new convention; if the search-control element IS the input
    // use it directly, otherwise look for an input inside it.
    var ctrl = document.querySelector('[filter-ui="search"]');
    if (ctrl) {
      if (ctrl.tagName === 'INPUT') return ctrl;
      var inner = ctrl.querySelector('input');
      if (inner) return inner;
    }
    return document.querySelector('.filters1_keyword-search input');
  }

  function findTagsContainer() {
    return document.querySelector('[filter-ui="tags"]') ||
           document.querySelector('.filters1_tags-wrapper');
  }

  function bindSearch() {
    var input = findSearchInput();
    if (!input) return;
    var t;
    input.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        keyword = (input.value || '').trim();
        visibleLimit = PAGE_SIZE;
        applyFilters();
      }, DEBOUNCE);
    });
  }

  function bindFilterGroup(groupName, store) {
    var inputs = findGroupCheckboxes(groupName);
    for (var i = 0; i < inputs.length; i++) {
      (function (cb) {
        cb.addEventListener('change', function () {
          var key = getOptionLabel(cb).toLowerCase();
          if (!key) return;
          if (cb.checked) store[key] = true; else delete store[key];
          visibleLimit = PAGE_SIZE;
          applyFilters();
        });
      })(inputs[i]);
    }
  }

  function bindWorkTypeRadios() {
    var radios = findGroupRadios('work-type');
    if (!radios || !radios.length) {
      // Legacy fallback: Webflow's autoname-radio convention
      radios = document.querySelectorAll('input[name="Filter-Two"]');
    }
    radios.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        var lbl = getOptionLabel(r);
        workType = (lbl.toLowerCase() === 'all' || !lbl) ? '' : lbl;
        visibleLimit = PAGE_SIZE;
        applyFilters();
      });
    });
  }

  function bindSort() {
    var dropdowns = document.querySelectorAll('.w-dropdown');
    dropdowns.forEach(function (dd) {
      var links = dd.querySelectorAll('a');
      links.forEach(function (link) {
        link.addEventListener('click', function (e) {
          var lbl = link.textContent.trim();
          if (!/Name|Default|Newest|Oldest/i.test(lbl)) return;
          sortMode = lbl;
          var toggle = dd.querySelector('.w-dropdown-toggle');
          if (toggle) {
            var parts = toggle.querySelectorAll('div');
            for (var i = 0; i < parts.length; i++) {
              if (parts[i].children.length === 0) { parts[i].textContent = lbl; break; }
            }
          }
          visibleLimit = PAGE_SIZE;
          applyFilters();
        });
      });
    });
  }

  function bindClear(resetEls) {
    function clearAll(e) {
      if (e) e.preventDefault();
      keyword = '';
      clearObj(activeCities);
      clearObj(activeRegions);
      clearObj(activeBrands);
      clearObj(activeCategories);
      workType = '';
      sortMode = 'default';
      visibleLimit = PAGE_SIZE;
      var inp = findSearchInput();
      if (inp) inp.value = '';
      ['city', 'region', 'brand', 'category'].forEach(function (g) {
        var cbs = findGroupCheckboxes(g);
        for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
      });
      if (_allRadio) _allRadio.checked = true;
      applyFilters();
    }
    for (var i = 0; i < resetEls.length; i++) resetEls[i].addEventListener('click', clearAll);
  }

  // ── Active filter tags ────────────────────
  // Tags: the [filter-ui="tags"] element IS the chip template (Designer-styled
  // pill with text + close icon). JS treats it as a template — hides the
  // original by default, clones it for each active filter, and inserts the
  // clones as siblings. This way the Designer-styled "Tag x" chip never
  // shows as a placeholder, and active filters appear as styled chips that
  // match the design exactly.
  function renderTags() {
    var template = findTagsContainer();
    if (!template) return;

    // Hide the template itself — it's never rendered as a real chip.
    template.style.display = 'none';

    // Remove prior clones (siblings of the template that we previously created).
    var parent = template.parentNode;
    if (parent) {
      parent.querySelectorAll('[data-fctg-tag-clone]').forEach(function (c) { c.remove(); });
    }

    var filters = [];
    if (keyword) filters.push({ type: 'keyword', label: '"' + keyword + '"' });
    Object.keys(activeCities).forEach(function (k) { filters.push({ type: 'city', label: k, key: k }); });
    Object.keys(activeRegions).forEach(function (k) { filters.push({ type: 'region', label: k, key: k }); });
    Object.keys(activeCategories).forEach(function (k) { filters.push({ type: 'category', label: k, key: k }); });
    Object.keys(activeBrands).forEach(function (k) { filters.push({ type: 'brand', label: k, key: k }); });
    if (workType) filters.push({ type: 'workType', label: workType });

    if (filters.length === 0 || !parent) return;

    // Insert clones after the template, in reverse so they appear in the
    // correct order using insertBefore(clone, template.nextSibling).
    var anchor = template.nextSibling;
    filters.forEach(function (filter) {
      var clone = template.cloneNode(true);
      clone.removeAttribute('filter-ui');
      clone.setAttribute('data-fctg-tag-clone', '1');
      clone.style.display = '';

      // Find the text node — the first child that's not the close-icon.
      // The Designer template has structure: <div>Tag</div><div class="filters1_close-icon">…</div>
      var children = clone.children;
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (!/filters1_close-icon|w-embed/.test(c.className) && !c.querySelector('svg')) {
          c.textContent = capitalize(filter.label);
          break;
        }
      }

      // Wire the close icon to remove the filter
      var closeIcon = clone.querySelector('.filters1_close-icon, [class*="close"]') ||
                      clone.querySelector('svg')?.parentElement;
      if (closeIcon) {
        closeIcon.style.cursor = 'pointer';
        (function (f) {
          closeIcon.addEventListener('click', function () { removeFilter(f); });
        })(filter);
      }

      parent.insertBefore(clone, anchor);
    });
  }

  function removeFilter(f) {
    switch (f.type) {
      case 'keyword':
        keyword = '';
        var inp = findSearchInput();
        if (inp) inp.value = '';
        break;
      case 'city':     delete activeCities[f.key];     uncheckByLabel('city', f.key); break;
      case 'region':   delete activeRegions[f.key];    uncheckByLabel('region', f.key); break;
      case 'category': delete activeCategories[f.key]; uncheckByLabel('category', f.key); break;
      case 'brand':    delete activeBrands[f.key];     uncheckByLabel('brand', f.key); break;
      case 'workType': workType = ''; if (_allRadio) _allRadio.checked = true; break;
    }
    visibleLimit = PAGE_SIZE;
    applyFilters();
  }

  function uncheckByLabel(groupName, lowerLabel) {
    var inputs = findGroupCheckboxes(groupName);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      if (getOptionLabel(cb).toLowerCase() === lowerLabel) cb.checked = false;
    }
  }

  // ── URL + sessionStorage state ────────────
  function applyFiltersFromURL() {
    var params = new URLSearchParams(location.search);
    var applied = false;

    var q = params.get(URL_PARAM.keyword);
    if (q) {
      keyword = q; applied = true;
      var inp = findSearchInput();
      if (inp) inp.value = q;
    }
    [
      [URL_PARAM.city, activeCities, 'city'],
      [URL_PARAM.region, activeRegions, 'region'],
      [URL_PARAM.brand, activeBrands, 'brand'],
      [URL_PARAM.category, activeCategories, 'category']
    ].forEach(function (entry) {
      var raw = params.get(entry[0]);
      if (!raw) return;
      var keys = raw.split(',');
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i].trim().toLowerCase();
        if (k) entry[1][k] = true;
      }
      applied = true;
      checkBoxesByLabels(entry[2], entry[1]);
    });
    var wt = params.get(URL_PARAM.workType);
    if (wt) { workType = wt; applied = true; }
    var sm = params.get(URL_PARAM.sortMode);
    if (sm) { sortMode = sm; applied = true; }
    return applied;
  }

  function checkBoxesByLabels(groupName, store) {
    var inputs = findGroupCheckboxes(groupName);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var key = getOptionLabel(cb).toLowerCase();
      if (key && store[key]) cb.checked = true;
    }
  }

  function serializeFiltersToURL() {
    var params = new URLSearchParams();
    if (keyword) params.set(URL_PARAM.keyword, keyword);
    var cityKeys = Object.keys(activeCities); if (cityKeys.length) params.set(URL_PARAM.city, cityKeys.join(','));
    var regionKeys = Object.keys(activeRegions); if (regionKeys.length) params.set(URL_PARAM.region, regionKeys.join(','));
    var brandKeys = Object.keys(activeBrands); if (brandKeys.length) params.set(URL_PARAM.brand, brandKeys.join(','));
    var catKeys = Object.keys(activeCategories); if (catKeys.length) params.set(URL_PARAM.category, catKeys.join(','));
    if (workType) params.set(URL_PARAM.workType, workType);
    if (sortMode && sortMode !== 'default') params.set(URL_PARAM.sortMode, sortMode);
    var qs = params.toString();
    var newUrl = location.pathname + (qs ? '?' + qs : '') + location.hash;
    if (newUrl !== location.pathname + location.search + location.hash) {
      history.replaceState(null, '', newUrl);
    }
  }

  function saveFilterState() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        kw: keyword, c: activeCities, r: activeRegions, b: activeBrands,
        ca: activeCategories, wt: workType, sm: sortMode
      }));
    } catch (e) {}
  }

  function restoreFilterState() {
    try {
      var raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.kw) {
        keyword = s.kw;
        var inp = findSearchInput();
        if (inp) inp.value = s.kw;
      }
      copyInto(activeCities, s.c); checkBoxesByLabels('city', activeCities);
      copyInto(activeRegions, s.r); checkBoxesByLabels('region', activeRegions);
      copyInto(activeBrands, s.b); checkBoxesByLabels('brand', activeBrands);
      copyInto(activeCategories, s.ca); checkBoxesByLabels('category', activeCategories);
      if (s.wt) workType = s.wt;
      if (s.sm) sortMode = s.sm;
    } catch (e) {}
  }

  // ── Back-button wiring (runs on /jobs/{slug} too) ──
  // The back button on a job detail page sets sessionStorage.fctg_back so the
  // /jobs page knows to scroll to filters and re-open the relevant accordions.
  function setupBackButton() {
    var btn = document.getElementById('all-jobs-button');
    if (!btn) return;
    btn.setAttribute('href', '/jobs#filters');
    btn.addEventListener('click', function () {
      try { sessionStorage.setItem(BACK_KEY, '1'); } catch (e) {}
    });
  }

  function handleBackNavigation() {
    var fromBack = false;
    try { fromBack = sessionStorage.getItem(BACK_KEY) === '1'; sessionStorage.removeItem(BACK_KEY); } catch (e) {}
    if (!fromBack) return;
    var anchor = document.getElementById('filters') || _listEl;
    if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Helpers ───────────────────────────────
  function objSize(obj) { return Object.keys(obj).length; }
  function clearObj(obj) { Object.keys(obj).forEach(function (k) { delete obj[k]; }); }
  function copyInto(target, source) {
    clearObj(target);
    if (!source) return;
    Object.keys(source).forEach(function (k) { target[k] = source[k]; });
  }
  function capitalize(s) {
    if (!s) return '';
    return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
})();
