# IP Scanner

A macOS network scanner styled after Advanced IP Scanner. It finds every alive IPv4 device on
your network and lists each one's **name**, **IP**, **manufacturer**, **MAC address** and
**open services**. Expand a device to see its services, and double-click one to open it.

The scanning code uses only built-in Python, so there is nothing to `pip install`.

## Install from the DMG (easiest)

The DMG contains a self-contained **IP Scanner.app** with Python built in, so you don't need to
install Python, Git or anything else. It runs on both Apple silicon and Intel Macs.

1. Download **IP-Scanner-x.y.z.dmg** from the repo's
   [Releases](https://github.com/rickkollins/IP-Scanner/releases) page.
2. Double-click the DMG, then drag **IP Scanner** onto the **Applications** shortcut in the window.
3. Eject the DMG, then open IP Scanner from Applications or Launchpad.

**First launch:** the app isn't notarized by Apple, so the first time you open a downloaded copy
macOS says it "cannot verify" the app. Click **Done**, then go to **System Settings → Privacy &
Security**, scroll down and click **Open Anyway** next to the IP Scanner message. Enter your
password, and click **Open**. You only need to do this once. Alternatively, run this in
Terminal: `xattr -dr com.apple.quarantine "/Applications/IP Scanner.app"`.

### Building the DMG yourself

On your Mac, with Python from python.org installed:

```bash
cd ~/IP-Scanner && ./make_dmg.sh
```

This creates `dist/IP-Scanner-<version>.dmg` and shows it in Finder. A DMG you build yourself
opens without the "cannot verify" step. The app icon comes from `packaging/icon.icns`; to change
it, edit `packaging/make_icon.py` and run it (needs `pip install pillow`). GitHub also builds the DMG automatically on every push:
open the repo's **Actions** tab, click the latest **Build DMG** run, and download
**IP-Scanner-dmg** under *Artifacts*. When `main` gets a new version number (`__version__` in
`scanner.py`), GitHub publishes the DMG as a release automatically.

## Install from source (Terminal)

**1. Install Python** from [python.org/downloads](https://www.python.org/downloads/): click
**Download Python** and run the installer. (Homebrew users can run `brew install python-tk`
instead.) macOS has a built-in Python, but its window toolkit (Tk 8.5) is old and can show a
blank window on recent macOS.

**2. Open Terminal** (press ⌘ Space, type **Terminal**, press Return), paste this line and press
Return:

```bash
git clone https://github.com/rickkollins/IP-Scanner.git ~/IP-Scanner && ~/IP-Scanner/build_app.sh
```

If macOS asks to install the **command line developer tools**, click **Install**, wait for it to
finish, then paste the line again.

**3. Done.** Terminal prints `Installed: /Applications/IP Scanner.app`, Finder shows the app,
and it opens. From now on, start it from Finder → Applications, Launchpad or Spotlight
(⌘ Space, "IP Scanner"), or drag it to your Dock. If your account can't write to
`/Applications`, the app goes into the Applications folder inside your home folder instead.

**First scan:**

- macOS may ask to allow IP Scanner to find devices on your **local network**. Click
  **Allow**, or the scan finds nothing. If you missed the prompt, turn it on in
  **System Settings → Privacy & Security → Local Network**.
- With **Clear ARP & DNS cache before scan** ticked (the default), macOS asks for your
  password before each scan, because clearing those caches needs admin rights. Untick the box
  to skip this.

### Updating

```bash
cd ~/IP-Scanner && git pull && ./build_app.sh
```

### Uninstalling

Drag **IP Scanner** from Applications to the Trash, then run `rm -rf ~/IP-Scanner ~/.ip_scanner.json`.

### Troubleshooting

| Problem | Fix |
|---|---|
| Terminal shows `dquote>` | A quote mark wasn't closed. Press **Control + C** and paste the command again. |
| `destination path ... already exists` | It's already downloaded. Use the **Updating** command above. |
| The window is blank or doesn't appear | Install Python from python.org (step 1), then open the app again. |
| "Python 3 with Tkinter was not found" | Install Python from python.org (step 1). |
| The scan finds nothing, or only your Mac | Allow **Local Network** access (see *First scan* above). |
| Anything else | Run `"/Applications/IP Scanner.app/Contents/MacOS/IP Scanner"` in Terminal to see the error message. |

## Using it

1. The range box is filled in with your Mac's network, e.g. `192.168.1.1-254`. You can also
   type ranges (`10.0.0.1-50`, `10.0.0.1-10.0.1.255`), subnets (`10.0.0.0/24`) or single IPs,
   separated by commas. **My network** fills in your current network again. The limit is
   65,536 addresses (a /16).
2. Press **Scan** (⌘R). Devices appear as they're found. The status bar shows
   *N alive, M dead*.
3. Click a column heading to sort, and use **Search** to filter by name, IP, maker, MAC or
   service.
4. Click the ▸ arrow on a device to see its open services, or click **Expand All** in the toolbar
   to open every device at once (click again for **Collapse All**). While Expand All is on,
   newly found devices appear expanded too. **Double-click** a service to open it:
   web ports open in your browser, SSH opens Terminal, SMB/AFP open Finder, and VNC opens
   Screen Sharing.
5. **Right-click** a device to open a service, copy its IP, name or MAC, or rescan just that
   device.
6. **File → Export CSV…** (⌘E) saves the list.

### Printing

Click **Print…** in the toolbar (or **File → Print…**, ⌘P). The app builds a **landscape table**
of the results and opens it in Preview. Press **⌘P** in Preview to choose a printer and print.

- The report uses the same columns as the app: #, Name, IP, Manufacturer, MAC address and
  Comments. Every device is shown **expanded**: below it, each open service gets its own row with
  the service name, `port N` and its link (e.g. `https://192.168.0.25:5001/`).
- It prints the list **as shown**: in the current sort order, and only the matching devices if
  you've typed in **Search**.
- The header shows the range scanned, the date, how many hosts were alive and which ports were
  checked. Long reports continue onto more pages, with the column headings and page numbers
  repeated on each page. A device and its services are kept on the same page where possible.
- Paper size is US Letter, or A4 if your Mac is set to metric units (System Settings → General →
  Language & Region).
- **File → Save as PDF…** saves the same report to a file instead.

## Ports checked

All of these are checked by default. You can edit the **Ports** box, which accepts ranges like
`8000-8100`; **Defaults** restores the list.

| Port | Service | Port | Service | Port | Service |
|-----:|---------|-----:|---------|-----:|---------|
| 21 | FTP | 548 | AFP | 5432 | PostgreSQL |
| 22 | SSH | 554 | RTSP (cameras) | 5900 | VNC / Screen Sharing |
| 23 | Telnet | 631 | IPP (printing) | 7000 | AirPlay |
| 25 | SMTP | 993 | IMAPS | 8000 | HTTP (alt) |
| 53 | DNS | 995 | POP3S | 8008 | HTTP (alt) |
| 80 | HTTP | 1883 | MQTT | 8080 | HTTP proxy |
| 81 | HTTP (alt) | 3000 | HTTP (dev) | 8081 | HTTP (alt) |
| 110 | POP3 | 3306 | MySQL | 8123 | Home Assistant |
| 135 | MS RPC | 3389 | RDP | 8443 | HTTPS (alt) |
| 139 | NetBIOS | 4007 | — | 8888 | HTTP (alt) |
| 143 | IMAP | 4008 | — | 9000 | HTTP (alt) |
| 443 | HTTPS | 5000 | HTTP (UPnP / Synology) | 9100 | Printer (JetDirect) |
| 445 | SMB | 5001 | HTTPS (Synology) | 32400 | Plex |
| | | | | 62078 | Apple device sync |

## How a scan works

1. **Clear caches** (optional, on by default): wipes the ARP cache (`arp -a -d`) and the DNS
   cache (`dscacheutil -flushcache`, `killall -HUP mDNSResponder`). Without this, devices that
   have left the network can still show up as alive, and renamed devices can keep their old
   names.
2. **Discovery**: pings every address, 128 at a time. The pings also refill the ARP cache, so
   devices that ignore ping but answer ARP (firewalled Macs, Windows PCs) are found as well.
3. **Ports**: every port on every alive device is checked in parallel.
4. **Names**: reverse DNS first, then Bonjour/mDNS (`name.local`), then NetBIOS (Windows
   names).
5. **Manufacturer**: looked up from the MAC address in the bundled IEEE vendor list
   (`data/oui.txt.gz`). Phones and laptops that use a private Wi-Fi address show
   *Private (randomized MAC)*.

A /24 network (254 addresses) usually takes 10–20 seconds.

## Command line

Scan your network (clears the caches first, so it asks for your password):

```bash
python3 scanner.py
```

Scan a specific range, or skip the cache clearing and pick ports:

```bash
python3 scanner.py 192.168.1.1-254
python3 scanner.py --no-flush -p 22,80,443 --csv out.csv
```

Save a printable landscape PDF of the results (add `--paper a4` for A4):

```bash
python3 scanner.py --pdf report.pdf
```

## Tests

```bash
python3 -m unittest discover -s tests
```
