import { StreamDock } from './sd.js';
import { registerDispatchAction } from './actions/dispatch.js';
import { registerPickerAction } from './actions/picker.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^-+/, '')] = argv[i + 1];
  return a;
}

const args = parseArgs(process.argv.slice(2));
const sd = new StreamDock({
  port: Number(args.port), uuid: args.pluginUUID, registerEvent: args.registerEvent,
});
registerDispatchAction(sd);
registerPickerAction(sd);
sd.connect();
