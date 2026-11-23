// What traffic-meter.mjs and setup.mjs share: the port, the app's id, and the settings kept between runs.
// paired: { id, name, serial, wifi (the bar's Wi-Fi address, or null), hosts (the list last written to the bar) }.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PORT = 8792;
export const APP_ID = "app.mrlunev.net_traffic";
export const CONFIG_DIR = path.join(os.homedir(), ".config", "busy-net-traffic");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // First run.
  }
  return { paired: saved.paired ?? null };
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/** The address list in the app's settings: at the top level (settings version 4; version 3 had it in the group "setup"). */
export const hostOf = (values) => values?.host ?? values?.setup?.host ?? "";
export const hostPatch = (host) => ({ host });
