"""Minimal QR Code encoder (byte mode), standard library only.

Used to show the phone link as a QR code. Based on the algorithm in
ISO/IEC 18004 as laid out by Project Nayuki's reference implementation.

    matrix = qr.encode("http://192.168.1.20:8765/?t=abc")
    matrix[y][x] -> True for a dark module
"""

from __future__ import annotations

# Error correction levels: (index into the tables, format bits)
LEVELS = {"L": (0, 1), "M": (1, 0), "Q": (2, 3), "H": (3, 2)}

_ECC_PER_BLOCK = (
    (-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
     28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    (-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
     26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
    (-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
     28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    (-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
     30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
)
_NUM_BLOCKS = (
    (-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12,
     12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
    (-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20,
     21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
    (-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25,
     27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
    (-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30,
     32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81),
)


def _raw_modules(ver: int) -> int:
    result = (16 * ver + 128) * ver + 64
    if ver >= 2:
        align = ver // 7 + 2
        result -= (25 * align - 10) * align - 55
        if ver >= 7:
            result -= 36
    return result


def _data_codewords(ver: int, lvl: int) -> int:
    return _raw_modules(ver) // 8 - _ECC_PER_BLOCK[lvl][ver] * _NUM_BLOCKS[lvl][ver]


def _gf_mul(x: int, y: int) -> int:
    z = 0
    for i in reversed(range(8)):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree: int) -> list[int]:
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(len(result)):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < len(result):
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 0x02)
    return result


def _rs_remainder(data: list[int], divisor: list[int]) -> list[int]:
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _gf_mul(coef, factor)
    return result


def _bit(x: int, i: int) -> bool:
    return (x >> i) & 1 != 0


class _Grid:
    def __init__(self, ver: int):
        self.ver = ver
        self.size = ver * 4 + 17
        self.mod = [[False] * self.size for _ in range(self.size)]
        self.func = [[False] * self.size for _ in range(self.size)]

    def set_func(self, x: int, y: int, dark: bool) -> None:
        self.mod[y][x] = dark
        self.func[y][x] = True

    def alignment_positions(self) -> list[int]:
        if self.ver == 1:
            return []
        align = self.ver // 7 + 2
        step = (self.ver * 8 + align * 3 + 5) // (align * 4 - 4) * 2
        result = [self.size - 7 - i * step for i in range(align - 1)] + [6]
        return list(reversed(result))

    def draw_function_patterns(self) -> None:
        size = self.size
        for i in range(size):
            self.set_func(6, i, i % 2 == 0)
            self.set_func(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < size and 0 <= y < size:
                        self.set_func(x, y, max(abs(dx), abs(dy)) not in (2, 4))
        pos = self.alignment_positions()
        n = len(pos)
        for i in range(n):
            for j in range(n):
                if (i, j) in ((0, 0), (0, n - 1), (n - 1, 0)):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.set_func(pos[i] + dx, pos[j] + dy, max(abs(dx), abs(dy)) != 1)
        self.draw_format_bits(0, 0)  # placeholder, redrawn after masking
        if self.ver >= 7:
            rem = self.ver
            for _ in range(12):
                rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
            bits = self.ver << 12 | rem
            for i in range(18):
                a, b = size - 11 + i % 3, i // 3
                self.set_func(a, b, _bit(bits, i))
                self.set_func(b, a, _bit(bits, i))

    def draw_format_bits(self, level_bits: int, mask: int) -> None:
        data = level_bits << 3 | mask
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = (data << 10 | rem) ^ 0x5412
        size = self.size
        for i in range(6):
            self.set_func(8, i, _bit(bits, i))
        self.set_func(8, 7, _bit(bits, 6))
        self.set_func(8, 8, _bit(bits, 7))
        self.set_func(7, 8, _bit(bits, 8))
        for i in range(9, 15):
            self.set_func(14 - i, 8, _bit(bits, i))
        for i in range(8):
            self.set_func(size - 1 - i, 8, _bit(bits, i))
        for i in range(8, 15):
            self.set_func(8, size - 15 + i, _bit(bits, i))
        self.set_func(8, size - 8, True)  # the "dark module"

    def draw_codewords(self, data: list[int]) -> None:
        i = 0
        size = self.size
        right = size - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(size):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = size - 1 - vert if upward else vert
                    if not self.func[y][x] and i < len(data) * 8:
                        self.mod[y][x] = _bit(data[i >> 3], 7 - (i & 7))
                        i += 1
            right -= 2

    def apply_mask(self, mask: int) -> None:
        for y in range(self.size):
            for x in range(self.size):
                if self.func[y][x]:
                    continue
                if mask == 0:
                    inv = (x + y) % 2 == 0
                elif mask == 1:
                    inv = y % 2 == 0
                elif mask == 2:
                    inv = x % 3 == 0
                elif mask == 3:
                    inv = (x + y) % 3 == 0
                elif mask == 4:
                    inv = (x // 3 + y // 2) % 2 == 0
                elif mask == 5:
                    inv = x * y % 2 + x * y % 3 == 0
                elif mask == 6:
                    inv = (x * y % 2 + x * y % 3) % 2 == 0
                else:
                    inv = ((x + y) % 2 + x * y % 3) % 2 == 0
                self.mod[y][x] ^= inv

    def penalty(self) -> int:
        """Simplified penalty: long runs, 2x2 blocks and dark/light balance."""
        size, m, score = self.size, self.mod, 0
        for lines in (m, list(zip(*m))):
            for line in lines:
                run, prev = 0, None
                for v in line:
                    if v == prev:
                        run += 1
                    else:
                        if run >= 5:
                            score += run - 2
                        run, prev = 1, v
                if run >= 5:
                    score += run - 2
        for y in range(size - 1):
            for x in range(size - 1):
                if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                    score += 3
        dark = sum(v for row in m for v in row)
        total = size * size
        score += (abs(dark * 20 - total * 10) + total - 1) // total * 10
        return score


def encode(text: str, level: str = "M") -> list[list[bool]]:
    """Encode text (UTF-8, byte mode) as a QR matrix of booleans."""
    lvl, level_bits = LEVELS[level]
    data = text.encode("utf-8")
    for ver in range(1, 41):
        count_bits = 8 if ver <= 9 else 16
        capacity = _data_codewords(ver, lvl) * 8
        if 4 + count_bits + len(data) * 8 <= capacity:
            break
    else:
        raise ValueError("Text too long for a QR code")

    bits: list[int] = []

    def append(value: int, n: int) -> None:
        bits.extend((value >> i) & 1 for i in reversed(range(n)))

    append(0b0100, 4)
    append(len(data), count_bits)
    for b in data:
        append(b, 8)
    append(0, min(4, capacity - len(bits)))
    append(0, (8 - len(bits) % 8) % 8)
    pad = 0xEC
    while len(bits) < capacity:
        append(pad, 8)
        pad ^= 0xEC ^ 0x11
    codewords = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]

    # Split into blocks, add error correction, interleave.
    num_blocks = _NUM_BLOCKS[lvl][ver]
    ecc_len = _ECC_PER_BLOCK[lvl][ver]
    raw = _raw_modules(ver) // 8
    num_short = num_blocks - raw % num_blocks
    short_len = raw // num_blocks
    divisor = _rs_divisor(ecc_len)
    blocks, k = [], 0
    for i in range(num_blocks):
        dat = codewords[k:k + short_len - ecc_len + (0 if i < num_short else 1)]
        k += len(dat)
        ecc = _rs_remainder(dat, divisor)
        if i < num_short:
            dat = dat + [0]
        blocks.append(dat + ecc)
    final = []
    for i in range(len(blocks[0])):
        for j, block in enumerate(blocks):
            if i != short_len - ecc_len or j >= num_short:
                final.append(block[i])

    grid = _Grid(ver)
    grid.draw_function_patterns()
    grid.draw_codewords(final)
    best, best_score = 0, None
    for mask in range(8):
        grid.apply_mask(mask)
        grid.draw_format_bits(level_bits, mask)
        score = grid.penalty()
        if best_score is None or score < best_score:
            best, best_score = mask, score
        grid.apply_mask(mask)  # undo
    grid.apply_mask(best)
    grid.draw_format_bits(level_bits, best)
    return grid.mod
