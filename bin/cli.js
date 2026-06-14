#!/usr/bin/env node
// claude-agent-pipeline CLI — install agents, rules, and commands into a target project.
// No runtime dependencies. Node >= 18.

import { existsSync, mkdirSync, readFileSync, statSync, lstatSync, unlinkSync, symlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync, spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..');
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'manifest.json'), 'utf8'));
const PKG = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));

// Pipe-safe stdout: silently exit on EPIPE so `... --json | head` etc. don't crash.
process.stdout.on('error', err => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

const HELP = `claude-agent-pipeline v${PKG.version}

Usage:
  agent-pipeline install <target> [options]   Install agents/rules/commands into a project
  agent-pipeline list-agents [--target <p>]   List agents and dep status (target optional)
  agent-pipeline list-presets                 List rule presets
  agent-pipeline detect [--target <p>]        Detect available deps in target environment
  agent-pipeline ui [--target <p>] [--port N] [--open]
                                              Launch the local pipeline dashboard
  agent-pipeline status [--target <p>] [--json] [--state <name>]
                                              Print pipeline snapshot (queued + active tickets)
  agent-pipeline ticket <id> [--target <p>] [--json]
                                              Show a single ticket
  agent-pipeline comment <id> --body "..." [--verdict pass|fail] [--target <p>]
                                              Append a human comment to a ticket (filesystem backend)
  agent-pipeline agent <name> [--target <p>] [--json]
                                              Show an agent + its current activity
  agent-pipeline events [--target <p>] [--json]
                                              Subscribe to live pipeline events (JSONL on stdout)
  agent-pipeline run <agent> --prompt "..." [--target <p>] [--wait|--detach] [--json]
                                              Dispatch a single agent run (default: stream JSONL)
  agent-pipeline runs [list] [--target <p>] [--json]
                                              List active + recent agent runs
  agent-pipeline runs <runId> [--target <p>] [--wait|--follow] [--json]
                                              Show a single run; --wait blocks until completion; --follow live-tails its events
  agent-pipeline runs <runId> events [--target <p>] [--json]
                                              Dump the captured events log for a single run
  agent-pipeline runs events [--target <p>] [--json]
                                              Subscribe to run-only events (JSONL on stdout)
  agent-pipeline runs kill <runId> [--target <p>]
                                              Send SIGTERM to a running agent run
  agent-pipeline cycle report --data '<json>' [--target <p>]
                                              Record an orchestrator cycle + print the formatted status block
  agent-pipeline watch [--target <p>]         Live terminal dashboard (TUI) of queue, runs, and cycles
  agent-pipeline version                      Print version

Install options:
  --mode <symlink|copy>          Symlink (default) for live updates, or copy for detached install
  --preset <name>                Rules preset (default: minimal). See \`list-presets\`.
  --omit-rule <file>             Skip a specific rule file (repeatable)
  --omit-agent <name>            Skip a specific agent (repeatable)
  --all                          Install every agent regardless of dep detection
  --with <dep>                   Force-enable a dep (repeatable). Deps: ${Object.keys(MANIFEST.deps).join(', ')}
  --without <dep>                Force-disable a dep (repeatable)
  --dry-run                      Print what would be installed; make no changes
  --quiet                        Suppress per-file output

Examples:
  agent-pipeline install ~/Code/my-app
  agent-pipeline install ~/Code/my-app --preset typescript-react
  agent-pipeline install ~/Code/my-app --mode copy --all
  agent-pipeline install ~/Code/my-app --without linear --omit-agent declarative-refactor-specialist
`;

function die(msg, code = 1) { console.error(msg); process.exit(code); }

function parseFlags(args) {
  const flags = {
    mode: 'symlink', preset: 'minimal', omitRule: [], omitAgent: [], all: false,
    with: [], without: [], dryRun: false, quiet: false, target: null,
    port: null, open: false, json: false, state: null,
    prompt: null, wait: false, detach: false, stream: false, follow: false, runId: null,
    allowedTools: [], disallowedTools: [], maxBudgetUsd: null, model: null,
    body: null, verdict: null, author: null, data: null,
  };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '-h': case '--help': console.log(HELP); process.exit(0);
      case '--mode': flags.mode = args[++i]; break;
      case '--preset': flags.preset = args[++i]; break;
      case '--omit-rule': flags.omitRule.push(args[++i]); break;
      case '--omit-agent': flags.omitAgent.push(args[++i]); break;
      case '--all': flags.all = true; break;
      case '--with': flags.with.push(args[++i]); break;
      case '--without': flags.without.push(args[++i]); break;
      case '--target': flags.target = args[++i]; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--quiet': flags.quiet = true; break;
      case '--port': flags.port = Number(args[++i]); break;
      case '--open': flags.open = true; break;
      case '--json': flags.json = true; break;
      case '--state': flags.state = args[++i]; break;
      case '--prompt': flags.prompt = args[++i]; break;
      case '--wait': flags.wait = true; break;
      case '--detach': flags.detach = true; break;
      case '--stream': flags.stream = true; break;
      case '--follow': case '-f': flags.follow = true; break;
      case '--run-id': flags.runId = args[++i]; break;
      case '--allowed-tools':
      case '--allowedTools': flags.allowedTools.push(...args[++i].split(/[\s,]+/).filter(Boolean)); break;
      case '--disallowed-tools':
      case '--disallowedTools': flags.disallowedTools.push(...args[++i].split(/[\s,]+/).filter(Boolean)); break;
      case '--max-budget-usd': flags.maxBudgetUsd = Number(args[++i]); break;
      case '--model': flags.model = args[++i]; break;
      case '--body': flags.body = args[++i]; break;
      case '--verdict': flags.verdict = args[++i]; break;
      case '--author': flags.author = args[++i]; break;
      case '--data': flags.data = args[++i]; break;
      default:
        if (a.startsWith('--')) die(`Unknown flag: ${a}\n\n${HELP}`);
        positional.push(a);
    }
  }
  if (!['symlink', 'copy'].includes(flags.mode)) die(`Invalid --mode: ${flags.mode}`);
  if (!MANIFEST.presets[flags.preset]) die(`Unknown preset '${flags.preset}'. Available: ${Object.keys(MANIFEST.presets).join(', ')}`);
  for (const d of [...flags.with, ...flags.without]) {
    if (!MANIFEST.deps[d]) die(`Unknown dep '${d}'. Known: ${Object.keys(MANIFEST.deps).join(', ')}`);
  }
  if (flags.port != null && (!Number.isInteger(flags.port) || flags.port < 0 || flags.port > 65535)) {
    die(`Invalid --port: ${flags.port}`);
  }
  return { flags, positional };
}

