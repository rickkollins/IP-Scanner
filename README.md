# IP Scanner

A macOS network scanner styled after Advanced IP Scanner. It finds every alive IPv4 device on
your network and lists each one's **name**, **IP**, **manufacturer**, **MAC address** and
**open services**. Expand a device to see its services, and double-click one to open it.

The scanning code uses only built-in Python, so there is nothing to `pip install`.

## Install on your MacBook

Open **Terminal** and paste:

```bash
git clone -b claude/vigilant-hypatia-2ajnto https://github.com/rickkollins/IP-Scanner.git ~/IP-Scanner \
  && ~/IP-Scanner/build_app.sh
```

This installs **IP Scanner** into your Applications folder, shows it in Finder and opens it. Start it
from Finder → Applications, Launchpad or Spotlight, or drag it to your Dock. (If your account
can't write to `/Applications`, it goes into the Applications folder inside your home folder.) To update later, run
`cd ~/IP-Scanner && git pull && ./build_app.sh`.

- If macOS asks to install the **command line developer tools**, click **Install**, then run
  the command again. That gives you `git` and a basic Python.
- **Recommended:** install Python from [python.org/downloads](https://www.python.org/downloads/)
  (or run `brew install python-tk`). Apple's built-in Python uses an old window toolkit
  (Tk 8.5) that can show a blank window on recent macOS. The app automatically uses the
  newer Python when it's installed, so you don't need to rebuild it.
- The first time you scan, macOS may ask to allow access to devices on your **local network**.
  Click **Allow**. If you missed the prompt, turn it on in
  **System Settings → Privacy & Security → Local Network**.
- When **Clear ARP & DNS cache before scan** is on (the default), macOS asks for your
  administrator password before each scan. Clearing these caches needs admin rights. Untick
  the box to skip it.

## Using it

1. The range box is filled in with your Mac's network, e.g. `192.168.1.1-254`. You can also
   type ranges (`10.0.0.1-50`, `10.0.0.1-10.0.1.255`), subnets (`10.0.0.0/24`) or single IPs,
   separated by commas. **My network** fills in your current network again. The limit is
   65,536 addresses (a /16).
2. Press **Scan** (⌘R). Devices appear as they're found. The status bar shows
   *N alive, M dead*.
3. Click a column heading to sort, and use **Search** to filter by name, IP, maker, MAC or
   service.
4. Click the ▸ arrow on a device to see its open services. **Double-click** a service to open it:
   web ports open in your browser, SSH opens Terminal, SMB/AFP open Finder, and VNC opens
   Screen Sharing.
5. **Right-click** a device to open a service, copy its IP, name or MAC, or rescan just that
   device.
6. **File → Export CSV…** (⌘E) saves the list.

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

## Tests

```bash
python3 -m unittest discover -s tests
```
