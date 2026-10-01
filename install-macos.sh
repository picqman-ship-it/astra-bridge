#!/bin/sh
# Astra Bridge for macOS: the one entry point.
#
#   ./install-macos.sh              guided setup (safe to re-run; continues where it stopped)
#   ./install-macos.sh doctor       read-only health check
#   ./install-macos.sh uninstall    stop and remove the agent (keeps keys unless --purge)
#   ./install-macos.sh --help       all options
#
# This wrapper only makes sure a suitable Node.js exists, because everything else is a Node
# script (installer/astra-macos.mjs). It never installs Node or anything else for you, and it
# never needs sudo.

set -eu

MIN_NODE_MAJOR=22

say() { printf '%s\n' "$*" >&2; }

if [ "$(uname -s)" != "Darwin" ]; then
  say "Astra Bridge's installer supports macOS only."
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  say "Do not run this with sudo. Run it as your normal user: ./install-macos.sh"
  exit 1
fi

here=$(cd "$(dirname "$0")" && pwd -P)

node_help() {
  say ""
  say "Install Node.js $MIN_NODE_MAJOR LTS or newer yourself, then re-run ./install-macos.sh:"
  say "  • the macOS installer (.pkg) from https://nodejs.org/en/download, or"
  say "  • Homebrew: brew install node, or"
  say "  • nvm: nvm install $MIN_NODE_MAJOR && nvm alias default $MIN_NODE_MAJOR"
}

if ! command -v node >/dev/null 2>&1; then
  say "Node.js was not found on your PATH."
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      say "It is installed at $candidate but this shell does not see it."
      case "$candidate" in
        /opt/homebrew/*) say "Add Homebrew to your shell, then open a new Terminal window:"
                         say "  echo 'eval \"\$(/opt/homebrew/bin/brew shellenv)\"' >> ~/.zprofile" ;;
        *)               say "Add /usr/local/bin to your PATH, then open a new Terminal window." ;;
      esac
      exit 1
    fi
  done
  node_help
  exit 1
fi

major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$major" in
  ''|*[!0-9]*) major=0 ;;
esac
if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
  say "Found Node.js $(node --version 2>/dev/null || echo '?') at $(command -v node); Astra Bridge needs $MIN_NODE_MAJOR or newer."
  node_help
  exit 1
fi

exec node "$here/installer/astra-macos.mjs" ${1+"$@"}
