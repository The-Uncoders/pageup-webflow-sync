/**
 * FCTG Careers - Job Filter & Sort System v1.5.2
 * Custom filtering for the /jobs page
 *
 * Handles: keyword search, city/location filter, region filter,
 * brand filter, work type filter, sorting, active filter tags,
 * results count, clear all, and empty state.
 *
 * v1.5.2 – Fix: Region accordion collapsed (height:0/overflow:hidden from IX2).
 *           Fix: Heading rename used wrong CSS class (.w-dropdown vs .filters1_filter-group).
 *           Rename "Regions" city section to "City" to avoid confusion.
 * v1.5.1 – Fix: Region tag display uses capitalizeRegion() for proper names.
 * v1.5 – Replace Country filter with Region filter to match PageUp ATS.
 *         Region mapping loaded from region-map.json (CDN).
 *         Country checkboxes hidden; dynamic region checkboxes injected.
 * v1.4.1 – Hide Webflow's static "1" badge; our dynamic count replaces it.
 * v1.4 – Added country filter support.
 *         Deduplicate filter checkboxes (keep first, hide dupes).
 *         Hide filter options with zero job listings.
 *         Add count badges (black pill, white number) next to each option.
 * v1.3 – Fix: strip ALL Finsweet attributes from the page to prevent
 *         MutationObserver infinite loop that crashed the tab.
 *         Cache element refs before stripping so our code still works.
 * v1.2 – Brand data fetched from brand-map.json (CDN) because the
 *         Webflow CMS binding on the brand text element is empty.
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────
  var DEBOUNCE = 250;
  var INIT_DELAY = 300; // ms – wait for Finsweet to finish before we init
  var BRAND_MAP_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/brand-map.json';
  var REGION_MAP_URL = 'https://cdn.jsdelivr.net/gh/The-Uncoders/pageup-webflow-sync@main/region-map.json';

  // ── State ─────────────────────────────────
  var keyword = '';
  var activeCities = {};    // lowercase label → true
  var activeRegions = {};   // lowercase region name → true
  var activeBrands = {};    // lowercase label → true
  var workType = '';        // '' = all
  var sortMode = 'default';
  var jobs = [];
  var _brandMap = null;     // title → brand name (fetched from CDN)
  var _regionMap = null;    // lowercase country → region name (fetched from CDN)

  // Cached element references (populated in init, before Finsweet attrs are stripped)
  var _rcEl = null;    // results-count element
  var _icEl = null;    // items-count element
  var _emptyEl = null; // empty-state element
  var _allRadio = null; // "All" work-type radio (inside fs-cmsfilter reset label)

  // ── Neutralise Finsweet ───────────────────
  // Finsweet Attributes v2 uses a global callback queue.
  // We hook into it to destroy any filter/sort instances it creates,
  // preventing it from interfering with our custom filters.
  window.fsAttributes = window.fsAttributes || [];
  window.fsAttributes.push(['cmsfilter', function (filterInstances) {
    if (filterInstances && filterInstances.length) {
      filterInstances.forEach(function (inst) {
        try { if (typeof inst.destroy === 'function') inst.destroy(); } catch (e) {}
      });
    }
  }]);
  window.fsAttributes.push(['cmssort', function (sortInstances) {
    if (sortInstances && sortInstances.length) {
      sortInstances.forEach(function (inst) {
        try { if (typeof inst.destroy === 'function') inst.destroy(); } catch (e) {}
      });
    }
  }]);

  // Strip ALL Finsweet attributes from the page so Finsweet becomes
  // completely blind to filter/sort elements. This prevents any
  // MutationObserver ping-pong between our code and Finsweet.
  function stripFinsweet() {
    var attrs = [
      'fs-cmsfilter-element', 'fs-cmsfilter-field',
      'fs-cmssort-element', 'fs-cmssort-field'
    ];
    for (var a = 0; a < attrs.length; a++) {
      var els = document.querySelectorAll('[' + attrs[a] + ']');
      for (var i = 0; i < els.length; i++) {
        els[i].removeAttribute(attrs[a]);
      }
    }
  }
  // NOTE: Do NOT call stripFinsweet() here — init() must cache element
  // references first (they use fs-cmsfilter-element selectors). Stripping
  // happens inside init() after caching, plus delayed follow-ups.

  // ── Boot ──────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, INIT_DELAY); });
  } else {
    setTimeout(init, INIT_DELAY);
  }

  // ── Initialise ────────────────────────────
  function init() {
    var list = document.querySelector('.career_list');
    if (!list) return;

    // Cache element references BEFORE stripping Finsweet attributes
    _rcEl = document.querySelector('[fs-cmsfilter-element="results-count"]');
    _icEl = document.querySelector('[fs-cmsfilter-element="items-count"]');
    _emptyEl = document.querySelector('[fs-cmsfilter-element="empty"]');
    var tpl = document.querySelector('[fs-cmsfilter-element="tag-template"]');
    var resetEls = document.querySelectorAll('a[fs-cmsfilter-element="reset"]');
    _allRadio = document.querySelector('label[fs-cmsfilter-element="reset"] input[type="radio"]');

    // Now strip all Finsweet attributes (makes Finsweet completely blind)
    // + schedule delayed follow-ups to catch any late Finsweet re-inits
    stripFinsweet();
    setTimeout(stripFinsweet, 0);
    setTimeout(stripFinsweet, 200);
    setTimeout(stripFinsweet, 1000);
    setTimeout(stripFinsweet, 3000);

    // Prevent Webflow form submission (filters live inside a form)
    var form = document.querySelector('.filters1_form-block form') ||
               document.querySelector('.filters1_form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });

    // Hide the tag template so it doesn't show "Tag" text
    if (tpl) tpl.style.display = 'none';

    // Fetch both maps in parallel, then parse cards & bind interactions
    var pending = 2;
    var brandResult = null;
    var regionResult = null;

    function afterFetch() {
      _brandMap = brandResult || {};
      _regionMap = regionResult || {};

      // Parse every job card (brand resolved via map, region derived from country)
      var items = list.querySelectorAll(':scope > .w-dyn-item');
      for (var i = 0; i < items.length; i++) {
        jobs.push(parseCard(items[i], i));
      }

      // Deduplicate filter checkboxes, hide zero-count options, add count badges
      deduplicateFilters();

      // Build dynamic region checkboxes (replaces country filter)
      buildRegionFilter();

      // Bind all interactions
      bindSearch();
      bindCheckboxes('input[name="city"]', activeCities);
      bindCheckboxes('input[name="region"]', activeRegions);
      bindCheckboxes('input[name="brand"]', activeBrands);
      bindRadios();
      bindSort();
      bindClear(resetEls);

      // Initial render
      applyFilters();
    }

    fetchJSON(BRAND_MAP_URL, function (map) {
      brandResult = map;
      if (--pending === 0) afterFetch();
    });
    fetchJSON(REGION_MAP_URL, function (map) {
      regionResult = map;
      if (--pending === 0) afterFetch();
    });
  }

  // ── Fetch JSON helper ───────────────────
  function fetchJSON(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 5000; // 5 s timeout – don't block page if CDN is slow
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(JSON.parse(xhr.responseText)); } catch (e) { cb(null); }
      } else {
        cb(null);
      }
    };
    xhr.onerror = function () { cb(null); };
    xhr.ontimeout = function () { cb(null); };
    xhr.send();
  }

  // ── Parse a single job card ───────────────
  function parseCard(el, idx) {
    var dw = el.querySelectorAll('.career23_detail-wrapper');
    var title = qText(el, '.heading-style-h5');

    // Resolve brand: prefer map lookup by title, fall back to DOM text
    var brandFromDOM = dwText(dw[2]);
    var brand = (_brandMap && _brandMap[title]) ? _brandMap[title] : brandFromDOM;

    // Extract country and derive region from map
    var countryRaw = dwText(dw[1]);
    var regionName = '';
    if (countryRaw && _regionMap) {
      regionName = _regionMap[countryRaw.toLowerCase()] || 'Multiple Locations';
    } else if (!countryRaw) {
      regionName = 'Multiple Locations';
    }

    return {
      el: el,
      idx: idx,
      title:    title,
      category: qText(el, '.tag'),
      city:     dwText(dw[0]),
      country:  countryRaw,
      region:   regionName,
      brand:    brand,
      workType: dwText(dw[3]),
      summary:  qText(el, '.text-size-regular')
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

  // ── Filter engine ─────────────────────────
  function applyFilters() {
    var kw = keyword.toLowerCase();
    var hasCities = objSize(activeCities) > 0;
    var hasRegions = objSize(activeRegions) > 0;
    var hasBrands = objSize(activeBrands) > 0;
    var wt = workType.toLowerCase();
    var count = 0;

    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var show = true;

      // Keyword (substring match across all text)
      if (show && kw) {
        var hay = [j.title, j.category, j.city, j.country, j.region,
                   j.brand, j.workType, j.summary].join(' ').toLowerCase();
        show = hay.indexOf(kw) !== -1;
      }

      // City / location (OR within group)
      if (show && hasCities) {
        show = !!activeCities[j.city.toLowerCase()];
      }

      // Region (OR within group)
      if (show && hasRegions) {
        show = !!activeRegions[j.region.toLowerCase()];
      }

      // Brand (OR within group)
      if (show && hasBrands) {
        show = !!activeBrands[j.brand.toLowerCase()];
      }

      // Work type
      if (show && wt) {
        show = j.workType.toLowerCase() === wt;
      }

      j.el.style.display = show ? '' : 'none';
      if (show) count++;
    }

    setCount(count);
    setEmpty(count === 0);
    renderTags();
    reorderDOM();
  }

  // ── Results count ─────────────────────────
  function setCount(n) {
    if (_rcEl) _rcEl.textContent = n;
    if (_icEl) _icEl.textContent = jobs.length;
  }

  function setEmpty(flag) {
    if (_emptyEl) _emptyEl.style.display = flag ? 'flex' : 'none';
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
    // Also handle Enter key
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); keyword = input.value.trim(); applyFilters(); }
    });
  }

  // ── Checkbox filters (cities, regions & brands) ────
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
    if (!lbl) return '';
    // Clone and strip out count badges so we get only the label text
    var clone = lbl.cloneNode(true);
    var badges = clone.querySelectorAll('.filter-count-badge');
    for (var i = 0; i < badges.length; i++) badges[i].remove();
    return clone.textContent.trim();
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
    var links = dd.querySelectorAll('.w-dropdown-link');
    links.forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        sortMode = link.textContent.trim();
        // Update toggle text
        var toggle = dd.querySelector('.w-dropdown-toggle');
        if (toggle) {
          var parts = toggle.querySelectorAll('div');
          for (var i = 0; i < parts.length; i++) {
            if (!parts[i].querySelector('svg') && !parts[i].classList.contains('w-icon-dropdown-toggle')) {
              parts[i].textContent = sortMode;
              break;
            }
          }
        }
        reorderDOM();
        // Close dropdown
        dd.classList.remove('w--open');
        var list = dd.querySelector('.w-dropdown-list');
        if (list) list.classList.remove('w--open');
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
        arr.sort(function (a, b) { return a.title.localeCompare(b.title); });
        break;
      case 'Name: Z to A':
        arr.sort(function (a, b) { return b.title.localeCompare(a.title); });
        break;
      case 'Most Recent':
        arr.sort(function (a, b) { return a.idx - b.idx; }); // CMS default = most recent
        break;
      default:
        arr.sort(function (a, b) { return a.idx - b.idx; });
    }
    for (var i = 0; i < arr.length; i++) {
      list.appendChild(arr[i].el);
    }
  }

  // ── Filter tags ────────────────────────────
  function renderTags() {
    var container = document.querySelector('.filters1_tags-wrapper');
    if (!container) return;

    // Remove all dynamically added tags
    var existing = container.querySelectorAll('.filters1_tag--dynamic');
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    var filters = [];

    if (keyword) filters.push({ type: 'keyword', label: '"' + keyword + '"' });

    var cityKeys = Object.keys(activeCities);
    for (var c = 0; c < cityKeys.length; c++) {
      filters.push({ type: 'city', label: cityKeys[c], key: cityKeys[c] });
    }

    var regionKeys = Object.keys(activeRegions);
    for (var r = 0; r < regionKeys.length; r++) {
      filters.push({ type: 'region', label: regionKeys[r], key: regionKeys[r] });
    }

    var brandKeys = Object.keys(activeBrands);
    for (var b = 0; b < brandKeys.length; b++) {
      filters.push({ type: 'brand', label: brandKeys[b], key: brandKeys[b] });
    }

    if (workType) filters.push({ type: 'workType', label: workType });

    for (var f = 0; f < filters.length; f++) {
      container.appendChild(makeTag(filters[f]));
    }
  }

  function makeTag(filter) {
    var tag = document.createElement('div');
    tag.className = 'filters1_tag filters1_tag--dynamic';
    tag.style.display = 'flex';

    var textDiv = document.createElement('div');
    textDiv.textContent = filter.type === 'region' ? capitalizeRegion(filter.label) : capitalize(filter.label);
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
      if (lbl && lbl.toLowerCase() === labelLower) cb.checked = false;
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
    activeCities = {};
    activeRegions = {};
    activeBrands = {};
    workType = '';
    sortMode = 'default';

    var inp = document.querySelector('.filters1_keyword-search input');
    if (inp) inp.value = '';

    document.querySelectorAll('input[name="city"], input[name="region"], input[name="brand"]').forEach(function (cb) {
      cb.checked = false;
    });

    if (_allRadio) _allRadio.checked = true;

    // Reset sort toggle text
    var dd = document.querySelector('.dropdown1_component');
    if (dd) {
      var toggle = dd.querySelector('.w-dropdown-toggle');
      if (toggle) {
        var parts = toggle.querySelectorAll('div');
        for (var i = 0; i < parts.length; i++) {
          if (!parts[i].querySelector('svg') && !parts[i].classList.contains('w-icon-dropdown-toggle')) {
            parts[i].textContent = 'Sort by';
            break;
          }
        }
      }
    }

    applyFilters();
  }

  // ── Deduplicate, hide empty, add count badges ──
  function deduplicateFilters() {
    dedupeGroup('input[name="city"]', 'city');
    // Country checkboxes are fully hidden; region filter built dynamically
    hideAllCountryCheckboxes();
    dedupeGroup('input[name="brand"]', 'brand');
  }

  // Hide ALL existing country checkboxes (replaced by dynamic region filter)
  function hideAllCountryCheckboxes() {
    var cbs = document.querySelectorAll('input[name="country"]');
    for (var c = 0; c < cbs.length; c++) {
      var wrapper = cbs[c].closest('.w-checkbox');
      if (wrapper) wrapper.style.display = 'none';
    }
  }

  // ── Build dynamic region filter ───────────
  // Replaces the country checkbox list with region checkboxes
  function buildRegionFilter() {
    // Count jobs per region
    var regionCounts = {};
    for (var i = 0; i < jobs.length; i++) {
      var r = jobs[i].region;
      if (!r) continue;
      var key = r.toLowerCase();
      regionCounts[key] = (regionCounts[key] || 0) + 1;
    }

    // Find the container that holds country checkboxes
    var firstCountryCb = document.querySelector('input[name="country"]');
    if (!firstCountryCb) return;
    var container = firstCountryCb.closest('.w-checkbox');
    if (!container) return;
    var parent = container.parentElement;
    if (!parent) return;

    // Rename the filter section heading from "Country" to "Region"
    renameFilterHeading(parent, 'Country', 'Region');

    // Force the accordion open so region checkboxes are visible
    expandFilterSection(parent);

    // Rename the city section from "Regions" to "City" (avoid naming confusion)
    renameCitySectionHeading();

    // Sort region names alphabetically
    var regionNames = Object.keys(regionCounts).sort();

    // Create a checkbox for each region
    for (var ri = 0; ri < regionNames.length; ri++) {
      var regionKey = regionNames[ri];
      var regionLabel = regionCounts[regionKey] ? capitalizeRegion(regionKey) : null;
      if (!regionLabel) continue;

      var wrapper = document.createElement('label');
      wrapper.className = 'w-checkbox filters1_checkbox-field';

      var input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'region';
      input.className = 'w-checkbox-input';
      input.style.cssText = 'opacity:0;position:absolute;z-index:-1;';
      wrapper.appendChild(input);

      var span = document.createElement('span');
      span.className = 'w-form-label';
      span.textContent = regionLabel;
      wrapper.appendChild(span);

      // Add count badge
      addCountBadge(wrapper, regionCounts[regionKey]);

      parent.appendChild(wrapper);
    }
  }

  // Capitalize region name properly (handles "uk & europe" → "UK & Europe", etc.)
  function capitalizeRegion(key) {
    // Map of lowercase region names to their proper display names
    var displayNames = {
      'asia': 'Asia',
      'australia': 'Australia',
      'canada': 'Canada',
      'multiple locations': 'Multiple Locations',
      'new zealand': 'New Zealand',
      'south africa': 'South Africa',
      'uae': 'UAE',
      'uk & europe': 'UK & Europe',
      'usa': 'USA'
    };
    return displayNames[key] || capitalize(key);
  }

  // Rename a filter section heading (e.g. "Country" → "Region")
  function renameFilterHeading(filterParent, oldName, newName) {
    // Walk up to the filter group and find the heading text div
    var group = filterParent.closest('.filters1_filter-group');
    if (!group) return;
    var heading = group.querySelector('.filters1_filter-group-heading');
    if (!heading) return;
    var textEl = heading.querySelector('.text-size-medium-4');
    if (textEl && textEl.textContent.trim().toLowerCase() === oldName.toLowerCase()) {
      textEl.textContent = newName;
    }
  }

  // Force a filter section accordion open (override Webflow IX2 collapsed state)
  function expandFilterSection(filterParent) {
    var group = filterParent.closest('.filters1_filter-group');
    if (!group) return;
    var options = group.querySelector('.filters1_filter-options');
    if (options) {
      options.style.height = 'auto';
      options.style.overflow = 'visible';
    }
  }

  // Rename the "Regions" city section to "City" to avoid confusion with our Region filter
  function renameCitySectionHeading() {
    var headings = document.querySelectorAll('.filters1_filter-group-heading');
    for (var i = 0; i < headings.length; i++) {
      var textEl = headings[i].querySelector('.text-size-medium-4');
      if (textEl && textEl.textContent.trim() === 'Regions') {
        textEl.textContent = 'City';
        break;
      }
    }
  }

  function dedupeGroup(selector, field) {
    // Count how many jobs have each value for this field
    var counts = {};
    for (var i = 0; i < jobs.length; i++) {
      var val = jobs[i][field];
      if (!val) continue;
      var key = val.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
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

      // Hide the Webflow-designed static "1" badge (always shows 1)
      var origBadge = wrapper.querySelector('.icon-1x1-xsmall');
      if (origBadge) origBadge.style.display = 'none';

      if (seen[key] || !counts[key]) {
        // Duplicate or no matching jobs → hide entirely
        wrapper.style.display = 'none';
      } else {
        // First occurrence with jobs → keep visible, add count badge
        seen[key] = true;
        addCountBadge(wrapper, counts[key]);
      }
    }
  }

  function addCountBadge(wrapper, count) {
    var lbl = wrapper.querySelector('.w-form-label');
    if (!lbl) return;
    var badge = document.createElement('span');
    badge.className = 'filter-count-badge';
    badge.textContent = count;
    badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;'
      + 'background:#1a1a2e;color:#fff;font-size:11px;line-height:1;'
      + 'min-width:22px;height:22px;border-radius:11px;padding:0 6px;'
      + 'margin-left:8px;font-weight:600;letter-spacing:0.02em;';
    lbl.appendChild(badge);
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
})();