function detectDeps(target, overrides = { with: [], without: [] }) {
  const detected = {};
  for (const [name, spec] of Object.entries(MANIFEST.deps)) {
    if (overrides.with.includes(name)) { detected[name] = { available: true, source: '--with' }; continue; }
    if (overrides.without.includes(name)) { detected[name] = { available: false, source: '--without' }; continue; }

    if (spec.detect === 'manual') {
      detected[name] = { available: false, source: 'manual (use --with to enable)' };
    } else if (spec.detect === 'package-json') {
      const pkgPath = join(target, 'package.json');
      let available = false;
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          available = Boolean(deps[spec.packageName]);
        } catch {}
      }
      detected[name] = { available, source: available ? `package.json:${spec.packageName}` : 'package.json (not found)' };
    } else if (spec.detect && spec.detect.startsWith('command -v ')) {
      try { execSync(spec.detect, { stdio: 'ignore' }); detected[name] = { available: true, source: 'PATH' }; }
      catch { detected[name] = { available: false, source: 'PATH (not found)' }; }
    } else {
      detected[name] = { available: false, source: 'unknown' };
    }
  }
  return detected;
}

function agentSatisfied(agentSpec, detected, all) {
  if (all) return { ok: true, missing: [] };
  const required = agentSpec.requires || [];
  const missing = required.filter(d => !detected[d] || !detected[d].available);
  return { ok: missing.length === 0, missing };
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

function installFile(srcAbs, destAbs, mode, label, opts) {
  const { dryRun, quiet } = opts;
  let action = 'install';
  let exists = false;
  try { exists = lstatSync(destAbs); } catch {}
  if (exists) {
    if (exists.isSymbolicLink()) {
      action = 'replace-symlink';
    } else {
      if (!quiet) console.log(`  [skip] ${label} (target exists, not a symlink — leaving untouched)`);
      return { installed: false, skipped: true };
    }
  }
  if (dryRun) { if (!quiet) console.log(`  [dry] ${action}: ${label}`); return { installed: true, skipped: false }; }
  ensureDir(dirname(destAbs));
  if (exists) unlinkSync(destAbs);
  if (mode === 'symlink') symlinkSync(srcAbs, destAbs);
  else copyFileSync(srcAbs, destAbs);
  if (!quiet) console.log(`  [${mode}] ${label}`);
  return { installed: true, skipped: false };
}

function listAgents(targetArg, withFlags = [], withoutFlags = []) {
  const target = targetArg ? resolve(targetArg) : process.cwd();
  const detected = detectDeps(target, { with: withFlags, without: withoutFlags });
  console.log(`\nDeps detected in ${target}:`);
  for (const [name, info] of Object.entries(detected)) {
    console.log(`  ${info.available ? '✓' : '✗'} ${name.padEnd(18)} (${info.source})`);
  }
  console.log(`\nAgents (${Object.keys(MANIFEST.agents).length}):\n`);
  const byStage = {};
  for (const [name, spec] of Object.entries(MANIFEST.agents)) {
    (byStage[spec.stage] ||= []).push([name, spec]);
  }
  for (const stage of Object.keys(byStage)) {
    console.log(`  ${stage}`);
    for (const [name, spec] of byStage[stage]) {
      const { ok, missing } = agentSatisfied(spec, detected, false);
      const status = ok ? '✓' : '✗';
      const reqs = (spec.requires || []).join(',') || '—';
      const opt = (spec.optional || []).length ? ` (opt: ${spec.optional.join(',')})` : '';
      const miss = missing.length ? `  needs: ${missing.join(',')}` : '';
      console.log(`    ${status} ${name.padEnd(34)} requires: ${reqs}${opt}${miss}`);
    }
  }
}

function listPresets() {
  console.log(`\nRule presets:\n`);
  for (const [name, spec] of Object.entries(MANIFEST.presets)) {
    console.log(`  ${name}`);
    console.log(`    ${spec.description}`);
    console.log(`    Rules: ${spec.rules.length}`);
  }
  console.log();
}

function install(positional, flags) {
  if (positional.length !== 1) die(`Usage: agent-pipeline install <target> [options]\n\n${HELP}`);
  const target = resolve(positional[0]);
  if (!existsSync(target)) die(`Target not found: ${target}`);
  if (!statSync(target).isDirectory()) die(`Target is not a directory: ${target}`);
  if (!existsSync(join(target, '.git'))) console.warn(`Warning: ${target} is not a git repo. Continuing anyway.`);

  const detected = detectDeps(target, { with: flags.with, without: flags.without });
  const claudeDir = join(target, '.claude');

  console.log(`Installing claude-agent-pipeline v${PKG.version} (${flags.mode}) into ${claudeDir}`);
  console.log(`  Plugin source: ${PLUGIN_ROOT}`);
  console.log(`  Preset:        ${flags.preset}`);
  console.log(`  Mode:          ${flags.mode}${flags.dryRun ? ' (dry-run)' : ''}`);
  console.log();
  console.log(`  Deps:`);
  for (const [name, info] of Object.entries(detected)) {
    const flag = flags.with.includes(name) ? ' [--with]' : flags.without.includes(name) ? ' [--without]' : '';
    console.log(`    ${info.available ? '✓' : '✗'} ${name.padEnd(18)} ${info.source}${flag}`);
  }
  console.log();

  // Agents
  console.log(`  Agents:`);
  let agentInstalled = 0, agentSkippedDeps = 0, agentSkippedExisting = 0, agentOmitted = 0;
  for (const [name, spec] of Object.entries(MANIFEST.agents)) {
    if (flags.omitAgent.includes(name)) { agentOmitted++; if (!flags.quiet) console.log(`    [omit] ${name}`); continue; }
    const { ok, missing } = agentSatisfied(spec, detected, flags.all);
    if (!ok) {
      agentSkippedDeps++;
      if (!flags.quiet) console.log(`    [skip-dep] ${name.padEnd(34)} missing: ${missing.join(',')}`);
      continue;
    }
    const src = join(PLUGIN_ROOT, 'agents', `${name}.md`);
    const dest = join(claudeDir, 'agents', `${name}.md`);
    const r = installFile(src, dest, flags.mode, `agents/${name}.md`, flags);
    if (r.installed) agentInstalled++; else if (r.skipped) agentSkippedExisting++;
  }
  // ORCHESTRATION.md is a doc, not an agent — install it if any agent installed
  if (agentInstalled > 0) {
    const src = join(PLUGIN_ROOT, 'agents', 'ORCHESTRATION.md');
    const dest = join(claudeDir, 'agents', 'ORCHESTRATION.md');
    if (existsSync(src)) installFile(src, dest, flags.mode, 'agents/ORCHESTRATION.md', flags);
  }
  console.log(`    → ${agentInstalled} installed, ${agentSkippedDeps} skipped-dep, ${agentSkippedExisting} skipped-existing, ${agentOmitted} omitted`);

  // Rules (preset-driven)
  const presetSpec = MANIFEST.presets[flags.preset];
  console.log(`  Rules (preset: ${flags.preset}):`);
  let ruleInstalled = 0, ruleSkippedExisting = 0, ruleOmitted = 0;
  for (const rel of presetSpec.rules) {
    const fileBase = basename(rel);
    if (flags.omitRule.includes(fileBase) || flags.omitRule.includes(rel)) {
      ruleOmitted++; if (!flags.quiet) console.log(`    [omit] rules/${fileBase}`); continue;
    }
    const src = join(PLUGIN_ROOT, 'rules', rel);
    if (!existsSync(src)) { console.warn(`    [warn] preset rule missing in package: ${rel}`); continue; }
    // Flatten preset paths into rules/<basename> so the host project sees them as siblings.
    const dest = join(claudeDir, 'rules', fileBase);
    const r = installFile(src, dest, flags.mode, `rules/${fileBase}`, flags);
    if (r.installed) ruleInstalled++; else if (r.skipped) ruleSkippedExisting++;
  }
  console.log(`    → ${ruleInstalled} installed, ${ruleSkippedExisting} skipped-existing, ${ruleOmitted} omitted`);

  // Commands
  console.log(`  Commands:`);
  let cmdInstalled = 0, cmdSkippedExisting = 0;
  const cmdsDir = join(PLUGIN_ROOT, 'commands');
  if (existsSync(cmdsDir)) {
    for (const f of readdirSync(cmdsDir)) {
      if (!f.endsWith('.md')) continue;
      const src = join(cmdsDir, f);
      const dest = join(claudeDir, 'commands', f);
      const r = installFile(src, dest, flags.mode, `commands/${f}`, flags);
      if (r.installed) cmdInstalled++; else if (r.skipped) cmdSkippedExisting++;
    }
  }
  console.log(`    → ${cmdInstalled} installed, ${cmdSkippedExisting} skipped-existing`);

  console.log();
  if (!existsSync(join(target, '.pipeline', 'config.json'))) {
    console.log(`Next: open ${target} in Claude Code and run /pipeline init to write .pipeline/config.json.`);
  } else {
    console.log(`Found existing .pipeline/config.json — no init needed.`);
  }
  if (flags.mode === 'symlink') {
    console.log(`Symlink mode: \`git pull\` in ${PLUGIN_ROOT} updates this project automatically.`);
  }
  console.log(`\nDone${flags.dryRun ? ' (dry-run, no files written)' : ''}.`);
}

// ─── dispatch ───────────────────────────────────────────────────────────────

if (!cmd || ['-h', '--help', 'help'].includes(cmd)) { console.log(HELP); process.exit(0); }
if (cmd === 'version' || cmd === '-v' || cmd === '--version') { console.log(PKG.version); process.exit(0); }

const { flags, positional } = parseFlags(rest);

switch (cmd) {
  case 'install': install(positional, flags); break;
  case 'list-agents': listAgents(flags.target, flags.with, flags.without); break;
  case 'list-presets': listPresets(); break;
  case 'detect': {
    const target = flags.target ? resolve(flags.target) : process.cwd();
    const d = detectDeps(target, { with: flags.with, without: flags.without });
    for (const [name, info] of Object.entries(d)) console.log(`${info.available ? '✓' : '✗'} ${name.padEnd(18)} ${info.source}`);
    break;
  }
  case 'ui':     runUi(flags); break;
  case 'status': runStatus(positional, flags); break;
  case 'ticket': runTicket(positional, flags); break;
  case 'comment': runComment(positional, flags); break;
  case 'agent':  runAgent(positional, flags); break;
  case 'events': runEvents(flags); break;
  case 'run':    runRun(positional, flags); break;
  case 'runs':   runRuns(positional, flags); break;
  case 'cycle':  runCycle(positional, flags); break;
  case 'orchestrator': runOrchestrator(positional, flags); break;
  case 'watch':  runWatchCmd(flags); break;
  case '_supervise': runSupervise(positional, flags); break;  // internal: detached supervisor
  case '_orchestrate-supervise': runOrchestrateSupervise(flags); break;  // internal: detached orchestrator supervisor
  default: die(`Unknown command: ${cmd}\n\n${HELP}`);
}

// ─── observability subcommands (ui / status / ticket / agent / events) ─────

function targetOf(flags) {
  return flags.target ? resolve(flags.target) : process.cwd();
}

function resolveQueueDir(target) {
  // Default matches config.schema.json filesystem.queueDir default.
  let queueDir = '.pipeline/queue';
  const cfgPath = join(target, '.pipeline', 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.filesystem?.queueDir) queueDir = cfg.filesystem.queueDir;
    } catch (err) {
      // Config exists but is unreadable/malformed — warn instead of silently
      // routing to the default queueDir (which could be the wrong store).
      console.warn(`warning: could not parse ${cfgPath} (${err.message}); using default queueDir '${queueDir}'`);
    }
  }
  return resolve(target, queueDir);
}

