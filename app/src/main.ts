// Internet Speed: the computer's traffic on the front display's speedometer (Figma "Apps for BUSY Bar Catalog",
// node 85:40269). The companion on the computer (daemon/speed-daemon.mjs) answers GET /speed.
// Everything that moves is baked into .anim files by tools/make-anim.py; a reading change is one small draw.

import manifest from "./appmeta/manifest.json";
import { helpElements, type Message, type WebAddress } from "./help.ts";

const APP = manifest.id;
const API = `http://${__BUSY_ADDR__}/api`;
/** The /speed api this app speaks. */
const API_VERSION = 1;

const POLL_MS = 500;
/** No speed for this long: the dial goes grey. */
const LOST_MS = 3500;
/** While nothing answers. A dead address freezes the app for the firmware's 5 s timeout, keys included. */
const RETRY_MS = 5000;
/** While nothing answers, re-read the settings: the companion writes the computer's new addresses there. */
const REREAD_MS = 30_000;
/** No answer at all for this long: NO PC. Before that the dial just rests grey. */
const NO_PC_MS = 10_000;
/** While a message is up, look again at where the bar's web page opens: Wi-Fi may join, a cable come. */
const HELP_REFRESH_MS = 30_000;

const FRAME_MS = 40; // 25 frames a second
const WAKE_MS = 18 * FRAME_MS; // the wake sweep, before its still frames
const K = 21; // needle positions baked by make-anim.py
/** Ends of the auto scale, Mbit/s: it steps up to the next one the speed passes. */
const AUTO_SCALES = [50, 100, 200, 300, 500, 1000, 2000, 5000, 10000];

