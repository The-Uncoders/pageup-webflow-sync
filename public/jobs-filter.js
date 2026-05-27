/**
 * FCTG Careers — Job Filter & Sort v6.0
 *
 * Webflow renders everything natively: the job cards and every filter panel
 * are CMS Collection Lists. This script does ONLY what Webflow can't do
 * natively — client-side faceted filtering, keyword search, cross-filter
 * counts, sort, active-filter tags, URL/session persistence, and merging the
 * paginated pages so every job is filterable at once (Webflow caps a rendered
 * Collection List at 100 items).
 *
 * ── Attribute contract (the script NEVER targets design classes, so a
 *    Designer class rename can't silently break it) ──────────────────────────
 *   filter="list"          The Collection List wrapper holding the job cards.
 *   filter="card"          Each job card (optional — falls back to the list's
 *                          direct `.w-dyn-item` children, which already
 *                          excludes nested label lists).
 *   filter="<dim>"         A value element on a card. Dimensions: name, job-id,
 *                          location, region, brand, category, work-type,
 *                          summary. Multi-value dims (location, region,
 *                          work-type) render one element per value via a nested
 *                          Collection List; the engine OR-matches across them.
 *   filter-group="<dim>"   A filter panel; its checkboxes drive that dimension.
 *                          `location` and `city` are aliases for one store.
 *   filter-ui="<role>"     A control: count | empty | clear | search | tags |
 *                          show-more. All optional; absent → that feature off.
 *
 * Category is the lone interim exception: its panel is bound to the Jobs
 * collection (not yet a canonical Category collection), so rebuildCategoryPanel()
 * regenerates it from the cards. See that function.
 *
 * Versions:
 *   v6.0 – Deep clean. Attribute-driven list discovery (replaces the
 *          `.career_list` class lookup a Designer rename silently broke).
 *          Removed all Finsweet neutralizing, dead helpers (matchesCategory,
 *          locationParts), id-based control fallbacks, and the JS-injected
 *          Show-more button (now opt-in via filter-ui="show-more"). Region is a
 *          single dual-purpose filter="region" label — dropped the old hidden
 *          duplicate and the filter="country" display alias, so 'country' left
 *          the search haystack. Kept: category panel rebuild + checkbox
 *          visual-sync, cross-filter counts, nested region-group hiding,
 *          pagination-merge, sort, tags, URL/session state.
 *   v5.x – CMS multi-reference dims; category card-driven rebuild; see git.
 */
