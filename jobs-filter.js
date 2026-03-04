/**
 * FCTG Careers - Job Filter & Sort System v3.0
 * Custom filtering for the /jobs page
 *
 * Handles: keyword search, city/location filter (grouped by region),
 * region filter, brand filter, category filter, work type filter,
 * sorting, active filter tags, results count, clear all, and empty state.
 *
 * v3.0   – MAJOR: Data-driven filtering against ALL jobs (not just 30 DOM items).
 *           Fetches all-jobs.json from CDN, renders cards dynamically.
 *           Cascading cross-filter counts: selecting a filter in one dimension
 *           updates available options and counts in all other dimensions.
 *           "Show More" pagination replaces Webflow CMS pagination.
 *           Single CDN fetch replaces 5 parallel fetches.
 * v2.0   – Fix: Region/city/category counts now from CDN (filter-counts.json)
 *           instead of DOM parsing which miscounted filter checkboxes as jobs.
 * v1.9   – Fix: Filter options now show ALL CMS items (not just first 30).
 *           New: Back button auto-scrolls to listings and opens active filter accordions.
 *           Fix: Script loader uses createElement (not HTML tag) for Webflow compatibility.
 */
(function () {
  'use strict';

  // Global guard – prevent double-init when Webflow includes the script twice
  if (window._fctgFilterLoaded) return;
  window._fctgFilterLoaded = true;

  // ── Config ────────────────────────────────
  var DEBOUNCE = 250;
  var INIT_DELAY = 300;
  var PAGE_SIZE = 30;
  var ALL_JOBS_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/all-jobs.json?v=3.0';

  // ── State ─────────────────────────────────
  var keyword = '';
  var activeCities = {};
  var activeRegions = {};
  var activeBrands = {};
  var activeCategories = {};
  var workType = '';
  var sortMode = 'default';

  var allJobs = [];        // all jobs from CDN JSON
  var filteredJobs = [];   // filtered subset
  var currentPage = 1;

  var _cardTemplate = null;  // cloned from first CMS card
  var _allCounts = null;     // derived from allJobs: regions, cities, brands, categories, lookup maps
  var _totalJobs = 0;

  // Cached element references
  var _rcEl = null;
  var _icEl = null;
  var _emptyEl = null;
  var _allRadio = null;
  var _listEl = null;

  // ── Helpers for preserving object references ──
  function clearObj(obj) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) delete obj[keys[i]];
  }
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

    _listEl = document.querySelector('.career_list');
    if (!_listEl) return;

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

    // Capture the card template from the first CMS-rendered card
    captureCardTemplate();

    // Hide Webflow CMS pagination permanently (we use "Show More")
    var pag = document.querySelector('.w-pagination-wrapper');
    if (pag) pag.style.display = 'none';

    // Fetch all jobs data from CDN, then build UI
    fetchJSON(ALL_JOBS_URL, function (data) {
      if (!data || !Array.isArray(data) || data.length === 0) {
        console.warn('[fctg] all-jobs.json fetch failed or empty, falling back to DOM');
        fallbackToDom();
        return;
      }

      allJobs = data;
      _totalJobs = allJobs.length;

      // Derive all filter options from the data
      buildInitialCounts();

      // Ensure headings match PageUp names
      renameHeadingsIfNeeded();

      // Build filter UI
      hideAllCountryCheckboxes();
      buildRegionFilter();
      groupLocationsByRegion();
      deduplicateAndBuildBrands();
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
      handleBackNavigation();
    });
  }

  // ── Fallback: if CDN fetch fails, revert to DOM-only filtering (v2.0 behavior) ──
  function fallbackToDom() {
    var items = _listEl.querySelectorAll(':scope > .w-dyn-item');
    if (items.length === 0) return;
    // Show whatever CMS rendered
    console.log('[fctg] Fallback: ' + items.length + ' DOM items');
  }

  // ── Capture card template from first CMS-rendered card ──
  function captureCardTemplate() {
    var firstCard = _listEl.querySelector('.w-dyn-item');
    if (!firstCard) return;
    _cardTemplate = firstCard.cloneNode(true);

    // Clear all CMS items from the list (we'll render dynamically)
    var items = _listEl.querySelectorAll(':scope > .w-dyn-item');
    for (var i = 0; i < items.length; i++) items[i].remove();
  }

  // ── Derive all filter counts from allJobs data ──
  function buildInitialCounts() {
    var regionCounts = {}, cityCounts = {}, brandCounts = {}, categoryCounts = {};
    var cityToRegion = {}, cityDisplay = {}, categoryDisplay = {}, brandDisplay = {};

    for (var i = 0; i < allJobs.length; i++) {
      var j = allJobs[i];

      // Regions
      var rk = j.r.toLowerCase();
      if (rk) regionCounts[rk] = (regionCounts[rk] || 0) + 1;

      // Cities
      var ck = j.ci.toLowerCase();
      if (ck) {
        cityCounts[ck] = (cityCounts[ck] || 0) + 1;
        if (!cityToRegion[ck]) cityToRegion[ck] = j.r;
        if (!cityDisplay[ck]) cityDisplay[ck] = j.ci;
      }

      // Brands
      var bk = j.b.toLowerCase();
      if (bk) {
        brandCounts[bk] = (brandCounts[bk] || 0) + 1;
        if (!brandDisplay[bk]) brandDisplay[bk] = j.b;
      }

      // Categories (may be comma-separated)
      var cats = j.ca.split(',');
      for (var c = 0; c < cats.length; c++) {
        var catk = cats[c].trim().toLowerCase();
        if (catk) {
          categoryCounts[catk] = (categoryCounts[catk] || 0) + 1;
          if (!categoryDisplay[catk]) categoryDisplay[catk] = cats[c].trim();
        }
      }
    }

    _allCounts = {
      regions: regionCounts,
      cities: cityCounts,
      brands: brandCounts,
      categories: categoryCounts,
      cityToRegion: cityToRegion,
      cityDisplay: cityDisplay,
      categoryDisplay: categoryDisplay,
      brandDisplay: brandDisplay
    };
  }

  // ── Filter engine ─────────────────────────
  function applyFilters() {
    var kw = keyword.toLowerCase();
    var hasCities = objSize(activeCities) > 0;
    var hasRegions = objSize(activeRegions) > 0;
    var hasBrands = objSize(activeBrands) > 0;
    var hasCategories = objSize(activeCategories) > 0;
    var wt = workType.toLowerCase();

    filteredJobs = [];

    for (var i = 0; i < allJobs.length; i++) {
      var j = allJobs[i];
      var show = true;

      if (show && kw) {
        var hay = [j.t, j.ca, j.ci, j.co, j.r, j.b, j.wt, j.su].join(' ').toLowerCase();
        show = hay.indexOf(kw) !== -1;
      }
      if (show && hasCities) show = !!activeCities[j.ci.toLowerCase()];
      if (show && hasRegions) show = !!activeRegions[j.r.toLowerCase()];
      if (show && hasBrands) show = !!activeBrands[j.b.toLowerCase()];
      if (show && hasCategories) show = matchesCategory(j.ca, activeCategories);
      if (show && wt) show = j.wt.toLowerCase() === wt;

      if (show) filteredJobs.push(j);
    }

    // Sort if needed
    sortFilteredJobs();

    currentPage = 1;
    renderCards();
    updateCrossFilterCounts();
    setCount(filteredJobs.length);
    setEmpty(filteredJobs.length === 0);
    renderTags();
    saveFilterState();
  }

  // ── Category matching (handles comma-separated) ──
  function matchesCategory(catField, activeMap) {
    var parts = catField.split(',');
    for (var i = 0; i < parts.length; i++) {
      if (activeMap[parts[i].trim().toLowerCase()]) return true;
    }
    return false;
  }

  // ── Cascading cross-filter counts ─────────
  function updateCrossFilterCounts() {
    var kw = keyword.toLowerCase();
    var hasCities = objSize(activeCities) > 0;
    var hasRegions = objSize(activeRegions) > 0;
    var hasBrands = objSize(activeBrands) > 0;
    var hasCategories = objSize(activeCategories) > 0;
    var wt = workType.toLowerCase();

    // For each dimension, count jobs matching all OTHER filters except that dimension
    var regionCounts = {}, cityCounts = {}, brandCounts = {}, categoryCounts = {};

    for (var i = 0; i < allJobs.length; i++) {
      var j = allJobs[i];

      // Apply keyword (always applies to all dimensions)
      var passesKeyword = true;
      if (kw) {
        var hay = [j.t, j.ca, j.ci, j.co, j.r, j.b, j.wt, j.su].join(' ').toLowerCase();
        passesKeyword = hay.indexOf(kw) !== -1;
      }
      if (!passesKeyword) continue;

      // Apply workType (always applies to all dimensions)
      if (wt && j.wt.toLowerCase() !== wt) continue;

      // Pre-compute filter matches for each dimension
      var matchCity = !hasCities || !!activeCities[j.ci.toLowerCase()];
      var matchRegion = !hasRegions || !!activeRegions[j.r.toLowerCase()];
      var matchBrand = !hasBrands || !!activeBrands[j.b.toLowerCase()];
      var matchCategory = !hasCategories || matchesCategory(j.ca, activeCategories);

      // Region counts: apply all EXCEPT region filter
      if (matchCity && matchBrand && matchCategory) {
        var rk = j.r.toLowerCase();
        if (rk) regionCounts[rk] = (regionCounts[rk] || 0) + 1;
      }

      // City counts: apply all EXCEPT city filter
      if (matchRegion && matchBrand && matchCategory) {
        var ck = j.ci.toLowerCase();
        if (ck) cityCounts[ck] = (cityCounts[ck] || 0) + 1;
      }

      // Brand counts: apply all EXCEPT brand filter
      if (matchCity && matchRegion && matchCategory) {
        var bk = j.b.toLowerCase();
        if (bk) brandCounts[bk] = (brandCounts[bk] || 0) + 1;
      }

      // Category counts: apply all EXCEPT category filter
      if (matchCity && matchRegion && matchBrand) {
        var cats = j.ca.split(',');
        for (var c = 0; c < cats.length; c++) {
          var catk = cats[c].trim().toLowerCase();
          if (catk) categoryCounts[catk] = (categoryCounts[catk] || 0) + 1;
        }
      }
    }

    // Update each filter panel
    updateFilterPanel('input[name="region"]', regionCounts);
    updateFilterPanel('input[name="city"]', cityCounts);
    updateFilterPanel('input[name="brand"]', brandCounts);
    updateFilterPanel('input[name="category"]', categoryCounts);
  }

  // ── Update filter panel badge counts + show/hide zero-count options ──
  function updateFilterPanel(selector, counts) {
    var inputs = document.querySelectorAll(selector);
    for (var i = 0; i < inputs.length; i++) {
      var cb = inputs[i];
      var label = cb.closest('.w-checkbox');
      if (!label) continue;
      var badge = label.querySelector('.filter-count') ||
                  label.querySelector('.icon-1x1-xsmall');
      var spanEl = label.querySelector('.w-form-label');
      var key = spanEl ? spanEl.textContent.trim().toLowerCase() : '';
      var count = counts[key] || 0;

      if (badge) badge.textContent = count;

      // Hide zero-count options, but keep checked ones visible (so user can uncheck)
      if (count > 0 || cb.checked) {
        label.style.display = '';
      } else {
        label.style.display = 'none';
      }
    }

    // Also update region sub-headings in the Locations panel
    if (selector === 'input[name="city"]') {
      updateLocationSubheadings(counts);
    }
  }

  // ── Hide location sub-headings that have no visible cities ──
  function updateLocationSubheadings(cityCounts) {
    var subheadings = document.querySelectorAll('.filters1_region-subheading');
    for (var i = 0; i < subheadings.length; i++) {
      var sh = subheadings[i];
      var regionName = sh.textContent.trim();
      // Check if any city in this region has count > 0
      var hasVisibleCities = false;
      var next = sh.nextElementSibling;
      while (next && !next.classList.contains('filters1_region-subheading')) {
        if (next.style.display !== 'none') {
          hasVisibleCities = true;
          break;
        }
        next = next.nextElementSibling;
      }
      sh.style.display = hasVisibleCities ? '' : 'none';
    }
  }

  // ── Results count ─────────────────────────
  function setCount(n) {
    var total = _totalJobs || allJobs.length;
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

  // ── Dynamic card rendering ────────────────
  function renderCards() {
    if (!_listEl || !_cardTemplate) return;

    // Clear existing cards
    var existing = _listEl.querySelectorAll(':scope > .w-dyn-item');
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    // Render current page slice
    var end = Math.min(currentPage * PAGE_SIZE, filteredJobs.length);
    for (var i = 0; i < end; i++) {
      _listEl.appendChild(createCard(filteredJobs[i]));
    }

    // Show/hide "Show More" button
    updateShowMoreButton(end < filteredJobs.length);
  }

  function createCard(job) {
    var card = _cardTemplate.cloneNode(true);

    // Title
    var heading = card.querySelector('.heading-style-h5');
    if (heading) heading.textContent = job.t;

    // Category tag
    var tag = card.querySelector('.tag');
    if (tag) tag.textContent = job.ca;

    // Detail wrappers: [0]=city, [1]=country, [2]=brand, [3]=workType
    var dw = card.querySelectorAll('.career23_detail-wrapper');
    setDwText(dw[0], job.ci);
    setDwText(dw[1], job.co);
    setDwText(dw[2], job.b);
    setDwText(dw[3], job.wt);

    // Summary
    var summary = card.querySelector('.text-size-regular');
    if (summary) summary.textContent = job.su;

    // Link — the card or its wrapper is an <a>
    var link = card.querySelector('a');
    if (link && job.ju) {
      link.href = job.ju;
    }
    // If the card itself is an <a> tag
    if (card.tagName === 'A' && job.ju) {
      card.href = job.ju;
    }
    // Also handle .w-dyn-item wrapping a link block
    var linkBlock = card.querySelector('.career23_card-link');
    if (linkBlock && job.ju) {
      linkBlock.href = job.ju;
    }

    return card;
  }

  function setDwText(wrapper, text) {
    if (!wrapper) return;
    var t = wrapper.querySelector('.text-size-medium');
    if (t) t.textContent = text || '';
  }

  // ── "Show More" button ────────────────────
  function updateShowMoreButton(hasMore) {
    var btn = document.getElementById('fctg-show-more');
    if (!btn && hasMore) {
      btn = document.createElement('button');
      btn.id = 'fctg-show-more';
      btn.className = 'button is-secondary';
      btn.textContent = 'Show More';
      btn.style.cssText = 'display:block;margin:24px auto 0;';
      btn.addEventListener('click', function () {
        currentPage++;
        renderCards();
      });
      _listEl.parentElement.insertBefore(btn, _listEl.nextSibling);
    }
    if (btn) btn.style.display = hasMore ? '' : 'none';
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
        sortFilteredJobs();
        currentPage = 1;
        renderCards();
        dd.classList.remove('w--open');
        var dl = dd.querySelector('.w-dropdown-list');
        if (dl) dl.classList.remove('w--open');
      });
    });
  }

  function sortFilteredJobs() {
    switch (sortMode) {
      case 'Name: A to Z':
        filteredJobs.sort(function (a, b) { return a.t.localeCompare(b.t); }); break;
      case 'Name: Z to A':
        filteredJobs.sort(function (a, b) { return b.t.localeCompare(a.t); }); break;
      default:
        // Keep original order (order from CMS/all-jobs.json)
        break;
    }
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

  // ── Build/deduplicate brand filter ─────────
  function deduplicateAndBuildBrands() {
    if (!_allCounts) return;
    var brandCounts = _allCounts.brands;

    // Update existing CMS brand checkboxes with accurate counts, hide dupes/unknowns
    var seen = {};
    var cbs = document.querySelectorAll('input[name="brand"]');
    for (var c = 0; c < cbs.length; c++) {
      var cb = cbs[c];
      var label = getCheckLabel(cb);
      if (!label) continue;
      var key = label.toLowerCase();
      var wrapper = cb.closest('.w-checkbox');
      if (!wrapper) continue;

      if (seen[key] || !brandCounts[key]) {
        wrapper.style.display = 'none';
      } else {
        seen[key] = true;
        var origBadge = wrapper.querySelector('.filter-count') ||
                        wrapper.querySelector('.icon-1x1-xsmall');
        if (origBadge) origBadge.textContent = brandCounts[key];
      }
    }

    // Add any brands from data that aren't in the CMS-rendered checkboxes
    var brandDisplay = _allCounts.brandDisplay;
    var brandGroup = findFilterGroupByInputName('brand');
    if (!brandGroup) return;
    var optContainer = brandGroup.querySelector('.filters1_filter-options');
    if (!optContainer) return;

    var brandKeys = Object.keys(brandCounts).sort();
    for (var b = 0; b < brandKeys.length; b++) {
      var bk = brandKeys[b];
      if (seen[bk]) continue;
      optContainer.appendChild(
        createCheckbox('brand', brandDisplay[bk] || capitalize(bk), brandCounts[bk])
      );
    }
  }

  // ── Build dynamic category filter ─────────
  function buildCategoryFilter() {
    if (!_allCounts) return;
    var categoryCounts = _allCounts.categories;
    var categoryDisplay = _allCounts.categoryDisplay;

    var catKeys = Object.keys(categoryCounts);
    if (catKeys.length === 0) return;

    var categoryGroup = findFilterGroupByInputName('category') ||
                        findFilterGroupByHeading('Category');
    var optionsContainer;

    if (categoryGroup) {
      var headingEl = categoryGroup.querySelector('.text-size-medium-4');
      if (headingEl && headingEl.textContent.trim() !== 'Category') {
        headingEl.textContent = 'Category';
      }
      optionsContainer = categoryGroup.querySelector('.filters1_filter-options');
      if (optionsContainer) {
        var existingList = optionsContainer.querySelector('.w-dyn-list');
        if (existingList) existingList.style.display = 'none';
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

  // ── Rename headings if needed ──────────────
  function renameHeadingsIfNeeded() {
    // Country group → "Regions"
    var countryCb = document.querySelector('input[name="country"]');
    if (countryCb) {
      var g1 = countryCb.closest('.filters1_filter-group');
      if (g1) {
        var t1 = g1.querySelector('.text-size-medium-4');
        if (t1 && t1.textContent.trim() !== 'Regions') t1.textContent = 'Regions';
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

  // ── "All Jobs" back button (job template pages) ──
  function setupBackButton() {
    if (document.querySelector('.career_list')) return;

    var links = document.querySelectorAll('a.button.is-link.is-icon');
    var backBtn = null;
    for (var i = 0; i < links.length; i++) {
      var txt = links[i].textContent.trim().toLowerCase();
      if (txt.indexOf('all') !== -1) { backBtn = links[i]; break; }
    }
    if (!backBtn) return;

    backBtn.setAttribute('href', '/jobs');
    backBtn.addEventListener('click', function (e) {
      e.preventDefault();
      try { sessionStorage.setItem('fctg_back', '1'); } catch (err) {}
      window.location.href = '/jobs';
    });
  }

  // ── Handle back navigation: scroll + open accordions ──
  function handleBackNavigation() {
    var isBack = false;
    try {
      isBack = sessionStorage.getItem('fctg_back') === '1';
      sessionStorage.removeItem('fctg_back');
    } catch (e) {}

    if (isBack) {
      setTimeout(function () {
        scrollToFilters();
        openAccordionsForActiveFilters();
      }, 500);

      var _safetyStart = Date.now();
      var _safetyInt = setInterval(function () {
        if (Date.now() - _safetyStart > 5000) { clearInterval(_safetyInt); return; }
        if (window.pageYOffset < 50) scrollToFilters();
      }, 300);
    }
  }

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
    xhr.timeout = 10000;  // 10s timeout for larger all-jobs.json
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(JSON.parse(xhr.responseText)); } catch (e) { cb(null); }
      } else { cb(null); }
    };
    xhr.onerror = function () { cb(null); };
    xhr.ontimeout = function () { cb(null); };
    xhr.send();
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

      var inp = document.querySelector('.filters1_keyword-search input');
      if (inp && keyword) inp.value = keyword;

      restoreCheckboxGroup('city', activeCities);
      restoreCheckboxGroup('region', activeRegions);
      restoreCheckboxGroup('brand', activeBrands);
      restoreCheckboxGroup('category', activeCategories);

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
