// Setup and uninstall for traffic-meter.mjs.
//
// setup: finds the bar (over the USB cable, where its API is always open, or on Wi-Fi), adds the daemon to the
// computer's login items and starts it, lets the bar through the Windows firewall, installs the prebuilt app on the
// bar, writes its settings (this computer's addresses) and starts it, then waits for the bar's first
// request: that proves the whole way, bar → computer, works.
//
// The login item needs no administrator rights: on Windows a hidden starter in the user's Run key, on macOS a
// LaunchAgent, on Linux an autostart entry.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appSettings, barInfo, installApp, launchApp, readText, removeApp, setAppSettings, stopApp, writeText } from "./bar-api.mjs";
import { findBars } from "./mdns.mjs";
import { APP_ID, CONFIG_DIR, hostOf, hostPatch, loadConfig, PORT, saveConfig } from "./config.mjs";
import { hostsFor, USB_BAR, USB_COMPUTER } from "./hosts.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "traffic-meter.mjs");
const BUNDLE = path.join(HERE, "..", "release", `${APP_ID}.tgz`);
const FIREWALL_RULE = "BusyNetTraffic";
const LOG = path.join(CONFIG_DIR, "daemon.log");
const LABEL = "app.mrlunev.net-traffic";
/**
 * The fingerprint of the package setup installed, kept next to the app on the bar. Installing an app replaces its
 * folder, so the file goes with any other copy: when it is there and matches, the bar has exactly this package.
 */
const MARK = `/ext/user_assets/${APP_ID}/package.sha256`;

const say = (text) => console.log(text);
/**
 * The Node.js the login item runs. install.sh passes the path it found on PATH (a link like /opt/homebrew/bin/node
 * that survives `brew upgrade`), where process.execPath is the versioned file behind it, gone after an upgrade.
 */
const NODE = process.env.BUSY_NODE || process.execPath;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ping() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/ping`, { signal: AbortSignal.timeout(500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function stopDaemon() {
  await fetch(`http://127.0.0.1:${PORT}/quit`, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(() => {});
  for (let i = 0; i < 20 && (await ping()); i += 1) await sleep(100);
}

// ---- login item -----------------------------------------------------------------------------------------------------

const winDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "busy-net-traffic");
const plist = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const desktop = () => path.join(os.homedir(), ".config", "autostart", "busy-net-traffic.desktop");

function macPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE}</string><string>${DAEMON}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`;
}

/** Whether the login item is already exactly this one (macOS; elsewhere it is rewritten every time, it is cheap). */
function loginItemCurrent() {
  if (process.platform !== "darwin") return false;
  try {
    return readFileSync(plist(), "utf8") === macPlist();
  } catch {
    return false;
  }
}

/** Adds the daemon to the login items and starts it now. */
function installLoginItem() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (process.platform === "win32") {
    // A VBScript starter runs node with no window; the Run key starts it at every login.
    mkdirSync(winDir(), { recursive: true });
    const starter = path.join(winDir(), "start.vbs");
    const quote = (s) => `""${s}""`;
    writeFileSync(starter, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${quote(NODE)} ${quote(DAEMON)} --log ${quote(LOG)}", 0, False\r\n`);
    spawnSync("reg", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "BusyNetTraffic", "/t", "REG_SZ", "/d", `wscript.exe "${starter}"`, "/f"], { stdio: "ignore" });
    // Started through WMI, so it belongs to no console's job and outlives the window setup runs in.
    const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'wscript.exe "${starter.replace(/'/g, "''")}"' }; exit $r.ReturnValue`;
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  } else if (process.platform === "darwin") {
    mkdirSync(path.dirname(plist()), { recursive: true });
    writeFileSync(plist(), macPlist());
    const uid = process.getuid();
    spawnSync("launchctl", ["bootout", `gui/${uid}`, plist()], { stdio: "ignore" });
    spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist()], { stdio: "ignore" });
  } else {
    mkdirSync(path.dirname(desktop()), { recursive: true });
    writeFileSync(desktop(), `[Desktop Entry]\nType=Application\nName=BUSY Net Traffic\nExec="${NODE}" "${DAEMON}" --log "${LOG}"\nX-GNOME-Autostart-enabled=true\n`);
    spawn(NODE, [DAEMON, "--log", LOG], { detached: true, stdio: "ignore" }).unref();
  }
}

function removeLoginItem() {
  if (process.platform === "win32") {
    spawnSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "BusyNetTraffic", "/f"], { stdio: "ignore" });
    rmSync(winDir(), { recursive: true, force: true });
  } else if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist()], { stdio: "ignore" });
    rmSync(plist(), { force: true });
  } else {
    rmSync(desktop(), { force: true });
  }
}

// ---- the earlier name -----------------------------------------------------------------------------------------------

/**
 * Until 22.11.2026 the app was "Internet Speed", with other folders, login item, firewall rules and app id. Setup
 * removes them, so two meters never fight over the port and the bar keeps one app.
 */
