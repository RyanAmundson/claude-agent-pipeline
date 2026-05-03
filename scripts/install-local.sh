#!/usr/bin/env bash
# install-local.sh — Install the agent-pipeline plugin into a target project's .claude/ folder.
#
# Usage:
#   ./scripts/install-local.sh <target-project-path> [--mode symlink|copy] [--rules opinionated|templates|none]
#
# Modes:
#   symlink (default) — symlink agents/ rules/ commands/ into <target>/.claude/. Pulls future updates automatically.
#   copy              — copy files. Detached from this repo; edit freely without affecting other installs.
#
# Rules:
#   opinionated (default) — install the full rule set from rules/ (typescript-react preset).
#   templates             — install only rules/templates/* as starting points; you author your own rules.
#   none                  — install no rules; you bring your own.
#
# Examples:
#   ./scripts/install-local.sh ~/Code/my-app
#   ./scripts/install-local.sh ~/Code/my-app --mode copy --rules templates
#
set -euo pipefail

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

if [ $# -lt 1 ]; then usage; fi

TARGET=""
MODE="symlink"
RULES="opinionated"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --rules) RULES="${2:-}"; shift 2 ;;
    --*) echo "Unknown flag: $1" >&2; usage ;;
    *) if [ -z "$TARGET" ]; then TARGET="$1"; shift; else echo "Unexpected arg: $1" >&2; usage; fi ;;
  esac
done

if [ -z "$TARGET" ]; then echo "Missing <target-project-path>" >&2; usage; fi

case "$MODE" in symlink|copy) ;; *) echo "Invalid --mode: $MODE" >&2; usage ;; esac
case "$RULES" in opinionated|templates|none) ;; *) echo "Invalid --rules: $RULES" >&2; usage ;; esac

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || { echo "Target not found: $TARGET" >&2; exit 1; })"

if [ ! -d "$TARGET/.git" ]; then
  echo "Warning: $TARGET is not a git repo. Continuing anyway." >&2
fi

CLAUDE_DIR="$TARGET/.claude"
mkdir -p "$CLAUDE_DIR/agents" "$CLAUDE_DIR/rules" "$CLAUDE_DIR/commands"

install_dir() {
  local src="$1" dest="$2" label="$3"
  local installed=0 skipped=0
  if [ ! -d "$src" ]; then return; fi
  for f in "$src"/*.md; do
    [ -e "$f" ] || continue
    local name; name="$(basename "$f")"
    local target="$dest/$name"
    if [ -e "$target" ] && [ ! -L "$target" ]; then
      echo "  [skip] $label/$name (target exists, not a symlink — leaving untouched)"
      skipped=$((skipped + 1))
      continue
    fi
    rm -f "$target"
    if [ "$MODE" = "symlink" ]; then
      ln -s "$f" "$target"
    else
      cp "$f" "$target"
    fi
    installed=$((installed + 1))
  done
  echo "  $label: $installed installed, $skipped skipped"
}

echo "Installing agent-pipeline ($MODE) into $TARGET/.claude"
echo "  Plugin source: $PLUGIN_DIR"
echo

install_dir "$PLUGIN_DIR/agents" "$CLAUDE_DIR/agents" "agents"
install_dir "$PLUGIN_DIR/commands" "$CLAUDE_DIR/commands" "commands"

case "$RULES" in
  opinionated) install_dir "$PLUGIN_DIR/rules" "$CLAUDE_DIR/rules" "rules (opinionated)" ;;
  templates)   install_dir "$PLUGIN_DIR/rules/templates" "$CLAUDE_DIR/rules" "rules (templates)" ;;
  none)        echo "  rules: skipped (--rules none)" ;;
esac

if [ ! -e "$TARGET/.pipeline/config.json" ]; then
  echo
  echo "Next: run /pipeline init in Claude Code from $TARGET to write .pipeline/config.json"
else
  echo
  echo "Found existing .pipeline/config.json — no init needed."
fi

echo
echo "Done. Open $TARGET in Claude Code and try /pipeline start."
