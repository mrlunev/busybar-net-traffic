# Net Traffic on the BUSY Bar

![Net Traffic on the BUSY Bar: the needle climbs from zero to 940 Mbit/s and drops back](media/demo.webp)

Your computer's live network traffic on the BUSY Bar: download on the needle, download and upload in numbers. It
shows what the computer moves right now; it is not a speed test.

You need: a BUSY Bar, a Mac or a Windows PC, and a USB cable.

> [!NOTE]
> **What the installer does.** Uses your Node.js 20+ if you have one. If not, or on a Mac where it comes from a
> version manager (nvm, fnm, Volta, asdf, n): on a Mac it puts a private copy from nodejs.org into
> `~/.busy-net-traffic` (checksum verified, nothing else on the system changes); on Windows it
> installs Node.js with winget or the official installer. Then it puts the traffic meter in `~/.busy-net-traffic`,
> adds it to the login items (a LaunchAgent on macOS, the Run key on Windows; no administrator rights), and over the
> USB cable puts the app on the bar and saves this computer's addresses in its settings. On Windows it also opens
> port 8792 in the firewall, asking you once.
>
> **What runs afterwards.** The traffic meter counts the bytes your network adapter sends and receives and gives the
> rate to devices on your local network. Nothing else.
>
> **What it never does.** Sends anything to the internet, or looks at what you download.
>
> Read it first if you like: [install.sh](install.sh), [install.ps1](install.ps1), [the traffic meter](daemon).

## macOS

1. Connect the bar to your Mac with the USB cable.
2. Open Terminal and paste:
   ```
   curl -fsSL https://raw.githubusercontent.com/mrlunev/busybar-net-traffic/main/install.sh | bash
   ```
   If it asks for your Mac password (only when the firewall is on), type it and press Return.

Done when it says so. Unplug the cable if the bar and the Mac are on the same Wi-Fi.

## Windows

1. Connect the bar to your PC with the USB cable.
2. Open PowerShell and paste:
   ```
   irm https://raw.githubusercontent.com/mrlunev/busybar-net-traffic/main/install.ps1 | iex
   ```
   When Windows asks to allow changes, click **Yes**.

Done when it says so. Unplug the cable if the bar and the PC are on the same Wi-Fi.

## Linux

The macOS command works too; the traffic meter starts with your desktop session (`~/.config/autostart`).

## On the bar

- The dial's end follows the speed (**Auto**). A fixed end: in the bar's web page, **Apps → Net Traffic → Dial scale**.
- Download in Mbit/s up to 990, then Gbit/s. Upload in Gbit/s from 100 Mbit/s.
- **Back** closes the app.
- The computer changes networks or addresses: the traffic meter tells the bar by itself.

## FAQ

Most problems are fixed the same way: connect the bar with the USB cable and run the install command again. It keeps
what works and fixes the rest, and says what is in the way.

**SET UP.** The app has no computer address: it was installed from the BUSY Apps catalog. Run the install command.

**NO PC.** The bar gets no answer: the computer is asleep or off, on another network, or a firewall, VPN or guest
Wi-Fi blocks the local network. The back screen shows the bar's address to open in a browser.

**NO NET.** The computer has no internet connection.

**UPDATE.** The traffic meter and the app are different versions. Run the install command.

**Had Internet Speed?** That was this app's earlier name. Run the install command: it removes Internet Speed from the
computer and the bar.

**A new computer.** Install on it. The bar works with one computer at a time, the last one set up.

**Still stuck?** [Open an issue](https://github.com/mrlunev/busybar-net-traffic/issues) and say what the bar shows.

## Remove

macOS (if `node` is not found, use `~/.busy-net-traffic/.node/bin/node`):

```
node ~/.busy-net-traffic/daemon/traffic-meter.mjs uninstall
rm -rf ~/.busy-net-traffic
```

Windows, in PowerShell:

```
node $HOME\.busy-net-traffic\busybar-net-traffic-main\daemon\traffic-meter.mjs uninstall
Remove-Item -Recurse $HOME\.busy-net-traffic
```

The firewall rules `BusyNetTraffic` and `BusyNetTrafficNode` stay; remove them in Windows Defender Firewall if you
like.

Then delete the app on the bar in the BUSY app.

## Source

- [`app/`](app): the app for the bar (TypeScript, `busy-cli build`). The dial, the needle and the stars are `.anim`
  files baked by `app/tools/make-anim.py`.
- [`daemon/`](daemon): the traffic meter (Node.js 20+, no dependencies) and the setup. `release/` holds the built app
  that setup puts on the bar.

## License

MIT, see [LICENSE](LICENSE).
