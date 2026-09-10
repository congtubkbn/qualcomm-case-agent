// tests/mocks/cdp_server.mjs
// Lightweight, zero-dependency Mock CDP Server using Node.js native http and crypto.
// Implements RFC 6455 WebSocket framing and basic Chrome DevTools Protocol JSON-RPC endpoints.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Creates a lightweight Mock CDP Server.
 * @param {Object} [options]
 * @param {number} [options.port=0] Port to listen on (0 for random available port)
 * @param {Function} [options.onMessage] Custom message handler `(msg, ws) => reply`
 */
export async function createMockCdpServer(options = {}) {
  const emitter = new EventEmitter();
  const connections = new Set();
  let server;
  let customHandler = options.onMessage || null;

  // Frame parser for client -> server (masked frames)
  function decodeClientFrame(buffer) {
    if (buffer.length < 2) return null;
    const fin = (buffer[0] & 0x80) === 0x80;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) === 0x80;
    let payloadLen = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buffer.length < 4) return null;
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buffer.length < 10) return null;
      payloadLen = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    let maskKey = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + payloadLen) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    return {
      opcode,
      payload,
      totalLength: offset + payloadLen,
    };
  }

  // Frame encoder for server -> client (unmasked frames)
  function encodeServerFrame(text, opcode = 0x01) {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;
    let header;

    if (length <= 125) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, payload]);
  }

  server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/json/version') {
      const port = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'Chrome/130.0.0.0 Mock',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock-browser-id`,
      }));
      return;
    }

    if (url.pathname === '/json' || url.pathname === '/json/list') {
      const port = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 'page-mock-1',
          type: 'page',
          title: 'Qualcomm Support',
          url: 'https://support.qualcomm.com/s/',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-mock-1`,
        },
      ]));
      return;
    }

    if (url.pathname === '/json/new' || url.pathname.startsWith('/json/new')) {
      const port = server.address().port;
      const targetUrl = url.search ? decodeURIComponent(url.search.slice(1)) : 'about:blank';
      const targetId = `page-mock-new-${Date.now()}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: targetId,
        type: 'page',
        title: 'Qualcomm Support',
        url: targetUrl,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}`,
      }));
      return;
    }

    if (url.pathname.startsWith('/json/activate/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Target activated');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ];

    socket.write(headers.join('\r\n'));

    const ws = {
      socket,
      send(data) {
        if (!socket.destroyed) {
          const str = typeof data === 'string' ? data : JSON.stringify(data);
          socket.write(encodeServerFrame(str));
        }
      },
      close() {
        if (!socket.destroyed) {
          socket.write(Buffer.from([0x88, 0x00])); // WS Close frame
          socket.end();
        }
      },
    };

    connections.add(ws);
    emitter.emit('connection', ws, req.url);

    let incomingBuffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      incomingBuffer = Buffer.concat([incomingBuffer, chunk]);

      while (incomingBuffer.length > 0) {
        const frame = decodeClientFrame(incomingBuffer);
        if (!frame) break;

        incomingBuffer = incomingBuffer.subarray(frame.totalLength);

        if (frame.opcode === 0x08) {
          // Close frame
          ws.close();
          connections.delete(ws);
          break;
        } else if (frame.opcode === 0x09) {
          // Ping -> Pong
          socket.write(encodeServerFrame('', 0x0a));
        } else if (frame.opcode === 0x01) {
          // Text frame
          try {
            const rawText = frame.payload.toString('utf8');
            const msg = JSON.parse(rawText);
            emitter.emit('message', msg, ws);

            let suppressLoadEvent = false;
            if (customHandler) {
              const reply = customHandler(msg, ws);
              if (reply !== undefined && reply !== null) {
                if (reply.suppressLoadEvent) suppressLoadEvent = true;
                ws.send(reply);
              }
            } else {
              // Default CDP mock responses
              handleDefaultCdp(msg, ws);
            }

            if (msg.method === 'Page.navigate' && !suppressLoadEvent) {
              setTimeout(() => {
                try {
                  ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: Date.now() / 1000 } }));
                } catch {}
              }, 1);
            }
          } catch (err) {
            emitter.emit('error', err);
          }
        }
      }
    });

    socket.on('close', () => {
      connections.delete(ws);
      emitter.emit('disconnection', ws);
    });

    socket.on('error', (err) => {
      connections.delete(ws);
      emitter.emit('clientError', err);
    });
  });

  function handleDefaultCdp(msg, ws) {
    const { id, method, params } = msg;
    if (method === 'Page.navigate') {
      ws.send({ id, result: { frameId: 'MOCK_FRAME_1', loaderId: 'MOCK_LOADER_1' } });
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: Date.now() / 1000 } }));
        } catch {}
      }, 1);
    } else if (method === 'Runtime.evaluate') {
      let value = null;
      if (params?.expression?.includes('location.href')) {
        value = 'https://support.qualcomm.com/s/case/08603854';
      } else if (params?.expression?.includes('return 42')) {
        value = 42;
      } else {
        value = { state: 'READY' };
      }
      ws.send({
        id,
        result: {
          result: {
            type: typeof value,
            value: value,
          },
        },
      });
    } else if (method === 'Input.dispatchMouseEvent') {
      ws.send({ id, result: {} });
    } else if (method === 'Page.enable' || method === 'Runtime.enable' || method === 'DOM.enable') {
      ws.send({ id, result: {} });
    } else if (method === 'Page.captureScreenshot') {
      const mockPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      ws.send({ id, result: { data: mockPngBase64 } });
    } else {
      ws.send({ id, result: {} });
    }
  }

  await new Promise((resolve) => {
    server.listen(options.port || 0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = address.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock-browser-id`,
    setHandler(fn) { customHandler = fn; },
    closeAllClients() {
      for (const ws of connections) {
        ws.close();
      }
    },
    async close() {
      for (const ws of connections) {
        ws.close();
      }
      await new Promise((resolve) => server.close(resolve));
    },
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
}
