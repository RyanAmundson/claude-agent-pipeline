// claude-agent-pipeline — internal UI server entry for `ui --watch`.
//
// The watch supervisor (ui/watch.js) spawns this as a child process and kills
// it to trigger a restart. Config arrives via env so the supervisor never has
// to re-quote argv. Not a public CLI surface.

import { startServer } from './server.js';

const target = process.env.CAP_UI_TARGET;
const port = process.env.CAP_UI_PORT ? Number(process.env.CAP_UI_PORT) : undefined;
const host = process.env.CAP_UI_HOST || undefined;
const pluginRoot = process.env.CAP_UI_PLUGIN_ROOT || undefined;

const { url } = await startServer({ target, port, host, pluginRoot, devReload: true });
// One line per (re)start so the watch supervisor's inherited stdout shows life.
console.log(`  serving ${url}`);

// Graceful exit on the supervisor's SIGTERM so the port frees before respawn.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => process.exit(0));
}
