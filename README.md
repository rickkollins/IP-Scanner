# IP Scanner

A small macOS app that scans your whole local network for alive IPv4 hosts. It shows each host's
hostname and MAC address, and checks these TCP ports:

| Port | Typical use |
|------|-------------|
| 80   | HTTP |
| 8000 | Dev / web servers |
| 8081 | Alt HTTP, proxies, admin panels |
| 8123 | Home Assistant |

It uses only the Python standard library, so there is nothing to `pip install`.

## Install on your MacBook

```bash
git clone https://github.com/rickkollins/IP-Scanner.git
cd IP-Scanner
./build_app.sh            # creates ~/Applications/IP Scanner.app
open ~/Applications/"IP Scanner.app"
```

You can then start **IP Scanner** from Launchpad or Spotlight, or drag it to your Dock.

The app needs Python 3 with Tkinter. On a MacBook, either of these works:

- `xcode-select --install` (gives you `/usr/bin/python3`, which includes Tkinter), or
- `brew install python python-tk`

The first time you scan, macOS (Sequoia and later) may ask to allow access to devices on your
**local network**. Click **Allow**. If you missed the prompt, turn it on in
**System Settings → Privacy & Security → Local Network**.

## Using it

1. The **Network(s)** box is filled in automatically with the subnet your Mac is on, for example
   `192.168.1.0/24`. You can change it or add more, separated by commas. The largest network
   allowed is a /16.
2. Click **Scan**. Hosts appear as they're found, sorted by IP. Hosts with at least one open
   port are shown in green.
3. **Double-click** an open port to open `http://ip:port` in your browser.
4. Click a column header to sort, or **Export CSV…** to save the results.

## How it works

1. **Ping sweep** of every address in the subnet, 128 at a time. Each host that replies gets
   its ports checked with a TCP connect.
2. **ARP table**: the sweep fills the Mac's ARP cache. Hosts that ignore ping (for example a
   firewalled Mac or a Windows PC) still answer ARP, so they get added and port-checked too.
   This step also supplies the MAC addresses.
3. **Hostnames** come from reverse DNS, with a fallback to a Bonjour/mDNS lookup
   (`something.local`).

A /24 network usually takes 5–15 seconds.

## Command line

You can also run the scanner without the window:

```bash
python3 scanner.py                         # auto-detect the local subnet
python3 scanner.py 192.168.1.0/24          # a specific subnet
python3 scanner.py -p 80,443,8123 --csv out.csv
```

## Tests

```bash
python3 -m unittest discover -s tests
```