(function () {
  'use strict';

  if (window._fctgFilterLoaded) return;
  window._fctgFilterLoaded = true;

  // ── Config ────────────────────────────────
  var DEBOUNCE = 250;
  var INIT_DELAY = 300;
  var SHOW_MORE_STEP = 30;       // only used when a filter-ui="show-more" exists
  var MAX_PAGES_TO_PROBE = 20;   // 100 × 20 = 2000-item hard ceiling
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
  var visibleLimit = Infinity;   // Infinity = show all matches (no show-more)

  // Cached refs
  var _listEl = null;            // the .w-dyn-items that directly holds cards
  var _rcEl = null, _emptyEl = null, _showMoreBtn = null;
  var _allCards = [];
  var _initialised = false;

  // ── Boot ──────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, INIT_DELAY); });
  } else {
    setTimeout(init, INIT_DELAY);
  }

  function init() {
    setupBackButton();             // also wires the back button on /jobs/{slug}
    if (_initialised) return;

    _listEl = findCardsContainer();
    if (!_listEl) return;          // not the jobs list page
    _initialised = true;
    _listEl.setAttribute('data-fctg-list', '');   // stable hook for injected CSS

    _rcEl = document.querySelector('[filter-ui="count"]');
    _emptyEl = document.querySelector('[filter-ui="empty"]');
    _showMoreBtn = document.querySelector('[filter-ui="show-more"]');
    if (_showMoreBtn) visibleLimit = SHOW_MORE_STEP;

    injectStyles();
    preventFormSubmits();

    function bindEverything() {
      // Region / location / brand / work-type panels are native CMS Collection
      // Lists — we only wire their checkboxes. Category is rebuilt from cards
      // first (its panel is bound to Jobs, not a canonical Category collection).
      rebuildCategoryPanel();

      bindSearch();
      bindFilterGroup('city', activeCities);
      bindFilterGroup('region', activeRegions);
      bindFilterGroup('brand', activeBrands);
      bindFilterGroup('category', activeCategories);
      bindFilterGroup('work-type', activeWorkTypes);
      bindSort();
      bindClear();
      bindShowMore();

      var urlApplied = applyFiltersFromURL();
      if (!urlApplied) restoreFilterState();

      applyFilters();
      handleBackNavigation();
    }

    loadAllPages().then(function () {
      hidePaginationControls();
      _allCards = collectCards();
      bindEverything();
    }).catch(function (err) {
      console.warn('[fctg-filter] paginate-load failed, first page only:', err);
      _allCards = collectCards();
      bindEverything();
    });
  }

  // ── List + card discovery (attribute-first, resilient) ──
  // `filter="list"` goes on the Collection List wrapper (.w-dyn-list); we
  // normalize to its inner .w-dyn-items (the element that directly holds the
  // card .w-dyn-item children). If the attribute isn't present we derive the
  // container from any card via [filter="card"] / [filter="job-id"] — no
  // dependency on any design class.
  function findCardsContainer(root) {
    root = root || document;
    var marked = root.querySelector('[filter="list"]');
    if (marked) return marked.querySelector('.w-dyn-items') || marked;
    var anyCard = root.querySelector('[filter="card"]') || root.querySelector('[filter="job-id"]');
    if (anyCard) {
      var item = anyCard.closest('.w-dyn-item');
      if (item && item.parentElement) return item.parentElement;
    }
    return null;
  }

  // Cards are the container's DIRECT .w-dyn-item children — this deliberately
  // excludes the nested label Collection Lists (locations/work-types) inside
  // each card, so they're never mistaken for cards.
  function collectCards() {
    return Array.prototype.slice.call(_listEl.querySelectorAll(':scope > .w-dyn-item'));
  }

  // ── Paginate-load: merge pages 2..N so all jobs are in the DOM ──
  // Webflow renders ≤100 items per page. We fetch subsequent pages via the
  // `?<hash>_page=N` param from the Next link and append their cards, deduping
  // by [filter="job-id"]. Stops at the first empty page.
  function loadAllPages() {
    return new Promise(function (resolve, reject) {
      var nextLink = document.querySelector('.w-pagination-next');
      if (!nextLink) return resolve();
      var paramName = readPageParamName(nextLink);
      if (!paramName) return resolve();

      var seen = {};
      collectCards().forEach(function (c) {
        var idEl = c.querySelector('[filter="job-id"]');
        var jid = idEl ? (idEl.textContent || '').trim() : '';
        if (jid) seen[jid] = true;
      });

      var basePath = location.pathname;
      var fetches = [];
      for (var p = 2; p <= MAX_PAGES_TO_PROBE; p++) {
        (function (page) {
          var url = basePath + '?' + encodeURIComponent(paramName) + '=' + page;
          fetches.push(
            fetch(url, { credentials: 'same-origin' }).then(function (r) {
              if (!r.ok) return { p: page, items: [] };
              return r.text().then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var container = findCardsContainer(doc);
                var items = container ? container.querySelectorAll(':scope > .w-dyn-item') : [];
                return { p: page, items: items };
              });
            }).catch(function () { return { p: page, items: [] }; })
          );
        })(p);
      }

      Promise.all(fetches).then(function (results) {
        results.sort(function (a, b) { return a.p - b.p; });
        var lastPage = 1, appended = 0;
        for (var i = 0; i < results.length; i++) {
          var page = results[i];
          if (!page.items || page.items.length === 0) break;   // past the last real page
          lastPage = page.p;
          for (var j = 0; j < page.items.length; j++) {
            var item = page.items[j];
            var idEl = item.querySelector('[filter="job-id"]');
            var jobId = idEl ? (idEl.textContent || '').trim() : '';
            if (!jobId || seen[jobId]) continue;
            seen[jobId] = true;
            _listEl.appendChild(document.adoptNode(item));
            appended++;
          }
        }
        if (appended > 0) {
          console.log('[fctg-filter] merged pages 2..' + lastPage + ' (' + Object.keys(seen).length + ' unique cards)');
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

  function hidePaginationControls() {
    var pags = document.querySelectorAll('.w-pagination-wrapper');
    for (var i = 0; i < pags.length; i++) pags[i].style.display = 'none';
  }

  // ── Scoped styles ─────────────────────────
  // Hides the `.hidden` combo elements that carry filter-only data (job-id,
  // brand) inside cards, and any pagination wrapper. Scoped to our runtime
  // list hook so it's independent of design class names.
  function injectStyles() {
    if (document.getElementById('fctg-filter-styles')) return;
    var s = document.createElement('style');
    s.id = 'fctg-filter-styles';
    s.textContent =
      '[data-fctg-list] .hidden { display: none !important; }' +
      '.w-pagination-wrapper { display: none !important; }';
    document.head.appendChild(s);
  }

  function preventFormSubmits() {
    // Any <form> wrapping the filter controls would reload the page on Enter.
    var ctrl = document.querySelector('[filter-group], [filter-ui="search"]');
    var form = ctrl ? ctrl.closest('form') : null;
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });
  }

  // ── Filter-panel selector helpers ─────────
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
    return [];
  }

  // Read a checkbox's user-visible label (Webflow's .w-form-label, else the
  // wrapping label's text).
  function getOptionLabel(input) {
    var label = input.closest('.w-checkbox, .w-radio, label');
    if (!label) return '';
    var span = label.querySelector('.w-form-label');
    return ((span ? span.textContent : label.textContent) || '').trim();
  }

  // ── Card value reads ──────────────────────
  function dimValue(card, dim) {
    var el = card.querySelector('[filter="' + dim + '"]');
    return el ? (el.textContent || '').trim() : '';
  }

  // Every value of a dimension. Multi-value dims render one [filter="X"]
  // element per value. `split` (category only) also splits a single element's
  // comma-separated text — never used for dims whose names can contain commas.
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

  // Keyword haystack (built once per card). Country is intentionally absent —
  // region carries the same value and the city/country detail lives in location.
  function haystack(card) {
    if (!card._fctgHay) {
      card._fctgHay = [
        cardValues(card, 'name', false).join(' '),
        cardValues(card, 'job-id', false).join(' '),
        cardValues(card, 'location', false).join(' '),
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

  function sortVisible(visible) {
    if (sortMode === 'Name: A to Z') {
      visible.sort(function (a, b) { return dimValue(a, 'name').localeCompare(dimValue(b, 'name')); });
    } else if (sortMode === 'Name: Z to A') {
      visible.sort(function (a, b) { return dimValue(b, 'name').localeCompare(dimValue(a, 'name')); });
    }
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

  function resetLimit() { visibleLimit = _showMoreBtn ? SHOW_MORE_STEP : Infinity; }

  // ── Cross-filter counts (cascading) ───────
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

  function hideOption(label) {
    (label.closest('.filters1_item, .w-dyn-item') || label).style.display = 'none';
  }
  function showOption(label) {
    (label.closest('.filters1_item, .w-dyn-item') || label).style.display = '';
  }

  // Writes each option's count badge and hides zero-count options (unless the
  // user has it checked). Duplicate labels (the Locations panel mirrors
  // PageUp's duplicate entries) are left as-is — they share a count and filter
  // identically.
  function updateFilterPanel(groupName, counts) {
    var inputs = findGroupCheckboxes(groupName);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var label = cb.closest('.w-checkbox, .w-radio, label');
      if (!label) continue;
      var count = counts[getOptionLabel(cb).toLowerCase()] || 0;
      var badge = label.querySelector('.filter-count');
      if (badge) badge.textContent = count;
      if (count > 0 || cb.checked) showOption(label); else hideOption(label);
    }
    if (groupName === 'city' || groupName === 'location') updateLocationRegionGroups();
  }

  // The Locations panel nests location checkboxes under per-region group items.
  // When filtering hides every location in a region, hide the whole region
  // group so its header doesn't linger over an empty section.
  function updateLocationRegionGroups() {
    var wrap = document.querySelector('[filter-group="location"]') ||
               document.querySelector('[filter-group="city"]');
    if (!wrap) return;
    var outerList = wrap.querySelector('.w-dyn-list');
    if (!outerList) return;
    var groups = outerList.querySelectorAll(':scope > .w-dyn-items > .w-dyn-item');
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var cbs = grp.querySelectorAll('input[type="checkbox"]');
      var anyVisible = false;
      for (var i = 0; i < cbs.length; i++) {
        var item = cbs[i].closest('.filters1_item, .w-dyn-item');
        if (item && item !== grp && item.style.display !== 'none') { anyVisible = true; break; }
      }
      grp.style.display = anyVisible ? '' : 'none';
    }
  }

  // ── Count + empty ─────────────────────────
  function setCount(n) {
    if (_rcEl) _rcEl.textContent = 'Showing ' + n + ' of ' + _allCards.length + ' Jobs';
  }
  function setEmpty(flag) {
    if (_emptyEl) _emptyEl.style.display = flag ? 'flex' : 'none';
  }

  // ── Show More (opt-in via filter-ui="show-more") ──
  function bindShowMore() {
    if (!_showMoreBtn) return;
    _showMoreBtn.addEventListener('click', function (e) {
      if (_showMoreBtn.tagName === 'A') e.preventDefault();
      visibleLimit += SHOW_MORE_STEP;
      applyFilters();
    });
  }
  function updateShowMoreButton(hasMore, remaining) {
    if (!_showMoreBtn) return;
    _showMoreBtn.style.display = hasMore ? '' : 'none';
    if (hasMore && _showMoreBtn.children.length === 0) {
      _showMoreBtn.textContent = 'Show more (' + remaining + ' remaining)';
    }
  }

  // ── UI bindings ───────────────────────────
  function findSearchInput() {
    var ctrl = document.querySelector('[filter-ui="search"]');
    if (!ctrl) return null;
    return ctrl.tagName === 'INPUT' ? ctrl : ctrl.querySelector('input');
  }
  function findTagsContainer() {
    return document.querySelector('[filter-ui="tags"]');
  }

  function bindSearch() {
    var input = findSearchInput();
    if (!input) return;
    var t;
    input.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        keyword = (input.value || '').trim();
        resetLimit();
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
          syncCheckboxVisual(cb);
          resetLimit();
          applyFilters();
        });
      })(inputs[i]);
    }
  }

  // Webflow custom checkboxes show their tick via `.w--redirected-checked` on
  // the sibling `.w-checkbox-input`, toggled by webflow.js on user click.
  // Checkboxes we inject after load (the rebuilt Category panel) aren't wired
  // by webflow.js, and programmatic check/uncheck never fires it — so we sync.
  function syncCheckboxVisual(cb) {
    var label = cb.closest('.w-checkbox, label');
    var box = label ? label.querySelector('.w-checkbox-input') : null;
    if (box) box.classList.toggle('w--redirected-checked', !!cb.checked);
  }

  // ── Category panel rebuild (interim) ──────
  // The Category Collection List is bound to the Jobs collection (one item per
  // job) → it duplicates, shows combined multi-category strings as single
  // options, and is capped at Webflow's 100-item display limit (dropping rarer
  // categories). We replace its items with one checkbox per DISTINCT category
  // gathered from ALL cards in the DOM. Data-driven: a brand-new category any
  // recruitment team posts appears automatically (no hardcoded list). Comma
  // handling is unchanged, so the lone PageUp category containing a comma
  // ("Legal, Risk and Compliance") still shows as two entries — the documented
  // quirk we accept until Category becomes its own canonical CMS collection.
  function rebuildCategoryPanel() {
    var group = document.querySelector('[filter-group="category"]');
    if (!group) return;
    var itemsWrap = group.querySelector('.w-dyn-items') || group.querySelector('.filters1_list');
    if (!itemsWrap) return;
    var template = itemsWrap.querySelector('.filters1_item, .w-dyn-item');
    if (!template) return;

    var seen = {};   // lowerKey -> display label
    for (var i = 0; i < _allCards.length; i++) {
      var vals = cardValues(_allCards[i], 'category', true);
      for (var j = 0; j < vals.length; j++) {
        var disp = vals[j], key = disp.toLowerCase();
        if (key && !seen[key]) seen[key] = disp;
      }
    }
    var labels = Object.keys(seen).map(function (k) { return seen[k]; });
    if (!labels.length) return;   // no card data — leave panel untouched
    labels.sort(function (a, b) { return a.localeCompare(b); });

    var frag = document.createDocumentFragment();
    for (var n = 0; n < labels.length; n++) {
      var clone = template.cloneNode(true);
      clone.style.display = '';
      var span = clone.querySelector('.w-form-label');
      if (span) span.textContent = labels[n];
      var cb = clone.querySelector('input[type="checkbox"]');
      if (cb) { cb.checked = false; cb.removeAttribute('checked'); }
      var box = clone.querySelector('.w-checkbox-input');
      if (box) box.classList.remove('w--redirected-checked');
      var badge = clone.querySelector('.filter-count');
      if (badge) {
        var inner = badge.querySelector('.text-size-regular');
        if (inner) inner.textContent = '0'; else badge.textContent = '0';
      }
      frag.appendChild(clone);
    }
    itemsWrap.innerHTML = '';
    itemsWrap.appendChild(frag);
  }

  function bindSort() {
    var dropdowns = document.querySelectorAll('.w-dropdown');
    dropdowns.forEach(function (dd) {
      dd.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
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
          resetLimit();
          applyFilters();
        });
      });
    });
  }

  function bindClear() {
    var resetEls = document.querySelectorAll('[filter-ui="clear"]');
    function clearAll(e) {
      if (e) e.preventDefault();
      keyword = '';
      clearObj(activeCities); clearObj(activeRegions); clearObj(activeBrands);
      clearObj(activeCategories); clearObj(activeWorkTypes);
      sortMode = 'default';
      resetLimit();
      var inp = findSearchInput();
      if (inp) inp.value = '';
      ['city', 'region', 'brand', 'category', 'work-type'].forEach(function (g) {
        var cbs = findGroupCheckboxes(g);
        for (var i = 0; i < cbs.length; i++) { cbs[i].checked = false; syncCheckboxVisual(cbs[i]); }
      });
      applyFilters();
    }
    for (var i = 0; i < resetEls.length; i++) resetEls[i].addEventListener('click', clearAll);
  }

  // ── Active filter tags ────────────────────
  // The [filter-ui="tags"] element is the chip template: hidden, cloned per
  // active filter, clones inserted as siblings.
  function renderTags() {
    var template = findTagsContainer();
    if (!template) return;
    template.style.display = 'none';
    var parent = template.parentNode;
    if (parent) parent.querySelectorAll('[data-fctg-tag-clone]').forEach(function (c) { c.remove(); });

    var filters = [];
    if (keyword) filters.push({ type: 'keyword', label: '"' + keyword + '"' });
    Object.keys(activeCities).forEach(function (k) { filters.push({ type: 'city', label: k, key: k }); });
    Object.keys(activeRegions).forEach(function (k) { filters.push({ type: 'region', label: k, key: k }); });
    Object.keys(activeCategories).forEach(function (k) { filters.push({ type: 'category', label: k, key: k }); });
    Object.keys(activeBrands).forEach(function (k) { filters.push({ type: 'brand', label: k, key: k }); });
    Object.keys(activeWorkTypes).forEach(function (k) { filters.push({ type: 'workType', label: k, key: k }); });
    if (filters.length === 0 || !parent) return;

    var anchor = template.nextSibling;
    filters.forEach(function (filter) {
      var clone = template.cloneNode(true);
      clone.removeAttribute('filter-ui');
      clone.setAttribute('data-fctg-tag-clone', '1');
      clone.style.display = '';
      var children = clone.children;
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (!/filters1_close-icon|w-embed/.test(c.className) && !c.querySelector('svg')) {
          c.textContent = capitalize(filter.label);
          break;
        }
      }
      var closeIcon = clone.querySelector('.filters1_close-icon, [class*="close"]') ||
                      (clone.querySelector('svg') && clone.querySelector('svg').parentElement);
      if (closeIcon) {
        closeIcon.style.cursor = 'pointer';
        (function (f) { closeIcon.addEventListener('click', function () { removeFilter(f); }); })(filter);
      }
      parent.insertBefore(clone, anchor);
    });
  }

  function removeFilter(f) {
    switch (f.type) {
      case 'keyword': keyword = ''; var inp = findSearchInput(); if (inp) inp.value = ''; break;
      case 'city':     delete activeCities[f.key];     uncheckByLabel('city', f.key); break;
      case 'region':   delete activeRegions[f.key];    uncheckByLabel('region', f.key); break;
      case 'category': delete activeCategories[f.key]; uncheckByLabel('category', f.key); break;
      case 'brand':    delete activeBrands[f.key];     uncheckByLabel('brand', f.key); break;
      case 'workType': delete activeWorkTypes[f.key];  uncheckByLabel('work-type', f.key); break;
    }
    resetLimit();
    applyFilters();
  }

  function uncheckByLabel(groupName, lowerLabel) {
    var inputs = findGroupCheckboxes(groupName);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      if (getOptionLabel(cb).toLowerCase() === lowerLabel) { cb.checked = false; syncCheckboxVisual(cb); }
    }
  }

  // ── URL + sessionStorage state ────────────
  function applyFiltersFromURL() {
    var params = new URLSearchParams(location.search);
    var applied = false;

    var q = params.get(URL_PARAM.keyword);
    if (q) { keyword = q; applied = true; var inp = findSearchInput(); if (inp) inp.value = q; }

    [
      [URL_PARAM.city, activeCities, 'city'],
      [URL_PARAM.region, activeRegions, 'region'],
      [URL_PARAM.brand, activeBrands, 'brand'],
      [URL_PARAM.category, activeCategories, 'category'],
      [URL_PARAM.workType, activeWorkTypes, 'work-type']
    ].forEach(function (entry) {
      var raw = params.get(entry[0]);
      if (!raw) return;
      raw.split(',').forEach(function (k) { k = k.trim().toLowerCase(); if (k) entry[1][k] = true; });
      applied = true;
      checkBoxesByLabels(entry[2], entry[1]);
    });

    var sm = params.get(URL_PARAM.sortMode);
    if (sm) { sortMode = sm; applied = true; }
    return applied;
  }

  function checkBoxesByLabels(groupName, store) {
    var inputs = findGroupCheckboxes(groupName);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      if (store[getOptionLabel(cb).toLowerCase()]) { cb.checked = true; syncCheckboxVisual(cb); }
    }
  }

  function serializeFiltersToURL() {
    var params = new URLSearchParams();
    if (keyword) params.set(URL_PARAM.keyword, keyword);
    var put = function (store, param) {
      var keys = Object.keys(store);
      if (keys.length) params.set(param, keys.join(','));
    };
    put(activeCities, URL_PARAM.city);
    put(activeRegions, URL_PARAM.region);
    put(activeBrands, URL_PARAM.brand);
    put(activeCategories, URL_PARAM.category);
    put(activeWorkTypes, URL_PARAM.workType);
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
      if (s.kw) { keyword = s.kw; var inp = findSearchInput(); if (inp) inp.value = s.kw; }
      copyInto(activeCities, s.c); checkBoxesByLabels('city', activeCities);
      copyInto(activeRegions, s.r); checkBoxesByLabels('region', activeRegions);
      copyInto(activeBrands, s.b); checkBoxesByLabels('brand', activeBrands);
      copyInto(activeCategories, s.ca); checkBoxesByLabels('category', activeCategories);
      copyInto(activeWorkTypes, s.wt); checkBoxesByLabels('work-type', activeWorkTypes);
      if (s.sm) sortMode = s.sm;
    } catch (e) {}
  }

  // ── Back-button wiring (runs on /jobs/{slug} too) ──
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
    if (source) Object.keys(source).forEach(function (k) { target[k] = source[k]; });
  }
  function capitalize(s) {
    return s ? s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '';
  }
})();