const EARLIER = {
  appId: "app.mrlunev.internet_speed",
  label: "app.busy.internet-speed",
  run: "BusyInternetSpeed",
  firewall: "BusyInternetSpeed",
  folders: () => [
    path.join(os.homedir(), ".busy-internet-speed"),
    path.join(os.homedir(), ".config", "busy-internet-speed"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "busy-internet-speed"),
  ],
  plist: () => path.join(os.homedir(), "Library", "LaunchAgents", "app.busy.internet-speed.plist"),
  desktop: () => path.join(os.homedir(), ".config", "autostart", "busy-internet-speed.desktop"),
};

/** Removes the earlier install from this computer. Returns whether there was one. */
async function removeEarlierInstall() {
  const runKey = ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", EARLIER.run];
  const found =
    EARLIER.folders().some((f) => existsSync(f)) ||
    existsSync(EARLIER.plist()) ||
    existsSync(EARLIER.desktop()) ||
    (process.platform === "win32" && spawnSync("reg", ["query", ...runKey], { stdio: "ignore" }).status === 0);
  if (!found) return false;
  say("Removing the earlier version, Internet Speed, from this computer...");
  if (process.platform === "win32") spawnSync("reg", ["delete", ...runKey, "/f"], { stdio: "ignore" });
  if (process.platform === "darwin" && existsSync(EARLIER.plist())) {
    // Unloading the LaunchAgent stops its daemon; KeepAlive would start it again after a plain quit.
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, EARLIER.plist()], { stdio: "ignore" });
  }
  rmSync(EARLIER.plist(), { force: true });
  rmSync(EARLIER.desktop(), { force: true });
  // Whatever still listens on the port is the earlier meter (or this one, which setup starts again below).
  await stopDaemon();
  for (const folder of EARLIER.folders()) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch (err) {
      say(`Could not remove ${folder} (${err.code}); delete it by hand.`);
    }
  }
  return true;
}

// ---- the bar ------------------------------------------------------------------------------------------------------

async function findBar() {
  try {
    return { address: USB_BAR, info: await barInfo(USB_BAR), usb: true };
  } catch {
    // No cable, or another bar; look on Wi-Fi.
  }
  const announced = await findBars({ timeoutMs: 3000 }).catch(() => []);
  for (const bar of announced) {
    try {
      return { address: bar.address, info: await barInfo(bar.address), usb: false };
    } catch {
      // Its API is closed over Wi-Fi (the default); the cable is the way in.
    }
  }
  return { announced };
}

/**
 * Windows: lets the bar's calls in, with one prompt for administrator rights. Two rules: the port, and Node.js
 * itself. The second keeps Windows from asking about Node.js when the meter first listens: a Cancel there makes
 * Block rules for node.exe, and a Block rule wins over any Allow.
 */
