import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect } from './ws-client.js';

// Stream Dock launches us with: -port N -pluginUUID U -registerEvent E -info JSON
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^-+/, '')] = argv[i + 1];
  return a;
}

const args = parseArgs(process.argv.slice(2));
const logPath = join(homedir(), '.cap', 'streamdock-events.log');

const ws = connect({
  port: Number(args.port),
  onOpen() {
    ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
    appendFileSync(logPath, `[open] registered ${args.pluginUUID}\n`);
  },
  onMessage(text) {
    appendFileSync(logPath, text + '\n');   // capture every event verbatim
  },
});
