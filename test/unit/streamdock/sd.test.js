import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { StreamDock } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/sd.js';
import { FrameDecoder, encodeTextFrame } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js';

function startMockServer(onClientText, { split = false } = {}) {
  const server = net.createServer((sock) => {
    const dec = new FrameDecoder();
    let up = false;
    sock.on('data', (chunk) => {
      if (!up) {
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(chunk.toString())[1].trim();
        const accept = createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        const firstPart =
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n';
        const secondPart =
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
        if (split) {
          sock.write(firstPart);
          setImmediate(() => {
            sock.write(secondPart);
            up = true;
            server.emit('ready', sock);
          });
        } else {
          sock.write(firstPart + secondPart);
          up = true;
          server.emit('ready', sock);
        }
        return;
      }
      for (const m of dec.push(chunk)) onClientText(m, sock);
    });
  });
  return server;
}

test('registers on connect and parses an inbound keyDown', async () => {
  const received = [];

  // Resolve with (text, sock) when a frame arrives; used to drive promise-based sync.
  let onClientText;
  const framePromise = () => new Promise((r) => { onClientText = (text, sock) => r({ text, sock }); });

  // Start waiting for the first frame (registerPlugin) before connecting.
  let nextFrame = framePromise();

  const server = startMockServer((text, sock) => {
    received.push(JSON.parse(text));
    if (onClientText) { const cb = onClientText; onClientText = null; cb(text, sock); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const sd = new StreamDock({ port, uuid: 'PLUGIN-UUID', registerEvent: 'registerPlugin' });

  // Promise that resolves once keyDown is delivered.
  let resolveKeyDown;
  const keyDownPromise = new Promise((r) => { resolveKeyDown = r; });
  const keyDowns = [];
  sd.on('keyDown', (ev) => { keyDowns.push(ev); resolveKeyDown(ev); });

  sd.connect();

  // Wait for the registerPlugin frame — this also gives us the connected socket.
  const { sock } = await nextFrame;

  assert.deepEqual(received[0], { event: 'registerPlugin', uuid: 'PLUGIN-UUID' });

  // Now test setImage with no state — assert state key is absent.
  nextFrame = framePromise();
  sd.setImage('CTXZ', 'data:image/png;base64,AAAA');
  await nextFrame;
  const setImageMsg = received.find((m) => m.event === 'setImage');
  assert.ok(setImageMsg, 'setImage frame should have been received');
  assert.equal(setImageMsg.context, 'CTXZ');
  assert.deepEqual(setImageMsg.payload.image, 'data:image/png;base64,AAAA');
  assert.ok(!('state' in setImageMsg.payload), 'state must be absent from setImage payload when not provided');

  // Send a keyDown from the server and await delivery.
  sock.write(encodeTextFrame(JSON.stringify({
    event: 'keyDown', action: 'com.cap.streamdock.dispatch', context: 'CTX1', payload: {},
  })));

  await keyDownPromise;
  assert.equal(keyDowns.length, 1);
  assert.equal(keyDowns[0].context, 'CTX1');

  // Clean up — destroy socket and close server.
  sock.destroy();
  await new Promise((r) => server.close(r));
});

test('registers when the HTTP 101 handshake is split across two writes', async () => {
  // The CLIENT accumulates the split 101 response across two TCP chunks before
  // completing the WebSocket handshake and sending the registerPlugin frame.
  const received = [];

  let onClientText;
  const framePromise = () => new Promise((r) => { onClientText = (text, sock) => r({ text, sock }); });
  let nextFrame = framePromise();

  const server = startMockServer((text, sock) => {
    received.push(JSON.parse(text));
    if (onClientText) { const cb = onClientText; onClientText = null; cb(text, sock); }
  }, { split: true });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const sd = new StreamDock({ port, uuid: 'SPLIT-UUID', registerEvent: 'registerPlugin' });

  let resolveKeyDown;
  const keyDownPromise = new Promise((r) => { resolveKeyDown = r; });
  const keyDowns = [];
  sd.on('keyDown', (ev) => { keyDowns.push(ev); resolveKeyDown(ev); });

  sd.connect();

  // Wait for the registerPlugin frame — confirms the client handled the split 101.
  const { sock } = await nextFrame;

  assert.deepEqual(received[0], { event: 'registerPlugin', uuid: 'SPLIT-UUID' });

  // Send a keyDown and await delivery.
  sock.write(encodeTextFrame(JSON.stringify({
    event: 'keyDown', action: 'com.cap.streamdock.dispatch', context: 'CTX2', payload: {},
  })));

  await keyDownPromise;
  assert.equal(keyDowns.length, 1);
  assert.equal(keyDowns[0].context, 'CTX2');

  // Clean up — destroy socket and close server.
  sock.destroy();
  await new Promise((r) => server.close(r));
});
