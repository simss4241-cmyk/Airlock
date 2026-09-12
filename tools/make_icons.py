"""Generate Airlock's icon set (PWA PNGs + a multi-size .ico for the taskbar pin).

Run:  python tools/make_icons.py
Draws at 4x and downsamples, so the sparkle edges come out clean at 16px.
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

# Nova's teal/purple moodboard
BG = (11, 17, 32, 255)        # --bg          #0b1120
TEAL = (45, 212, 191, 255)    # --teal-bright #2dd4bf
PURPLE = (168, 85, 247, 255)  # --accent      #a855f7
VIOLET = (109, 40, 217, 255)  # --accent-deep #6d28d9
CORE = (233, 213, 255, 255)   # hot core, pale lilac
GLOW = (124, 58, 237)         # glow tint, violet

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
SS = 4                        # supersample factor


def star(cx, cy, outer, inner, points=4, rotation=-math.pi / 2):
    """Vertices for a sharp N-point sparkle."""
    verts = []
    step = math.pi / points
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = rotation + i * step
        verts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return verts


def gradient(size, stops):
    """Diagonal (bottom-left -> top-right) linear gradient as an RGBA image."""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    n = len(stops) - 1
    for y in range(size):
        for x in range(size):
            # 0 at bottom-left, 1 at top-right
            t = ((x / (size - 1)) + (1 - y / (size - 1))) / 2
            seg = min(int(t * n), n - 1)
            f = t * n - seg
            a, b = stops[seg], stops[seg + 1]
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(4))
    return img


def rounded_bg(size, radius_frac=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_frac), fill=BG)
    return img


def draw_airlock(size, maskable=False):
    """One icon at `size` px. maskable=True fills the whole square (no corner rounding)."""
    S = size * SS
    img = Image.new("RGBA", (S, S), BG if maskable else (0, 0, 0, 0))

    if not maskable:
        img = rounded_bg(S)

    cx = cy = S / 2

    # soft violet glow behind the star
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i, alpha in enumerate((28, 42, 62)):
        r = S * (0.34 - i * 0.07)
        gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GLOW + (alpha,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.045))
    img = Image.alpha_composite(img, glow)

    outer = S * 0.325   # keeps the star inside the maskable safe circle

    # Build the sparkle as a mask, then pour a teal -> purple -> violet gradient
    # through it, so the star carries the palette instead of one flat colour.
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(star(cx, cy, outer, outer * 0.23), fill=255)
    sx, sy = cx + outer * 0.86, cy - outer * 0.88
    md.polygon(star(sx, sy, S * 0.072, S * 0.018), fill=235)

    # rendered small and scaled up — a smooth ramp needs no more detail than this
    # TEAL twice so the lower-left third stays clearly teal instead of washing to purple
    ramp = gradient(96, [TEAL, TEAL, PURPLE, VIOLET]).resize((S, S), Image.LANCZOS)
    img = Image.composite(ramp, img, mask)

    # pale hot core on the main star only — small and semi-transparent, or it
    # swallows the gradient and the whole mark reads as one flat lilac blob
    core = Image.new("L", (S, S), 0)
    ImageDraw.Draw(core).polygon(star(cx, cy, outer * 0.34, outer * 0.10), fill=150)
    img = Image.composite(Image.new("RGBA", (S, S), CORE), img, core)

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)

    written = []
    for size in (512, 192, 64):
        name = "favicon.png" if size == 64 else f"icon-{size}.png"
        p = os.path.join(OUT, name)
        draw_airlock(size).save(p)
        written.append(p)

    # maskable variant so Windows/Android can crop it without clipping the star
    p = os.path.join(OUT, "icon-512-maskable.png")
    draw_airlock(512, maskable=True).save(p)
    written.append(p)

    # multi-resolution .ico for the pinned shortcut
    ico = os.path.join(OUT, "airlock.ico")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw_airlock(s) for s in sizes]
    frames[-1].save(ico, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    written.append(ico)

    for p in written:
        print(f"  {os.path.relpath(p, os.path.dirname(OUT))}  ({os.path.getsize(p):,} bytes)")


if __name__ == "__main__":
    main()
