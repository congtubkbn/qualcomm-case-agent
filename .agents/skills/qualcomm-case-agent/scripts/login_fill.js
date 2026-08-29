// scripts/login_fill.js
//
// In-page script that drives Okta username & password fill steps
// and classifies the outcome: AUTHENTICATED, OTP_REQUIRED, REJECTED, or UNKNOWN.
//
// Parameters (injected by caller / buildPayload):
//   __PASSWORD  (string, required) - plaintext password
//   __USERNAME  (string, optional) - username (default 'the.thoi@samsung.com')
//   __TIMEOUT   (number, optional) - max wait timeout in ms (default 10000)
//
// Returns:
//   { outcome: 'AUTHENTICATED' | 'OTP_REQUIRED' | 'REJECTED' | 'UNKNOWN', reason?: string }

(function () {
  var password = (typeof __PASSWORD !== 'undefined') ? String(__PASSWORD) : '';
  var username = (typeof __USERNAME !== 'undefined' && __USERNAME) ? String(__USERNAME) : 'the.thoi@samsung.com';
  var timeout = (typeof __TIMEOUT !== 'undefined') ? Number(__TIMEOUT) : 10000;

  var txt = function (el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  };

  var qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function isHostAuthenticated() {
    return location.hostname === 'support.qualcomm.com' ||
      (location.hostname !== 'account.qualcomm.com' && !/login|auth|okta/i.test(location.pathname));
  }

  function checkError() {
    var errorEls = qsa('.okta-form-infobox-error, .infobox-error, [role="alert"], .okta-form-input-error, .error-summary, .o-form-error-container');
    for (var i = 0; i < errorEls.length; i++) {
      var errText = txt(errorEls[i]);
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
    var otpInputs = qsa('input[name="credentials.passcode"][pattern*="0-9"], input[name="otp-code"], input[name="answer"], input[name="credentials.passcode"][inputmode="numeric"]');
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

  // Check initial state
  var initial = classifyCurrentState();
  if (initial) {
    return Promise.resolve(initial);
  }

  if (!password) {
    return Promise.resolve({ outcome: 'UNKNOWN', reason: 'No password provided to fill script' });
  }

  return new Promise(function (resolve) {
    var deadline = Date.now() + timeout;
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

      // Check for password field first (if present on screen)
      var pwInput = document.querySelector('input[type="password"], input[name="credentials.passcode"], input[name="password"]');
      if (pwInput && !hasSubmittedPassword) {
        fillInput(pwInput, password);
        var clickedPw = clickSubmit(pwInput.form);
        if (!clickedPw) clickSubmit();
        hasSubmittedPassword = true;
        setTimeout(step, 800);
        return;
      }

      // If no password field yet, check for username field
      var userInput = document.querySelector('input[name="identifier"], input[name="username"], #okta-signin-username, input[autocomplete="username"]');
      if (userInput && !pwInput) {
        if (!userInput.value || userInput.value.trim() !== username) {
          fillInput(userInput, username);
        }
        var clickedUser = clickSubmit(userInput.form);
        if (!clickedUser) clickSubmit();
        setTimeout(step, 800);
        return;
      }

      // If password was submitted and we are waiting for classification
      if (hasSubmittedPassword) {
        setTimeout(step, 500);
        return;
      }

      // Neither username nor password input found
      setTimeout(step, 500);
    }

    step();
  });
})()
