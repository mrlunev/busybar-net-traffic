#!/usr/bin/env node
// Internet Speed's companion on the computer: measures this computer's internet traffic and gives it to the
// BUSY Bar, which shows it on its speedometer. Node 20 or newer, no dependencies.
//
//   node speed-daemon.mjs              runs (the login item starts it like this)
//   node speed-daemon.mjs setup        finds the bar on the USB cable, installs the app, pairs, starts at login
//   node speed-daemon.mjs uninstall    stops it, removes the login item and the settings
//
// It reads the byte counters of the one network adapter that carries the internet: the default route with the
// lowest metric (a VPN's tunnel, when it takes the default route, rather than the tunnel and the cable under it
// twice). The same counters the system's own network monitor shows: one long-lived PowerShell reading .NET's
// interface statistics on Windows, one long-lived `netstat -w 1` on macOS, /proc/net/dev on Linux.
// The bar asks GET /speed twice a second and gets {down, up} in Mbit/s, the rate over the last second. There is no
// password: the speed is all it gives, and only to addresses of local networks (the bar's Wi-Fi, its USB cable).
//
// While it runs it also keeps the bar's list of this computer's addresses current (keeper below): a computer that
// moves to another network or gets another address tells the paired bar, over the cable or the bar's Wi-Fi.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appSettings, barInfo, setAppSettings } from "./bar-api.mjs";
import { APP_ID, hostOf, hostPatch, loadConfig, PORT, saveConfig } from "./config.mjs";
import { hostsFor, USB_BAR } from "./hosts.mjs";

/** A short hash of the daemon's files: a changed daemon replaces the one left running. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  const hash = createHash("sha256");
  for (const name of ["speed-daemon.mjs", "hosts.mjs", "bar-api.mjs", "config.mjs", "mdns.mjs", "setup.mjs"]) hash.update(readFileSync(path.join(HERE, name)));
  return hash.digest("hex").slice(0, 12);
})();
const args = process.argv.slice(2);

// ---- the counters --------------------------------------------------------------------------------------------------

/** Samples of the internet adapter's total bytes: [{ t, rx, tx }], the last few seconds. */
const samples = [];
let adapters = "";
/** Whether the adapter has been looked for at least once: until then an empty `adapters` means "not known yet". */
let looked = false;
/** A gap longer than this between samples (the computer slept) starts the rate afresh. */
const GAP_MS = 3000;

function sample(rx, tx, names) {
  const t = Date.now();
  // Another adapter, or a sleep: the counters before belong to something else. Without this, switching from
  // Wi-Fi to a cable counted the cable's lifetime total as one second of traffic.
  if (names !== adapters || (samples.length > 0 && t - samples[samples.length - 1].t > GAP_MS)) samples.length = 0;
  adapters = names;
  looked = true;
  if (!names) return;
  samples.push({ t, rx, tx });
  while (samples.length > 2 && t - samples[0].t > 3000) samples.shift();
}

/** Mbit/s over about the last second; null until there are two samples. */
function rate() {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const s of samples) if (last.t - s.t >= 900) first = s;
  const seconds = (last.t - first.t) / 1000;
  if (seconds <= 0) return null;
  // A counter that went back (the adapter was reset) gives no rate this time.
  const down = Math.max(0, last.rx - first.rx);
  const up = Math.max(0, last.tx - first.tx);
  return { down: (down * 8) / seconds / 1e6, up: (up * 8) / seconds / 1e6 };
}

