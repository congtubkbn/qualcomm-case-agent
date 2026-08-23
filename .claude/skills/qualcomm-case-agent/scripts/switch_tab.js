// scripts/switch_tab.js
//
// Switches active tab on Salesforce Lightning case page (e.g., between "Detail" and "Feed").
// Evaluated via agent-browser or CDP.
//
// Parameter: __TARGET_TAB (string: 'Detail' | 'Feed' | 'Details' etc.)
(function () {
  var target = (typeof __TARGET_TAB !== 'undefined' ? __TARGET_TAB : '').toLowerCase().trim();
  if (!target) return { ok: false, reason: 'no target tab specified' };

  var txt = function (el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  };
  var qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };
  var fire = function (el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
      try {
        var Ctor = (/^pointer/.test(type) && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
      } catch (e) { /* fallback */ }
    });
    el.click();
  };

  // 1. Check if target is already active
  var activeTabs = qsa('[role="tab"][aria-selected="true"], .slds-is-active [role="tab"], .slds-tabs_default__item.slds-is-active a, [role="tab"].active');
  for (var i = 0; i < activeTabs.length; i++) {
    var t = txt(activeTabs[i]).toLowerCase();
    var titleAttr = (activeTabs[i].getAttribute('title') || '').toLowerCase();
    if (
      t === target ||
      titleAttr === target ||
      (target === 'detail' && (t === 'details' || titleAttr === 'details')) ||
      (target === 'details' && (t === 'detail' || titleAttr === 'detail'))
    ) {
      return { ok: true, alreadyActive: true, tab: target };
    }
  }

  // 2. Search for matching tab element
  var candidates = qsa('[role="tab"], [role="presentation"] a, .slds-tabs_default__item a, [data-tab-value], [data-tab-name], button, a');
  var match = null;
  for (var j = 0; j < candidates.length; j++) {
    var el = candidates[j];
    var elText = txt(el).toLowerCase();
    var elTitle = (el.getAttribute('title') || '').toLowerCase();
    var dataVal = (el.getAttribute('data-tab-value') || el.getAttribute('data-tab-name') || '').toLowerCase();

    if (
      elText === target ||
      elTitle === target ||
      dataVal === target ||
      (target === 'detail' && (elText === 'details' || elTitle === 'details' || dataVal === 'details')) ||
      (target === 'details' && (elText === 'detail' || elTitle === 'detail' || dataVal === 'detail'))
    ) {
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
