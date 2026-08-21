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
   * @param {number} [options.port=9222]
   * @param {string} [options.targetId]
   */
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port || 9222);
    this.wsUrl = options.wsUrl || null;
    this.targetId = options.targetId || null;
    this.targetFilter = options.targetFilter || null;

    this.ws = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._closed = false;
    this._connectingPromise = null;
  }

  /**
   * Connect to Chrome DevTools Protocol over native WebSocket.
   * Discovers available targets and attaches to the target page tab (or browser session).
   */
  static async connect(options = {}) {
    const host = options.host || '127.0.0.1';
    const port = Number(options.port || 9222);
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
   * Navigate attached tab to specified URL.
   */
  async navigate(url) {
    return this.send('Page.navigate', { url });
  }

  /**
   * Evaluate JavaScript expression in the page context.
   * @param {string} expression
   * @param {Record<string, any>} [vars] Injected variables (scoped inside IIFE)
   * @param {boolean} [awaitPromise=false]
   */
  async eval(expression, vars = {}, awaitPromise = false) {
    let payload = expression;
    if (Object.keys(vars).length > 0 || !payload.trim().startsWith('(function')) {
      payload = buildPayload(expression, vars);
    }

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
