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
    _rcEl = document.querySelector('[fs-cmsfilter-element="results-count"]');
    _icEl = document.querySelector('[fs-cmsfilter-element="items-count"]');
    _emptyEl = document.querySelector('[fs-cmsfilter-element="empty"]');
    _allRadio = document.querySelector('label[fs-cmsfilter-element="reset"] input[type="radio"]');
    var resetEls = document.querySelectorAll('a[fs-cmsfilter-element="reset"]');

    injectStyles();
    neutraliseFinsweet();
    preventFormSubmits();

    // Load remaining pages, then bind UI + apply filters
    loadAllPages().then(function () {
      hidePaginationControls();
      _allCards = collectCards();

      bindSearch();
      bindCheckboxes('input[name="city"]', activeCities);
      bindCheckboxes('input[name="region"]', activeRegions);
      bindCheckboxes('input[name="brand"]', activeBrands);
      bindCheckboxes('input[name="category"]', activeCategories);
      bindWorkTypeRadios();
      bindSort();
      bindClear(resetEls);
      bindShowMore();

      // URL params take precedence; sessionStorage is the fallback (back-nav).
      var urlApplied = applyFiltersFromURL();
      if (!urlApplied) restoreFilterState();

      applyFilters();
      handleBackNavigation();
    }).catch(function (err) {
      console.warn('[fctg-filter] paginate-load failed, falling back to first page only:', err);
      _allCards = collectCards();
      bindSearch();
      bindCheckboxes('input[name="city"]', activeCities);
      bindCheckboxes('input[name="region"]', activeRegions);
      bindCheckboxes('input[name="brand"]', activeBrands);
      bindCheckboxes('input[name="category"]', activeCategories);
      bindWorkTypeRadios();
      bindSort();
      bindClear(resetEls);
      bindShowMore();
      var urlApplied2 = applyFiltersFromURL();
      if (!urlApplied2) restoreFilterState();
      applyFilters();
      handleBackNavigation();
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
  // Subsequent pages are reachable via `?<hash>_page=N` URLs surfaced
  // through the pagination links. We fetch them all in parallel and merge
  // the cards into the live `.career_list`.
  //
  // Deduplicates by `[filter="job-id"]` value as a defensive safety net.
  // Webflow's "Random shuffle" sort independently re-shuffles each page,
  // so without dedup the same job can appear on multiple paginated pages
  // (and others can be missed entirely). Recommend a deterministic sort
  // in Designer (Default, Closing Date, or Name) — but dedup is a safety
  // belt for any other source of duplication too.
  function loadAllPages() {
    return new Promise(function (resolve, reject) {
      var nextLink = document.querySelector('.w-pagination-next');
      if (!nextLink) return resolve();

      var pageCount = readTotalPageCount();
      if (pageCount <= 1) return resolve();

      var paramName = readPageParamName(nextLink);
      if (!paramName) return resolve();

      // Track job-ids already in the DOM (from page 1) to dedupe page N.
      var seen = {};
      var existingCards = collectCards();
      for (var i = 0; i < existingCards.length; i++) {
        var jid = (existingCards[i].querySelector('[filter="job-id"]')?.textContent || '').trim();
        if (jid) seen[jid] = true;
      }

      var urls = [];
      var basePath = location.pathname;
      for (var p = 2; p <= pageCount; p++) {
        urls.push(basePath + '?' + encodeURIComponent(paramName) + '=' + p);
      }

      Promise.all(urls.map(function (u) {
        return fetch(u, { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + u);
          return r.text();
        });
      })).then(function (htmls) {
        var parser = new DOMParser();
        var dupesSkipped = 0;
        var noIdSkipped = 0;
        for (var i = 0; i < htmls.length; i++) {
          var doc = parser.parseFromString(htmls[i], 'text/html');
          var items = doc.querySelectorAll('.career_list > .w-dyn-item');
          for (var j = 0; j < items.length; j++) {
            var item = items[j];
            var idEl = item.querySelector('[filter="job-id"]');
            var jobId = idEl ? (idEl.textContent || '').trim() : '';
            if (!jobId) { noIdSkipped++; continue; }
            if (seen[jobId]) { dupesSkipped++; continue; }
            seen[jobId] = true;
            _listEl.appendChild(document.adoptNode(item));
          }
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

  function readTotalPageCount() {
    var pageCountEl = document.querySelector('.w-page-count');
    if (!pageCountEl) return 1;
    var m = (pageCountEl.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return parseInt(m[2], 10);
    var n = parseInt((pageCountEl.textContent || '').replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? 1 : n;
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

    updateFilterPanel('input[name="region"]', regionCounts);
    updateFilterPanel('input[name="city"]', cityCounts);
    updateFilterPanel('input[name="brand"]', brandCounts);
    updateFilterPanel('input[name="category"]', categoryCounts);
  }

  function updateFilterPanel(selector, counts) {
    var inputs = document.querySelectorAll(selector);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var label = cb.closest('.w-checkbox');
      if (!label) continue;
      var spanEl = label.querySelector('.w-form-label');
      var key = spanEl ? spanEl.textContent.trim().toLowerCase() : '';
      var count = counts[key] || 0;

      var badge = label.querySelector('.filter-count');
      if (badge) badge.textContent = count;

      // Hide zero-count options unless the user has them checked already.
      if (count > 0 || cb.checked) label.style.display = '';
      else label.style.display = 'none';
    }
    if (selector === 'input[name="city"]') updateLocationSubheadings(counts);
  }

  function updateLocationSubheadings(cityCounts) {
    var subheadings = document.querySelectorAll('.filters1_filter-group-subheading');
    for (var i = 0; i < subheadings.length; i++) {
      var sh = subheadings[i];
      var hasVisible = false;
      var next = sh.nextElementSibling;
      while (next && !next.classList.contains('filters1_filter-group-subheading')) {
        if (next.style.display !== 'none') { hasVisible = true; break; }
        next = next.nextElementSibling;
      }
      sh.style.display = hasVisible ? '' : 'none';
    }
  }

  // ── Counts + empty state ──────────────────
  function setCount(n) {
    var total = _allCards.length;
    if (_rcEl) _rcEl.textContent = n;
    if (_icEl) _icEl.textContent = total;

    var wrapper = _rcEl ? _rcEl.parentElement : null;
    if (wrapper && _rcEl && _icEl) {
      while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
      wrapper.appendChild(document.createTextNode('Showing '));
      wrapper.appendChild(_rcEl);
      wrapper.appendChild(document.createTextNode(' of '));
      wrapper.appendChild(_icEl);
      wrapper.appendChild(document.createTextNode(' Jobs'));
    }
  }

  function setEmpty(flag) {
    if (_emptyEl) _emptyEl.style.display = flag ? 'flex' : 'none';
  }

  // ── Show More button ──────────────────────
  function bindShowMore() {
    var btn = document.getElementById('fctg-show-more');
    if (btn) return;            // already injected
    btn = document.createElement('button');
    btn.id = 'fctg-show-more';
    btn.type = 'button';
    btn.textContent = 'Show more jobs';
    btn.style.cssText = 'display:none;margin:24px auto;padding:12px 24px;background:#000;color:#fff;border:none;border-radius:8px;font:600 14px/1 inherit;cursor:pointer;';
    btn.addEventListener('click', function () {
      visibleLimit += PAGE_SIZE;
      applyFilters();
    });
    if (_listEl.parentElement) _listEl.parentElement.appendChild(btn);
  }

  function updateShowMoreButton(hasMore, remaining) {
    var btn = document.getElementById('fctg-show-more');
    if (!btn) return;
    if (hasMore) {
      btn.style.display = '';
      btn.textContent = 'Show more (' + remaining + ' remaining)';
    } else {
      btn.style.display = 'none';
    }
  }

  // ── Filter UI bindings ────────────────────
  function bindSearch() {
    var input = document.querySelector('.filters1_keyword-search input');
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

  function bindCheckboxes(selector, store) {
    var inputs = document.querySelectorAll(selector);
    for (var i = 0; i < inputs.length; i++) {
      (function (cb) {
        cb.addEventListener('change', function () {
          var label = cb.closest('.w-checkbox');
          var spanEl = label ? label.querySelector('.w-form-label') : null;
          var key = spanEl ? spanEl.textContent.trim().toLowerCase() : '';
          if (!key) return;
          if (cb.checked) store[key] = true; else delete store[key];
          visibleLimit = PAGE_SIZE;
          applyFilters();
        });
      })(inputs[i]);
    }
  }

  function bindWorkTypeRadios() {
    document.querySelectorAll('input[name="Filter-Two"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        var label = r.closest('.w-radio');
        var spanEl = label ? label.querySelector('.w-form-label') : null;
        var lbl = spanEl ? spanEl.textContent.trim() : '';
        workType = (lbl === 'All') ? '' : lbl;
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
      var inp = document.querySelector('.filters1_keyword-search input');
      if (inp) inp.value = '';
      var cbs = document.querySelectorAll(
        'input[name="city"], input[name="region"], input[name="brand"], input[name="category"]'
      );
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
      if (_allRadio) _allRadio.checked = true;
      applyFilters();
    }
    for (var i = 0; i < resetEls.length; i++) resetEls[i].addEventListener('click', clearAll);
  }

  // ── Active filter tags ────────────────────
  function renderTags() {
    var container = document.querySelector('.filters1_tags-wrapper');
    if (!container) return;
    var existing = container.querySelectorAll('.filters1_tag--dynamic');
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    var filters = [];
    if (keyword) filters.push({ type: 'keyword', label: '"' + keyword + '"' });
    Object.keys(activeCities).forEach(function (k) { filters.push({ type: 'city', label: k, key: k }); });
    Object.keys(activeRegions).forEach(function (k) { filters.push({ type: 'region', label: k, key: k }); });
    Object.keys(activeCategories).forEach(function (k) { filters.push({ type: 'category', label: k, key: k }); });
    Object.keys(activeBrands).forEach(function (k) { filters.push({ type: 'brand', label: k, key: k }); });
    if (workType) filters.push({ type: 'workType', label: workType });

    for (var f = 0; f < filters.length; f++) container.appendChild(makeTag(filters[f]));
  }

  function makeTag(filter) {
    var tag = document.createElement('div');
    tag.className = 'filters1_tag filters1_tag--dynamic';
    tag.style.display = 'flex';

    var textDiv = document.createElement('div');
    textDiv.textContent = capitalize(filter.label);
    tag.appendChild(textDiv);

    var closeDiv = document.createElement('div');
    closeDiv.className = 'filters1_close-icon w-embed';
    closeDiv.style.cursor = 'pointer';
    closeDiv.innerHTML = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.13 16.77l-.35.35a.25.25 0 01-.36 0L12 12.85 7.57 17.12a.25.25 0 01-.35 0l-.35-.35a.25.25 0 010-.35L11.15 12 6.87 7.57a.25.25 0 010-.35l.35-.35a.25.25 0 01.35 0L12 11.15l4.43-4.28a.25.25 0 01.35 0l.35.35a.25.25 0 010 .35L13.15 12l4.28 4.43a.25.25 0 010 .35z" fill="currentColor"/></svg>';
    tag.appendChild(closeDiv);

    closeDiv.addEventListener('click', function () { removeFilter(filter); });
    return tag;
  }

  function removeFilter(f) {
    switch (f.type) {
      case 'keyword':
        keyword = '';
        var inp = document.querySelector('.filters1_keyword-search input');
        if (inp) inp.value = '';
        break;
      case 'city':     delete activeCities[f.key];     uncheckByLabel('input[name="city"]', f.key); break;
      case 'region':   delete activeRegions[f.key];    uncheckByLabel('input[name="region"]', f.key); break;
      case 'category': delete activeCategories[f.key]; uncheckByLabel('input[name="category"]', f.key); break;
      case 'brand':    delete activeBrands[f.key];     uncheckByLabel('input[name="brand"]', f.key); break;
      case 'workType': workType = ''; if (_allRadio) _allRadio.checked = true; break;
    }
    visibleLimit = PAGE_SIZE;
    applyFilters();
  }

  function uncheckByLabel(selector, lowerLabel) {
    var inputs = document.querySelectorAll(selector);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var label = cb.closest('.w-checkbox');
      var spanEl = label ? label.querySelector('.w-form-label') : null;
      var key = spanEl ? spanEl.textContent.trim().toLowerCase() : '';
      if (key === lowerLabel) cb.checked = false;
    }
  }

  // ── URL + sessionStorage state ────────────
  function applyFiltersFromURL() {
    var params = new URLSearchParams(location.search);
    var applied = false;

    var q = params.get(URL_PARAM.keyword);
    if (q) {
      keyword = q; applied = true;
      var inp = document.querySelector('.filters1_keyword-search input');
      if (inp) inp.value = q;
    }
    [
      [URL_PARAM.city, activeCities, 'input[name="city"]'],
      [URL_PARAM.region, activeRegions, 'input[name="region"]'],
      [URL_PARAM.brand, activeBrands, 'input[name="brand"]'],
      [URL_PARAM.category, activeCategories, 'input[name="category"]']
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

  function checkBoxesByLabels(selector, store) {
    var inputs = document.querySelectorAll(selector);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var label = cb.closest('.w-checkbox');
      var spanEl = label ? label.querySelector('.w-form-label') : null;
      var key = spanEl ? spanEl.textContent.trim().toLowerCase() : '';
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
        var inp = document.querySelector('.filters1_keyword-search input');
        if (inp) inp.value = s.kw;
      }
      copyInto(activeCities, s.c); checkBoxesByLabels('input[name="city"]', activeCities);
      copyInto(activeRegions, s.r); checkBoxesByLabels('input[name="region"]', activeRegions);
      copyInto(activeBrands, s.b); checkBoxesByLabels('input[name="brand"]', activeBrands);
      copyInto(activeCategories, s.ca); checkBoxesByLabels('input[name="category"]', activeCategories);
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