function allowThroughFirewall() {
  if (process.platform !== "win32") return;
  const ruleThere = () => spawnSync("netsh", ["advfirewall", "firewall", "show", "rule", `name=${FIREWALL_RULE}`], { encoding: "utf8" }).status === 0;
  if (ruleThere()) return;
  say(`Windows will ask to let the bar reach this computer on port ${PORT}. Click Yes.`);
  const port = `netsh advfirewall firewall add rule name=${FIREWALL_RULE} dir=in action=allow protocol=TCP localport=${PORT} profile=any`;
  const node = `netsh advfirewall firewall add rule name=${FIREWALL_RULE}Node dir=in action=allow program="${process.execPath}" profile=any`;
  const earlier = spawnSync("netsh", ["advfirewall", "firewall", "show", "rule", `name=${EARLIER.firewall}`], { stdio: "ignore" }).status === 0
    ? ` & netsh advfirewall firewall delete rule name=${EARLIER.firewall} & netsh advfirewall firewall delete rule name=${EARLIER.firewall}Node`
    : "";
  const both = `/c ${port} & ${node}${earlier}`.replace(/'/g, "''");
  spawnSync("powershell", ["-NoProfile", "-Command", `Start-Process cmd -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '${both}'`], { stdio: "inherit" });
  if (!ruleThere()) say("The firewall rule was not added (was the prompt declined?): the bar can reach this computer only once it is.");
}

/**
 * macOS: the application firewall, when it is on, blocks the bar's calls to Node.js (and with "block all incoming"
 * blocks them whatever is allowed). When it is off, as by default, nothing is touched and no password is asked.
 */
function allowThroughMacFirewall() {
  if (process.platform !== "darwin") return;
  const fw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
  const out = (args) => spawnSync(fw, args, { encoding: "utf8" }).stdout ?? "";
  if (!/enabled/i.test(out(["--getglobalstate"]))) return;
  if (/enabled/i.test(out(["--getblockall"]))) {
    say("The Mac's firewall blocks all incoming connections, so the bar cannot reach this Mac over Wi-Fi. Turn that off in System Settings, Network, Firewall, Options, or keep the bar on the cable.");
    return;
  }
  const node = spawnSync("realpath", [NODE], { encoding: "utf8" }).stdout?.trim() || NODE;
  if (/permitted|allow/i.test(out(["--getappblocked", node])) && !/blocked/i.test(out(["--getappblocked", node]))) return;
  say("The Mac's firewall is on: allowing Node.js to receive the bar's calls. Type your Mac password if asked.");
  spawnSync("sudo", [fw, "--add", node], { stdio: "inherit" });
  spawnSync("sudo", [fw, "--unblockapp", node], { stdio: "inherit" });
}

/** @returns {Promise<number>} the exit code */
export async function setup({ version }) {
  say("Looking for the BUSY Bar...");
  const found = await findBar();
  if (!found.info) {
    if (found.announced?.length) say(`Found ${found.announced.map((b) => b.name || b.id).join(", ")} on Wi-Fi, but a bar only lets a computer set it up over the cable.`);
    say("Connect the bar to this computer with a USB cable, then run this again.");
    return 1;
  }
  const { address, info } = found;
  say(`Bar: ${info.name || info.id} (${info.serial}), firmware ${info.firmware}`);

  const wifi = info.wifi?.connected ? info.wifi.address : null;
  const hostList = hostsFor(wifi, PORT);
  const onWifi = wifi !== null && hostList.some((h) => h !== `${USB_COMPUTER}:${PORT}`);
  if (hostList.length === 0) {
    say("The bar and this computer share no network. Connect the bar to the same Wi-Fi (BUSY app) or by cable.");
    return 1;
  }
  if (!wifi) say("The bar is not on Wi-Fi, so it works only while the cable is plugged in. Connect it to Wi-Fi in the BUSY app and run this again to go without the cable.");
  else if (!onWifi) say(`The bar is on Wi-Fi "${info.wifi.ssid}", and this computer is on another network: it works while the cable is plugged in.`);

  const config = loadConfig();
  const hosts = hostList.join(",");
  config.paired = { id: info.id, name: info.name, serial: info.serial, wifi, hosts: config.paired?.id === info.id ? config.paired.hosts : null };
  saveConfig(config);
  allowThroughFirewall();
  allowThroughMacFirewall();
  await removeEarlierInstall();

  let up = (await ping())?.version === version && loginItemCurrent();
  if (up) {
    say("The traffic meter on this computer is already this version and starts at login.");
  } else {
    say("Starting the traffic meter on this computer (it will start by itself at every login)...");
    await stopDaemon();
    installLoginItem();
    for (let i = 0; i < 50 && !up; i += 1) {
      await sleep(100);
      up = (await ping())?.version === version;
    }
  }
  if (!up) {
    say(`The traffic meter did not start. Its log: ${LOG}`);
    return 1;
  }

  if (!existsSync(BUNDLE)) {
    say(`The app bundle is missing: ${BUNDLE}`);
    return 1;
  }
  // The bar deletes an app only when it is not running; setup quits the running app below anyway.
  await stopApp(address, EARLIER.appId).catch(() => {});
  if (await removeApp(address, EARLIER.appId).catch(() => false)) say("Removed the earlier version, Internet Speed, from the bar.");
  const fingerprint = createHash("sha256").update(readFileSync(BUNDLE)).digest("hex");
  if ((await readText(address, MARK))?.trim() === fingerprint) {
    say("The app on the bar is already this version.");
  } else {
    say("Installing the app on the bar...");
    try {
      await stopApp(address, APP_ID).catch(() => {});
      await installApp(address, BUNDLE);
      await writeText(address, MARK, fingerprint).catch(() => {});
    } catch (err) {
      say(`Could not install the app: ${err.message}`);
      if (/404/.test(err.message)) say("This bar's firmware has no apps yet. Update it in the BUSY app.");
      return 1;
    }
  }
  // The settings are written only when they differ; the app is (re)started so it runs with them now.
  const current = await appSettings(address, APP_ID).catch(() => null);
  await stopApp(address, APP_ID).catch(() => {});
  if (hostOf(current) !== hosts) await setAppSettings(address, APP_ID, hostPatch(hosts));
  config.paired.hosts = hosts;
  saveConfig(config);
  await launchApp(address, APP_ID);

  say("Waiting for the bar to ask for the speed...");
  const wanted = new Set([USB_BAR, ...(wifi ? [wifi] : [])]);
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const seen = (await ping())?.seen ?? [];
    if (seen.some((a) => wanted.has(a))) {
      say("Done: the bar shows this computer's network traffic.");
      if (onWifi) say(`It works over Wi-Fi "${info.wifi.ssid}"; you can unplug the cable.`);
      say("If this computer changes networks or addresses, the traffic meter tells the bar by itself.");
      return 0;
    }
  }
  say("The bar can't reach this computer.");
  if (process.platform === "win32") say("Check Windows Firewall: Node.js may have Block rules from an earlier prompt.");
  say(`It calls ${hostList.join(" or ")}. A firewall, a VPN that blocks the local network, or a guest Wi-Fi network can stand in the way.`);
  return 1;
}

export async function uninstall() {
  await stopDaemon();
  removeLoginItem();
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  say("The traffic meter is stopped and will not start at login any more; its settings are removed.");
  if (process.platform === "win32") say(`The firewall rules ${FIREWALL_RULE} and ${FIREWALL_RULE}Node stay; remove them in Windows Defender Firewall if you like.`);
  say("Delete the app on the bar in the BUSY app.");
  return 0;
}
