import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTextFrame, FrameDecoder } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js';

test('client text frame sets FIN+text opcode and mask bit', () => {
  const buf = encodeTextFrame('hi');
  assert.equal(buf[0], 0x81);            // FIN + opcode 0x1 (text)
  assert.equal(buf[1] & 0x80, 0x80);     // MASK bit set
  assert.equal(buf[1] & 0x7f, 2);        // payload length 2
  assert.equal(buf.length, 2 + 4 + 2);   // header + mask key + payload
});

test('decoder reassembles an unmasked server text frame', () => {
  // Server frame: FIN+text, len 5, no mask, payload "hello"
  const server = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  const dec = new FrameDecoder();
  assert.deepEqual(dec.push(server), ['hello']);
});

test('decoder handles a 16-bit extended length and split chunks', () => {
  const payload = 'x'.repeat(200);
  const header = Buffer.from([0x81, 126, 0x00, 0xc8]); // 126 => 16-bit, 0x00c8 = 200
  const full = Buffer.concat([header, Buffer.from(payload)]);
  const dec = new FrameDecoder();
  assert.deepEqual(dec.push(full.subarray(0, 50)), []);          // partial: nothing yet
  assert.deepEqual(dec.push(full.subarray(50)), [payload]);      // rest completes it
});
