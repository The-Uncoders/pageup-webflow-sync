/**
 * FCTG Careers - Job Filter & Sort System v2.0
 * Custom filtering for the /jobs page
 *
 * Handles: keyword search, city/location filter (grouped by region),
 * region filter, brand filter, category filter, work type filter,
 * sorting, active filter tags, results count, clear all, and empty state.
 *
 * v2.0   – Fix: Region/city/category counts now from CDN (filter-counts.json)
 *           instead of DOM parsing which miscounted filter checkboxes as jobs.
 * v1.9   – Fix: Filter options now show ALL CMS items (not just first 30).
 *           New: Back button auto-scrolls to listings and opens active filter accordions.
 *           Fix: Script loader uses createElement (not HTML tag) for Webflow compatibility.
 * v1.7.3 – Fix: Object reference bug — clearAll() and restoreFilterState()
 *           now mutate filter objects in-place instead of reassigning,
 *           preserving closure references from bindCheckboxes().
 * v1.7.1 – Fix: Brand badge selector (.filter-count); guard against double init.
 * v1.7   – Fix: Brand filter uses CDN counts (brand-counts.json) for all 370 jobs.
 *           Fix: Hide pagination when JS filters reduce visible results.
 *           New: Save/restore filter state via sessionStorage.
 *           New: "All Jobs" back button on template preserves filters.
 * v1.6.3 – Fix: Accordions respect Webflow IX2 interactions (removed forced open).
 *           Fix: Total count fetched from total-jobs.json (shows all CMS jobs).
 * v1.6.2 – Fix: Checkbox visual state inversion (remove change listener that
 *           double-toggles w--redirected-checked with Webflow's native handler).
 *           Fix: Dynamic badge uses 'filter-count' class to match designer styling.
 *           Fix: Results count shows "Showing X of Y Jobs" format.
 * v1.6.1 – Fix: Detect designer's category group by input name (not heading).
 *           Hides CMS checkboxes, renames heading to "Category", no duplicate.
 * v1.6 – Fix: Region checkboxes use proper Webflow custom checkbox structure.
 *         Fix: Stop overriding designer styles – update native badge counts.
 *         Fix: Heading renames use input names (not text) to avoid ambiguity.
 *         New: Locations grouped by region with sub-headings (PageUp layout).
 *         New: Dynamic Category filter built from job data.
 * v1.5.2 – Fix: Region accordion collapsed. Heading rename CSS class fix.
 * v1.5.1 – Fix: Region tag display uses capitalizeRegion().
 * v1.5   – Replace Country filter with Region filter.
 * v1.4.1 – Hide static badge; dynamic count replaces it.
 * v1.4   – Added country filter support, dedup, count badges.
 * v1.3   – Strip Finsweet attributes to prevent MutationObserver loop.
 * v1.2   – Brand data from brand-map.json (CDN).
 */
