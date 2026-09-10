// cdp_client.mjs — Deep Module: Native WebSocket CDP client for Chrome DevTools Protocol.
// Zero third-party dependencies, built with standard Node.js (>=22.3.0) native WebSocket and fetch.

import { buildPayload } from './browser.mjs';

export class CdpError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CdpError';
    this.detail = detail;
  }
}

export class CdpClient {
  /**
   * @param {Object} options
   * @param {string} options.wsUrl
   * @param {string} [options.host='127.0.0.1']
   * @param {number} [options.port=9773]
   * @param {string} [options.targetId]
   */
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port || 9773);
    this.wsUrl = options.wsUrl || null;
    this.targetId = options.targetId || null;
    this.targetFilter = options.targetFilter || null;

    this.ws = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._eventListeners = new Map(); // eventName -> Set<Function>
    this._closed = false;
    this._connectingPromise = null;
    this._pageEnabled = false;
  }

  /**
   * Register a callback for CDP events (e.g. 'Page.loadEventFired', 'Page.frameNavigated').
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, new Set());
    }
    this._eventListeners.get(event).add(handler);
    return this;
  }

  /**
   * Remove an event listener.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    if (this._eventListeners.has(event)) {
      this._eventListeners.get(event).delete(handler);
    }
    return this;
  }

  /**
   * Register a one-time callback for a CDP event.
   * @param {string} event
   * @param {Function} handler
   */
  once(event, handler) {
    const wrapped = (params) => {
      this.off(event, wrapped);
      handler(params);
    };
    return this.on(event, wrapped);
  }

  /**
   * Connect to Chrome DevTools Protocol over native WebSocket.
   * Discovers available targets and attaches to the target page tab (or browser session).
   */
  static async connect(options = {}) {
    const host = options.host || '127.0.0.1';
    const port = Number(options.port || 9773);
    const timeout = options.timeout || 10000;

    let wsUrl = options.wsUrl;
    let targetId = null;

    if (!wsUrl) {
      const endpoint = `http://${host}:${port}`;
      let targets = [];
      try {
        const res = await fetch(`${endpoint}/json/list`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (res.ok) {
          targets = await res.json();
        }
      } catch {
        // Try /json fallback
        try {
          const res = await fetch(`${endpoint}/json`, {
            signal: AbortSignal.timeout(timeout),
          });
          if (res.ok) targets = await res.json();
        } catch {
          // Ignore
        }
      }

      // Filter target if targetFilter provided, else pick first 'page' or first available
      if (Array.isArray(targets) && targets.length > 0) {
        let chosen;
        if (options.targetFilter && typeof options.targetFilter === 'function') {
          chosen = targets.find(options.targetFilter);
        }
        if (!chosen) {
          chosen = targets.find(t => t.type === 'page') || targets[0];
        }
        if (chosen && chosen.webSocketDebuggerUrl) {
          wsUrl = chosen.webSocketDebuggerUrl;
          targetId = chosen.id;
        }
      }

      // If still no wsUrl, try /json/version
      if (!wsUrl) {
        try {
          const res = await fetch(`${endpoint}/json/version`, {
            signal: AbortSignal.timeout(timeout),
          });
          if (res.ok) {
            const ver = await res.json();
            wsUrl = ver.webSocketDebuggerUrl;
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!wsUrl) {
      throw new CdpError(`Unable to discover CDP WebSocket debugger URL at http://${host}:${port}`);
    }

    const client = new CdpClient({
      host,
      port,
      wsUrl,
      targetId,
      targetFilter: options.targetFilter,
    });

    await client._connectSocket(timeout);
    return client;
  }

  isConnected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN && !this._closed);
  }

  async _connectSocket(timeout = 10000) {
    if (this.isConnected()) return;
    if (this._connectingPromise) return this._connectingPromise;

    this._connectingPromise = new Promise((resolve, reject) => {
      let timer = null;
      try {
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        timer = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            try { ws.close(); } catch {}
            reject(new CdpError(`CDP WebSocket connection timeout to ${this.wsUrl}`));
          }
        }, timeout);

        ws.addEventListener('open', () => {
          clearTimeout(timer);
          this._closed = false;
          resolve();
        });

        ws.addEventListener('message', (event) => {
          this._handleMessage(event.data);
        });

        ws.addEventListener('close', () => {
          this._handleClose();
        });

        ws.addEventListener('error', (err) => {
          // If still connecting, reject
          clearTimeout(timer);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }).finally(() => {
      this._connectingPromise = null;
    });

    return this._connectingPromise;
  }

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      return;
    }

    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      clearTimeout(timer);
      this._pending.delete(msg.id);

      if (msg.error) {
        reject(new CdpError(`CDP command failed: ${msg.error.message}`, msg.error));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      // Event notification from CDP
      const listeners = this._eventListeners.get(msg.method);
      if (listeners && listeners.size > 0) {
        for (const handler of Array.from(listeners)) {
          try {
            handler(msg.params);
          } catch {}
        }
      }
    }
  }

  _handleClose() {
    // Reject any pending promises if socket closed
    for (const [id, { reject, timer }] of this._pending.entries()) {
      clearTimeout(timer);
      reject(new CdpError('CDP WebSocket connection closed'));
    }
    this._pending.clear();
  }

  /**
   * Send a JSON-RPC command over CDP.
   * Auto-reconnects if connection is currently closed.
   */
  async send(method, params = {}, { timeout = 30000 } = {}) {
    if (this._closed) {
      throw new CdpError('CdpClient is closed');
    }

    if (!this.isConnected()) {
      await this._connectSocket(timeout);
    }

    const id = this._nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CdpError(`CDP command ${method} timed out after ${timeout}ms`));
      }, timeout);

      this._pending.set(id, { resolve, reject, timer });

      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Navigate attached tab to specified URL and optionally wait for lifecycle events.
   * @param {string} url
   * @param {Object} [options]
   * @param {'load'|'domcontentloaded'|'none'} [options.waitUntil='load']
   * @param {number} [options.timeout=15000]
   */
  async navigate(url, { waitUntil = 'load', timeout = 15000 } = {}) {
    if (!this._pageEnabled) {
      try {
        await this.send('Page.enable');
        this._pageEnabled = true;
      } catch {}
    }

    if (waitUntil === 'none') {
      return this.send('Page.navigate', { url }, { timeout });
    }

    const eventName = waitUntil === 'domcontentloaded'
      ? 'Page.domContentEventFired'
      : 'Page.loadEventFired';

    let eventCleanup = null;
    let timer = null;

    const eventPromise = new Promise((resolve) => {
      const onEvent = () => resolve({ timedOut: false });
      this.once(eventName, onEvent);
      eventCleanup = () => this.off(eventName, onEvent);
      timer = setTimeout(() => {
        resolve({ timedOut: true });
      }, timeout);
    });

    try {
      const [navResult, eventResult] = await Promise.all([
        this.send('Page.navigate', { url }, { timeout }),
        eventPromise,
      ]);
      return { ...navResult, timedOut: eventResult.timedOut };
    } finally {
      if (timer) clearTimeout(timer);
      if (eventCleanup) eventCleanup();
    }
  }

  /**
   * Evaluate JavaScript expression in the page context with optional retry on context destruction.
   * @param {string} expression
   * @param {Record<string, any>} [vars] Injected variables (scoped inside IIFE)
   * @param {boolean|Object} [options=false] Either boolean awaitPromise or options object
   */
  async eval(expression, vars = {}, options = false) {
    let awaitPromise = false;
    let maxRetries = 0;
    let retryDelay = 100;

    if (typeof options === 'boolean') {
      awaitPromise = options;
    } else if (typeof options === 'object' && options !== null) {
      awaitPromise = Boolean(options.awaitPromise);
      maxRetries = Number(options.maxRetries ?? 0);
      retryDelay = Number(options.retryDelay ?? 100);
    }

    let payload = expression;
    if (Object.keys(vars).length > 0 || !payload.trim().startsWith('(function')) {
      payload = buildPayload(expression, vars);
    }

    let lastError = null;
    const totalAttempts = 1 + maxRetries;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        const res = await this.send('Runtime.evaluate', {
          expression: payload,
          returnByValue: true,
          awaitPromise,
        });

        if (res?.exceptionDetails) {
          throw new CdpError(
            `JS execution error: ${res.exceptionDetails.text || res.exceptionDetails.exception?.description || 'Evaluation error'}`,
            res.exceptionDetails
          );
        }

        return res?.result?.value;
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || '');
        const isContextDestruction =
          /Execution context was destroyed/i.test(msg) ||
          /Cannot find context with specified id/i.test(msg) ||
          /Inspected target navigated or closed/i.test(msg);

        if (isContextDestruction && attempt < totalAttempts - 1) {
          const delay = retryDelay * Math.pow(1.5, attempt);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Click an element matching selector by evaluating its center position and dispatching mouse events.
   * @param {string} selector
   */
  async click(selector) {
    const coords = await this.eval(`
      const el = document.querySelector(__SELECTOR);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `, { __SELECTOR: selector });

    if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') {
      return false;
    }

    const { x, y } = coords;

    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });

    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });

    return true;
  }

  /**
   * Capture a screenshot of the current page using CDP Page.captureScreenshot.
   * @param {Object} [options]
   * @param {string} [options.format='png'] 'png' | 'jpeg' | 'webp'
   * @param {number} [options.quality] Compression quality (0-100) for jpeg/webp
   * @param {boolean} [options.fullPage=true] Whether to capture beyond viewport
   * @param {Object} [options.clip] Viewport clip rectangle { x, y, width, height, scale }
   * @param {number} [options.timeout=15000] Command timeout in ms
   * @returns {Promise<Buffer>} The raw image buffer
   */
  async screenshot(options = {}) {
    if (!this._pageEnabled) {
      try {
        await this.send('Page.enable');
        this._pageEnabled = true;
      } catch {}
    }

    const {
      format = 'png',
      quality,
      fullPage = true,
      clip,
      timeout = 15000,
    } = options;

    const params = {
      format,
      ...(typeof quality === 'number' ? { quality } : {}),
      ...(clip ? { clip } : {}),
      ...(fullPage ? { captureBeyondViewport: true } : {}),
    };

    const res = await this.send('Page.captureScreenshot', params, { timeout });
    if (!res || !res.data) {
      throw new CdpError('Page.captureScreenshot returned no data');
    }

    return Buffer.from(res.data, 'base64');
  }

  /**
   * Close CDP WebSocket connection.
   */
  async close() {
    this._closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this._handleClose();
  }
}
