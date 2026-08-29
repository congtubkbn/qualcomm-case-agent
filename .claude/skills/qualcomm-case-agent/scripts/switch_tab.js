// scripts/switch_tab.js
//
// Switches active tab on Salesforce Lightning case page (e.g., between "Detail" and "Feed").
// Evaluated via agent-browser or CDP.
//
// Parameter: __TARGET_TAB (string: 'Detail' | 'Feed' | 'Details' etc.)
(function () {
  var target = (typeof __TARGET_TAB !== 'undefined' ? __TARGET_TAB : '').toLowerCase().trim();
  if (!target) return { ok: false, reason: 'no target tab specified' };

  var deepQsa = function (sel, root) {
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

  var matchesTarget = function (s) {
    if (!s) return false;
    var str = s.toLowerCase().trim();
    if (str === target) return true;
    if (target === 'detail' || target === 'details') {
      return str === 'detail' || str === 'details' || str === 'case detail' || str === 'case details';
    }
    if (target === 'feed' || target === 'feeds' || target === 'chatter') {
      // 'Communication' is this label on some Case layouts (case 08637663):
      // the switch-back silently failed every run because this alias was
      // missing, leaving the Detail tab active during extraction — every
      // visibility-dependent check (isVisible, getBoundingClientRect) then
      // read a hidden feed as empty, under-capturing the case.
      return str === 'feed' || str === 'feeds' || str === 'chatter' || str === 'case feed' || str === 'collaborate' || str === 'communication';
    }
    return false;
  };

  // 1. Check if target is already active
  var activeTabs = deepQsa('[role="tab"][aria-selected="true"], .slds-is-active [role="tab"], .slds-tabs_default__item.slds-is-active a, [role="tab"].active, .slds-tabs_default__item.slds-is-active button');
  for (var i = 0; i < activeTabs.length; i++) {
    var t = txt(activeTabs[i]);
    var titleAttr = activeTabs[i].getAttribute('title') || '';
    var ariaLabel = activeTabs[i].getAttribute('aria-label') || '';
    var dataVal = activeTabs[i].getAttribute('data-tab-value') || activeTabs[i].getAttribute('data-tab-name') || '';
    if (matchesTarget(t) || matchesTarget(titleAttr) || matchesTarget(ariaLabel) || matchesTarget(dataVal)) {
      return { ok: true, alreadyActive: true, tab: target };
    }
  }

  // 2. Search for matching tab element
  var candidates = deepQsa('[role="tab"], [role="presentation"] a, .slds-tabs_default__item a, .slds-tabs_default__item button, [data-tab-value], [data-tab-name], lightning-tab-bar button, button, a');
  var match = null;
  for (var j = 0; j < candidates.length; j++) {
    var el = candidates[j];
    var elText = txt(el);
    var elTitle = el.getAttribute('title') || '';
    var elAriaLabel = el.getAttribute('aria-label') || '';
    var dataVal = el.getAttribute('data-tab-value') || el.getAttribute('data-tab-name') || '';

    if (matchesTarget(elText) || matchesTarget(elTitle) || matchesTarget(elAriaLabel) || matchesTarget(dataVal)) {
      match = el;
      break;
    }
  }

  if (match) {
    fire(match);
    return { ok: true, clicked: true, tab: target };
  }

  return { ok: false, reason: 'tab not found: ' + target };
})();