function startWindows() {
  // One PowerShell for the daemon's life. Every 10 s: the default route (IPv4 or IPv6) with the lowest metric,
  // route and interface metrics added the way Windows itself picks; twice a second its counters from .NET, which
  // costs far less than Get-NetAdapterStatistics. Names are the same in every language of Windows.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$nic = $null; $n = 0
function Pick {
  $best = $null
  foreach ($r in Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0') {
    $ip = Get-NetIPInterface -InterfaceIndex $r.InterfaceIndex -AddressFamily $r.AddressFamily
    if ($ip.ConnectionState -ne 'Connected') { continue }
    $m = [int]$r.RouteMetric + [int]$ip.InterfaceMetric
    if ($best -eq $null -or $m -lt $best.M) { $best = @{ I = $r.InterfaceIndex; M = $m } }
  }
  if ($best -eq $null) { return $null }
  foreach ($x in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    $p = $x.GetIPProperties()
    $i4 = $null; $i6 = $null
    try { $i4 = $p.GetIPv4Properties().Index } catch {}
    try { $i6 = $p.GetIPv6Properties().Index } catch {}
    if ($i4 -eq $best.I -or $i6 -eq $best.I) { return $x }
  }
  return $null
}
while ($true) {
  if ($n % 20 -eq 0) { $nic = Pick }
  if ($nic -ne $null -and $nic.OperationalStatus -eq 'Up') {
    $s = $nic.GetIPStatistics()
    [Console]::Out.WriteLine("S $($s.BytesReceived) $($s.BytesSent) $($nic.Name)")
  } else {
    [Console]::Out.WriteLine("S 0 0 ")
  }
  [Console]::Out.Flush()
  $n++; Start-Sleep -Milliseconds 500
}`;
  const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let buffer = "";
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const m = /^S (\d+) (\d+) ?(.*)$/.exec(line);
      if (m) sample(Number(m[1]), Number(m[2]), m[3]);
    }
  });
  ps.on("exit", () => {
    log("the PowerShell reading the counters ended; starting it again");
    setTimeout(startWindows, 2000);
  });
}

/** The interface of the default route, from `route -n get default`, or "" when there is none. */
function defaultInterfaceMac() {
  return new Promise((resolve) => {
    execFile("route", ["-n", "get", "default"], { timeout: 3000 }, (err, out) => {
      resolve(err ? "" : ((/interface:\s*(\S+)/.exec(String(out)) || [])[1] ?? ""));
    });
  });
}

function startMac() {
  // One `netstat -I <interface> -b -w 1` for as long as the default route stays on that interface: it prints the
  // bytes of each passing second, so the counters are summed here. When the route moves (Wi-Fi to cable, a VPN
  // coming up) the netstat is replaced and the sums start afresh.
  let iface = "";
  let proc = null;
  const run = (name) => {
    if (proc) {
      proc.removeAllListeners("exit");
      proc.kill();
      proc = null;
    }
    iface = name;
    sample(0, 0, "");
    if (!name) return;
    let rx = 0;
    let tx = 0;
    let first = true;
    let buffer = "";
    proc = spawn("netstat", ["-I", name, "-b", "-w", "1"], { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const cells = buffer.slice(0, nl).trim().split(/\s+/);
        buffer = buffer.slice(nl + 1);
        // Data rows: packets errs bytes packets errs bytes colls. Headers repeat every screenful.
        if (cells.length < 6 || !/^\d+$/.test(cells[0]) || !/^\d+$/.test(cells[2])) continue;
        // Some macOS versions start with totals since boot: the first row only marks the start.
        if (first) {
          first = false;
          sample(0, 0, name);
          continue;
        }
        rx += Number(cells[2]);
        tx += Number(cells[5]);
        sample(rx, tx, name);
      }
    });
    proc.on("exit", () => {
      proc = null;
      log(`netstat for ${name} ended; starting it again`);
      setTimeout(() => void check(true), 2000);
    });
  };
  const check = async (force = false) => {
    const name = await defaultInterfaceMac();
    if (force || name !== iface) run(name);
  };
  void check(true);
  setInterval(() => void check(), 10_000);
}

/** Linux: the default route with the lowest metric, IPv4 or IPv6. */
function defaultInterfaceLinux() {
  let best = null;
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1)) {
      const f = line.split(/\s+/);
      if (f[1] === "00000000" && (best === null || Number(f[6]) < best.metric)) best = { name: f[0], metric: Number(f[6]) };
    }
  } catch {
    // No IPv4.
  }
  try {
    for (const line of readFileSync("/proc/net/ipv6_route", "utf8").trim().split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f[0] === "0".repeat(32) && f[1] === "00" && f[9] !== "lo") {
        const metric = parseInt(f[5], 16);
        if (best === null || metric < best.metric) best = { name: f[9], metric };
      }
    }
  } catch {
    // No IPv6.
  }
  return best ? best.name : "";
}

function startLinux() {
  let name = defaultInterfaceLinux();
  let n = 0;
  setInterval(() => {
    if (++n % 20 === 0) name = defaultInterfaceLinux();
    if (!name) return sample(0, 0, "");
    for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [iface, rest] = line.split(":");
      if (!rest || iface.trim() !== name) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      sample(f[0], f[8], name);
    }
  }, 500);
}

// ---- the keeper: the bar's list of this computer's addresses ---------------------------------------------------------

/**
 * Every 15 s: if this computer's addresses for the bar changed since they were last written (another network,
 * another DHCP lease, the cable plugged in or out), writes the new list into the paired bar's settings, over the
 * cable when it is plugged in, else over the bar's Wi-Fi when its API is open there. The app re-reads its settings
 * when none of its addresses answers. Nothing is written when nothing changed: a bar is not touched for nothing.
 * A bar whose list is no longer the one written from here was set up by another computer: it is let go.
 */
function keep() {
  let busy = false;
  const round = async () => {
    if (busy) return;
    busy = true;
    try {
      const config = loadConfig();
      if (!config.paired) return;
      const hosts = hostsFor(config.paired.wifi ?? null, PORT).join(",");
      if (hosts === config.paired.hosts || hosts === "") return;
      const ways = [USB_BAR, ...(config.paired.wifi ? [config.paired.wifi] : [])];
      for (const address of ways) {
        try {
          const info = await barInfo(address);
          if (info.id !== config.paired.id) continue;
          // Another computer set the bar up since: its addresses are there, not the ones written from here. The bar
          // is its now; this computer lets go rather than take it back.
          const there = hostOf(await appSettings(address, APP_ID));
          if (config.paired.hosts && there !== "" && there !== config.paired.hosts) {
            log(`the bar now calls ${there}: another computer set it up; this one stops keeping it`);
            config.paired = null;
            saveConfig(config);
            return;
          }
          await setAppSettings(address, APP_ID, hostPatch(hosts));
          config.paired.hosts = hosts;
          if (info.wifi?.connected) config.paired.wifi = info.wifi.address;
          saveConfig(config);
          log(`told the bar this computer's addresses: ${hosts} (through ${address})`);
          return;
        } catch {
          // That way is closed: the next one.
        }
      }
    } finally {
      busy = false;
    }
  };
  setInterval(() => void round(), 15_000);
}