const report = (err: unknown) => console.error(`${APP}: ${String((err as { message?: unknown } | null)?.message ?? err)}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- readings ------------------------------------------------------------------------------------------------------

let scale = AUTO_SCALES[1]; // Mbit/s at the end of the arc
let autoScale = true;

/** Needle position 0..K-1. */
const place = (mb: number) => Math.round(Math.min(1, Math.max(0, mb / scale)) * (K - 1));

/** Name of the baked reading: Mbit/s exact to 299, by tens to 990, then Gbit/s by tenths. UP is narrower: Gbit/s past 99. */
function reading(mb: number, room: "down" | "up"): string {
  const gb = () => {
    const t = Math.max(1, Math.min(99, Math.round(mb / 100)));
    return `${Math.floor(t / 10)}_${t % 10}_Gb`;
  };
  if (room === "up") return mb < 99.5 ? `${Math.max(0, Math.round(mb))}_Mb` : gb();
  if (mb < 299.5) return `${Math.max(0, Math.round(mb))}_Mb`;
  if (mb < 995) return `${Math.round(mb / 10) * 10}_Mb`;
  return gb();
}

/** Star level 0..4 by how far up the scale the speed is. */
function stars(mb: number): number {
  const f = mb / scale;
  return mb < 0.5 ? 0 : f < 0.28 ? 1 : f < 0.55 ? 2 : f < 0.8 ? 3 : 4;
}

/** Frames of a needle move; make-anim.py bakes the same. */
const moveFrames = (j: number, k: number) => 4 + Math.round(Math.abs(k - j) * 0.35);

// ---- elements ------------------------------------------------------------------------------------------------------

const layer = (id: string, z: number) => ({ id, x: 0, y: 0, z_index: z, display: "front" });
const base = { ...layer("base", 0), type: "image", path: "images/base.png" };
// Each animation section loops; the next one is queued behind it (a section that ends stops the player for good).
const starfield = (section: string, queued = false) => ({
  ...layer("stars", 1), type: "animation", path: "animations/stars.anim", section, loop: true, await_previous_end: queued,
});
const gauge = (section: string, queued = false) => ({
  ...layer("gauge", 2), type: "animation", path: "animations/gauge.anim", section, loop: true, await_previous_end: queued,
});
/** DOWN and UP, or a message in their place. */
const labels = (grey: boolean, message: Message | null = null) => ({
  ...layer("labels", 3), type: "image",
  path: message !== null ? `images/msg_${message}.png` : grey ? "images/labels_off.png" : "images/labels.png",
});
/** A reading: grey 0 Mb without data, nothing under a message. UP sits 1 px left of the Figma place. */
const value = (id: "down" | "up", mb: number | null, message: Message | null = null) => ({
  ...layer(id, 4), type: "image",
  path: message !== null ? "images/none.png" : mb === null ? "images/v_off.png" : `images/v_${reading(mb, id)}.png`,
  x: id === "down" ? 21 : 49, y: 8,
});

async function request(method: "POST" | "DELETE", body: object): Promise<void> {
  const res = await fetch(`${API}/display/draw`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ application_name: APP, ...body }),
  });
  const answer = await res.text();
  if (!res.ok) throw new Error(`${method} draw: ${res.status} ${answer}`);
}
const draw = (elements: object[]) => request("POST", { priority: 50, elements });
const erase = (ids: string[]) => request("DELETE", { element_ids: ids });

// ---- state ---------------------------------------------------------------------------------------------------------

let stopped = false;
let startedAt = Date.now();
let lastAnswerAt = 0; // any answer from the computer
let lastSpeedAt = 0; // an answer with a speed to show
let speed = { down: 0, up: 0 }; // Mbit/s
/** What the front says instead of the readings; null: the dial, live or grey. */
let message: Message | null = null;

/** The dial is live while speeds keep coming and nothing is wrong. */
const live = () => message === null && Date.now() - lastSpeedAt < LOST_MS;

// ---- front display -------------------------------------------------------------------------------------------------

type Dial = "off" | "waking" | "live";
let dial: Dial = "off";
let needle = 0; // where the needle is, or is going
let busyUntil = 0; // a move or the wake plays until then
let shown: { down: string; up: string; stars: number; message: Message | null } = { down: "", up: "", stars: 0, message: null };
let drawing = false;
let again = false;

/** Brings the front to what it should show; calls during a draw fold into one more pass. */
async function update(): Promise<void> {
  if (drawing) {
    again = true;
    return;
  }
  drawing = true;
  try {
    do {
      again = false;
      await step();
    } while (again && !stopped);
  } catch (err) {
    report(err);
  } finally {
    drawing = false;
  }
}

async function step(): Promise<void> {
  if (stopped) return;
  const now = Date.now();
  const online = live();
  const down = online ? speed.down : 0;
  const up = online ? speed.up : 0;
  const level = online ? stars(down) : 0;
  const texts = online ? { down: reading(down, "down"), up: reading(up, "up") } : { down: message ?? "off", up: message ?? "off" };
  const values = online ? [value("down", down), value("up", up)] : [value("down", null, message), value("up", null, message)];
  const rest = [...values, ...(level !== shown.stars ? [starfield(`s_${level}`)] : [])];
  const changed = texts.down !== shown.down || texts.up !== shown.up || level !== shown.stars;

  // A message appears, changes or goes while the dial is grey.
  if (!online && message !== shown.message) {
    await draw([labels(true, message), ...values]);
    shown = { ...texts, stars: level, message };
    if (dial === "off") return;
  }

  if (online && dial === "off") {
    // Wake: the colour comes back as the needle sweeps to the end and back.
    dial = "waking";
    needle = 0;
    busyUntil = now + WAKE_MS;
    await draw([gauge("wake"), starfield("fade_on"), labels(false), ...values]);
    await draw([gauge("h_0", true), starfield("s_0", true)]);
    setTimeout(() => void update(), WAKE_MS);
    // The wake ends on the starless loop: the pass after it starts the stars for the speed.
    shown = { ...texts, stars: 0, message: null };
    return;
  } else if (!online && dial !== "off") {
    // Drop: the needle falls and the colour goes.
    const from = needle;
    dial = "off";
    needle = 0;
    busyUntil = 0;
    await draw([gauge(`drop_${from}`), starfield("fade_off"), labels(true, message), ...values]);
    await draw([gauge("off", true), starfield("off", true)]);
  } else if (dial !== "off" && now >= busyUntil) {
    dial = "live";
    const to = place(down);
    if (to !== needle) {
      const from = needle;
      needle = to;
      const ms = moveFrames(from, to) * FRAME_MS;
      busyUntil = now + ms;
      await draw([gauge(`m_${from}_${to}`), ...rest]);
      await draw([gauge(`h_${to}`, true)]);
      setTimeout(() => void update(), ms + 10);
    } else if (changed) {
      await draw(rest);
    }
  } else if (changed) {
    await draw(rest);
  } else {
    return;
  }
  shown = { ...texts, stars: level, message: online ? null : message };
}

// ---- back display --------------------------------------------------------------------------------------------------

/** Where the bar's web page opens: Wi-Fi when its API is open there without a password; USB when the port has power. */
async function webAddresses(): Promise<WebAddress[]> {
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(`${API}/${path}`);
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const [wifi, access, power] = await Promise.all([
    get<{ state?: string; ip_config?: { address?: string } }>("wifi/status"),
    get<{ mode?: string }>("access"),
    get<{ usb_voltage?: number }>("status/power"),
  ]);
  const out: WebAddress[] = [];
  if (wifi?.state === "connected" && wifi.ip_config?.address && access?.mode === "enabled") out.push({ how: "Wi-Fi", address: wifi.ip_config.address });
  // A charger cannot be told from a computer's port.
  if ((power?.usb_voltage ?? 0) > 4000) out.push({ how: "USB", address: "10.0.4.20" });
  return out;
}

let helpIds: string[] = [];
let helpKey = "";
let helpAt = 0;
let helpBusy = false;
let helpAgain = false;

/** Shows the help for the current message on the back display, or clears it. One run at a time. */
async function help(): Promise<void> {
  if (helpBusy) {
    helpAgain = true;
    return;
  }
  helpBusy = true;
  try {
    do {
      helpAgain = false;
      helpAt = Date.now();
      const elements = message === null ? [] : helpElements(message, await webAddresses());
      const key = JSON.stringify(elements);
      if (key === helpKey) continue;
      const ids = elements.map((e) => e.id);
      // helpIds holds only ids that are on the screen: DELETE fails whole on one that is not.
      const gone = helpIds.filter((id) => !ids.includes(id));
      if (gone.length > 0) {
        await erase(gone);
        helpIds = helpIds.filter((id) => ids.includes(id));
      }
      if (elements.length > 0) await draw(elements);
      helpIds = ids;
      helpKey = key;
    } while (helpAgain && !stopped);
  } catch (err) {
    report(err);
    helpKey = ""; // draw again next time
  } finally {
    helpBusy = false;
  }
}

// ---- the computer --------------------------------------------------------------------------------------------------

let hosts: string[] = [];
let scaleSetting = "";
let lastRead = 0;

/** Asks each address for the speed; the one that answers goes first next time. */
async function ask(): Promise<{ down: number; up: number; internet: boolean; api: number } | null> {
  for (let i = 0; i < hosts.length; i += 1) {
    try {
      const res = await fetch(`http://${hosts[i]}/speed`);
      if (!res.ok) {
        await res.text().catch(() => "");
        continue;
      }
      const body = (await res.json()) as { down?: number; up?: number; internet?: boolean; api?: number };
      if (i > 0) hosts = [hosts[i], ...hosts.slice(0, i), ...hosts.slice(i + 1)];
      // A companion older than api 1 sends no api.
      return { down: Number(body.down) || 0, up: Number(body.up) || 0, internet: body.internet !== false, api: Number(body.api) || 0 };
    } catch {
      // Not there: the next address.
    }
  }
  return null;
}

