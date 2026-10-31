#!/bin/bash
# Installs REA (reverse-engineering MCP server + skill) for Claude Code cloud sessions.
set -uo pipefail

# Cloud sessions only; local machines manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Skip if REA is already registered and its skill is installed
# (the hook runs on every start, resume, clear and compact).
rea_ready() {
  [ -f "$HOME/.claude/skills/reverse-engineer-anything/SKILL.md" ] || return 1
  python3 -c 'import json,os,sys
d=json.load(open(os.path.expanduser("~/.claude.json")))
sys.exit(0 if "rea" in d.get("mcpServers",{}) else 1)' 2>/dev/null
}

if rea_ready; then
  exit 0
fi

# Non-fatal: a failed REA install must not block the session.
# Run from /tmp so npx does not resolve against the repo.
if (cd /tmp && npx -y rea-agents@latest setup --client claude_code --yes) >/tmp/rea-setup.log 2>&1; then
  echo "REA installed for Claude Code."
else
  echo "REA setup failed (exit $?); see /tmp/rea-setup.log. Continuing without REA." >&2
fi
exit 0
