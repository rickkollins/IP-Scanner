import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "system_monitor"))
import sysmon  # noqa: E402

VM_STAT = """\
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5000.
Pages active:                            300000.
Pages inactive:                          290000.
Pages speculative:                         4000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          10000.
"Translation faults":                 900000000.
Pages copy-on-write:                   30000000.
Pages zero filled:                    400000000.
Pages reactivated:                      9000000.
Pages purged:                           2000000.
File-backed pages:                       240000.
Anonymous pages:                         350000.
Pages stored in compressor:              200000.
Pages occupied by compressor:             60000.
Decompressions:                         5000000.
"""

MOUNT = """\
/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk5s1 on /Volumes/My Backup (apfs, local, nodev, nosuid, journaled, noowners)
//rick@nas._smb._tcp.local/Photos on /Volumes/Photos (smbfs, nodev, nosuid, mounted by rick)
/dev/disk7s1 on /Volumes/Hidden (apfs, local, nobrowse)
"""

PS = """\
  101  204800 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
  202 1048576 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  303    1024 /usr/sbin/cfprefsd
junk line
"""

MEMINFO = """\
MemTotal:       16000000 kB
MemFree:         2000000 kB
MemAvailable:    6000000 kB
Buffers:          500000 kB
Cached:          3000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
"""

PAGE = 16384


class MemoryTests(unittest.TestCase):
    def test_vm_stat_matches_activity_monitor(self):
        m = sysmon.memory_from_vm_stat(VM_STAT, 16 * 1024 ** 3)
        self.assertEqual(m.app, (350000 - 10000) * PAGE)
        self.assertEqual(m.wired, 150000 * PAGE)
        self.assertEqual(m.compressed, 60000 * PAGE)
        self.assertEqual(m.cached, (240000 + 10000) * PAGE)
        self.assertEqual(m.used, (340000 + 150000 + 60000) * PAGE)
        self.assertEqual(m.free, m.total - m.used - m.cached)
        self.assertAlmostEqual(m.percent, 100 * m.used / m.total)

    def test_parse_vm_stat_handles_quoted_labels(self):
        page, pages = sysmon.parse_vm_stat(VM_STAT)
        self.assertEqual(page, PAGE)
        self.assertEqual(pages["Translation faults"], 900000000)

    def test_swapusage(self):
        total, used = sysmon.parse_swapusage(
            "total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)")
        self.assertEqual(total, 2048 * 1024 ** 2)
        self.assertEqual(used, int(1024.5 * 1024 ** 2))
        self.assertEqual(sysmon.parse_swapusage(""), (0, 0))

    def test_free_never_negative(self):
        m = sysmon.Memory(total=100, app=80, wired=10, compressed=5, cached=50)
        self.assertEqual(m.free, 0)
        self.assertEqual(sysmon.Memory().percent, 0.0)

    def test_meminfo(self):
        m = sysmon.memory_from_meminfo(MEMINFO)
        self.assertEqual(m.total, 16000000 * 1024)
        self.assertEqual(m.used, 10000000 * 1024)
        self.assertEqual(m.swap_used, 500000 * 1024)
        self.assertEqual(m.pressure, "normal")


LIVE = unittest.skipIf(sys.platform == "win32", "System Monitor is for macOS")


class DiskTests(unittest.TestCase):
    def test_parse_mount_keeps_finder_volumes(self):
        vols = sysmon.parse_mount(MOUNT)
        self.assertEqual([v[1] for v in vols], ["/", "/Volumes/My Backup", "/Volumes/Photos"])
        self.assertEqual(vols[2][2], "smbfs")
        self.assertIn("read-only", vols[0][3])

    def test_proc_mounts(self):
        text = ("/dev/sda1 / ext4 rw,relatime 0 0\n"
                "proc /proc proc rw 0 0\n"
                "/dev/loop3 /snap/core/1 squashfs ro 0 0\n"
                "/dev/sdb1 /media/My\\040Disk vfat rw 0 0\n"
                "/dev/sda1 /var/bind ext4 rw 0 0\n")
        vols = sysmon.parse_proc_mounts(text)
        self.assertEqual([v[1] for v in vols], ["/", "/media/My Disk"])

    def test_volume_maths(self):
        v = sysmon.Volume("HD", "/", "/dev/disk1", "apfs", "Internal", total=1000, free=250)
        self.assertEqual(v.used, 750)
        self.assertEqual(v.percent, 75.0)

    @LIVE
    def test_live_volumes(self):
        vols = sysmon.volumes()
        self.assertTrue(vols)
        self.assertEqual(vols[0].mount, "/")


class FormatTests(unittest.TestCase):
    def test_format_bytes(self):
        self.assertEqual(sysmon.format_bytes(512), "512 bytes")
        self.assertEqual(sysmon.format_bytes(500_000_000_000), "500.0 GB")
        self.assertEqual(sysmon.format_bytes(1_500_000_000), "1.50 GB")
        self.assertEqual(sysmon.format_bytes(16 * 1024 ** 3, binary=True), "16.00 GB")
        self.assertEqual(sysmon.format_bytes(2_000_000_000_000), "2.00 TB")


class ProcessTests(unittest.TestCase):
    def test_parse_ps_sorts_by_memory(self):
        procs = sysmon.parse_ps(PS)
        self.assertEqual([p.name for p in procs], ["Google Chrome", "Finder", "cfprefsd"])
        self.assertEqual(procs[0].rss, 1048576 * 1024)

    @LIVE
    def test_live_snapshot(self):
        snap = sysmon.snapshot()
        self.assertGreater(snap.memory.total, 0)
        self.assertTrue(snap.processes)


if __name__ == "__main__":
    unittest.main()
