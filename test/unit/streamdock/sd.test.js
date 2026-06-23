import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { StreamDock } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/sd.js';
import { FrameDecoder, encodeTextFrame } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js';

function startMockServer(onClientText) {
  const server = net.createServer((sock) => {
    const dec = new FrameDecoder();
    let up = false;
    sock.on('data', (chunk) => {
      if (!up) {
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(chunk.toString())[1].trim();
        const accept = createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        up = true; server.emit('ready', sock);
        return;
      }
      for (const m of dec.push(chunk)) onClientText(m, sock);
    });
  });
  return server;
}

test('registers on connect and parses an inbound keyDown', async () => {
  const received = [];
  const server = startMockServer((text) => received.push(JSON.parse(text)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const sd = new StreamDock({ port, uuid: 'PLUGIN-UUID', registerEvent: 'registerPlugin' });
  const keyDowns = [];
  sd.on('keyDown', (ev) => keyDowns.push(ev));
  sd.connect();

  // Server pushes a keyDown frame once a client socket is ready.
  const sock = await new Promise((r) => server.once('ready', r));
  sock.write(encodeTextFrame(JSON.stringify({
    event: 'keyDown', action: 'com.cap.streamdock.dispatch', context: 'CTX1', payload: {},
  })));

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received[0], { event: 'registerPlugin', uuid: 'PLUGIN-UUID' });
  assert.equal(keyDowns.length, 1);
  assert.equal(keyDowns[0].context, 'CTX1');
  server.close();
});

test('registers when the HTTP 101 handshake is split across two writes', async () => {
  const received = [];
  const server = net.createServer((sock) => {
    const dec = new FrameDecoder();
    let up = false;
    sock.on('data', (chunk) => {
      if (!up) {
        const raw = chunk.toString();
        const keyMatch = /Sec-WebSocket-Key: (.+)\r\n/.exec(raw);
        if (!keyMatch) return; // still accumulating (shouldn't happen in practice)
        const key = keyMatch[1].trim();
        const accept = createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        // Split the 101 response across two writes
        const firstPart =
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n';
        const secondPart =
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
        sock.write(firstPart);
        setImmediate(() => {
          sock.write(secondPart);
          up = true;
          server.emit('ready', sock);
        });
        return;
      }
      for (const m of dec.push(chunk)) received.push(JSON.parse(m));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const sd = new StreamDock({ port, uuid: 'SPLIT-UUID', registerEvent: 'registerPlugin' });
  const keyDowns = [];
  sd.on('keyDown', (ev) => keyDowns.push(ev));
  sd.connect();

  const sock = await new Promise((r) => server.once('ready', r));
  // Give the client time to send the register frame after the 2nd write arrives
  await new Promise((r) => setTimeout(r, 50));
  sock.write(encodeTextFrame(JSON.stringify({
    event: 'keyDown', action: 'com.cap.streamdock.dispatch', context: 'CTX2', payload: {},
  })));

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received[0], { event: 'registerPlugin', uuid: 'SPLIT-UUID' });
  assert.equal(keyDowns.length, 1);
  assert.equal(keyDowns[0].context, 'CTX2');
  server.close();
});
