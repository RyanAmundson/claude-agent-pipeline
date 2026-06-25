import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { encodeTextFrame, FrameDecoder } from './ws-frame.js';

export function connect({ port, onOpen, onMessage, onClose }) {
  const key = randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  const decoder = new FrameDecoder();
  let upgraded = false;
  let headerBuf = Buffer.alloc(0);

  sock.on('connect', () => {
    sock.write(
      `GET / HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`
    );
  });

  sock.on('data', (chunk) => {
    if (!upgraded) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const headerEnd = headerBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      upgraded = true;
      onOpen && onOpen();
      const rest = headerBuf.subarray(headerEnd + 4);
      headerBuf = Buffer.alloc(0);
      if (rest.length) for (const m of decoder.push(rest)) onMessage(m);
      return;
    }
    for (const m of decoder.push(chunk)) onMessage(m);
  });

  sock.on('close', () => onClose && onClose());
  sock.on('error', () => onClose && onClose());

  return {
    send(text) { sock.write(encodeTextFrame(text)); },
    close() { sock.end(); },
  };
}
