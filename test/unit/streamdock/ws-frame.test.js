import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTextFrame, FrameDecoder } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js';

test('decoder reassembles a fragmented text message across continuation frames', () => {
  // initial text frame: FIN=0, opcode 0x1 (text), len 3, "hel"
  const f1 = Buffer.from([0x01, 0x03, 0x68, 0x65, 0x6c]);
  // continuation frame: FIN=1, opcode 0x0 (continuation), len 2, "lo"
  const f2 = Buffer.from([0x80, 0x02, 0x6c, 0x6f]);
  const dec = new FrameDecoder();
  assert.deepEqual(dec.push(f1), []);        // not final yet — nothing emitted
  assert.deepEqual(dec.push(f2), ['hello']); // final continuation completes the message
});

test('decoder rejects an oversized advertised frame length', () => {
  // 64-bit length header advertising 64 MB (over the cap), payload not present
  const header = Buffer.alloc(10);
  header[0] = 0x81; header[1] = 127;
  header.writeBigUInt64BE(64n * 1024n * 1024n, 2);
  const dec = new FrameDecoder();
  assert.throws(() => dec.push(header), /too large/i);
});

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
