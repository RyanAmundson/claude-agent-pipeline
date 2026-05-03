#!/usr/bin/env node
// claude-agent-pipeline CLI — install agents, rules, and commands into a target project.
// No runtime dependencies. Node >= 18.

import { existsSync, mkdirSync, readFileSync, statSync, lstatSync, unlinkSync, symlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..');
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'manifest.json'), 'utf8'));
const PKG = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

const HELP = `claude-agent-pipeline v${PKG.version}

Usage:
  agent-pipeline install <target> [options]   Install agents/rules/commands into a project
  agent-pipeline list-agents [--target <p>]   List agents and dep status (target optional)
  agent-pipeline list-presets                 List rule presets
  agent-pipeline detect [--target <p>]        Detect available deps in target environment
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
  const flags = { mode: 'symlink', preset: 'minimal', omitRule: [], omitAgent: [], all: false, with: [], without: [], dryRun: false, quiet: false, target: null };
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
  default: die(`Unknown command: ${cmd}\n\n${HELP}`);
}
