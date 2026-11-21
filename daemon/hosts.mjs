// Which of this computer's addresses the bar should call, in the order it should try them.
//
// The bar cannot resolve names (a `.local` name fails with "DNS lookup failed", probe of 21.11), so it gets
// addresses. A dead address costs the app 5 s frozen ("Inactivity timeout"; a closed port fails at once), so the
// list holds only addresses the bar can plausibly reach:
//
//   1. this computer's addresses on the bar's Wi-Fi network (same subnet): computer on Wi-Fi or on a cable to the
//      same router, the bar on Wi-Fi;
//   2. the USB cable's 10.0.4.21, when the bar is plugged in: works whatever network either is on;
//   3. only when neither exists, the other private addresses (a router that gives cable and Wi-Fi different
//      subnets but routes between them).
//
// VPN tunnels, virtual machines' and containers' bridges are never in the list: the bar cannot reach them.

import os from "node:os";

export const USB_BAR = "10.0.4.20";
export const USB_COMPUTER = "10.0.4.21";

/** Interfaces that are never the way from the bar to this computer. */
const VIRTUAL = /^(utun|ipsec|ppp|tun|tap|awdl|llw|bridge|vmnet|vboxnet|docker|veth|br-|virbr|zt|tailscale|wg|vEthernet|Npcap)/i;

const toNumber = (a) => a.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

function isPrivate(address) {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** This computer's usable IPv4 addresses: [{ name, address, netmask }]. */
export function ownAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || !isPrivate(a.address)) continue;
      out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

/**
 * The addresses for the bar's settings, best first, as "address:port". `barWifi` is the bar's Wi-Fi address when
 * known (null when it is not on Wi-Fi or unknown).
 */
export function hostsFor(barWifi, port, interfaces = os.networkInterfaces()) {
  const own = ownAddresses(interfaces);
  const near = barWifi
    ? own.filter((a) => (toNumber(a.address) & toNumber(a.netmask)) === (toNumber(barWifi) & toNumber(a.netmask))).map((a) => a.address)
    : [];
  const usb = own.some((a) => a.address === USB_COMPUTER) ? [USB_COMPUTER] : [];
  let list = [...near, ...usb];
  if (list.length === 0) list = own.map((a) => a.address).filter((a) => a !== USB_COMPUTER);
  return [...new Set(list)].map((a) => `${a}:${port}`);
}
