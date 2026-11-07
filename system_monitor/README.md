# System Monitor

A small macOS app that shows live **memory** and **disk** usage, in the same light-blue and dark
theme as IP Scanner. Like IP Scanner, it uses only built-in Python, so there is nothing to
`pip install`.

## What it shows

- **Memory**: the percentage in use, a bar split into the same parts as Activity Monitor
  (*App memory*, *Wired*, *Compressed*, *Cached files*, *Free*), swap used, and the
  **memory pressure** (Normal, Warning or Critical, coloured green, yellow or red). A graph shows
  the last few minutes of usage.
- **Disks**: every volume Finder shows (the startup disk, external drives, disk images and
  network shares), each with a usage bar, *used of total* and *free*. Bars turn yellow at 75 %
  and red at 90 %. **Double-click** a volume to open it in Finder; **right-click** it to copy its
  path or **eject** it.
- **Top memory users**: the 10 processes using the most real memory.

Figures update every 2 seconds. **View → Update Every** changes that (1, 2, 5 or 10 seconds),
**View → Refresh Now** (⌘R) updates straight away, and **View → Keep Window on Top** keeps
the window above other apps. Click **☾ Dark** / **☀ Light**, or use **View → Appearance**, to
switch themes. Settings are saved in `~/.system_monitor.json`. **Activity Monitor** at the
bottom opens Apple's app for more detail.

Memory sizes use 1 GB = 1024³ bytes and disk sizes 1 GB = 1000³ bytes, matching Activity
Monitor and Finder. Free disk space doesn't include *purgeable* space, so it can be a little
lower than Finder's *Available*.

## Install

You need Python 3 with Tk 8.6, the same as for IP Scanner: install it from
[python.org/downloads](https://www.python.org/downloads/). Then, in Terminal:

```bash
git clone https://github.com/rickkollins/IP-Scanner.git ~/IP-Scanner && ~/IP-Scanner/system_monitor/build_app.sh
```

If you already have the repository:

```bash
cd ~/IP-Scanner && git pull && ./system_monitor/build_app.sh
```

This installs **System Monitor.app** in Applications (or `~/Applications` if you can't write to
`/Applications`) and opens it. To run it without building the app:

```bash
python3 ~/IP-Scanner/system_monitor/monitor_gui.py
```

For a one-off text summary in Terminal, run `python3 system_monitor/sysmon.py`.

To uninstall, drag **System Monitor** from Applications to the Trash and run
`rm ~/.system_monitor.json`.

## Files

| File | What it does |
|---|---|
| `sysmon.py` | Reads the figures: `vm_stat`, `sysctl` (memory size, swap, pressure), `mount` + `statvfs` (disks), `diskutil` (volume names and kinds) and `ps` (processes). |
| `monitor_gui.py` | The window. Readings are taken on a background thread so the window never stalls. `--self-test <file>` checks it without showing a window. |
| `build_app.sh` | Builds the `.app` bundle. |
| `make_icon.py` | Draws `icon.icns` and `icon.png` (needs `pip install pillow`, only to change the icon). |

The window also uses `theme.py` from the repository root. Tests are in `tests/test_sysmon.py`.
