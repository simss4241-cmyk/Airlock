"""Generate Airlock's icon set (PWA PNGs + a multi-size .ico for the taskbar pin).

Run:  python tools/make_icons.py
Draws at 4x and downsamples, so the seam stays clean at 16px.

The mark is a hatch seal: a heavy ring split by a vertical seam, teal on the inside
half and violet on the outside half. It is the boundary, which is the thing this app
actually is — and, just as importantly, it is not a sparkle.

⚠ That matters more than it looks. This file used to draw Glimmer's four-point star,
because Airlock was forked from Glimmer and the generator was renamed without the art
being redrawn. Both projects therefore shipped byte-identical icons, so the two taskbar
pins were indistinguishable and clicking the wrong one was routine. Two apps that live
side by side on one machine have to be tellable apart at 16 pixels.
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

# Matches styles.css, and carries the same meaning: green is this machine, amber is
# across the boundary. The ring is literally the two halves of a hatch.
BG = (11, 13, 16, 255)        # --bg          #0b0d10  graphite
TEAL = (118, 185, 0, 255)     # --accent      #76b900  NVIDIA green, the inside half
PURPLE = (255, 176, 32, 255)  # --cross       #ffb020  amber, the outside half
VIOLET = (184, 118, 10, 255)  # --cross-deep  #b8760a
CORE = (230, 233, 237, 255)   # --text        #e6e9ed  the packet at the threshold
GLOW = (118, 185, 0)          # glow tint, green

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
SS = 4                        # supersample factor


def gradient(size, stops, vertical=False):
    """Linear gradient as an RGBA image. Diagonal by default, vertical on request."""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    n = len(stops) - 1
    for y in range(size):
        for x in range(size):
            t = (y / (size - 1)) if vertical else ((x / (size - 1)) + (1 - y / (size - 1))) / 2
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


def ring_mask(S, cx, cy, outer, thickness):
    """A filled annulus, as an L mask."""
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([cx - outer, cy - outer, cx + outer, cy + outer], fill=255)
    inner = outer - thickness
    d.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], fill=0)
    return m


def draw_airlock(size, maskable=False):
    """One icon at `size` px. maskable=True fills the whole square (no corner rounding)."""
    S = size * SS
    img = Image.new("RGBA", (S, S), BG if maskable else (0, 0, 0, 0))
    if not maskable:
        img = rounded_bg(S)

    cx = cy = S / 2
    outer = S * 0.360          # inside the maskable safe circle
    thickness = S * 0.150      # heavy enough to survive a 16px downsample

    # Soft violet glow, kept from the family look so the suite still hangs together.
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i, alpha in enumerate((14, 20, 28)):
        r = S * (0.36 - i * 0.07)
        gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GLOW + (alpha,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.045))
    img = Image.alpha_composite(img, glow)

    # The ring, poured two-tone: teal on the left (this machine), violet on the right
    # (across the boundary). A hard split rather than a blend — at 16px a gradient
    # across the seam turns into one muddy colour and the whole point is lost.
    ring = ring_mask(S, cx, cy, outer, thickness)

    left = Image.new("L", (S, S), 0)
    ImageDraw.Draw(left).rectangle([0, 0, cx, S], fill=255)
    right = Image.new("L", (S, S), 0)
    ImageDraw.Draw(right).rectangle([cx, 0, S, S], fill=255)

    teal_arc = Image.new("L", (S, S), 0)
    teal_arc.paste(ring, (0, 0), left)
    violet_arc = Image.new("L", (S, S), 0)
    violet_arc.paste(ring, (0, 0), right)

    img = Image.composite(Image.new("RGBA", (S, S), TEAL), img, teal_arc)
    violet_ramp = gradient(96, [PURPLE, VIOLET], vertical=True).resize((S, S), Image.LANCZOS)
    img = Image.composite(violet_ramp, img, violet_arc)

    # The seam. Cut back to the background so the hatch reads as two halves that meet,
    # not as one ring with a line drawn on it.
    seam = S * 0.045
    seam_layer = Image.new("L", (S, S), 0)
    ImageDraw.Draw(seam_layer).rectangle([cx - seam / 2, 0, cx + seam / 2, S], fill=255)
    base = rounded_bg(S) if not maskable else Image.new("RGBA", (S, S), BG)
    img = Image.composite(base, img, seam_layer)

    # A pale core at the threshold — one packet mid-crossing. Small on purpose: at 16px
    # it lands as a single bright pixel, which is a focal point rather than noise.
    r = S * 0.050
    core = Image.new("L", (S, S), 0)
    ImageDraw.Draw(core).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
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
