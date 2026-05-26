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
 * v5.0   – Filters read native CMS multi-reference fields (Regions, Locations,
 *           Work Types collections). Each multi-ref renders one [filter="X"]
 *           element per value; the engine OR-matches across them. Work type is
 *           now multi-select. Removed autoPopulate / comma-split / JSON paths.
 *           Dedup-by-label OFF (mirrors PageUp's duplicate entries verbatim).
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
  var activeWorkTypes = {};
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
      // Filter-panel checkboxes are native Webflow Collection Lists bound to
      // the Regions / Locations / Work Types collections — no JS population.
      bindSearch();
      bindFilterGroup('city', activeCities);
      bindFilterGroup('region', activeRegions);
      bindFilterGroup('brand', activeBrands);
      bindFilterGroup('category', activeCategories);
      bindFilterGroup('work-type', activeWorkTypes);
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

  // Read a checkbox/radio's user-visible label text. Tries Webflow's
  // .w-form-label first; falls back to the parent label's textContent.
  function getOptionLabel(input) {
    var label = input.closest('.w-checkbox, .w-radio, label');
    if (!label) return '';
    var span = label.querySelector('.w-form-label');
    if (span) return (span.textContent || '').trim();
    return (label.textContent || '').trim();
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

  // Read every value of a card dimension. Multi-reference dimensions (region,
  // location, work-type) render one [filter="X"] element per referenced item
  // (Webflow nested Collection List), so we collect them all. `split` is only
  // for the plaintext category field (comma-separated in one element) — never
  // for locations, whose canonical names can contain commas (e.g. "Mumbai,
  // India").
  function cardValues(card, dim, split) {
    var els = card.querySelectorAll('[filter="' + dim + '"]');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (!t) continue;
      if (split) {
        t.split(',').forEach(function (p) { var s = p.trim(); if (s) out.push(s); });
      } else {
        out.push(t);
      }
    }
    return out;
  }

  function anyMatch(values, activeMap) {
    for (var i = 0; i < values.length; i++) {
      if (activeMap[values[i].toLowerCase()]) return true;
    }
    return false;
  }

  function locationParts(card) {
    return cardValues(card, 'location', false);
  }

  // Search haystack — combines all filterable dimensions plus the visible
  // text. Cached per-card so we only build it once. Includes job-id so
  // recruiters can paste a job number and find the listing immediately.
  function haystack(card) {
    if (!card._fctgHay) {
      card._fctgHay = [
        cardValues(card, 'name', false).join(' '),
        cardValues(card, 'job-id', false).join(' '),
        cardValues(card, 'location', false).join(' '),
        cardValues(card, 'country', false).join(' '),
        cardValues(card, 'region', false).join(' '),
        cardValues(card, 'brand', false).join(' '),
        cardValues(card, 'category', true).join(' '),
        cardValues(card, 'work-type', false).join(' '),
        cardValues(card, 'summary', false).join(' ')
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
    var hasWorkTypes = objSize(activeWorkTypes) > 0;

    var visible = [];
    for (var i = 0; i < _allCards.length; i++) {
      var card = _allCards[i];
      var show = true;

      if (show && kw) show = haystack(card).indexOf(kw) !== -1;
      if (show && hasCities) show = anyMatch(cardValues(card, 'location', false), activeCities);
      if (show && hasRegions) show = anyMatch(cardValues(card, 'region', false), activeRegions);
      if (show && hasBrands) show = anyMatch(cardValues(card, 'brand', false), activeBrands);
      if (show && hasCategories) show = anyMatch(cardValues(card, 'category', true), activeCategories);
      if (show && hasWorkTypes) show = anyMatch(cardValues(card, 'work-type', false), activeWorkTypes);

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
    return anyMatch(cardValues(card, 'category', true), activeMap);
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
    var hasWorkTypes = objSize(activeWorkTypes) > 0;

    var regionCounts = {}, cityCounts = {}, brandCounts = {}, categoryCounts = {}, workTypeCounts = {};
    var bump = function (map, values) {
      for (var n = 0; n < values.length; n++) {
        var k = values[n].toLowerCase();
        if (k) map[k] = (map[k] || 0) + 1;
      }
    };

    for (var i = 0; i < _allCards.length; i++) {
      var card = _allCards[i];
      if (kw && haystack(card).indexOf(kw) === -1) continue;

      var locs = cardValues(card, 'location', false);
      var regions = cardValues(card, 'region', false);
      var brands = cardValues(card, 'brand', false);
      var cats = cardValues(card, 'category', true);
      var wts = cardValues(card, 'work-type', false);

      var matchCity = !hasCities || anyMatch(locs, activeCities);
      var matchRegion = !hasRegions || anyMatch(regions, activeRegions);
      var matchBrand = !hasBrands || anyMatch(brands, activeBrands);
      var matchCategory = !hasCategories || anyMatch(cats, activeCategories);
      var matchWorkType = !hasWorkTypes || anyMatch(wts, activeWorkTypes);

      // Each dimension's counts apply every OTHER active filter.
      if (matchCity && matchBrand && matchCategory && matchWorkType) bump(regionCounts, regions);
      if (matchRegion && matchBrand && matchCategory && matchWorkType) bump(cityCounts, locs);
      if (matchCity && matchRegion && matchCategory && matchWorkType) bump(brandCounts, brands);
      if (matchCity && matchRegion && matchBrand && matchWorkType) bump(categoryCounts, cats);
      if (matchCity && matchRegion && matchBrand && matchCategory) bump(workTypeCounts, wts);
    }

    updateFilterPanel('region', regionCounts);
    updateFilterPanel('city', cityCounts);
    updateFilterPanel('brand', brandCounts);
    updateFilterPanel('category', categoryCounts);
    updateFilterPanel('work-type', workTypeCounts);
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
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var label = cb.closest('.w-checkbox, .w-radio, label');
      if (!label) continue;
      var key = getOptionLabel(cb).toLowerCase();
      var count = counts[key] || 0;

      // No dedup-by-label: the canonical Locations collection intentionally
      // mirrors PageUp's duplicates (e.g. two "Manchester" entries) and the
      // client wants both checkboxes visible. They share a label, so they
      // carry the same count and filter identically.
      var badge = label.querySelector('.filter-count');
      if (badge) badge.textContent = count;

      if (count > 0 || cb.checked) showOption(label);
      else hideOption(label);
    }
    if (groupName === 'city' || groupName === 'location') updateLocationRegionGroups();
  }

  // Nested region grouping: each region is an OUTER Collection List item
  // (.w-dyn-item) holding a region header (.text-size-small.text-weight-
  // semibold) plus a nested Collection List of that region's location
  // checkboxes. When filtering hides every location in a region, hide the
  // whole region group so its header doesn't linger over an empty section.
  function updateLocationRegionGroups() {
    var wrap = document.querySelector('[filter-group="location"]')
            || document.querySelector('[filter-group="city"]');
    if (!wrap) return;
    var outerList = wrap.querySelector('.w-dyn-list');   // first = outer Regions list
    if (!outerList) return;
    var groups = outerList.querySelectorAll(':scope > .w-dyn-items > .w-dyn-item');
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var cbs = grp.querySelectorAll('input[type="checkbox"]');
      var anyVisible = false;
      for (var i = 0; i < cbs.length; i++) {
        // The location's own (inner) item wrapper — not the region group.
        var item = cbs[i].closest('.filters1_item, .w-dyn-item');
        if (item && item !== grp && item.style.display !== 'none') { anyVisible = true; break; }
      }
      grp.style.display = anyVisible ? '' : 'none';
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
      clearObj(activeWorkTypes);
      sortMode = 'default';
      visibleLimit = PAGE_SIZE;
      var inp = findSearchInput();
      if (inp) inp.value = '';
      ['city', 'region', 'brand', 'category', 'work-type'].forEach(function (g) {
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
    Object.keys(activeWorkTypes).forEach(function (k) { filters.push({ type: 'workType', label: k, key: k }); });

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
      case 'workType': delete activeWorkTypes[f.key]; uncheckByLabel('work-type', f.key); break;
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
    if (wt) {
      wt.split(',').forEach(function (k) { k = k.trim().toLowerCase(); if (k) activeWorkTypes[k] = true; });
      applied = true;
      checkBoxesByLabels('work-type', activeWorkTypes);
    }
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
    var wtKeys = Object.keys(activeWorkTypes); if (wtKeys.length) params.set(URL_PARAM.workType, wtKeys.join(','));
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
        ca: activeCategories, wt: activeWorkTypes, sm: sortMode
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
      copyInto(activeWorkTypes, s.wt); checkBoxesByLabels('work-type', activeWorkTypes);
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