// ---- the server ----------------------------------------------------------------------------------------------------

let logFile = null;
function log(text) {
  const line = `${new Date().toISOString()} ${text}`;
  if (logFile) appendFileSync(logFile, line + "\n");
  else console.log(line);
}

/** Loopback and private networks (RFC 1918, link-local): the bar is on one of these; the internet is not. */
function local(address) {
  const a = String(address ?? "").replace(/^::ffff:/, "");
  if (a === "::1") return true;
  const m = /^(\d+)\.(\d+)\./.exec(a);
  if (!m) return /^fe80:|^f[cd]/i.test(a);
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
}

/** Bars that asked for the speed since the daemon started: setup waits for the first one. */
const seen = new Set();

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const from = String(req.socket.remoteAddress).replace(/^::ffff:/, "");
    if (!local(from)) return send(403, { error: "local networks only" });
    const self = from === "127.0.0.1" || from === "::1";
    if (url.pathname === "/ping") return send(200, { version: VERSION, seen: [...seen] });
    if (url.pathname === "/quit" && self && req.method === "POST") {
      send(200, { ok: true });
      setTimeout(() => process.exit(0), 50);
      return;
    }
    if (url.pathname === "/speed") {
      seen.add(from);
      // No route to the internet at all (Wi-Fi off, cable out): the bar says NO NET rather than show a quiet line.
      if (looked && adapters === "") return send(200, { api: 1, internet: false, down: 0, up: 0, adapters: "", host: os.hostname() });
      const r = rate();
      if (r === null) return send(503, { error: "no counters yet" });
      return send(200, { api: 1, internet: true, down: Math.round(r.down * 100) / 100, up: Math.round(r.up * 100) / 100, adapters, host: os.hostname() });
    }
    send(404, { error: "not found" });
  });
  server.on("error", (err) => {
    log(err.code === "EADDRINUSE" ? `port ${PORT} is taken: the daemon already runs` : err.message);
    process.exit(1);
  });
  server.listen(PORT, "0.0.0.0", () => log(`Internet Speed daemon ${VERSION} on port ${PORT}`));
}

// ---- entry ---------------------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (args[0] === "setup") {
    const { setup } = await import("./setup.mjs");
    process.exit(await setup({ version: VERSION }));
  } else if (args[0] === "uninstall") {
    const { uninstall } = await import("./setup.mjs");
    process.exit(await uninstall());
  } else {
    const i = args.indexOf("--log");
    if (i >= 0) logFile = args[i + 1];
    if (process.platform === "win32") startWindows();
    else if (process.platform === "darwin") startMac();
    else startLinux();
    serve();
    keep();
  }
}

