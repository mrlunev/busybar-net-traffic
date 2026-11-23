#!/bin/bash
# Net Traffic on the BUSY Bar: installs everything on macOS (and Linux) with one command.
#
#   curl -fsSL https://raw.githubusercontent.com/mrlunev/busybar-net-traffic/main/install.sh | bash
#
# Run it again at any time: each step first looks at what is already there and does only what is missing.
#
# 1. Node.js 20 or newer. One already installed is used as it is. Otherwise a private copy from nodejs.org goes into
#    ~/.busy-net-traffic/.node: no password, no Homebrew, nothing else on the system changes. Its checksum is
#    verified against nodejs.org's list.
# 2. The traffic meter, into ~/.busy-net-traffic, downloaded only when GitHub has a newer version than the one there.
# 3. Setup: finds the bar (USB cable, or Wi-Fi when its API is open there), starts the traffic meter and adds it to the
#    login items (unless it already runs this version), installs the app on the bar (unless it has exactly this
#    package), writes this computer's addresses into the app's settings, and waits for the bar's first call.
#
# Everything sits in main(), called on the last line: bash reads a piped script as it runs, so a half-downloaded
# script must not start.

# BUSYBAR_SOURCE: a local copy of the repository instead of GitHub, for testing before it is published.
REPO="${BUSYBAR_SOURCE:-mrlunev/busybar-net-traffic}"
DIR="$HOME/.busy-net-traffic"
# Until 22.11.2026 this was Internet Speed, in ~/.busy-internet-speed. Its private Node.js moves over; setup removes
# the rest.
EARLIER_DIR="$HOME/.busy-internet-speed"
NODE_LINE="latest-v22.x"
NODE_MIN=20

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '%s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

# The major version of a node binary, or 0.
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Picks the Node.js to use into NODE: the one on PATH when new enough and installed for good (Homebrew's link, which
# survives upgrades, or nodejs.org's), else the private copy, else none. A Node.js of a version manager (nvm, fnm,
# volta, asdf, n) lives in a folder of its version: removing that version or cleaning up would silently break the
# login item, so it is not used.
find_node() {
  NODE=""
  local system
  system=$(command -v node 2>/dev/null)
  if [ -n "$system" ] && [ "$(node_major "$system")" -ge "$NODE_MIN" ]; then
    case "$system" in
      */.nvm/* | */.fnm/* | */fnm/node-versions/* | */.volta/* | */.asdf/* | */n/versions/* | */.local/share/mise/*)
        note "Node.js $("$system" -v) is here, but from a version manager ($system): Net Traffic keeps a copy of its own." ;;
      *)
        NODE="$system"
        note "Node.js $("$NODE" -v) is already here ($NODE)."
        return ;;
    esac
  fi
  if [ -x "$DIR/.node/bin/node" ] && [ "$(node_major "$DIR/.node/bin/node")" -ge "$NODE_MIN" ]; then
    NODE="$DIR/.node/bin/node"
    note "Node.js $("$NODE" -v) is already here (the copy of Net Traffic)."
  fi
}

install_node() {
  local os arch name base tmp
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "This system is not supported." ;; esac
  case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) fail "This processor is not supported." ;; esac
  base="https://nodejs.org/dist/$NODE_LINE"
  say "Downloading Node.js (about 50 MB) for Net Traffic only; nothing else on the system changes..."
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" || fail "Could not reach nodejs.org. Check the internet connection and run this again."
  name=$(awk -v want="-$os-$arch.tar.gz" '$2 ~ want"$" { print $2; exit }' "$tmp/SHASUMS256.txt")
  [ -n "$name" ] || fail "nodejs.org has no Node.js for $os-$arch."
  curl -fsSL -o "$tmp/$name" "$base/$name" || fail "Could not download Node.js."
  (cd "$tmp" && grep " $name\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null 2>&1) || fail "The Node.js download is damaged (its checksum does not match). Run this again."
  mkdir -p "$DIR"
  rm -rf "$DIR/.node" && mkdir -p "$DIR/.node"
  tar -xzf "$tmp/$name" -C "$DIR/.node" --strip-components 1 || fail "Could not unpack Node.js."
  rm -rf "$tmp"
  NODE="$DIR/.node/bin/node"
  note "Node.js $("$NODE" -v) is in place."
}

# Brings the code in $DIR up to date. Keeps the private Node.js.
fetch_code() {
  if [ -d "$REPO" ]; then
    CODE="$REPO"
    note "Using the local copy $REPO."
    return
  fi
  CODE="$DIR"
  local latest have tmp
  latest=$(curl -fsSL -m 10 -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/main" 2>/dev/null)
  have=$(cat "$DIR/.commit" 2>/dev/null)
  if [ -n "$latest" ] && [ "$latest" = "$have" ] && [ -f "$DIR/daemon/traffic-meter.mjs" ]; then
    note "Net Traffic is already the latest version."
    return
  fi
  say "Downloading Net Traffic..."
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/code.tgz" "https://codeload.github.com/$REPO/tar.gz/${latest:-main}" || fail "Could not download Net Traffic. Check the internet connection and run this again."
  mkdir "$tmp/code" && tar -xzf "$tmp/code.tgz" -C "$tmp/code" --strip-components 1 && [ -f "$tmp/code/daemon/traffic-meter.mjs" ] || fail "The Net Traffic download is damaged. Run this again."
  rm "$tmp/code.tgz" && tmp="$tmp/code"
  mkdir -p "$DIR"
  # Everything but the private Node.js is replaced.
  find "$DIR" -mindepth 1 -maxdepth 1 ! -name .node -exec rm -rf {} +
  (cd "$tmp" && tar -cf - .) | (cd "$DIR" && tar -xf -)
  rm -rf "$(dirname "$tmp")"
  [ -n "$latest" ] && printf '%s\n' "$latest" >"$DIR/.commit"
}

main() {
  if [ -x "$EARLIER_DIR/.node/bin/node" ] && [ ! -e "$DIR/.node" ]; then
    mkdir -p "$DIR" && mv "$EARLIER_DIR/.node" "$DIR/.node"
  fi
  find_node
  [ -n "$NODE" ] || install_node
  [ "$(node_major "$NODE")" -ge "$NODE_MIN" ] || fail "Node.js $NODE_MIN or newer is needed, and it is still missing."

  fetch_code

  say "Setting up the bar..."
  # setup decides what to restart: it compares the running traffic meter's version with this code. Its questions
  # (the Mac's password, only when the firewall is on) need the terminal, which a piped script does not have on stdin.
  if (exec </dev/tty) 2>/dev/null; then
    BUSY_NODE="$NODE" "$NODE" "$CODE/daemon/traffic-meter.mjs" setup </dev/tty
  else
    BUSY_NODE="$NODE" "$NODE" "$CODE/daemon/traffic-meter.mjs" setup
  fi
}

main
