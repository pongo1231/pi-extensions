#!/usr/bin/env bash
# Launcher for the Ghidra MCP bridge.
# Creates a venv with dependencies on first run, then starts the bridge.
set -euo pipefail

BRIDGE_SCRIPT="${0%/*}/bridge_mcp_ghidra.py"
VENV_DIR="${HOME}/.pi/agent/extensions/mcp-ghidra/.venv-ghidra"

if [ ! -f "$BRIDGE_SCRIPT" ]; then
  echo "Error: bridge script not found at $BRIDGE_SCRIPT" >&2
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "Setting up venv for Ghidra MCP bridge..." >&2

  if command -v python3 &>/dev/null; then
    python3 -m venv "$VENV_DIR"
  elif command -v python &>/dev/null; then
    python -m venv "$VENV_DIR"
  elif command -v nix &>/dev/null; then
    nix run nixpkgs#python3 -- -m venv "$VENV_DIR" 2>/dev/null || \
      nix shell nixpkgs#python3 --command python3 -m venv "$VENV_DIR"
  else
    echo "Error: no Python found." >&2
    exit 1
  fi

  echo "Installing mcp package..." >&2
  "$VENV_DIR/bin/pip" install --quiet "mcp>=1.2.0,<2"
  echo "Ready." >&2
fi

exec "$VENV_DIR/bin/python" "$BRIDGE_SCRIPT" "$@"
