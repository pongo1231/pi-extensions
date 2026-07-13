#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run-ghidra.sh — Launcher for the GhidraMCP Python bridge
#
# Works on Linux, macOS, and Windows (via Git Bash / MSYS2 / WSL).
# Creates a Python venv with the 'mcp' package on first run.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_SCRIPT="${SCRIPT_DIR}/bridge_mcp_ghidra.py"
VENV_DIR="${SCRIPT_DIR}/.venv-ghidra"

find_python() {
  # Try common Python 3 names
  for py in python3 python; do
    if command -v "$py" &>/dev/null; then
      echo "$py"
      return
    fi
  done
  # Last resort: try nix if available
  if command -v nix &>/dev/null; then
    echo "nix-python"  # special sentinel handled below
    return
  fi
  echo ""
}

if [ ! -f "$BRIDGE_SCRIPT" ]; then
  echo "Error: bridge script not found at $BRIDGE_SCRIPT" >&2
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "[mcp-ghidra] Setting up Python venv..." >&2

  PY="$(find_python)"

  if [ -z "$PY" ]; then
    echo "Error: No Python found. Install Python 3.10+ and try again." >&2
    exit 1
  fi

  if [ "$PY" = "nix-python" ]; then
    # Create venv via nix
    nix run nixpkgs#python3 -- -m venv "$VENV_DIR" 2>/dev/null || {
      echo "Error: nix run nixpkgs#python3 failed" >&2
      exit 1
    }
  else
    "$PY" -m venv "$VENV_DIR"
  fi

  echo "[mcp-ghidra] Installing mcp package..." >&2
  "$VENV_DIR/bin/pip" install --quiet "mcp>=1.2.0,<2"
  echo "[mcp-ghidra] Ready." >&2
fi

exec "$VENV_DIR/bin/python" "$BRIDGE_SCRIPT" "$@"
