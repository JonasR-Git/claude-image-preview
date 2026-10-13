#!/usr/bin/env python3
"""Writes tests/fixtures/images.ts: encoded pictures and the pixels they must decode to.

PNG files are encoded here by hand, so every color type, bit depth, filter
type and interlacing is covered with exactly known pixels. JPEG, GIF, BMP and
WebP files come from Pillow, and Pillow's own decode is the reference.

Run from the repository root: python3 scripts/make-fixtures.py

Another Pillow version may encode the lossy files a little differently; the tests compare
against the pixels written beside each file, so a fresh run stays consistent.
"""

import base64
import io
import struct
import zlib

from PIL import Image

OUT = 'tests/fixtures/images.ts'


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')


# ---------------------------------------------------------------- PNG writer

def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def pack_row(pixels, depth, channels) -> bytes:
    if depth >= 8:
        out = bytearray()
        for pixel in pixels:
            for sample in pixel[:channels]:
                out += struct.pack('>H', sample) if depth == 16 else bytes([sample])
        return bytes(out)
    out = bytearray()
    acc, bits = 0, 0
    for pixel in pixels:
        acc = (acc << depth) | pixel[0]
        bits += depth
        if bits == 8:
            out.append(acc)
            acc, bits = 0, 0
    if bits:
        out.append(acc << (8 - bits))
    return bytes(out)


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def filter_row(kind, row, prev, bpp):
    out = bytearray(len(row))
    for i, x in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        predictor = [0, a, b, (a + b) // 2, paeth(a, b, c)][kind]
        out[i] = (x - predictor) & 0xFF
    return bytes(out)


ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def write_png(image, color_type, depth, palette=None, trns=None, interlace=False, split=1):
    height, width = len(image), len(image[0])
    channels = CHANNELS[color_type]
    bpp = max(1, channels * depth // 8)
    passes = ADAM7 if interlace else [(0, 0, 1, 1)]
    raw = bytearray()
    counter = 0
    for x0, y0, dx, dy in passes:
        sub = [[image[y][x] for x in range(x0, width, dx)] for y in range(y0, height, dy)]
        if not sub or not sub[0]:
            continue
        prev = bytes(len(pack_row(sub[0], depth, channels)))
        for row_pixels in sub:
            row = pack_row(row_pixels, depth, channels)
            kind = counter % 5  # every filter type, in turn
            counter += 1
            raw += bytes([kind]) + filter_row(kind, row, prev, bpp)
            prev = row
    data = zlib.compress(bytes(raw), 9)
    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, depth, color_type, 0, 0, 1 if interlace else 0))
    if palette is not None:
        out += chunk(b'PLTE', bytes(v for rgb in palette for v in rgb))
    if trns is not None:
        out += chunk(b'tRNS', trns)
    step = max(1, len(data) // split + 1)
    for i in range(0, len(data), step):
        out += chunk(b'IDAT', data[i:i + step])
    out += chunk(b'IEND', b'')
    return out


def expect(image, color_type, depth, palette=None, trns=None):
    """The RGBA the decoder must produce, by the same rules it follows."""
    out = bytearray()
    top = (1 << depth) - 1
    for row in image:
        for pixel in row:
            if color_type == 3:
                index = pixel[0]
                r, g, b = palette[index] if index < len(palette) else (0, 0, 0)
                a = trns[index] if trns is not None and index < len(trns) else 255
            elif color_type == 0:
                v = pixel[0]
                gray = v >> 8 if depth == 16 else (v if depth == 8 else int(v * 255 / top + 0.5))
                key = struct.unpack('>H', trns)[0] if trns else -1
                r = g = b = gray
                a = 0 if v == key else 255
            elif color_type == 2:
                r, g, b = [s >> 8 if depth == 16 else s for s in pixel[:3]]
                key = struct.unpack('>HHH', trns) if trns else None
                a = 0 if key is not None and tuple(pixel[:3]) == key else 255
            elif color_type == 4:
                r = g = b = pixel[0] >> 8 if depth == 16 else pixel[0]
                a = pixel[1] >> 8 if depth == 16 else pixel[1]
            else:
                r, g, b, a = [s >> 8 if depth == 16 else s for s in pixel]
            out += bytes([r, g, b, a])
    return bytes(out)


W, H = 13, 9  # odd sizes, so padding and partial bytes are exercised


def pattern(channels, depth):
    top = (1 << depth) - 1
    return [[tuple(((x * 37 + y * 11 + c * 101) * (top // 31 + 1) + c) % (top + 1) for c in range(channels))
             for x in range(W)] for y in range(H)]


png_cases = []


def add_png(name, color_type, depth, palette=None, trns=None, interlace=False, split=1, image=None):
    channels = CHANNELS[color_type]
    if image is None:
        image = pattern(channels, depth)
    data = write_png(image, color_type, depth, palette, trns, interlace, split)
    png_cases.append((name, data, W, H, expect(image, color_type, depth, palette, trns)))


for depth in (1, 2, 4, 8, 16):
    add_png(f'gray{depth}', 0, depth)
add_png('gray8-trns', 0, 8, trns=struct.pack('>H', pattern(1, 8)[2][3][0]))
add_png('rgb8', 2, 8)
add_png('rgb16', 2, 16)
add_png('rgb8-trns', 2, 8, trns=struct.pack('>HHH', *pattern(3, 8)[1][1]))
add_png('graya8', 4, 8)
add_png('graya16', 4, 16)
add_png('rgba8', 6, 8)
add_png('rgba16', 6, 16)
for depth in (1, 2, 4, 8):
    count = 1 << depth
    palette = [((i * 53) % 256, (i * 97) % 256, (i * 151) % 256) for i in range(count)]
    trns = bytes((i * 61) % 256 for i in range(max(1, count // 2)))
    add_png(f'palette{depth}', 3, depth, palette=palette, trns=trns)
add_png('rgba8-interlaced', 6, 8, interlace=True)
add_png('gray4-interlaced', 0, 4, interlace=True)
add_png('rgb8-split-idat', 2, 8, split=5)

# ------------------------------------------------------------ Pillow formats


def scene(width, height, alpha=False):
    image = Image.new('RGBA' if alpha else 'RGB', (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            r = int(255 * x / max(1, width - 1))
            g = int(255 * y / max(1, height - 1))
            b = 255 - (r + g) // 2
            if (x // max(1, width // 4) + y // max(1, height // 3)) % 2 == 0:
                r, g = g, r
            pixels[x, y] = (r, g, b, 255 if not alpha or x % 5 else 0) if alpha else (r, g, b)
    return image


def reference(data: bytes) -> bytes:
    return Image.open(io.BytesIO(data)).convert('RGBA').tobytes()


pillow_cases = []


def add(name, image, fmt, reduce_to=None, expected=None, **params):
    buffer = io.BytesIO()
    image.save(buffer, fmt, **params)
    data = buffer.getvalue()
    decoded = Image.open(io.BytesIO(data))
    decoded.load()
    rgba = (expected if expected is not None else decoded).convert('RGBA')
    if 'exif' in params:
        from PIL import ImageOps
        rgba = ImageOps.exif_transpose(rgba)
    if reduce_to is not None:
        rgba = rgba.resize(reduce_to, Image.BOX)
    pillow_cases.append((name, data, rgba.width, rgba.height, rgba.tobytes(), reduce_to is not None))


base = scene(37, 23)
add('jpeg-baseline-420', base, 'JPEG', quality=92)
add('jpeg-baseline-444', base, 'JPEG', quality=92, subsampling=0)
add('jpeg-baseline-422', base, 'JPEG', quality=92, subsampling=1)
add('jpeg-progressive', base, 'JPEG', quality=90, progressive=True)
add('jpeg-progressive-444', base, 'JPEG', quality=90, progressive=True, subsampling=0)
add('jpeg-gray', base.convert('L'), 'JPEG', quality=90)
add('jpeg-cmyk', base.convert('CMYK'), 'JPEG', quality=92)
add('jpeg-restart', base, 'JPEG', quality=92, restart_marker_blocks=3)
exif = Image.Exif()
exif[0x0112] = 6
add('jpeg-orientation-6', base, 'JPEG', quality=92, exif=exif.tobytes())
big = scene(1600, 1040)
add('jpeg-large-baseline', big, 'JPEG', quality=60, reduce_to=(40, 26))
add('jpeg-large-progressive', big, 'JPEG', quality=60, progressive=True, reduce_to=(40, 26))
add('gif', base.convert('P', palette=Image.ADAPTIVE, colors=64), 'GIF')
transparent = base.convert('P', palette=Image.ADAPTIVE, colors=63)
transparent.info['transparency'] = 5
add('gif-transparent', transparent, 'GIF', transparency=5)
add('gif-interlaced', base.convert('P', palette=Image.ADAPTIVE, colors=32), 'GIF', interlace=True)
add('bmp-24', base, 'BMP')
add('bmp-8', base.convert('P', palette=Image.ADAPTIVE, colors=200), 'BMP')
add('bmp-1', base.convert('1'), 'BMP')
# Pillow reads the fourth byte of a 32-bit BI_RGB file as padding; browsers and
# the decoder here read it as alpha whenever some pixel uses it.
add('bmp-32-alpha', scene(37, 23, alpha=True), 'BMP', expected=scene(37, 23, alpha=True))
add('webp-lossless', scene(37, 23, alpha=True), 'WEBP', lossless=True)
add('webp-lossy', base, 'WEBP', quality=90)
add('webp-lossy-alpha', scene(37, 23, alpha=True), 'WEBP', quality=90)


def photo(width, height, seed=7):
    """Smooth shapes plus noise: exercises 4x4 prediction, segments and the loop filter."""
    import random
    rng = random.Random(seed)
    image = Image.new('RGB', (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            r = int(128 + 100 * ((x * 3 + y) % 97) / 97 - 50) + rng.randint(-20, 20)
            g = int(255 * y / height) + rng.randint(-20, 20)
            b = int(255 * ((x // 9 + y // 7) % 2)) // 2 + rng.randint(-20, 20)
            pixels[x, y] = tuple(max(0, min(255, v)) for v in (r, g, b))
    return image


add('webp-lossy-photo', photo(120, 88), 'WEBP', quality=75, method=6)
add('webp-lossy-q15', photo(80, 60, seed=3), 'WEBP', quality=15)
add('webp-lossy-odd', photo(33, 17, seed=5), 'WEBP', quality=80)
add('webp-lossless-photo', photo(96, 72, seed=11), 'WEBP', lossless=True, quality=100, method=6)
add('webp-lossless-palette', base.quantize(12).convert('RGB'), 'WEBP', lossless=True)
add('webp-lossless-2colors', base.convert('1').convert('RGB'), 'WEBP', lossless=True)
frames = [scene(37, 23), photo(37, 23, seed=9)]
add('webp-animated', frames[0], 'WEBP', save_all=True, append_images=frames[1:], duration=100, lossless=True)
add('webp-large-lossy', scene(1200, 800), 'WEBP', quality=60, reduce_to=(60, 40))

# --------------------------------------------------------------------- output

lines = [
    '// Generated by scripts/make-fixtures.py; do not edit by hand.',
    '',
    'export type Fixture = { name: string; data: string; width: number; height: number; rgba: string; isReduced: boolean }',
    '',
    'export const PNG_FIXTURES: Fixture[] = [',
]
for name, data, width, height, rgba in png_cases:
    lines.append(f"  {{ name: '{name}', data: '{b64(data)}', width: {width}, height: {height}, rgba: '{b64(rgba)}', isReduced: false }},")
lines += [']', '', 'export const PILLOW_FIXTURES: Fixture[] = [']
for name, data, width, height, rgba, reduced in pillow_cases:
    flag = 'true' if reduced else 'false'
    lines.append(f"  {{ name: '{name}', data: '{b64(data)}', width: {width}, height: {height}, rgba: '{b64(rgba)}', isReduced: {flag} }},")
lines += [']', '']
with open(OUT, 'w') as out:
    out.write('\n'.join(lines))
print(f'{OUT}: {len(png_cases)} PNG and {len(pillow_cases)} Pillow fixtures')
