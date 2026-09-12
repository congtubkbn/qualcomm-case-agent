// scripts/dom_extractor.js
//
// Unified, namespaced DOM extractor and browser automation helper module.
// Consolidates Chatter feed expander, case state observer, login helper,
// tab switcher, search results parser, and raw DOM case extractor into
// window.__QC_DOM__.
//

(function () {
  var _g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this));
  var QC = _g.__QC_DOM__ || {};

  // --- Shared DOM Helpers ---
  QC.txt = function (el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  };

  QC.qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  QC.isVisible = function (el) {
    if (!el) return false;
    var cls = el.className || '';
    if (typeof cls === 'string' && /\b(hidden|fadeOut)\b/i.test(cls)) return false;
    if (el.classList) {
      if (el.classList.contains('hidden') || el.classList.contains('fadeOut')) return false;
    }
    if (el.closest) {
      var hiddenAncestor = el.closest('.hidden, .fadeOut, [style*="display: none"], [style*="display:none"]');
      if (hiddenAncestor) return false;
    }
    if (el.style) {
      if (el.style.display === 'none' || el.style.visibility === 'hidden' || el.style.opacity === '0') return false;
    }
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      try {
        var style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
      } catch (e) {}
    }
    if (el.offsetParent === null && (!el.style || el.style.position !== 'fixed')) {
      return false;
    }
    return true;
  };

  QC.deepByText = function (sel, re) {
    var out = [];
    (function scan(root) {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.matches && el.matches(sel) && re.test(QC.txt(el)) && QC.isVisible(el)) out.push(el);
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    })(document);
    return out;
  };

  QC.fire = function (el) {
    var win = (typeof window !== 'undefined') ? window : _g;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
      try {
        var Ctor = (/^pointer/.test(type) && win.PointerEvent) ? win.PointerEvent : win.MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: win }));
      } catch (e) {}
    });
    if (el && typeof el.click === 'function') el.click();
  };

  QC.bodyOf = function (a) {
    var b = a.querySelector(".feedBodyInner, .cuf-feedBodyText, [class*='feedBody']");
    return QC.txt(b || a);
  };

  QC.authorOf = function (a) {
    return QC.txt(a.querySelector('a'));
  };

  QC.findAnchorIdx = function (articles, anchor) {
    var anchorIdx = -1;
    if (anchor && anchor.bodyStart) {
      var needle = String(anchor.bodyStart).replace(/\s+/g, ' ').trim().slice(0, 40);
      for (var i = 0; i < articles.length && needle; i++) {
        if (QC.bodyOf(articles[i]).indexOf(needle) !== 0) continue;
        if ('author' in anchor && QC.authorOf(articles[i]) !== anchor.author) continue;
        anchorIdx = i;
        break;
      }
    }
    return anchorIdx;
  };

  QC.skipAsCached = function (idx, anchorIdx, baseline, prefixes) {
    if (!(anchorIdx >= 0 && idx >= anchorIdx)) return false;
    return !baseline || baseline.indexOf(prefixes[idx]) >= 0;
  };

  QC.deepQsa = function (sel, root) {
    var results = [];
    var seen = new Set();
    var add = function (el) {
      if (el && !seen.has(el)) {
        seen.add(el);
        results.push(el);
      }
    };
    var scan = function (node) {
      if (!node) return;
      if (node.querySelectorAll) {
        try {
          var matched = node.querySelectorAll(sel);
          for (var i = 0; i < matched.length; i++) {
            add(matched[i]);
          }
        } catch (e) {}
        try {
          var all = node.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i] && all[i].shadowRoot) {
              scan(all[i].shadowRoot);
            }
          }
        } catch (e) {}
      }
      if (node.shadowRoot) {
        scan(node.shadowRoot);
      }
    };
    scan(root || document);
    return results;
  };

  var LINE_BREAK_TAGS = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR"]);
  QC.domLines = function (el) {
    if (!el) return "";
    var kids = Array.prototype.slice.call(el.childNodes || []);
    if (kids.length === 0) {
      return (el.textContent || "").replace(/ /g, " ");
    }
    var lines = [];
    var current = "";
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === 3) {
        current += (child.textContent || "").replace(/ /g, " ");
        continue;
      }
      if (child.nodeType != null && child.nodeType !== 1) continue;
      if (child.tagName === "BR") {
        lines.push(current);
        current = "";
      } else if (LINE_BREAK_TAGS.has(child.tagName)) {
        if (current) { lines.push(current); current = ""; }
        lines.push(QC.domLines(child));
      } else {
        current += QC.domLines(child);
      }
    }
    if (current) lines.push(current);
    return lines.join("\n");
  };

  QC.cleanBody = function (s) {
    if (!s) return "";
    return s
      .replace(/â”¬Ã¡/g, "")
      .replace(/Â(?=[\s\n]|$)/g, "")
      .replace(/\s*Expand Post\s*$/i, "")
      .trim();
  };

  QC.stripFieldAffordances = function (s, label) {
    if (!s || typeof s !== 'string') return s;
    var val = s.trim();
    val = val.replace(/\s*Preview\s*$/, '').trim();
    val = val.replace(/(?:\r?\n|\s+)Edit\s+[A-Za-z0-9_\-\s]+$/i, '').trim();
    if (/^Help\s+/i.test(val)) {
      var target = val.replace(/^Help\s+/i, '').trim().toLowerCase();
      var lbl = (label || '').trim().toLowerCase();
      if (lbl && (target === lbl || target.includes(lbl) || lbl.includes(target))) {
        return '';
      }
      if (target === 'related crs' || target === 'related cr' || target === 'status' || target === 'priority' || target === 'case record type') {
        return '';
      }
    }
    return val;
  };

  QC.sectionValue = function (labelOrLabels) {
    var labelsList = Array.isArray(labelOrLabels) ? labelOrLabels : [labelOrLabels];
    var lowerLabels = labelsList.map(function (l) { return (l || "").toLowerCase().trim(); }).filter(Boolean);
    if (!lowerLabels.length) return null;

    var findContainer = function (el) {
      var cur = el;
      while (cur) {
        if (cur.matches && cur.matches(".slds-form-element, [class*='record-layout-item'], lightning-record-layout-item, records-record-layout-item, dl, .slds-grid, records-record-layout-row, records-record-layout-block, lightning-accordion-section, [class*='accordion']")) {
          return cur;
        }
        if (cur.parentElement) {
          cur = cur.parentElement;
        } else if (cur.parent) {
          cur = cur.parent;
        } else if (cur.getRootNode && cur.getRootNode().host) {
          cur = cur.getRootNode().host;
        } else {
          break;
        }
      }
      return el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    };

    var btns = QC.deepQsa("button");
    var btn = btns.find(function (b) {
      var bt = QC.txt(b).toLowerCase();
      return lowerLabels.includes(bt) || lowerLabels.some(function (l) { return bt === l || bt.startsWith(l + ":"); });
    });
    if (btn) {
      var host = findContainer(btn);
      if (host) {
        var valEls = QC.deepQsa(".slds-accordion__content, [class*='accordion__content'], lightning-formatted-text, lightning-formatted-name, p, span:not([class*='label'])", host);
        var valEl = valEls.find(function (el) { return el !== btn && !btn.contains(el) && !lowerLabels.includes(QC.txt(el).toLowerCase()) && QC.txt(el).length > 0; });
        if (valEl) {
          var val = QC.stripFieldAffordances(QC.txt(valEl));
          if (val) return val;
        }
      }
    }

    var labels = QC.deepQsa(".slds-form-element__label, label, [class*='label'], dt, .test-id__field-label, [data-label]");
    var matchedLabel = labels.find(function (l) {
      var t = QC.txt(l).toLowerCase();
      return lowerLabels.includes(t) || lowerLabels.some(function (lbl) { return t === lbl || t.startsWith(lbl + ":") || t.startsWith(lbl + " *") || t === lbl + "*"; });
    });

    if (matchedLabel) {
      var parent = findContainer(matchedLabel);
      if (parent) {
        var dedicatedVal = QC.deepQsa(".test-id__field-value, lightning-formatted-text, lightning-formatted-name, lightning-formatted-date-time, lightning-formatted-lookup", parent);
        var bestEl = dedicatedVal.find(function (el) { return el !== matchedLabel && !matchedLabel.contains(el) && !el.closest?.('lightning-helptext, button, .slds-assistive-text'); });
        if (bestEl) {
          var val = QC.stripFieldAffordances(QC.txt(bestEl), lowerLabels[0]);
          if (val) return val;
        }

        var isAffordanceEl = function (el) {
          if (!el) return true;
          if (el.closest && el.closest('lightning-helptext, .slds-form-element__label-container, button.test-id__inline-edit-trigger, button.slds-button_icon')) return true;
          if (el.classList && (el.classList.contains('slds-assistive-text') || el.classList.contains('test-id__inline-edit-trigger'))) return true;
          return false;
        };

        var valEls = QC.deepQsa(".slds-form-element__control, dd, p, a, span:not([class*='label'])", parent);
        var valEl = valEls.find(function (el) { return el !== matchedLabel && !matchedLabel.contains(el) && !isAffordanceEl(el) && !lowerLabels.includes(QC.txt(el).toLowerCase()) && QC.txt(el).length > 0; });
        if (valEl) {
          var val = QC.stripFieldAffordances(QC.txt(valEl), lowerLabels[0]);
          if (val) return val;
        }
      }
    }

    for (var i = 0; i < lowerLabels.length; i++) {
      var lbl = lowerLabels[i];
      var els = QC.deepQsa(`[data-field="${lbl}"], [data-field-name="${lbl}"], [data-name="${lbl}"], [data-target-selection-name*="${lbl}"]`);
      if (els && els.length > 0) {
        var val = QC.stripFieldAffordances(QC.txt(els[0]), lbl);
        if (val) return val;
      }
    }

    return null;
  };

  var isBlacklistedTs = function (s) {
    if (!s) return true;
    var lower = s.toLowerCase();
    return (
      lower.includes("click for single-item view") ||
      lower.includes("expand post") ||
      lower.includes("chatter feed item") ||
      lower.includes("view more comments") ||
      lower.includes("more comments")
    );
  };

  QC.extractTimestamp = function (a, named, author) {
    var datePattern = /(?:ago|yesterday|today|\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b)/i;
    var tsEl = a.querySelector("a.cuf-timestamp, span.cuf-timestamp, time, .uiOutputDateTime, [class*='timestamp'], [class*='Timestamp'], [class*='dateTime'], [class*='DateTime'], [class*='createdDate'], [class*='created-date']");
    if (tsEl) {
      var val = tsEl.getAttribute("title") || tsEl.getAttribute("datetime") || tsEl.getAttribute("data-timestamp") || tsEl.getAttribute("data-created-date") || QC.txt(tsEl) || "";
      if (val && !isBlacklistedTs(val)) return val;
    }
    var match = named.find(function (t) { return !isBlacklistedTs(t) && t !== author && datePattern.test(t); });
    if (match) return match;

    var inlineCandidates = QC.qsa("span, div, p, time, a", a);
    for (var i = 0; i < inlineCandidates.length; i++) {
      var el = inlineCandidates[i];
      if (el.closest && (el.closest('.feedBodyInner') || el.closest('.cuf-feedItemAttachments'))) continue;
      var titleAttr = el.getAttribute("title") || el.getAttribute("datetime") || el.getAttribute("data-timestamp");
      if (titleAttr && !isBlacklistedTs(titleAttr) && datePattern.test(titleAttr)) {
        return titleAttr;
      }
      var t = QC.txt(el);
      if (t && t !== author && !isBlacklistedTs(t) && t.length < 60 && datePattern.test(t)) {
        return t;
      }
    }

    for (var idx = 1; idx < named.length; idx++) {
      var n = named[idx];
      if (n && n !== author && !isBlacklistedTs(n)) {
        return n;
      }
    }
    return "";
  };

  QC.extractAttachments = function (art) {
    var attList = [];
    var seenFiles = new Set();
    var seenHrefs = new Set();

    var cards = QC.qsa(".cuf-feedItemAttachments .slds-file, .cuf-attachment.slds-file, .slds-file_card, .cuf-feedItemAttachments, [class*='feedItemAttachments']", art);
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var links = QC.qsa("a[href*='sfc/servlet.shepherd'], a[href*='ContentDocument'], a[href*='download'], a.slds-file__crop, a.slds-file__text, a.cuf-attachment", card);
      var downloadLink = links.find(function (l) {
        var h = l.getAttribute("href") || l.href || "";
        return h.includes("/version/download/") || h.includes("download");
      });
      var chosenLink = downloadLink || links[0];
      if (!chosenLink) continue;

      var href = chosenLink.getAttribute("href") || chosenLink.href || "";
      if (!href || href === "#" || href.startsWith("javascript:")) continue;
      if (href.startsWith("/")) {
        href = "https://support.qualcomm.com" + href;
      }
      if (href.includes("/s/profile/") || href.includes("/_ui/core/userprofile/")) continue;

      var name = chosenLink.getAttribute("download") || chosenLink.getAttribute("title");
      if (!name) {
        var titleEl = card.querySelector(".slds-file__text-title, .slds-file__title, .slds-truncate, .slds-assistive-text");
        if (titleEl) name = QC.txt(titleEl);
      }
      if (!name) {
        name = QC.txt(chosenLink) || href.split("/").pop()?.split("?")[0] || "attachment";
      }
      name = name.trim();

      var dedupKey = name.toLowerCase();
      if (!seenFiles.has(dedupKey) && !seenHrefs.has(href)) {
        seenFiles.add(dedupKey);
        seenHrefs.add(href);
        attList.push({ name: name, url: href });
      }
    }

    var allLinks = QC.qsa("a.cuf-attachment, a[href*='ContentDocument'], a[href*='sfc/servlet.shepherd/version/download']", art);
    for (var j = 0; j < allLinks.length; j++) {
      var a = allLinks[j];
      var href = a.getAttribute("href") || a.href || "";
      if (!href || href === "#" || href.startsWith("javascript:")) continue;
      if (href.startsWith("/")) {
        href = "https://support.qualcomm.com" + href;
      }
      if (href.includes("/s/profile/") || href.includes("/_ui/core/userprofile/")) continue;

      var name = a.getAttribute("download") || a.getAttribute("title") || QC.txt(a) || href.split("/").pop()?.split("?")[0] || "attachment";
      name = name.trim();

      var dedupKey = name.toLowerCase();
      if (!seenFiles.has(dedupKey) && !seenHrefs.has(href)) {
        seenFiles.add(dedupKey);
        seenHrefs.add(href);
        attList.push({ name: name, url: href });
      }
    }

    return attList;
  };


  // --- Feature Sub-routines ---

  QC.expandStep = function (anchor, probe, trusted) {
    var ANCHOR = anchor || null;
    var PROBE = probe || false;

    var byText = function (sel, re) {
      return QC.qsa(sel).filter(function (e) { return re.test(QC.txt(e)); });
    };

    var articles = QC.qsa('article');
    articles.forEach(function (a) {
      try { a.scrollIntoView({ behavior: 'instant', block: 'nearest' }); } catch(e) {}
    });

    var anchorIdx = QC.findAnchorIdx(articles, ANCHOR);

    var displayed = null;
    var statuses = QC.qsa("[role='status']");
    for (var si = 0; si < statuses.length; si++) {
      var m = QC.txt(statuses[si]).match(/(\d+)\s+Chatter\s+Feed\s+Items?\b/i);
      if (m) { displayed = Number(m[1]); break; }
    }

    var top = articles[0]
      ? { author: QC.authorOf(articles[0]), bodyStart: QC.bodyOf(articles[0]).slice(0, 80) }
      : null;

    var expandControls = QC.qsa('.cuf-more, [class*="cuf-more"], a, button')
      .filter(function (e) {
        var isExpandText = /^Expand Post$/i.test(QC.txt(e));
        var isCufMore = e.className && /\bcuf-more\b/.test(e.className);
        if (!isExpandText && !isCufMore) return false;
        if (!e.closest('article')) return false;
        return QC.isVisible(e);
      })
      .filter(function (e, idx, arr) {
        return !arr.some(function (other) {
          if (other === e) return false;
          if (other.contains) return other.contains(e);
          var p = e.parentElement || e.parent;
          while (p) {
            if (p === other) return true;
            p = p.parentElement || p.parent;
          }
          return false;
        });
      });

    var moreCommentControls = QC.deepByText('a, button', /^(view\s+)?\d*\s*more\s+comments?$/i);

    var prefixes = articles.map(function (a) { return QC.bodyOf(a).slice(0, 60); });
    var win = (typeof window !== 'undefined') ? window : _g;
    if (PROBE || !win.__qcExpandBaseline) win.__qcExpandBaseline = prefixes.slice();
    var baseline = win.__qcExpandBaseline;

    var skipElAsCached = function (e) {
      var art = e.closest('article');
      var idx = art ? articles.indexOf(art) : -1;
      return QC.skipAsCached(idx, anchorIdx, baseline, prefixes);
    };

    var result = {
      articles: articles.length,
      displayed: displayed,
      anchorIdx: anchorIdx,
      top: top,
      pendingExpand: expandControls.filter(function (e) { return !skipElAsCached(e); }).length,
      pendingMoreComments: moreCommentControls.length,
      clickedExpand: 0,
      clickedViewMore: 0,
      clickedDescription: 0,
      clickedMoreComments: 0,
      remainingExpand: 0,
    };
    if (PROBE) return result;

    expandControls.forEach(function (e) {
      if (skipElAsCached(e)) { result.remainingExpand++; return; }
      QC.fire(e);
      result.clickedExpand++;
    });

    moreCommentControls.forEach(function (e) {
      QC.fire(e);
      result.clickedMoreComments++;
    });

    if (anchorIdx < 0) {
      var more = byText('button, a', /^View More/i)[0];
      if (more) { QC.fire(more); result.clickedViewMore = 1; }
    }

    if (!ANCHOR) {
      var desc = QC.deepByText('button', /^Description$/i).filter(function (b) {
        return b.getAttribute('aria-expanded') === 'false';
      })[0];
      if (desc) { QC.fire(desc); result.clickedDescription = 1; }
    }

    return result;
  };

  QC.checkCollapsed = function (anchor) {
    var ANCHOR = anchor || null;
    var articles = QC.qsa('article');
    var anchorIdx = QC.findAnchorIdx(articles, ANCHOR);
    var win = (typeof window !== 'undefined') ? window : _g;
    var baseline = win.__qcExpandBaseline || null;
    var prefixes = articles.map(function (a) { return QC.bodyOf(a).slice(0, 60); });

    var isArticleCollapsed = function (art) {
      if (!art) return false;
      var controls = QC.qsa('.cuf-more, [class*="cuf-more"], a, button', art).filter(function (el) {
        return (el.className && /\bcuf-more\b/.test(el.className)) || /^Expand Post$/i.test(QC.txt(el));
      });
      for (var i = 0; i < controls.length; i++) {
        if (QC.isVisible(controls[i])) return true;
      }
      return false;
    };

    var stillCollapsed = articles.reduce(function (n, art, idx) {
      if (QC.skipAsCached(idx, anchorIdx, baseline, prefixes)) return n;
      return isArticleCollapsed(art) ? n + 1 : n;
    }, 0);

    var stillHasMoreComments = QC.deepByText('a, button', /^(view\s+)?\d*\s*more\s+comments?$/i).length;

    return { stillCollapsed: stillCollapsed, stillHasMoreComments: stillHasMoreComments };
  };

  QC.switchTab = function (targetTab) {
    var target = (targetTab || '').toLowerCase().trim();
    if (!target) return { ok: false, reason: 'no target tab specified' };

    var matchesTarget = function (s) {
      if (!s) return false;
      var str = s.toLowerCase().trim();
      if (str === target) return true;
      if (target === 'detail' || target === 'details') {
        return str === 'detail' || str === 'details' || str === 'case detail' || str === 'case details';
      }
      if (target === 'feed' || target === 'feeds' || target === 'chatter') {
        return str === 'feed' || str === 'feeds' || str === 'chatter' || str === 'case feed' || str === 'collaborate' || str === 'communication';
      }
      return false;
    };

    var activeTabs = QC.deepQsa('[role="tab"][aria-selected="true"], .slds-is-active [role="tab"], .slds-tabs_default__item.slds-is-active a, [role="tab"].active, .slds-tabs_default__item.slds-is-active button');
    for (var i = 0; i < activeTabs.length; i++) {
      var t = QC.txt(activeTabs[i]);
      var titleAttr = activeTabs[i].getAttribute('title') || '';
      var ariaLabel = activeTabs[i].getAttribute('aria-label') || '';
      var dataVal = activeTabs[i].getAttribute('data-tab-value') || activeTabs[i].getAttribute('data-tab-name') || '';
      if (matchesTarget(t) || matchesTarget(titleAttr) || matchesTarget(ariaLabel) || matchesTarget(dataVal)) {
        return { ok: true, alreadyActive: true, tab: target };
      }
    }

    var candidates = QC.deepQsa('[role="tab"], [role="presentation"] a, .slds-tabs_default__item a, .slds-tabs_default__item button, [data-tab-value], [data-tab-name], lightning-tab-bar button, button, a');
    var match = null;
    for (var j = 0; j < candidates.length; j++) {
      var el = candidates[j];
      var elText = QC.txt(el);
      var elTitle = el.getAttribute('title') || '';
      var elAriaLabel = el.getAttribute('aria-label') || '';
      var dataVal = el.getAttribute('data-tab-value') || el.getAttribute('data-tab-name') || '';

      if (matchesTarget(elText) || matchesTarget(elTitle) || matchesTarget(elAriaLabel) || matchesTarget(dataVal)) {
        match = el;
        break;
      }
    }

    if (match) {
      QC.fire(match);
      return { ok: true, clicked: true, tab: target };
    }

    return { ok: false, reason: 'tab not found: ' + target };
  };

  QC.observeCaseState = function (code, timeout) {
    var maxTimeout = typeof timeout !== 'undefined' ? timeout : 15000;

    function checkState() {
      if (location.hostname === 'account.qualcomm.com') {
        return { state: 'AUTH', url: location.href };
      }
      if (location.pathname.indexOf('/s/case/') >= 0 && location.pathname.indexOf('/s/case/Case/Default') === -1) {
        return { state: 'ON_CASE', href: location.href };
      }
      return null;
    }

    var immediate = checkState();
    if (immediate) return Promise.resolve(immediate);

    return new Promise(function(resolve) {
      var timer = null;
      var pollTimer = null;
      var observer = null;

      function cleanup() {
        if (timer) clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
        if (observer) observer.disconnect();
      }

      timer = setTimeout(function() {
        cleanup();
        var last = checkState();
        if (last) resolve(last);
        else resolve({ state: 'TIMEOUT', href: location.href });
      }, maxTimeout);

      pollTimer = setInterval(function() {
        var res = checkState();
        if (res) {
          cleanup();
          resolve(res);
        }
      }, 500);

      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(function() {
          var res = checkState();
          if (res) {
            cleanup();
            resolve(res);
          }
        });
        observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
      }
    });
  };

  QC.searchCaseResults = function (code, timeout) {
    var maxTimeout = typeof timeout !== 'undefined' ? timeout : 25000;
    var searchCode = typeof code !== 'undefined' ? String(code) : '';

    function checkSearch() {
      if (location.hostname === 'account.qualcomm.com') {
        return { state: 'AUTH', url: location.href };
      }
      if (location.pathname.indexOf('/s/case/') >= 0 && location.pathname.indexOf('/s/case/Case/Default') === -1) {
        return { state: 'ON_CASE', href: location.href, fields: {} };
      }

      var nonStubLinks = QC.qsa('a[href*="/s/case/"]').filter(function(a) {
        return a.href.indexOf('/s/case/Case/Default') === -1;
      });

      var hit = null, row = null;
      for (var i = 0; i < nonStubLinks.length; i++) {
        var r = nonStubLinks[i].closest('tr, li, [role="row"]');
        if (QC.txt(nonStubLinks[i]).indexOf(searchCode) >= 0 || (r && QC.txt(r).indexOf(searchCode) >= 0)) {
          hit = nonStubLinks[i]; row = r; break;
        }
      }
      var exact = !!hit;
      if (!hit && nonStubLinks.length > 0) {
        hit = nonStubLinks[0];
        row = hit.closest('tr, li, [role="row"]');
      }

      if (!hit) {
        return null;
      }

      var fields = {};
      var cells = [];
      if (row) {
        cells = QC.qsa('td, th', row).map(QC.txt).filter(Boolean);
        var table = row.closest('table');
        var heads = table ? QC.qsa('thead th, th', table).map(QC.txt) : [];
        var offset = cells.length - heads.length;
        for (var h = 0; h < heads.length; h++) {
          var key = heads[h].toLowerCase();
          var val = cells[h + (offset > 0 ? offset : 0)] || '';
          if (!key || !val || val === searchCode) continue;
          if (/subject|title/.test(key)) { if (!fields.title) fields.title = val; }
          else if (/status/.test(key)) { if (!fields.status) fields.status = val; }
          else if (/priority/.test(key)) { if (!fields.priority) fields.priority = val; }
          else if (/severity/.test(key)) { if (!fields.severity) fields.severity = val; }
        }
      }

      if (!fields.title) {
        var best = '';
        for (var c = 0; c < cells.length; c++) {
          var v = cells[c];
          if (v === searchCode || v.length < 10 || /^\d/.test(v)) continue;
          if (v.length > best.length) best = v;
        }
        if (best) fields.title = best;
      }

      QC.qsa('[data-cq-hit]').forEach(function (el) { el.removeAttribute('data-cq-hit'); });
      hit.setAttribute('data-cq-hit', '1');
      hit.removeAttribute('target');

      return {
        state: 'FOUND',
        href: hit.href,
        exact: exact,
        fields: fields,
        rows: nonStubLinks.length
      };
    }

    var immediate = checkSearch();
    if (immediate) return Promise.resolve(immediate);

    return new Promise(function(resolve) {
      var timer = null;
      var pollTimer = null;
      var observer = null;

      function cleanup() {
        if (timer) clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
        if (observer) observer.disconnect();
      }

      timer = setTimeout(function() {
        cleanup();
        var last = checkSearch();
        if (last) resolve(last);
        else resolve({ state: 'NO_LINK', href: '', fields: {}, rows: 0, reason: 'Timeout waiting for search results to render' });
      }, maxTimeout);

      pollTimer = setInterval(function() {
        var res = checkSearch();
        if (res) {
          cleanup();
          resolve(res);
        }
      }, 500);

      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(function() {
          var res = checkSearch();
          if (res) {
            cleanup();
            resolve(res);
          }
        });
        observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
      }
    });
  };

  QC.loginFill = function (password, username, timeout) {
    var pw = (typeof password !== 'undefined') ? String(password) : '';
    var user = (typeof username !== 'undefined' && username) ? String(username) : '';
    var maxTimeout = (typeof timeout !== 'undefined') ? Number(timeout) : 10000;

    function isHostAuthenticated() {
      return location.hostname === 'support.qualcomm.com' ||
        (location.hostname !== 'account.qualcomm.com' && !/login|auth|okta/i.test(location.pathname));
    }

    function checkError() {
      var errorEls = QC.qsa('.okta-form-infobox-error, .infobox-error, [role="alert"], .okta-form-input-error, .error-summary, .o-form-error-container');
      for (var i = 0; i < errorEls.length; i++) {
        var errText = QC.txt(errorEls[i]);
        if (errText && !/loading|spinner/i.test(errText)) {
          return errText;
        }
      }

      var bodyText = (document.body && (document.body.innerText || document.body.textContent) || '');
      if (/unable to sign in|sign[- ]in failed|password is incorrect|password was incorrect|your password has expired|authentication failed|account is locked|user is locked out|invalid username or password|check your username and password/i.test(bodyText)) {
        return 'Authentication failed';
      }

      return null;
    }

    function checkOtp() {
      var bodyText = (document.body && (document.body.innerText || document.body.textContent) || '');
      var otpRe = /send me an email|get a verification|enter a verification code|verification code|enter code|select an authenticator|select a security method|verify with your/i;
      if (otpRe.test(bodyText)) {
        return true;
      }
      var otpInputs = QC.qsa('input[name="credentials.passcode"][pattern*="0-9"], input[name="otp-code"], input[name="answer"], input[name="credentials.passcode"][inputmode="numeric"]');
      return otpInputs.length > 0;
    }

    function classifyCurrentState() {
      if (isHostAuthenticated()) {
        return { outcome: 'AUTHENTICATED' };
      }

      var error = checkError();
      if (error) {
        return { outcome: 'REJECTED', reason: error };
      }

      if (checkOtp()) {
        return { outcome: 'OTP_REQUIRED' };
      }

      return null;
    }

    function fillInput(el, value) {
      if (!el) return;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clickSubmit(root) {
      var scope = root || document;
      var btn = scope.querySelector('input[type="submit"], button[type="submit"], [data-type="save"], .button-primary, .okta-form-submit-button, button.button');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }

    var initial = classifyCurrentState();
    if (initial) {
      return Promise.resolve(initial);
    }

    if (!pw) {
      return Promise.resolve({ outcome: 'UNKNOWN', reason: 'No password provided to fill script' });
    }

    return new Promise(function (resolve) {
      var deadline = Date.now() + maxTimeout;
      var hasSubmittedPassword = false;

      function step() {
        var current = classifyCurrentState();
        if (current) {
          return resolve(current);
        }

        if (Date.now() > deadline) {
          var finalCheck = classifyCurrentState();
          if (finalCheck) return resolve(finalCheck);
          return resolve({ outcome: 'UNKNOWN', reason: 'Timeout waiting for login flow transition' });
        }

        var pwInput = document.querySelector('input[type="password"], input[name="credentials.passcode"], input[name="password"]');
        if (pwInput && !hasSubmittedPassword) {
          fillInput(pwInput, pw);
          var clickedPw = clickSubmit(pwInput.form);
          if (!clickedPw) clickSubmit();
          hasSubmittedPassword = true;
          setTimeout(step, 800);
          return;
        }

        var userInput = document.querySelector('input[name="identifier"], input[name="username"], #okta-signin-username, input[autocomplete="username"]');
        if (userInput && !pwInput) {
          if (!userInput.value || userInput.value.trim() !== user) {
            fillInput(userInput, user);
          }
          var clickedUser = clickSubmit(userInput.form);
          if (!clickedUser) clickSubmit();
          setTimeout(step, 800);
          return;
        }

        if (hasSubmittedPassword) {
          setTimeout(step, 500);
          return;
        }

        setTimeout(step, 500);
      }

      step();
    });
  };

  QC.extractCase = function () {
    var titleMatch = (document.title || "").match(/Case:\s*(\d[\w-]*)/i);
    var caseHeading = QC.qsa("h1, [role='heading']").find(function (h) { return /^Case\s+\d/i.test(QC.txt(h)); });
    var caseNumber = (titleMatch && titleMatch[1])
      || (caseHeading ? QC.txt(caseHeading).replace(/^Case\s+/i, "").trim() : "")
      || location.pathname.split("/").filter(Boolean).pop();

    var lastTopLevelIndex = null;
    var rawArticles = QC.qsa("article");
    var extractedComments = [];
    for (var i = 0; i < rawArticles.length; i++) {
      var a = rawArticles[i];
      var named = Array.from(a.querySelectorAll("a")).map(QC.txt).map(function (s) { return QC.stripFieldAffordances(s, 'author'); }).filter(Boolean);
      var author = named[0] || "";
      var bodyEl = a.querySelector(".feedBodyInner, .cuf-feedBodyText, [class*='feedBody']");
      var rawBodyText = bodyEl ? QC.domLines(bodyEl) : QC.txt(a);
      var body = QC.cleanBody(rawBodyText);
      if (!body || body.length === 0) continue;

      var timestamp = QC.extractTimestamp(a, named, author);
      var attachments = QC.extractAttachments(a);
      var isReply = a.classList.contains('cuf-comment') || a.classList.contains('cuf-commentItem')
        || Boolean(a.closest && a.closest('ul.cuf-replies, .cuf-replies, li.cuf-reply, li.cuf-commentLi'));

      var rect = a.getBoundingClientRect && a.getBoundingClientRect();
      var displayPosition = rect ? rect.top : null;

      var currentIndex = extractedComments.length;
      var parentIndex = null;
      if (isReply) {
        parentIndex = lastTopLevelIndex;
      } else {
        lastTopLevelIndex = currentIndex;
      }

      extractedComments.push({
        id: a.id || ("c" + (currentIndex + 1)),
        timestamp: timestamp,
        author: author,
        body: body,
        attachments: attachments,
        isReply: isReply,
        parentIndex: parentIndex,
        displayPosition: displayPosition,
      });
    }
    var comments = extractedComments;

    var displayedCommentCount = null;
    var statuses = QC.qsa("[role='status']");
    for (var si = 0; si < statuses.length; si++) {
      var m = QC.txt(statuses[si]).match(/(\d+)\s+Chatter\s+Feed\s+Items?\b/i);
      if (m) { displayedCommentCount = Number(m[1]); break; }
    }

    var title = QC.sectionValue(["Subject", "Case Subject"]);
    var status = QC.sectionValue(["Status", "Case Status"]);
    var priority = QC.sectionValue(["Priority", "Case Priority"]);
    var severity = QC.sectionValue(["Severity", "Case Severity", "Severity Level", "Severity:"]);
    var product = QC.sectionValue(["Chipset", "Product", "Product Name", "Product Family", "Product Line", "Product:"]);
    var accountName = QC.sectionValue(["Account Name", "Account", "Customer", "Customer Name"]);
    var contactName = QC.sectionValue(["Contact Name", "Contact", "Case Contact", "Contact:"]);
    var customerProject = QC.sectionValue(["Customer Project", "Customer Project Name", "Project", "Project Name"]);
    var customerTracking = QC.sectionValue(["Customer Tracking", "Customer Tracking Number", "Customer Tracking#"]);
    var relatedCRs = QC.sectionValue(["Related CRs", "Related CR", "Related Change Requests", "Change Requests", "CRs"]);
    var caseRecordType = QC.sectionValue(["Case Record Type Name", "Case Record Type", "Record Type", "Record Type Name"]);
    var openedAt = QC.sectionValue(["Date/Time Opened", "Date Opened", "Created Date", "Created At", "Opened Date", "Opened"]);
    var closedAt = QC.sectionValue(["Date/Time Closed", "Date Closed", "Closed Date", "Closed At", "Closed"]);
    var updated = QC.sectionValue(["Last Modified Date", "Modified Date", "Last Modified", "Last Modified By", "Date/Time Modified", "Modified At", "Modified"]);
    var description = QC.sectionValue(["Description", "Description Information", "Case Description", "Problem Description", "Subject Description"]);

    return {
      caseNumber: caseNumber,
      title: title,
      status: status,
      priority: priority,
      severity: severity,
      product: product,
      accountName: accountName,
      contactName: contactName,
      customerProject: customerProject,
      customerTracking: customerTracking,
      relatedCRs: relatedCRs,
      caseRecordType: caseRecordType,
      openedAt: openedAt,
      closedAt: closedAt,
      updated: updated,
      description: description,
      url: location.href,
      displayedCommentCount: displayedCommentCount,
      comments: comments,
    };
  };

  // Assign to global.__QC_DOM__
  _g.__QC_DOM__ = QC;

  // --- Dispatcher Pass ---
  var action = (typeof __ACTION !== 'undefined') ? __ACTION : null;

  if (!action) {
    if (typeof __TARGET_TAB !== 'undefined') action = 'switchTab';
    else if (typeof __PASSWORD !== 'undefined') action = 'loginFill';
    else if (typeof __CODE !== 'undefined' && typeof __TIMEOUT !== 'undefined') {
      if (typeof __SEARCH !== 'undefined' && __SEARCH) action = 'searchCaseResults';
      else action = 'observeCaseState';
    } else if (typeof __ANCHOR !== 'undefined' || typeof __PROBE !== 'undefined' || typeof __TRUSTED !== 'undefined') {
      if (typeof __CHECK_COLLAPSED !== 'undefined' && __CHECK_COLLAPSED) action = 'checkCollapsed';
      else action = 'expandStep';
    }
  }

  if (action === 'expandStep') {
    var anchor = (typeof __ANCHOR !== 'undefined') ? __ANCHOR : null;
    var probe = (typeof __PROBE !== 'undefined') ? __PROBE : false;
    var trusted = (typeof __TRUSTED !== 'undefined') ? __TRUSTED : false;
    return QC.expandStep(anchor, probe, trusted);
  }
  if (action === 'checkCollapsed') {
    var anchor = (typeof __ANCHOR !== 'undefined') ? __ANCHOR : null;
    return QC.checkCollapsed(anchor);
  }
  if (action === 'switchTab') {
    var targetTab = (typeof __TARGET_TAB !== 'undefined') ? __TARGET_TAB : '';
    return QC.switchTab(targetTab);
  }
  if (action === 'extractCase') {
    return QC.extractCase();
  }
  if (action === 'loginFill') {
    var password = (typeof __PASSWORD !== 'undefined') ? __PASSWORD : '';
    var username = (typeof __USERNAME !== 'undefined') ? __USERNAME : '';
    var timeout = (typeof __TIMEOUT !== 'undefined') ? __TIMEOUT : 10000;
    return QC.loginFill(password, username, timeout);
  }
  if (action === 'observeCaseState') {
    var code = (typeof __CODE !== 'undefined') ? __CODE : '';
    var timeout = (typeof __TIMEOUT !== 'undefined') ? __TIMEOUT : 15000;
    return QC.observeCaseState(code, timeout);
  }
  if (action === 'searchCaseResults') {
    var code = (typeof __CODE !== 'undefined') ? __CODE : '';
    var timeout = (typeof __TIMEOUT !== 'undefined') ? __TIMEOUT : 25000;
    return QC.searchCaseResults(code, timeout);
  }

  return QC;
})();