function runComment(positional, flags) {
  if (positional.length !== 1) die(`Usage: agent-pipeline comment <id> --body "..." [--verdict pass|fail] [--target <p>]`);
  if (!flags.body) die(`comment: --body is required`);
  if (flags.verdict && !['pass', 'fail'].includes(flags.verdict)) die(`comment: --verdict must be pass|fail`);
  const target = targetOf(flags);
  const queueDir = resolveQueueDir(target);
  const script = join(PLUGIN_ROOT, 'queue', 'queue-comment.sh');
  const args = [script, positional[0], '--author', flags.author || 'human', '--body', flags.body, '--queue-dir', queueDir];
  if (flags.verdict) args.push('--verdict', flags.verdict);
  try {
    execFileSync('bash', args, { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

async function runUi(flags) {
  const { startServer } = await import('../ui/server.js');
  const target = targetOf(flags);
  if (!existsSync(join(target, '.pipeline', 'queue'))) {
    console.warn(`Note: ${join(target, '.pipeline/queue')} does not exist yet. The dashboard will populate once tickets are created.`);
  }
  const { url, port } = await startServer({ target, port: flags.port ?? undefined, pluginRoot: PLUGIN_ROOT });
  console.log(`agent-pipeline dashboard → ${url}`);
  console.log(`  target: ${target}`);
  console.log(`  press Ctrl+C to stop`);
  if (flags.open) {
    try {
      const opener = process.platform === 'darwin' ? 'open'
                   : process.platform === 'win32' ? 'start'
                   : 'xdg-open';
      execSync(`${opener} ${JSON.stringify(url)}`, { stdio: 'ignore' });
    } catch {}
  }
  // Keep the process alive; the watcher's interval is unrefed so we need this.
  setInterval(() => {}, 1 << 30);
}

async function runStatus(positional, flags) {
  if (positional.length) die(`Usage: agent-pipeline status [--target <p>] [--json] [--state <name>]`);
  const { readSnapshot, STATES } = await import('../api/index.js');
  const snap = readSnapshot({ target: targetOf(flags), pluginRoot: PLUGIN_ROOT });
  if (flags.state && !STATES.includes(flags.state)) {
    die(`Unknown --state '${flags.state}'. Valid: ${STATES.join(', ')}`);
  }
  if (flags.json) {
    if (flags.state) console.log(JSON.stringify(snap.tickets.byState[flags.state] || [], null, 2));
    else console.log(JSON.stringify(snap, null, 2));
    return;
  }
  console.log(`agent-pipeline status — ${snap.target}`);
  console.log(`  generated: ${snap.generatedAt}`);
  console.log();
  console.log(`  Tickets by state:`);
  for (const st of STATES) {
    if (flags.state && st !== flags.state) continue;
    const list = snap.tickets.byState[st] || [];
    console.log(`    ${st.padEnd(20)} ${String(list.length).padStart(3)}`);
    if (flags.state) {
      for (const t of list) {
        const pri = t.priority != null ? `P${t.priority}` : '  ';
        const agent = t.source?.agent || '-';
        console.log(`      ${pri}  ${t.id.padEnd(14)} [${agent.padEnd(20)}] ${t.title || ''}`);
      }
    }
  }
  console.log();
  console.log(`  Active agents (tickets in in-progress):`);
  const active = snap.agents.filter(a => a.activity.active > 0);
  if (active.length === 0) console.log(`    (none)`);
  for (const a of active) {
    console.log(`    ${a.name.padEnd(34)} active=${a.activity.active}  owned=${a.activity.owned}`);
  }
}

async function runTicket(positional, flags) {
  if (positional.length !== 1) die(`Usage: agent-pipeline ticket <id> [--target <p>] [--json]`);
  const { getTicket } = await import('../api/index.js');
  const t = getTicket({ target: targetOf(flags), pluginRoot: PLUGIN_ROOT }, positional[0]);
  if (!t) die(`Ticket not found: ${positional[0]}`, 1);
  if (flags.json) { console.log(JSON.stringify(t, null, 2)); return; }
  console.log(`${t.id}  [${t.state}]  ${t.priority != null ? 'P' + t.priority : ''}`);
  if (t.title) console.log(`  title:       ${t.title}`);
  if (t.source?.agent) console.log(`  agent:       ${t.source.agent}`);
  if (t.source?.file)  console.log(`  file:        ${t.source.file}${t.source.line ? ':' + t.source.line : ''}`);
  if (t.pr_url) console.log(`  pr:          ${t.pr_url}`);
  if (t.branch) console.log(`  branch:      ${t.branch}${t.base ? '  (base ' + t.base + ')' : ''}`);
  if (t.worktree) console.log(`  worktree:    ${t.worktree}`);
  if (t.created_at) console.log(`  created:     ${t.created_at}`);
  if (t.updated_at) console.log(`  updated:     ${t.updated_at}`);
  if (t.description) { console.log(`\n${t.description}\n`); }
  if (Array.isArray(t.comments) && t.comments.length) {
    console.log(`\n  comments (${t.comments.length}):`);
    for (const c of t.comments) {
      const v = c.verdict ? ` [${c.verdict}]` : '';
      console.log(`    ${(c.author || '?').padEnd(18)}${v}  ${(c.body || '').split('\n')[0]}`);
    }
  }
}

async function runAgent(positional, flags) {
  if (positional.length !== 1) die(`Usage: agent-pipeline agent <name> [--target <p>] [--json]`);
  const { getAgent } = await import('../api/index.js');
  const a = getAgent({ target: targetOf(flags), pluginRoot: PLUGIN_ROOT }, positional[0]);
  if (!a) die(`Agent not found: ${positional[0]}`, 1);
  if (flags.json) { console.log(JSON.stringify(a, null, 2)); return; }
  console.log(`${a.name}  (${a.stage || 'unknown stage'})`);
  if (a.title && a.title !== a.name) console.log(`  title:       ${a.title}`);
  if (a.role) console.log(`  role:        ${a.role}`);
  if (a.input) console.log(`  input:       ${a.input}`);
  if (a.output) console.log(`  output:      ${a.output}`);
  if (a.scope) console.log(`  scope:       ${a.scope}`);
  if (a.provenance) console.log(`  provenance:  ${a.provenance}`);
  if (a.requires?.length) console.log(`  requires:    ${a.requires.join(', ')}`);
  if (a.optional?.length) console.log(`  optional:    ${a.optional.join(', ')}`);
  console.log(`  activity:    active=${a.activity.active}  owned=${a.activity.owned}`);
  if (a.activity.recent.length) {
    console.log(`  recent:`);
    for (const r of a.activity.recent) {
      console.log(`    ${r.id.padEnd(14)} [${r.state.padEnd(18)}] ${r.title || ''}`);
    }
  }
}

async function runEvents(flags) {
  const { createWatcher } = await import('../api/index.js');
  const w = createWatcher({ target: targetOf(flags), pluginRoot: PLUGIN_ROOT });
  process.on('SIGINT', () => { w.close(); process.exit(0); });
  for await (const ev of w) renderEvent(ev, flags);
}

async function runCycle(positional, flags) {
  const usage = `Usage: agent-pipeline cycle report --data '<json>' [--target <p>]   (--data - reads the payload from stdin)`;
  if (positional.length !== 1 || positional[0] !== 'report') die(usage);
  if (!flags.data) {
    die(`cycle report: --data is required — the cycle payload JSON (or '-' to read it from stdin).\n${usage}\nExample: agent-pipeline cycle report --data '{"dispatched":[{"agent":"worker","item":"fs-103"}],"nextCheckSeconds":600}'`);
  }
  const target = targetOf(flags);
  const { STATES, readSnapshot } = await import('../api/index.js');
  const { getBackend, validatePayload, readCycleTail, buildCycleEntry, appendCycle, renderBlock } =
    await import('../api/cycles.js');

  const raw = flags.data === '-' ? readFileSync(0, 'utf8') : flags.data;
  let payload;
  try { payload = JSON.parse(raw); }
  catch (err) {
    die(`cycle report: --data is not valid JSON (${err.message}).\nExample: --data '{"dispatched":[],"nextCheckSeconds":600}'`);
  }

  const backend = getBackend(target);
  const errs = validatePayload(payload, { backend, states: STATES });
  if (errs.length) die(`cycle report: invalid payload:\n  - ${errs.join('\n  - ')}`);

  // Filesystem mode: counts are optional — snapshot the queue ourselves.
  if (!payload.counts && backend === 'filesystem') {
    const snap = readSnapshot({ target, pluginRoot: PLUGIN_ROOT });
    payload.counts = {};
    for (const st of STATES) {
      const n = (snap.tickets.byState[st] || []).length;
      if (n) payload.counts[st] = n;
    }
  }

  const { entries, corruptTail } = readCycleTail(target, 1);
  if (corruptTail) {
    console.warn(`warning: last line of .pipeline/runs/cycles.jsonl is not valid JSON — treating this as the first cycle (numbering and deltas reset). Inspect the file if cycle history matters.`);
  }
  const prev = corruptTail ? null : (entries[entries.length - 1] ?? null);
  const entry = buildCycleEntry(payload, prev, { backend });
  appendCycle(target, entry);
  console.log(renderBlock(entry, prev, STATES));
}

async function runOrchestrator(positional, flags) {
  const sub = positional[0] || 'status';
  const target = targetOf(flags);
  const orch = await import('../api/orchestrator.js');
  const { isProcessAlive } = await import('../api/runs.js');

  const emit = (obj, line) => { if (flags.json) console.log(JSON.stringify(obj)); else console.log(line); };

  switch (sub) {
    case 'status': {
      const st = orch.readOrchestratorState(target) || orch.defaultOrchestratorState();
      if (flags.json) { console.log(JSON.stringify(st, null, 2)); return; }
      console.log(`orchestrator — ${target}`);
      console.log(`  state:      ${st.state}`);
      console.log(`  supervisor: ${st.supervisorPid ?? '-'}`);
      console.log(`  cadence:    ${st.cadence ?? '-'}`);
      console.log(`  last cycle: ${st.lastCycleNumber ?? '-'} @ ${st.lastCycleAt ?? '-'}`);
      console.log(`  next fire:  ${st.nextFireAt ?? '-'}`);
      return;
    }
    case 'pause': {
      const st = orch.writeOrchestratorState(target, { state: 'paused', nextFireAt: null });
      emit({ state: st.state }, `orchestrator paused`);
      return;
    }
    case 'resume': {
      const st = orch.writeOrchestratorState(target, { state: 'running' });
      emit({ state: st.state }, `orchestrator resumed`);
      return;
    }
    case 'stop': {
      const cur = orch.readOrchestratorState(target);
      orch.writeOrchestratorState(target, { state: 'stopped', nextFireAt: null, supervisorPid: null });
      if (cur?.supervisorPid && isProcessAlive(cur.supervisorPid)) {
        try { process.kill(cur.supervisorPid, 'SIGTERM'); } catch {}
      }
      emit({ stopped: true }, `orchestrator stopped`);
      return;
    }
    case 'start':   return orchestratorStart(target, flags);
    case 'restart': return orchestratorRestart(target, flags);
    default:
      die(`Usage: agent-pipeline orchestrator <start|pause|resume|restart|stop|status> [--target <p>] [--json]`);
  }
}

async function runWatchCmd(flags) {
  if (!process.stdout.isTTY) {
    die(`watch: stdout is not a TTY — the live dashboard needs an interactive terminal.\nFor pipeable output use: agent-pipeline events --json`);
  }
  const { runWatch } = await import('./watch.js');
  await runWatch({ target: targetOf(flags), pluginRoot: PLUGIN_ROOT });
}

function renderEvent(ev, flags, { runsOnly = false } = {}) {
  if (runsOnly && !ev.type.startsWith('run.') && ev.type !== 'snapshot') return;
  if (flags.json) { process.stdout.write(JSON.stringify(ev) + '\n'); return; }
  switch (ev.type) {
    case 'snapshot':
      console.log(`# snapshot  agents=${ev.data.agents.length}  tickets=${ev.data.tickets.count}  runs(active)=${ev.data.runs?.activeCount ?? 0}`);
      break;
    case 'ticket.move':   console.log(`MOVE   ${ev.id.padEnd(20)} ${ev.from} → ${ev.to}`); break;
    case 'ticket.upsert': console.log(`UPSERT ${ev.ticket.id.padEnd(20)} [${ev.state}]`); break;
    case 'ticket.remove': console.log(`REMOVE ${ev.id.padEnd(20)} [${ev.state}]`); break;
    case 'run.start':     console.log(`RUN+   ${ev.runId}  agent=${ev.run?.agent}`); break;
    case 'run.update':    console.log(`RUN~   ${ev.runId}  ${ev.run?.status || ''} ${ev.run?.lastActivity || ''}`); break;
    case 'run.complete':  console.log(`RUN✓   ${ev.runId}  ${formatCost(ev.run?.cost)}`); break;
    case 'run.fail':      console.log(`RUN✗   ${ev.runId}  exit=${ev.run?.exitCode}`); break;
    case 'run.kill':      console.log(`RUNK   ${ev.runId}`); break;
    case 'run.remove':    console.log(`RUN-   ${ev.runId}  [${ev.state}]`); break;
    case 'cycle.report': {
      const c = ev.cycle;
      const ready = c.counts?.['ready-for-human'] || 0;
      console.log(`CYCLE  #${c.cycle}  dispatched=${(c.dispatched || []).length}  ready-for-human=${ready}`);
      break;
    }
    case 'orchestrator.changed': {
      const o = ev.orchestrator;
      const cadence = o.cadence ? `  cadence=${o.cadence}` : '';
      console.log(`ORCH   state=${o.state}${cadence}`);
      break;
    }
  }
}

function formatCost(cost) {
  if (!cost) return '';
  if (typeof cost.usd === 'number') return `$${cost.usd.toFixed(4)}`;
  return '';
}

async function runRun(positional, flags) {
  if (positional.length !== 1) die(`Usage: agent-pipeline run <agent> --prompt "..." [--wait|--detach] [--json]`);
  if (!flags.prompt) die(`run: --prompt is required`);
  if (flags.wait && flags.detach) die(`run: --wait and --detach are mutually exclusive`);
  const target = targetOf(flags);

  // --detach: hand the work to a properly-detached supervisor and return immediately.
  // We must NOT call dispatch() in this process — its `child.on('close')` listener
  // would die when this process exits, leaving the run stuck in active/.
  if (flags.detach) {
    const out = await detachToSupervisor(positional[0], target, flags);
    console.log(flags.json ? JSON.stringify(out) : `${out.runId}  started`);
    return;
  }

  const { dispatch } = await import('../runner/dispatch.js');
  const handle = dispatch({
    agent: positional[0],
    prompt: flags.prompt,
    target,
    allowedTools: flags.allowedTools.length ? flags.allowedTools : undefined,
    disallowedTools: flags.disallowedTools.length ? flags.disallowedTools : undefined,
    maxBudgetUsd: flags.maxBudgetUsd ?? undefined,
    model: flags.model || undefined,
  });

  // Default + --wait: stream events to stdout. --wait then prints final summary.
  process.on('SIGINT', () => { handle.kill('SIGTERM'); });
  handle.events.on('event', ev => {
    if (flags.json) process.stdout.write(JSON.stringify(ev) + '\n');
    else if (ev.activity) process.stdout.write(`[${ev.type}] ${ev.activity}\n`);
  });
  const final = await handle.result;
  if (flags.wait || flags.json) {
    if (flags.json) process.stdout.write(JSON.stringify({ type: 'end', run: final }) + '\n');
    else console.log(`# done  status=${final.status}  exit=${final.exitCode}  ${formatCost(final.cost)}`);
  }
  process.exit(final.status === 'completed' ? 0 : 1);
}

/**
 * Spawn a detached node supervisor that owns the dispatch lifecycle.
 * Pre-allocates the runId so we can return it to the caller immediately,
 * then writes a placeholder active/<runId>.json that the supervisor will
 * overwrite once it starts. Returns { runId, status: 'started', supervisorPid }.
 */
async function detachToSupervisor(agent, target, flags) {
  const { randomUUID } = await import('node:crypto');
  const { ensureRunsDirs, writeRun } = await import('../api/runs.js');
  ensureRunsDirs(target);
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const runId = `${ts}-${randomUUID().slice(0, 8)}`;

  // Placeholder so a follow/list right after detach sees the run even before
  // the supervisor's process boots. The supervisor will overwrite this.
  writeRun(target, {
    runId,
    state: 'active',
    agent,
    prompt: flags.prompt,
    target,
    status: 'starting',
    startedAt: new Date().toISOString(),
    pid: null,
    lastActivity: null,
    cost: null,
  });

  const supervisorArgs = [
    fileURLToPath(import.meta.url),
    '_supervise',
    agent,
    '--run-id', runId,
    '--prompt', flags.prompt,
    '--target', target,
  ];
  if (flags.maxBudgetUsd != null) supervisorArgs.push('--max-budget-usd', String(flags.maxBudgetUsd));
  if (flags.model) supervisorArgs.push('--model', flags.model);
  if (flags.allowedTools.length) supervisorArgs.push('--allowed-tools', flags.allowedTools.join(' '));
  if (flags.disallowedTools.length) supervisorArgs.push('--disallowed-tools', flags.disallowedTools.join(' '));

  const child = spawn(process.execPath, supervisorArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: target,
    env: process.env,
  });
  child.unref();
  return { runId, status: 'started', supervisorPid: child.pid };
}

/**
 * Internal supervisor entrypoint. Not part of the public CLI surface — invoked
 * only by detachToSupervisor() via a detached spawn. Owns the claude lifecycle
 * for one run; exits when claude exits.
 */
async function runSupervise(positional, flags) {
  if (positional.length !== 1) process.exit(2);
  if (!flags.prompt || !flags.runId) process.exit(2);
  const { dispatch } = await import('../runner/dispatch.js');
  const handle = dispatch({
    runId: flags.runId,
    agent: positional[0],
    prompt: flags.prompt,
    target: targetOf(flags),
    allowedTools: flags.allowedTools.length ? flags.allowedTools : undefined,
    disallowedTools: flags.disallowedTools.length ? flags.disallowedTools : undefined,
    maxBudgetUsd: flags.maxBudgetUsd ?? undefined,
    model: flags.model || undefined,
  });
  // Quietly absorb events — supervisor has no stdout (stdio: 'ignore').
  handle.events.on('event', () => {});
  handle.events.on('error', () => {});
  const final = await handle.result;
  process.exit(final.status === 'completed' ? 0 : 1);
}

function detachOrchestratorSupervisor(target) {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '_orchestrate-supervise', '--target', target,
  ], { detached: true, stdio: 'ignore', cwd: target, env: process.env });
  child.unref();
  return child.pid;
}

async function orchestratorRestart(target, flags) {
  const orch = await import('../api/orchestrator.js');
  const { isProcessAlive, listRuns } = await import('../api/runs.js');
  // Kill any in-flight orchestrator cycle run (leaves other agent runs alone).
  for (const r of listRuns({ target }).active) {
    if (r.agent === 'orchestrator' && r.pid) { try { process.kill(r.pid, 'SIGTERM'); } catch {} }
  }
  const cur = orch.readOrchestratorState(target);
  orch.writeOrchestratorState(target, { state: 'running', cadence: 'initial', nextFireAt: new Date().toISOString() });
  // Ensure a live supervisor (start one if none).
  let pid = cur?.supervisorPid ?? null;
  if (!(pid && isProcessAlive(pid))) {
    pid = detachOrchestratorSupervisor(target);
    orch.writeOrchestratorState(target, { supervisorPid: pid });
  }
  if (flags.json) console.log(JSON.stringify({ restarted: true, supervisorPid: pid }));
  else console.log(`orchestrator restarted (supervisor pid ${pid})`);
}

async function orchestratorStart(target, flags) {
  const orch = await import('../api/orchestrator.js');
  const { isProcessAlive } = await import('../api/runs.js');
  const cur = orch.readOrchestratorState(target);
  if (cur && cur.state === 'running' && cur.supervisorPid && isProcessAlive(cur.supervisorPid)) {
    die(`orchestrator already running (supervisor pid ${cur.supervisorPid}); use 'restart' to force a fresh cycle`);
  }
  // Mark running and due-now BEFORE detaching, so the supervisor's first tick dispatches.
  orch.writeOrchestratorState(target, { state: 'running', cadence: 'initial', nextFireAt: new Date().toISOString() });
  const pid = detachOrchestratorSupervisor(target);
  orch.writeOrchestratorState(target, { supervisorPid: pid });
  if (flags.json) console.log(JSON.stringify({ started: true, supervisorPid: pid }));
  else console.log(`orchestrator started (supervisor pid ${pid})`);
}

async function runOrchestrateSupervise(flags) {
  const { runOrchestratorSupervisor } = await import('../runner/orchestrator-supervisor.js');
  await runOrchestratorSupervisor({ target: targetOf(flags) });
}

async function runRuns(positional, flags) {
  const sub = positional[0];
  const { listRuns, getRun, createWatcher } = await import('../api/index.js');
  const target = targetOf(flags);

  // `runs` or `runs list`
  if (!sub || sub === 'list') {
    const { active, completed } = listRuns({ target });
    if (flags.json) { console.log(JSON.stringify({ active, completed }, null, 2)); return; }
    console.log(`Active runs (${active.length}):`);
    for (const r of active) {
      console.log(`  ${r.runId}  ${r.agent.padEnd(20)} ${r.status.padEnd(10)} ${r.lastActivity || ''}`);
    }
    console.log(`\nRecent completed (${completed.length}):`);
    for (const r of completed.slice(0, 10)) {
      console.log(`  ${r.runId}  ${r.agent.padEnd(20)} ${r.status.padEnd(10)} ${formatCost(r.cost)}  ${r.lastActivity || ''}`);
    }
    return;
  }

  if (sub === 'events') {
    const w = createWatcher({ target, pluginRoot: PLUGIN_ROOT });
    process.on('SIGINT', () => { w.close(); process.exit(0); });
    for await (const ev of w) renderEvent(ev, flags, { runsOnly: true });
    return;
  }

  if (sub === 'kill') {
    const id = positional[1];
    if (!id) die(`Usage: agent-pipeline runs kill <runId>`);
    const run = getRun({ target }, id);
    if (!run) die(`Run not found: ${id}`);
    if (run.state !== 'active') die(`Run ${id} is not active (state=${run.state})`);
    if (!run.pid) die(`Run ${id} has no pid recorded`);
    try { process.kill(run.pid, 'SIGTERM'); }
    catch (err) { die(`kill failed: ${err.message}`); }
    if (flags.json) console.log(JSON.stringify({ runId: id, killed: true }));
    else console.log(`sent SIGTERM to ${id} (pid ${run.pid})`);
    return;
  }

  // `runs <runId> events` — dump captured events log.
  if (positional[1] === 'events') {
    const { getRunEvents } = await import('../api/index.js');
    const events = getRunEvents({ target }, sub);
    if (!events.length) {
      // distinguish missing run from a run that produced no events
      const r = getRun({ target }, sub);
      if (!r) die(`Run not found: ${sub}`);
    }
    for (const ev of events) {
      if (flags.json) process.stdout.write(JSON.stringify(ev) + '\n');
      else {
        const activity = ev.activity ? ` ${ev.activity}` : '';
        process.stdout.write(`${ev.ts}  [${ev.type}]${activity}\n`);
      }
    }
    return;
  }

  // `runs <runId> --follow` — replay events.jsonl, then live-tail until run ends.
  const runId = sub;
  if (flags.follow) {
    await followRun(target, runId, flags);
    return;
  }
  if (flags.wait) {
    const w = createWatcher({ target, pluginRoot: PLUGIN_ROOT });
    let finalRun = getRun({ target }, runId);
    if (finalRun && finalRun.state === 'completed') { w.close(); }
    else {
      for await (const ev of w) {
        if (ev.type === 'snapshot') continue;
        if (ev.runId !== runId) continue;
        if (ev.type === 'run.complete' || ev.type === 'run.fail' || ev.type === 'run.kill') {
          finalRun = ev.run; break;
        }
      }
      w.close();
    }
    if (!finalRun) die(`Run not found: ${runId}`);
    if (flags.json) console.log(JSON.stringify(finalRun, null, 2));
    else printRun(finalRun);
    return;
  }
  const run = getRun({ target }, runId);
  if (!run) die(`Run not found: ${runId}`);
  if (flags.json) console.log(JSON.stringify(run, null, 2));
  else printRun(run);
}

async function followRun(target, runId, flags) {
  const { getRun } = await import('../api/index.js');
  const eventsPath = join(resolve(target), '.pipeline', 'runs', 'logs', `${runId}.events.jsonl`);

  // Confirm the run exists at all (otherwise we'd block forever waiting).
  if (!getRun({ target }, runId) && !existsSync(eventsPath)) {
    die(`Run not found: ${runId}`);
  }

  let offset = 0;
  const drain = () => {
    if (!existsSync(eventsPath)) return;
    const buf = readFileSync(eventsPath);
    if (buf.length <= offset) return;
    const fresh = buf.slice(offset).toString('utf8');
    offset = buf.length;
    for (const line of fresh.split('\n')) {
      if (!line.trim()) continue;
      if (flags.json) { process.stdout.write(line + '\n'); continue; }
      try {
        const ev = JSON.parse(line);
        const activity = ev.activity ? ` ${ev.activity}` : '';
        process.stdout.write(`${ev.ts}  [${ev.type}]${activity}\n`);
      } catch {
        process.stdout.write(line + '\n');
      }
    }
  };

  // 1) Replay everything already written
  drain();

  // 2) If the run is already finished, exit
  let snap = getRun({ target }, runId);
  if (snap && snap.state === 'completed') {
    if (flags.json) process.stdout.write(JSON.stringify({ type: 'end', run: snap }) + '\n');
    else console.log(`# done  status=${snap.status}  ${formatCost(snap.cost)}`);
    return;
  }

  // 3) Tail: poll file size every 200ms; check completion every tick.
  await new Promise(resolveTail => {
    const tick = setInterval(() => {
      drain();
      const r = getRun({ target }, runId);
      if (r && r.state === 'completed') {
        clearInterval(tick);
        // One final drain to catch any last bytes written between checks
        drain();
        if (flags.json) process.stdout.write(JSON.stringify({ type: 'end', run: r }) + '\n');
        else console.log(`# done  status=${r.status}  ${formatCost(r.cost)}`);
        resolveTail();
      }
    }, 200);
    process.on('SIGINT', () => { clearInterval(tick); resolveTail(); });
  });
}

function printRun(r) {
  console.log(`${r.runId}  [${r.state || r.status}]`);
  console.log(`  agent:      ${r.agent}`);
  if (r.target)       console.log(`  target:     ${r.target}`);
  if (r.pid != null)  console.log(`  pid:        ${r.pid}`);
  if (r.startedAt)    console.log(`  startedAt:  ${r.startedAt}`);
  if (r.completedAt)  console.log(`  completedAt:${r.completedAt}`);
  if (r.durationMs != null) console.log(`  durationMs: ${r.durationMs}`);
  if (r.exitCode != null)   console.log(`  exitCode:   ${r.exitCode}`);
  if (r.cost?.usd != null)  console.log(`  cost:       $${r.cost.usd.toFixed(4)}`);
  if (r.lastActivity) console.log(`  lastActivity: ${r.lastActivity}`);
  if (r.error)        console.log(`  error:      ${r.error}`);
}