async function readSettings(): Promise<void> {
  lastRead = Date.now();
  try {
    const res = await fetch(`${API}/apps/settings?app_id=${APP}`);
    type Fields = { host?: string; scale?: string };
    const values: Fields = ((await res.json()) as { values?: Fields }).values ?? {};
    hosts = String(values.host ?? "").split(",").map((h) => h.trim()).filter((h) => h !== "");
    const setting = String(values.scale ?? "auto");
    if (setting !== scaleSetting) {
      // Only a changed setting resets the scale: an auto scale keeps what it has grown to.
      scaleSetting = setting;
      const fixed = Number(setting);
      autoScale = !(fixed > 0);
      scale = autoScale ? AUTO_SCALES[1] : fixed;
    }
  } catch (err) {
    report(err);
  }
}

/** What the front should say, from the latest answer (null: none). */
function judge(got: Awaited<ReturnType<typeof ask>>, now: number): Message | null {
  if (hosts.length === 0) return "setup";
  if (got === null) {
    if (now - Math.max(lastAnswerAt, startedAt) > NO_PC_MS) return "nopc";
    // A missed answer or two keeps the message there was, so the screen does not flicker.
    return message === "setup" ? null : message;
  }
  if (got.api !== API_VERSION) return "update";
  if (!got.internet) return "nonet";
  return null;
}

async function poll(): Promise<void> {
  while (!stopped) {
    const started = Date.now();
    const got = hosts.length > 0 ? await ask() : null;
    const now = Date.now();
    if (got === null && now - lastRead > REREAD_MS) await readSettings();
    if (got !== null) lastAnswerAt = now;

    const before = message;
    message = judge(got, now);
    if (got !== null && message === null) {
      lastSpeedAt = now;
      speed = got;
      while (autoScale && speed.down > scale && scale < AUTO_SCALES[AUTO_SCALES.length - 1]) {
        scale = AUTO_SCALES.find((s) => s > scale) ?? scale;
      }
    }
    void update();
    if (message !== before || (message !== null && now - helpAt > HELP_REFRESH_MS)) void help();

    await sleep(Math.max(50, (got !== null ? POLL_MS : RETRY_MS) - (Date.now() - started)));
  }
}

// ---- start ---------------------------------------------------------------------------------------------------------

let tick: ReturnType<typeof setInterval> | null = null;

async function start(): Promise<void> {
  await draw([base, starfield("off"), gauge("off"), labels(true), value("down", null), value("up", null)]);
  shown = { down: "off", up: "off", stars: 0, message: null };
  await readSettings();
  startedAt = Date.now();
  void poll();
  // Lets a grey dial notice the speed is gone even between answers.
  tick = setInterval(() => void update(), POLL_MS);
}

start().catch(report);

const unbind = listen("input", (event) => {
  if (event.action === "short" && event.key === "back") {
    stopped = true;
    if (tick) clearInterval(tick);
    // Not from inside the handler: with nothing left, the unbind stops the app on the spot.
    setTimeout(unbind, 0);
  }
});
