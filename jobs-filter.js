/**
 * FCTG Careers - Job Filter & Sort System v1.0
 * Custom filtering for the /jobs page
 *
 * Handles: keyword search, city/location filter, brand filter,
 * work type filter, sorting, active filter tags, results count,
 * clear all, and empty state.
 *
 * NOTE: For brand filtering to work, bind the hidden "brand" text
 * element on each job card to the CMS "brand-name" field in the
 * Webflow Designer. Same for the hidden "country" text element.
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────
  var DEBOUNCE = 250;

  // ── State ─────────────────────────────────
  var keyword = '';
  var activeCities = {};   // lowercase label → true
  var activeBrands = {};   // lowercase label → true
  var workType = '';        // '' = all
  var sortMode = 'default';
  var jobs = [];

  // ── Boot ──────────────────────────────────
  // Remove Finsweet placeholder attributes so it doesn't interfere
  document.querySelectorAll('[fs-cmsfilter-field="IDENTIFIER"]').forEach(function (el) {
    el.removeAttribute('fs-cmsfilter-field');
  });
  document.querySelectorAll('[fs-cmssort-field="IDENTIFIER"]').forEach(function (el) {
    el.removeAttribute('fs-cmssort-field');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 60); });
  } else {
    setTimeout(init, 60);
  }

  // ── Initialise ────────────────────────────
  function init() {
    var list = document.querySelector('.career_list');
    if (!list) return;

    // Prevent Webflow form submission (filters live inside a form)
    var form = document.querySelector('.filters1_form-block form') ||
               document.querySelector('.filters1_form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });

    // Hide the tag template so it doesn't show "Tag" text
    var tpl = document.querySelector('[fs-cmsfilter-element="tag-template"]');
    if (tpl) tpl.style.display = 'none';

    // Parse every job card
    var items = list.querySelectorAll(':scope > .w-dyn-item');
    for (var i = 0; i < items.length; i++) {
      jobs.push(parseCard(items[i], i));
    }

    // Bind all interactions
    bindSearch();
    bindCheckboxes('input[name="city"]', activeCities);
    bindCheckboxes('input[name="brand"]', activeBrands);
    bindRadios();
    bindSort();
    bindClear();

    // Initial render
    applyFilters();
  }

  // ── Parse a single job card ───────────────
  function parseCard(el, idx) {
    var dw = el.querySelectorAll('.career23_detail-wrapper');
    return {
      el: el,
      idx: idx,
      title:    qText(el, '.heading-style-h5'),
      category: qText(el, '.tag'),
      city:     dwText(dw[0]),
      country:  dwText(dw[1]),
      brand:    dwText(dw[2]),
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
    var hasBrands = objSize(activeBrands) > 0;
    var wt = workType.toLowerCase();
    var count = 0;

    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var show = true;

      // Keyword (substring match across all text)
      if (show && kw) {
        var hay = [j.title, j.category, j.city, j.country,
                   j.brand, j.workType, j.summary].join(' ').toLowerCase();
        show = hay.indexOf(kw) !== -1;
      }

      // City / location (OR within group)
      if (show && hasCities) {
        show = !!activeCities[j.city.toLowerCase()];
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
    var rc = document.querySelector('[fs-cmsfilter-element="results-count"]');
    var ic = document.querySelector('[fs-cmsfilter-element="items-count"]');
    if (rc) rc.textContent = n;
    if (ic) ic.textContent = jobs.length;
  }

  function setEmpty(flag) {
    var el = document.querySelector('[fs-cmsfilter-element="empty"]');
    if (el) el.style.display = flag ? 'flex' : 'none';
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

  // ── Checkbox filters (cities & brands) ────
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
      case 'city':
        delete activeCities[f.key];
        uncheckByLabel('input[name="city"]', f.key);
        break;
      case 'brand':
        delete activeBrands[f.key];
        uncheckByLabel('input[name="brand"]', f.key);
        break;
      case 'workType':
        workType = '';
        var allRadio = document.querySelector('label[fs-cmsfilter-element="reset"] input[type="radio"]');
        if (allRadio) allRadio.checked = true;
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
  function bindClear() {
    document.querySelectorAll('a[fs-cmsfilter-element="reset"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        clearAll();
      });
    });
  }

  function clearAll() {
    keyword = '';
    activeCities = {};
    activeBrands = {};
    workType = '';
    sortMode = 'default';

    var inp = document.querySelector('.filters1_keyword-search input');
    if (inp) inp.value = '';

    document.querySelectorAll('input[name="city"], input[name="brand"]').forEach(function (cb) {
      cb.checked = false;
    });

    var allRadio = document.querySelector('label[fs-cmsfilter-element="reset"] input[type="radio"]');
    if (allRadio) allRadio.checked = true;

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
