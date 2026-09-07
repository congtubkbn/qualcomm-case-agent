// scripts/observe_case_state.js
//
// In-page script that evaluates page state or uses MutationObserver to wait for
// ON_CASE / AUTH after a navigation or click.
//
// Parameters (injected by caller / buildPayload):
//   __CODE     (string, optional) - case code (unused, kept for parity with search probe)
//   __TIMEOUT  (number, optional) - max wait timeout in ms (default 15000)
//
// Returns:
//   { state: 'ON_CASE', href: string }
//   | { state: 'AUTH', url: string }
//   | { state: 'TIMEOUT', href: string }

(function() {
  var timeout = typeof __TIMEOUT !== 'undefined' ? __TIMEOUT : 15000;
  var code = typeof __CODE !== 'undefined' ? String(__CODE) : '';

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
    }, timeout);

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
})()