(function () {
  'use strict';

  // Global guard – prevent double-init when Webflow includes the script twice
  if (window._fctgFilterLoaded) return;
  window._fctgFilterLoaded = true;

  // ── Config ────────────────────────────────
  var DEBOUNCE = 250;
  var INIT_DELAY = 300;
  var BRAND_MAP_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/brand-map.json';
  var REGION_MAP_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/region-map.json';
  var TOTAL_JOBS_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/total-jobs.json';
  var BRAND_COUNTS_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/brand-counts.json';
  var FILTER_COUNTS_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/filter-counts.json';

  // ── State ─────────────────────────────────
  var keyword = '';
  var activeCities = {};
  var activeRegions = {};
  var activeBrands = {};
  var activeCategories = {};
  var workType = '';
  var sortMode = 'default';
  var jobs = [];
  var _brandMap = null;
  var _regionMap = null;
  var _totalJobs = 0; // fetched from total-jobs.json (all CMS jobs, not just paginated)
  var _brandCounts = null; // fetched from brand-counts.json (accurate brand counts across all jobs)
  var _allCounts = null;   // { regions, cities, categories, cityToRegion, cityDisplay, categoryDisplay } from CDN filter-counts.json

  // Cached element references
  var _rcEl = null;
  var _icEl = null;
  var _emptyEl = null;
  var _allRadio = null;

  // ── Helpers for preserving object references ──
  // Clear all keys from an object in-place (avoids breaking closure references)
  function clearObj(obj) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) delete obj[keys[i]];
  }
  // Copy keys from source into target in-place (clears target first)
  function copyInto(target, source) {
    clearObj(target);
    if (!source) return;
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) target[keys[i]] = source[keys[i]];
  }

  // ── Neutralise Finsweet ───────────────────
  window.fsAttributes = window.fsAttributes || [];
  window.fsAttributes.push(['cmsfilter', function (fi) {
    if (fi && fi.length) fi.forEach(function (inst) {
      try { if (typeof inst.destroy === 'function') inst.destroy(); } catch (e) {}
    });
  }]);
  window.fsAttributes.push(['cmssort', function (si) {
    if (si && si.length) si.forEach(function (inst) {
      try { if (typeof inst.destroy === 'function') inst.destroy(); } catch (e) {}
    });
  }]);

  function stripFinsweet() {
    var attrs = [
      'fs-cmsfilter-element', 'fs-cmsfilter-field',
      'fs-cmssort-element', 'fs-cmssort-field'
    ];
    for (var a = 0; a < attrs.length; a++) {
      var els = document.querySelectorAll('[' + attrs[a] + ']');
      for (var i = 0; i < els.length; i++) els[i].removeAttribute(attrs[a]);
    }
  }

  // ── Boot ──────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, INIT_DELAY); });
  } else {
    setTimeout(init, INIT_DELAY);
  }

  // ── Initialise ────────────────────────────
  var _initialised = false;
  function init() {
    // Handle "All Jobs" back button on job template pages
    setupBackButton();

    if (_initialised) return;
    _initialised = true;

    var list = document.querySelector('.career_list');
    if (!list) return;

    // Cache refs BEFORE stripping Finsweet attributes
    _rcEl = document.querySelector('[fs-cmsfilter-element="results-count"]');
    _icEl = document.querySelector('[fs-cmsfilter-element="items-count"]');
    _emptyEl = document.querySelector('[fs-cmsfilter-element="empty"]');
    var tpl = document.querySelector('[fs-cmsfilter-element="tag-template"]');
    var resetEls = document.querySelectorAll('a[fs-cmsfilter-element="reset"]');
    _allRadio = document.querySelector('label[fs-cmsfilter-element="reset"] input[type="radio"]');

    stripFinsweet();
    setTimeout(stripFinsweet, 0);
    setTimeout(stripFinsweet, 200);
    setTimeout(stripFinsweet, 1000);
    setTimeout(stripFinsweet, 3000);

    var form = document.querySelector('.filters1_form-block form') ||
               document.querySelector('.filters1_form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });

    if (tpl) tpl.style.display = 'none';

    // Inject minimal styles for region sub-headings in location group
    injectStyles();

    // Fetch all config in parallel, then build UI
    var pending = 5;
    var brandResult = null;
    var regionResult = null;
    var totalResult = null;
    var brandCountsResult = null;
    var filterCountsResult = null;

    function afterFetch() {
      _brandMap = brandResult || {};
      _regionMap = regionResult || {};
      _totalJobs = (totalResult && totalResult.total) ? totalResult.total : 0;
      _brandCounts = brandCountsResult || {};

      // Parse the visible job cards (in .career_list) for filtering/display
      var items = list.querySelectorAll(':scope > .w-dyn-item');
      for (var i = 0; i < items.length; i++) jobs.push(parseCard(items[i], i));

      // Use CDN filter counts (pre-computed from ALL CMS items during sync).
      // Falls back to DOM parsing if CDN fetch fails — but DOM only has ~30 items.
      _allCounts = filterCountsResult || parseAllItemsForCounts();

      // Ensure headings match PageUp names
      renameHeadingsIfNeeded();

      // Build filter UI (using _allCounts for comprehensive options)
      hideAllCountryCheckboxes();
      buildRegionFilter();
      groupLocationsByRegion();
      deduplicateFilters();
      buildCategoryFilter();

      // Bind all interactions
      bindSearch();
      bindCheckboxes('input[name="city"]', activeCities);
      bindCheckboxes('input[name="region"]', activeRegions);
      bindCheckboxes('input[name="brand"]', activeBrands);
      bindCheckboxes('input[name="category"]', activeCategories);
      bindRadios();
      bindSort();
      bindClear(resetEls);

      // Restore any saved filter state (e.g. returning from a job template page)
      restoreFilterState();

      applyFilters();

      // If returning via "All Jobs" back button, scroll to listings and open relevant accordions
      var isBack = false;
      try {
        isBack = sessionStorage.getItem('fctg_back') === '1';
        sessionStorage.removeItem('fctg_back');
      } catch (e) {}

      if (isBack) {
        setTimeout(function () {
          // Scroll to the filter/listings section
          scrollToFilters();
          // Open accordion sections that have active filters
          openAccordionsForActiveFilters();
        }, 500);

        // Safety net: re-scroll if something resets position (e.g. late IX2 animation)
        var _safetyStart = Date.now();
        var _safetyInt = setInterval(function () {
          if (Date.now() - _safetyStart > 5000) { clearInterval(_safetyInt); return; }
          if (window.pageYOffset < 50) scrollToFilters();
        }, 300);
      }
    }

    fetchJSON(BRAND_MAP_URL, function (map) {
      brandResult = map;
      if (--pending === 0) afterFetch();
    });
    fetchJSON(REGION_MAP_URL, function (map) {
      regionResult = map;
      if (--pending === 0) afterFetch();
    });
    fetchJSON(TOTAL_JOBS_URL, function (data) {
      totalResult = data;
      if (--pending === 0) afterFetch();
    });
    fetchJSON(BRAND_COUNTS_URL, function (data) {
      brandCountsResult = data;
      if (--pending === 0) afterFetch();
    });
    fetchJSON(FILTER_COUNTS_URL, function (data) {
      filterCountsResult = data;
      if (--pending === 0) afterFetch();
    });
  }

  // ── "All Jobs" back button (job template pages) ──
  function setupBackButton() {
    // Only run on template pages (where .career_list doesn't exist)
    if (document.querySelector('.career_list')) return;

    // Find the back button: an <a> with class "button is-link is-icon" containing "All" text
    var links = document.querySelectorAll('a.button.is-link.is-icon');
    var backBtn = null;
    for (var i = 0; i < links.length; i++) {
      var txt = links[i].textContent.trim().toLowerCase();
      if (txt.indexOf('all') !== -1) { backBtn = links[i]; break; }
    }
    if (!backBtn) return;

    // Point to /jobs — sessionStorage filter state will be restored on arrival
    backBtn.setAttribute('href', '/jobs');
    backBtn.addEventListener('click', function (e) {
      e.preventDefault();
      try { sessionStorage.setItem('fctg_back', '1'); } catch (err) {}
      window.location.href = '/jobs';
    });
  }

  // ── Inject minimal styles ─────────────────
  function injectStyles() {
    var style = document.createElement('style');
    style.textContent =
      '.filters1_region-subheading{font-weight:600;font-size:13px;' +
      'padding:10px 0 4px;color:#333;margin-top:4px;}' +
      '.filters1_region-subheading:first-child{padding-top:0;margin-top:0;}';
    document.head.appendChild(style);
  }

  // ── Fetch JSON helper ───────────────────
  function fetchJSON(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 5000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(JSON.parse(xhr.responseText)); } catch (e) { cb(null); }
      } else { cb(null); }
    };
    xhr.onerror = function () { cb(null); };
    xhr.ontimeout = function () { cb(null); };
    xhr.send();
  }

  // ── Parse a single job card ───────────────
  function parseCard(el, idx) {
    var dw = el.querySelectorAll('.career23_detail-wrapper');
    var title = qText(el, '.heading-style-h5');
    var brandFromDOM = dwText(dw[2]);
    var brand = (_brandMap && _brandMap[title]) ? _brandMap[title] : brandFromDOM;

    var countryRaw = dwText(dw[1]);
    var regionName = '';
    if (countryRaw && _regionMap) {
      regionName = _regionMap[countryRaw.toLowerCase()] || 'Multiple Locations';
    } else if (!countryRaw) {
      regionName = 'Multiple Locations';
    }

    return {
      el: el, idx: idx, title: title,
      category: qText(el, '.tag'),
      city: dwText(dw[0]),
      country: countryRaw,
      region: regionName,
      brand: brand,
      workType: dwText(dw[3]),
      summary: qText(el, '.text-size-regular')
    };
  }

  function qText(parent, sel) {
    var el = parent.querySelector(sel);
    return el ? el.textContent.trim() : '';
  }

  function dwText(wrapper) {
    if (!wrapper) return '';
    var t = wrapper.querySelector('.text-size-medium');
    return t ? t.textContent.trim() : '';
  }

  // ── Parse ALL .w-dyn-item elements for complete filter counts ──
  // Webflow renders ~367 items across pagination wrappers but only ~30 are in .career_list.
  // This function scans ALL items so filter checkboxes show every available option.
  function parseAllItemsForCounts() {
    var allItems = document.querySelectorAll('.w-dyn-item');
    var regions = {}, cities = {}, categories = {};
    var cityToRegion = {}, cityDisplay = {}, categoryDisplay = {};

    for (var i = 0; i < allItems.length; i++) {
      var el = allItems[i];
      var dw = el.querySelectorAll('.career23_detail-wrapper');

      // Region (derived from country via _regionMap)
      var countryRaw = dwText(dw[1]);
      var regionName = '';
      if (countryRaw && _regionMap) {
        regionName = _regionMap[countryRaw.toLowerCase()] || 'Multiple Locations';
      } else if (!countryRaw) {
        regionName = 'Multiple Locations';
      }
      if (regionName) {
        var rk = regionName.toLowerCase();
        regions[rk] = (regions[rk] || 0) + 1;
      }

      // City
      var city = dwText(dw[0]);
      if (city) {
        var ck = city.toLowerCase();
        cities[ck] = (cities[ck] || 0) + 1;
        if (regionName && !cityToRegion[ck]) cityToRegion[ck] = regionName;
        if (!cityDisplay[ck]) cityDisplay[ck] = city;
      }

      // Category
      var cat = qText(el, '.tag');
      if (cat) {
        var catk = cat.toLowerCase();
        categories[catk] = (categories[catk] || 0) + 1;
        if (!categoryDisplay[catk]) categoryDisplay[catk] = cat;
      }
    }

    return {
      regions: regions, cities: cities, categories: categories,
      cityToRegion: cityToRegion, cityDisplay: cityDisplay,
      categoryDisplay: categoryDisplay
    };
  }

  // ── Rename headings (safe: identifies groups by input name) ──
  function renameHeadingsIfNeeded() {
    // Country group → "Regions"
    var countryCb = document.querySelector('input[name="country"]');
    if (countryCb) {
      var g = countryCb.closest('.filters1_filter-group');
      if (g) {
        var t = g.querySelector('.text-size-medium-4');
        if (t && t.textContent.trim() !== 'Regions') t.textContent = 'Regions';
      }
    }
    // City group → "Locations"
    var cityCb = document.querySelector('input[name="city"]');
    if (cityCb) {
      var g2 = cityCb.closest('.filters1_filter-group');
      if (g2) {
        var t2 = g2.querySelector('.text-size-medium-4');
        if (t2 && t2.textContent.trim() !== 'Locations') t2.textContent = 'Locations';
      }
    }
  }

  // ── Filter engine ─────────────────────────
  function applyFilters() {
    var kw = keyword.toLowerCase();
    var hasCities = objSize(activeCities) > 0;
    var hasRegions = objSize(activeRegions) > 0;
    var hasBrands = objSize(activeBrands) > 0;
    var hasCategories = objSize(activeCategories) > 0;
    var wt = workType.toLowerCase();
    var count = 0;

    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var show = true;

      if (show && kw) {
        var hay = [j.title, j.category, j.city, j.country, j.region,
                   j.brand, j.workType, j.summary].join(' ').toLowerCase();
        show = hay.indexOf(kw) !== -1;
      }
      if (show && hasCities) show = !!activeCities[j.city.toLowerCase()];
      if (show && hasRegions) show = !!activeRegions[j.region.toLowerCase()];
      if (show && hasBrands) show = !!activeBrands[j.brand.toLowerCase()];
      if (show && hasCategories) show = !!activeCategories[j.category.toLowerCase()];
      if (show && wt) show = j.workType.toLowerCase() === wt;

      j.el.style.display = show ? '' : 'none';
      if (show) count++;
    }

    setCount(count);
    setEmpty(count === 0);
    setPagination(count);
    renderTags();
    reorderDOM();
    saveFilterState();
  }

  // ── Results count ─────────────────────────
  function setCount(n) {
    // Total = fetched CMS total (all jobs), fallback to DOM count
    var total = _totalJobs || jobs.length;
    if (_rcEl) _rcEl.textContent = n;
    if (_icEl) _icEl.textContent = total;

    // Update parent wrapper to show "Showing X of Y Jobs" format
    var wrapper = _rcEl ? _rcEl.parentElement : null;
    if (wrapper && _rcEl && _icEl) {
      // Preserve the span refs but rebuild surrounding text
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

  // ── Pagination visibility ──────────────────
  function setPagination(count) {
    // Hide Webflow CMS pagination when ANY JS filter is active,
    // because the pagination loads different CMS pages that won't have our filters.
    var paginationWrapper = document.querySelector('.w-pagination-wrapper');
    if (!paginationWrapper) return;
    var hasAnyFilter = keyword || objSize(activeCities) > 0 || objSize(activeRegions) > 0 ||
                       objSize(activeBrands) > 0 || objSize(activeCategories) > 0 || workType;
    paginationWrapper.style.display = hasAnyFilter ? 'none' : '';
  }

  // ── Search ────────────────────────────────
  function bindSearch() {
    var input = document.querySelector('.filters1_keyword-search input');
    if (!input) return;
    var timer;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        keyword = input.value.trim();
        applyFilters();
      }, DEBOUNCE);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); keyword = input.value.trim(); applyFilters(); }
    });
  }

  // ── Checkbox filters ──────────────────────
  function bindCheckboxes(selector, store) {
    document.querySelectorAll(selector).forEach(function (cb) {
      cb.addEventListener('change', function () {
        var label = getCheckLabel(cb);
        if (!label) return;
        var key = label.toLowerCase();
        if (cb.checked) store[key] = true;
        else delete store[key];
        applyFilters();
      });
    });
  }

  function getCheckLabel(cb) {
    var wrap = cb.closest('.w-checkbox');
    if (!wrap) return '';
    var lbl = wrap.querySelector('.w-form-label');
    return lbl ? lbl.textContent.trim() : '';
  }

  // ── Radio filter (work type) ──────────────
  function bindRadios() {
    document.querySelectorAll('input[name="Filter-Two"]').forEach(function (r) {
      r.addEventListener('change', function () {
        var lbl = getRadioLabel(r);
        workType = (lbl === 'All') ? '' : lbl;
        applyFilters();
      });
    });
  }

  function getRadioLabel(r) {
    var wrap = r.closest('.w-radio');
    if (!wrap) return '';
    var lbl = wrap.querySelector('.w-form-label');
    return lbl ? lbl.textContent.trim() : '';
  }

  // ── Sort ───────────────────────────────────
  function bindSort() {
    var dd = document.querySelector('.dropdown1_component');
    if (!dd) return;
    dd.querySelectorAll('.w-dropdown-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        sortMode = link.textContent.trim();
        var toggle = dd.querySelector('.w-dropdown-toggle');
        if (toggle) {
          var parts = toggle.querySelectorAll('div');
          for (var i = 0; i < parts.length; i++) {
            if (!parts[i].querySelector('svg') && !parts[i].classList.contains('w-icon-dropdown-toggle')) {
              parts[i].textContent = sortMode; break;
            }
          }
        }
        reorderDOM();
        dd.classList.remove('w--open');
        var dl = dd.querySelector('.w-dropdown-list');
        if (dl) dl.classList.remove('w--open');
      });
    });
  }

  function reorderDOM() {
    if (sortMode === 'default') return;
    var list = document.querySelector('.career_list');
    if (!list) return;
    var arr = jobs.slice();
    switch (sortMode) {
      case 'Name: A to Z':
        arr.sort(function (a, b) { return a.title.localeCompare(b.title); }); break;
      case 'Name: Z to A':
        arr.sort(function (a, b) { return b.title.localeCompare(a.title); }); break;
      default:
        arr.sort(function (a, b) { return a.idx - b.idx; });
    }
    for (var i = 0; i < arr.length; i++) list.appendChild(arr[i].el);
  }

  // ── Filter tags ────────────────────────────
  function renderTags() {
    var container = document.querySelector('.filters1_tags-wrapper');
    if (!container) return;
    var existing = container.querySelectorAll('.filters1_tag--dynamic');
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    var filters = [];
    if (keyword) filters.push({ type: 'keyword', label: '"' + keyword + '"' });

    var cityKeys = Object.keys(activeCities);
    for (var c = 0; c < cityKeys.length; c++)
      filters.push({ type: 'city', label: cityKeys[c], key: cityKeys[c] });

    var regionKeys = Object.keys(activeRegions);
    for (var r = 0; r < regionKeys.length; r++)
      filters.push({ type: 'region', label: regionKeys[r], key: regionKeys[r] });

    var catKeys = Object.keys(activeCategories);
    for (var t = 0; t < catKeys.length; t++)
      filters.push({ type: 'category', label: catKeys[t], key: catKeys[t] });

    var brandKeys = Object.keys(activeBrands);
    for (var b = 0; b < brandKeys.length; b++)
      filters.push({ type: 'brand', label: brandKeys[b], key: brandKeys[b] });

    if (workType) filters.push({ type: 'workType', label: workType });

    for (var f = 0; f < filters.length; f++)
      container.appendChild(makeTag(filters[f]));
  }

  function makeTag(filter) {
    var tag = document.createElement('div');
    tag.className = 'filters1_tag filters1_tag--dynamic';
    tag.style.display = 'flex';

    var textDiv = document.createElement('div');
    textDiv.textContent = filter.type === 'region'
      ? capitalizeRegion(filter.label)
      : capitalize(filter.label);
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
      case 'city':
        delete activeCities[f.key];
        uncheckByLabel('input[name="city"]', f.key);
        break;
      case 'region':
        delete activeRegions[f.key];
        uncheckByLabel('input[name="region"]', f.key);
        break;
      case 'category':
        delete activeCategories[f.key];
        uncheckByLabel('input[name="category"]', f.key);
        break;
      case 'brand':
        delete activeBrands[f.key];
        uncheckByLabel('input[name="brand"]', f.key);
        break;
      case 'workType':
        workType = '';
        if (_allRadio) _allRadio.checked = true;
        break;
    }
    applyFilters();
  }

  function uncheckByLabel(sel, labelLower) {
    document.querySelectorAll(sel).forEach(function (cb) {
      var lbl = getCheckLabel(cb);
      if (lbl && lbl.toLowerCase() === labelLower) {
        cb.checked = false;
        // Also update visual state for custom checkbox div
        var wrap = cb.closest('.w-checkbox');
        if (wrap) {
          var chk = wrap.querySelector('.w-checkbox-input--inputType-custom');
          if (chk) chk.classList.remove('w--redirected-checked');
        }
      }
    });
  }

  // ── Clear all ──────────────────────────────
  function bindClear(resetEls) {
    if (!resetEls) return;
    resetEls.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        clearAll();
      });
    });
  }

  function clearAll() {
    keyword = '';
    clearObj(activeCities);
    clearObj(activeRegions);
    clearObj(activeBrands);
    clearObj(activeCategories);
    workType = '';
    sortMode = 'default';

    var inp = document.querySelector('.filters1_keyword-search input');
    if (inp) inp.value = '';

    document.querySelectorAll(
      'input[name="city"], input[name="region"], input[name="brand"], input[name="category"]'
    ).forEach(function (cb) {
      cb.checked = false;
      var wrap = cb.closest('.w-checkbox');
      if (wrap) {
        var chk = wrap.querySelector('.w-checkbox-input--inputType-custom');
        if (chk) chk.classList.remove('w--redirected-checked');
      }
    });

    if (_allRadio) _allRadio.checked = true;

    // Clear saved filter state
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}

    var dd = document.querySelector('.dropdown1_component');
    if (dd) {
      var toggle = dd.querySelector('.w-dropdown-toggle');
      if (toggle) {
        var parts = toggle.querySelectorAll('div');
        for (var i = 0; i < parts.length; i++) {
          if (!parts[i].querySelector('svg') && !parts[i].classList.contains('w-icon-dropdown-toggle')) {
            parts[i].textContent = 'Sort by'; break;
          }
        }
      }
    }

    applyFilters();
  }

  // ── Create checkbox (matches native Webflow structure) ──
  function createCheckbox(name, labelText, count) {
    // Replicates:
    // <label class="w-checkbox filters1_form-checkbox1">
    //   <div class="w-checkbox-input w-checkbox-input--inputType-custom filters1_form-checkbox1-icon"></div>
    //   <input type="checkbox" name="..." style="opacity:0;position:absolute;z-index:-1" />
    //   <span class="filters1_form-checkbox1-label w-form-label">Label</span>
    //   <div class="icon-1x1-xsmall background-color-black">count</div>
    // </label>
    var label = document.createElement('label');
    label.className = 'w-checkbox filters1_form-checkbox1';

    var checkDiv = document.createElement('div');
    checkDiv.className = 'w-checkbox-input w-checkbox-input--inputType-custom filters1_form-checkbox1-icon';
    label.appendChild(checkDiv);

    var input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.style.cssText = 'opacity:0;position:absolute;z-index:-1;';
    label.appendChild(input);

    var span = document.createElement('span');
    span.className = 'filters1_form-checkbox1-label w-form-label';
    span.textContent = labelText;
    label.appendChild(span);

    if (count !== undefined && count !== null) {
      var badge = document.createElement('div');
      badge.className = 'icon-1x1-xsmall background-color-black filter-count';
      badge.textContent = count;
      label.appendChild(badge);
    }

    // NOTE: Do NOT add a 'change' listener to sync w--redirected-checked here.
    // Webflow's native JS uses event delegation on .w-checkbox-input--inputType-custom
    // and already toggles the class on click. Adding our own listener causes a
    // double-toggle, resulting in an inverted visual state.

    return label;
  }

  // ── Hide all country checkboxes (replaced by region filter) ──
  function hideAllCountryCheckboxes() {
    var cbs = document.querySelectorAll('input[name="country"]');
    for (var c = 0; c < cbs.length; c++) {
      var wrapper = cbs[c].closest('.w-checkbox');
      if (wrapper) wrapper.style.display = 'none';
    }
  }

  // ── Build dynamic region filter ───────────
  function buildRegionFilter() {
    var regionCounts = _allCounts ? _allCounts.regions : {};

    var firstCountryCb = document.querySelector('input[name="country"]');
    if (!firstCountryCb) return;
    var container = firstCountryCb.closest('.w-checkbox');
    if (!container) return;
    var parent = container.parentElement;
    if (!parent) return;

    var regionNames = Object.keys(regionCounts).sort();
    for (var ri = 0; ri < regionNames.length; ri++) {
      var regionKey = regionNames[ri];
      var regionLabel = capitalizeRegion(regionKey);
      if (!regionLabel) continue;
      parent.appendChild(createCheckbox('region', regionLabel, regionCounts[regionKey]));
    }
  }

  // ── Group locations by region ─────────────
  function groupLocationsByRegion() {
    if (!_allCounts) return;
    var cityCounts = _allCounts.cities;
    var cityToRegion = _allCounts.cityToRegion;
    var cityDisplay = _allCounts.cityDisplay;

    var cityInput = document.querySelector('input[name="city"]');
    if (!cityInput) return;
    var filterGroup = cityInput.closest('.filters1_filter-group');
    if (!filterGroup) return;
    var optionsContainer = filterGroup.querySelector('.filters1_filter-options');
    if (!optionsContainer) return;

    // Hide the original CMS list
    var cmsList = optionsContainer.querySelector('.w-dyn-list');
    if (cmsList) cmsList.style.display = 'none';

    // Organize cities by region
    var regionGroups = {};
    var cityKeys = Object.keys(cityCounts);
    for (var c = 0; c < cityKeys.length; c++) {
      var ck = cityKeys[c];
      var rg = cityToRegion[ck] || 'Other';
      if (!regionGroups[rg]) regionGroups[rg] = [];
      regionGroups[rg].push({
        key: ck,
        label: cityDisplay[ck] || capitalize(ck),
        count: cityCounts[ck]
      });
    }

    var sortedRegions = Object.keys(regionGroups).sort();
    var groupedContainer = document.createElement('div');
    groupedContainer.className = 'filters1_grouped-locations';

    for (var ri = 0; ri < sortedRegions.length; ri++) {
      var regionName = sortedRegions[ri];
      var cities = regionGroups[regionName].sort(function (a, b) {
        return a.label.localeCompare(b.label);
      });

      var subHeading = document.createElement('div');
      subHeading.className = 'filters1_region-subheading';
      subHeading.textContent = regionName;
      groupedContainer.appendChild(subHeading);

      for (var ci = 0; ci < cities.length; ci++) {
        groupedContainer.appendChild(
          createCheckbox('city', cities[ci].label, cities[ci].count)
        );
      }
    }

    optionsContainer.appendChild(groupedContainer);
  }

  // ── Build dynamic category filter ─────────
  function buildCategoryFilter() {
    if (!_allCounts) return;
    var categoryCounts = _allCounts.categories;
    var categoryDisplay = _allCounts.categoryDisplay;

    var catKeys = Object.keys(categoryCounts);
    if (catKeys.length === 0) return;

    // Find existing Category group: first by input name, then by heading text
    var categoryGroup = findFilterGroupByInputName('category') ||
                        findFilterGroupByHeading('Category');
    var optionsContainer;

    if (categoryGroup) {
      // Rename heading to "Category" if it's something else (e.g. "Locations")
      var headingEl = categoryGroup.querySelector('.text-size-medium-4');
      if (headingEl && headingEl.textContent.trim() !== 'Category') {
        headingEl.textContent = 'Category';
      }
      optionsContainer = categoryGroup.querySelector('.filters1_filter-options');
      if (optionsContainer) {
        // Hide original CMS-bound checkboxes
        var existingList = optionsContainer.querySelector('.w-dyn-list');
        if (existingList) existingList.style.display = 'none';
        // Also hide any standalone CMS checkboxes that aren't in our dynamic list
        var existingCbs = optionsContainer.querySelectorAll('input[name="category"]');
        for (var ec = 0; ec < existingCbs.length; ec++) {
          var existingWrap = existingCbs[ec].closest('.w-checkbox');
          if (existingWrap) existingWrap.style.display = 'none';
        }
      }
    } else {
      categoryGroup = createFilterGroup('Category');
      var brandsGroup = findFilterGroupByHeading('Brands') ||
                        findFilterGroupByHeading('Work Type');
      if (brandsGroup && brandsGroup.parentElement) {
        brandsGroup.parentElement.insertBefore(categoryGroup, brandsGroup);
      } else {
        var filterForm = document.querySelector('.filters1_form-block form') ||
                         document.querySelector('.filters1_form');
        if (filterForm) filterForm.appendChild(categoryGroup);
      }
      optionsContainer = categoryGroup.querySelector('.filters1_filter-options');
    }

    if (!optionsContainer) return;

    catKeys.sort();
    for (var ci = 0; ci < catKeys.length; ci++) {
      var ck = catKeys[ci];
      optionsContainer.appendChild(
        createCheckbox('category', categoryDisplay[ck] || capitalize(ck), categoryCounts[ck])
      );
    }
  }

  // ── Deduplicate brand filter ──────────────
  function deduplicateFilters() {
    dedupeGroup('input[name="brand"]', 'brand');
  }

  function dedupeGroup(selector, field) {
    // Use CDN brand counts if available (accurate across all CMS items),
    // otherwise fall back to counting from the 30 DOM items
    var counts;
    if (field === 'brand' && _brandCounts && objSize(_brandCounts) > 0) {
      counts = _brandCounts;
    } else {
      counts = {};
      for (var i = 0; i < jobs.length; i++) {
        var val = jobs[i][field];
        if (!val) continue;
        counts[val.toLowerCase()] = (counts[val.toLowerCase()] || 0) + 1;
      }
    }

    var seen = {};
    var cbs = document.querySelectorAll(selector);
    for (var c = 0; c < cbs.length; c++) {
      var cb = cbs[c];
      var label = getCheckLabel(cb);
      if (!label) continue;
      var key = label.toLowerCase();
      var wrapper = cb.closest('.w-checkbox');
      if (!wrapper) continue;

      if (seen[key] || !counts[key]) {
        wrapper.style.display = 'none';
      } else {
        seen[key] = true;
        // Update native badge with actual count (preserve designer styling)
        // CMS checkboxes use .filter-count; dynamic ones use .icon-1x1-xsmall
        var origBadge = wrapper.querySelector('.filter-count') ||
                        wrapper.querySelector('.icon-1x1-xsmall');
        if (origBadge) origBadge.textContent = counts[key];
      }
    }
  }

  // ── Filter group helpers ──────────────────
  function findFilterGroupByInputName(name) {
    var input = document.querySelector('input[name="' + name + '"]');
    if (!input) return null;
    return input.closest('.filters1_filter-group');
  }

  function findFilterGroupByHeading(headingText) {
    var groups = document.querySelectorAll('.filters1_filter-group');
    for (var i = 0; i < groups.length; i++) {
      var textEl = groups[i].querySelector('.text-size-medium-4');
      if (textEl && textEl.textContent.trim().toLowerCase() === headingText.toLowerCase()) {
        return groups[i];
      }
    }
    return null;
  }

  function createFilterGroup(heading) {
    var existingIcon = document.querySelector('.filters1_accordion-icon');
    var iconClone = existingIcon ? existingIcon.cloneNode(true) : null;

    var group = document.createElement('div');
    group.className = 'filters1_filter-group';

    var headingEl = document.createElement('div');
    headingEl.className = 'filters1_filter-group-heading';
    headingEl.style.cursor = 'pointer';

    var textEl = document.createElement('div');
    textEl.className = 'text-size-medium-4';
    textEl.textContent = heading;
    headingEl.appendChild(textEl);

    if (iconClone) headingEl.appendChild(iconClone);

    group.appendChild(headingEl);

    var options = document.createElement('div');
    options.className = 'filters1_filter-options';
    group.appendChild(options);

    // Simple accordion toggle (only for dynamically created groups without IX2)
    headingEl.addEventListener('click', function () {
      var computed = window.getComputedStyle(options);
      var isOpen = computed.display !== 'none' && computed.height !== '0px';
      options.style.display = isOpen ? 'none' : '';
      if (iconClone) {
        iconClone.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
        iconClone.style.transition = 'transform 0.3s ease';
      }
    });

    return group;
  }

  // ── Region name helpers ───────────────────
  function capitalizeRegion(key) {
    var displayNames = {
      'asia': 'Asia', 'australia': 'Australia', 'canada': 'Canada',
      'multiple locations': 'Multiple Locations', 'new zealand': 'New Zealand',
      'south africa': 'South Africa', 'uae': 'UAE',
      'uk & europe': 'UK & Europe', 'usa': 'USA'
    };
    return displayNames[key] || capitalize(key);
  }

  // ── Helpers ────────────────────────────────
  function objSize(obj) {
    var n = 0;
    for (var k in obj) if (obj.hasOwnProperty(k)) n++;
    return n;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ── Back-button UX: scroll to listings + open relevant accordions ──
  function openAccordionsForActiveFilters() {
    var filterGroups = [
      { name: 'region', store: activeRegions },
      { name: 'city', store: activeCities },
      { name: 'brand', store: activeBrands },
      { name: 'category', store: activeCategories }
    ];

    for (var i = 0; i < filterGroups.length; i++) {
      if (objSize(filterGroups[i].store) === 0) continue;

      var cb = document.querySelector('input[name="' + filterGroups[i].name + '"]');
      if (!cb) continue;
      var group = cb.closest('.filters1_filter-group');
      if (!group) continue;

      var heading = group.querySelector('.filters1_filter-heading') ||
                    group.querySelector('.filters1_filter-group-heading');
      if (!heading) continue;

      // Check if accordion is closed — open it via MouseEvent dispatch
      // (Webflow IX2 requires a real MouseEvent, not HTMLElement.click())
      var options = group.querySelector('.filters1_filter-options');
      if (options) {
        var computed = window.getComputedStyle(options);
        if (computed.display === 'none' || computed.height === '0px') {
          heading.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      }
    }
  }

  function scrollToFilters() {
    var target = document.querySelector('.section_filters1') ||
                 document.querySelector('.filters1_form-block') ||
                 document.querySelector('.career_list');
    if (!target) return;
    var y = target.getBoundingClientRect().top + window.pageYOffset - 20;
    window.scrollTo(0, y);
  }

  // ── Session storage: save/restore filter state ──
  var STORAGE_KEY = 'fctg_filters';

  function saveFilterState() {
    try {
      var state = {
        keyword: keyword,
        activeCities: activeCities,
        activeRegions: activeRegions,
        activeBrands: activeBrands,
        activeCategories: activeCategories,
        workType: workType
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* quota / private mode */ }
  }

  function restoreFilterState() {
    try {
      var saved = sessionStorage.getItem(STORAGE_KEY);
      if (!saved) return false;
      var state = JSON.parse(saved);
      keyword = state.keyword || '';
      copyInto(activeCities, state.activeCities);
      copyInto(activeRegions, state.activeRegions);
      copyInto(activeBrands, state.activeBrands);
      copyInto(activeCategories, state.activeCategories);
      workType = state.workType || '';

      // Update search input
      var inp = document.querySelector('.filters1_keyword-search input');
      if (inp && keyword) inp.value = keyword;

      // Restore checkbox visual states
      restoreCheckboxGroup('city', activeCities);
      restoreCheckboxGroup('region', activeRegions);
      restoreCheckboxGroup('brand', activeBrands);
      restoreCheckboxGroup('category', activeCategories);

      // Restore work type radio
      if (workType) {
        document.querySelectorAll('input[name="Filter-Two"]').forEach(function (r) {
          var lbl = getRadioLabel(r);
          if (lbl && lbl.toLowerCase() === workType.toLowerCase()) r.checked = true;
        });
      }
      return true;
    } catch (e) { return false; }
  }

  function restoreCheckboxGroup(name, store) {
    var keys = Object.keys(store);
    if (keys.length === 0) return;
    document.querySelectorAll('input[name="' + name + '"]').forEach(function (cb) {
      var lbl = getCheckLabel(cb);
      if (lbl && store[lbl.toLowerCase()]) {
        cb.checked = true;
        var wrap = cb.closest('.w-checkbox');
        if (wrap) {
          var chk = wrap.querySelector('.w-checkbox-input--inputType-custom');
          if (chk) chk.classList.add('w--redirected-checked');
        }
      }
    });
  }
})();
