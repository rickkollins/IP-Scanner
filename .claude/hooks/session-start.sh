#!/bin/bash
# Installs the REA skill for Claude Code cloud sessions.
# The REA MCP server itself is registered by the repo's .mcp.json.
set -uo pipefail

# Cloud sessions only; local machines manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Skip if the skill is already installed
# (the hook runs on every start, resume, clear and compact).
if [ -f "$HOME/.claude/skills/reverse-engineer-anything/SKILL.md" ]; then
  exit 0
fi

# Non-fatal: a failed install must not block the session.
# Run from /tmp so npx does not resolve against the repo.
if (cd /tmp && npx -y rea-agents@latest setup --skill-client claude_code --skill --yes) >/tmp/rea-setup.log 2>&1; then
  echo "REA skill installed for Claude Code."
else
  echo "REA skill setup failed (exit $?); see /tmp/rea-setup.log. Continuing without it." >&2
fi
exit 0
