"""Dateisymbole für Dateien, die mit Webcase geöffnet werden: Blatt mit Eselsohr und Zeilen, das Webcase-Logo in der
Mitte, darunter die Endung (html, pdf ...) und ganz unten ein Streifen - je Typ in eigener Farbe, hell und dunkel.
Welche Variante Windows zeigt, stellt man in Webcase ein (src/fileicons.js). Die Zuordnung Typ -> Symbol steht in
package.json (build.fileAssociations[].icon). Schreibt assets/filetypes/light|dark/<name>.ico.
Braucht Python 3 + Pillow und Segoe UI (Windows). Aufruf: python tools/make-filetype-icons.py"""
import io
import os
import struct

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'filetypes')
LOGO = Image.open(os.path.join(ROOT, 'assets', 'icon.png')).convert('RGBA')
FONT = next((f for f in ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf'] if os.path.exists(f)), None)

# Name (= Dateiname des Symbols) -> (Beschriftung, Farbe)
TYPES = {
    'html': ('html', '#e34c26'), 'htm': ('htm', '#c2410c'), 'pdf': ('pdf', '#d32f2f'), 'svg': ('svg', '#d97706'),
    'xhtml': ('xhtml', '#9333ea'), 'mhtml': ('mhtml', '#0e7490'), 'md': ('md', '#334155'),
}

LIGHT = {'paper': (255, 255, 255), 'outline': (176, 182, 194), 'fold': (226, 230, 237), 'lines': (229, 232, 238), 'shadow': 60}
DARK = {'paper': (43, 45, 50), 'outline': (88, 92, 102), 'fold': (62, 65, 72), 'lines': (60, 63, 70), 'shadow': 110}


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def page(size, label, color, detail, dark=False):
    """Ein Symbol in 'size' Pixeln, gezeichnet in 4-facher Größe und verkleinert (glatte Kanten)."""
    P = DARK if dark else LIGHT
    col = hexrgb(color)
    if dark:  # auf dunklem Blatt aufhellen, damit die Endung lesbar bleibt
        col = tuple(round(c + (255 - c) * 0.38) for c in col)
    S = size * 4
    u = S / 256
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    left, top, right, bottom, fold = 40 * u, 10 * u, 216 * u, 246 * u, 52 * u
    if size <= 24:
        left, right, top, bottom, fold = 34 * u, 222 * u, 6 * u, 250 * u, 60 * u
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(left, top + 4 * u), (right - fold, top + 4 * u), (right, top + fold + 4 * u), (right, bottom + 4 * u), (left, bottom + 4 * u)], fill=(0, 0, 0, P['shadow']))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(5 * u)))
    outline = P['outline'] + (255,)
    w = max(1, round(3 * u)) if size >= 32 else max(1, round(5 * u))
    d.polygon([(left, top), (right - fold, top), (right, top + fold), (right, bottom), (left, bottom)], fill=P['paper'] + (255,), outline=outline, width=w)
    d.polygon([(right - fold, top), (right - fold, top + fold), (right, top + fold)], fill=P['fold'] + (255,), outline=outline, width=w)
    if detail:
        y = top + 34 * u
        while y < bottom - 34 * u:
            x2 = right - (fold + 14 * u if y < top + fold + 6 * u else 22 * u)
            d.rounded_rectangle([left + 20 * u, y, x2, y + 7 * u], radius=3.5 * u, fill=P['lines'] + (255,))
            y += 19 * u
    ls = (104 if detail else 150) * u
    cx = (left + right) / 2
    cy = (top + 98 * u) if detail else (top + bottom) / 2
    if detail:
        d.rounded_rectangle([cx - ls / 2 - 7 * u, cy - ls / 2 - 7 * u, cx + ls / 2 + 7 * u, cy + ls / 2 + 7 * u], radius=30 * u, fill=P['paper'] + (255,))
    img.alpha_composite(LOGO.resize((round(ls), round(ls)), Image.LANCZOS), (round(cx - ls / 2), round(cy - ls / 2)))
    if detail and label:
        fs = 58 * u if len(label) <= 3 else (48 * u if len(label) == 4 else 40 * u)
        font = ImageFont.truetype(FONT, round(fs))
        tw = d.textlength(label, font=font)
        ty = bottom - 84 * u
        x0, y0, x1, y1 = d.textbbox((cx - tw / 2, ty - 8 * u), label, font=font)
        d.rectangle([x0 - 8 * u, y0 - 6 * u, x1 + 8 * u, y1 + 6 * u], fill=P['paper'] + (255,))
        d.text((cx - tw / 2, ty - 8 * u), label, font=font, fill=col + (255,))
    if label and size >= 32:  # farbiger Streifen ganz unten
        d.rectangle([left + w, bottom - 16 * u, right - w + 1, bottom], fill=col + (255,))
    return img.resize((size, size), Image.LANCZOS)


def png(img):
    b = io.BytesIO()
    img.save(b, 'PNG', optimize=True)
    return b.getvalue()


def write_ico(path, images):
    head = struct.pack('<HHH', 0, 1, len(images))
    entries, data = b'', b''
    offset = 6 + 16 * len(images)
    for size, blob in images:
        entries += struct.pack('<BBBBHHII', 0 if size >= 256 else size, 0 if size >= 256 else size, 0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    open(path, 'wb').write(head + entries + data)


# macOS: electron-builder sucht zu fileAssociations[].icon dieselbe Datei als .icns (gleicher Ordner)
ICNS = [('ic11', 32), ('ic12', 64), ('ic07', 128), ('ic13', 256), ('ic08', 256), ('ic14', 512), ('ic09', 512), ('ic10', 1024)]


def write_icns(path, render):
    body, cache = b'', {}
    for typ, size in ICNS:
        if size not in cache:
            cache[size] = png(render(size))
        body += typ.encode('ascii') + struct.pack('>I', len(cache[size]) + 8) + cache[size]
    open(path, 'wb').write(b'icns' + struct.pack('>I', len(body) + 8) + body)


for variant in ('light', 'dark'):
    os.makedirs(os.path.join(OUT, variant), exist_ok=True)
    for name, (label, color) in TYPES.items():
        write_ico(os.path.join(OUT, variant, f'{name}.ico'),
                  [(s, png(page(s, label, color, s >= 48, variant == 'dark'))) for s in (16, 24, 32, 48, 64, 128, 256)])
for name, (label, color) in TYPES.items():
    write_icns(os.path.join(OUT, 'light', f'{name}.icns'), lambda s, label=label, color=color: page(s, label, color, s >= 48))
print(f'{len(TYPES)} Dateisymbole (hell + dunkel, dazu .icns für macOS) nach {OUT}')
