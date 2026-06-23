import { randomBytes } from 'node:crypto';

// Encode a single final text frame from client → server (RFC6455 requires masking).
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

const MAX_FRAME = 16 * 1024 * 1024; // 16 MB sanity cap for loopback device traffic

// Incrementally decode server → client frames. Server frames are unmasked.
// Handles fragmentation across chunks; returns completed text messages.
export class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) === 0x80;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        len = Number(this.buf.readBigUInt64BE(2)); offset = 10;
      }
      if (len > MAX_FRAME) throw new RangeError(`ws frame too large: ${len}`);
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) break;
      let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i & 3];
        payload = copy;
      }
      this.buf = this.buf.subarray(offset + maskLen + len);
      if (opcode === 0x1 || opcode === 0x0) {
        // text frame or continuation frame — accumulate fragments
        this.fragments.push(Buffer.from(payload));
        if (fin) {
          out.push(Buffer.concat(this.fragments).toString('utf8'));
          this.fragments = [];
        }
      }
      // opcode 0x8 (close) / 0x9 (ping) / 0xA (pong) ignored for our local use
      // (control frames must NOT touch this.fragments — they may interleave fragments)
    }
    return out;
  }
}
