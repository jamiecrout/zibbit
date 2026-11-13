"""Draw the launcher icon: a white "z" with a yellow dot on violet.

Writes an adaptive-icon foreground (mipmap-*/ic_fg.png, 108dp canvas, art kept
inside the 66dp safe zone) and a legacy full icon (mipmap-*/ic_launcher.png).
The adaptive background colour is ic_bg in res/values/colors.xml (keep in sync with BG).
"""
import os
from PIL import Image, ImageDraw

BG = (77, 51, 224, 255)       # #4D33E0
WHITE = (255, 255, 255, 255)
DOT = (255, 201, 60, 255)     # #FFC93C
SS = 4                        # supersampling factor
# Artwork is laid out on a 512 grid; its bounding box is x 131..407, y 139..373.
CX, CY, AW = 269.0, 256.0, 276.0


def draw_z(im, frac):
    """Draw the z + dot centred in `im`, the art spanning `frac` of the width."""
    s = im.size[0]
    k = frac * s / AW
    X = lambda x: s / 2 + (x - CX) * k
    Y = lambda y: s / 2 + (y - CY) * k
    d = ImageDraw.Draw(im)
    w = 58 * k
    pts = [(160, 168), (352, 168), (160, 344), (300, 344)]
    P = [(X(x), Y(y)) for x, y in pts]
    d.line(P, fill=WHITE, width=int(w), joint="curve")
    r = w / 2
    for x, y in (P[0], P[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)
    dr = 29 * k
    d.ellipse([X(378) - dr, Y(344) - dr, X(378) + dr, Y(344) + dr], fill=DOT)


def foreground(px):
    s = px * SS
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw_z(im, 0.47)
    return im.resize((px, px), Image.LANCZOS)


def legacy(px):
    s = px * SS
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BG)
    draw_z(im, 0.54)
    return im.resize((px, px), Image.LANCZOS)


DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, f in DENS.items():
    out = os.path.join("res", f"mipmap-{name}")
    os.makedirs(out, exist_ok=True)
    foreground(int(108 * f)).save(os.path.join(out, "ic_fg.png"))
    legacy(int(48 * f)).save(os.path.join(out, "ic_launcher.png"))

# Android TV home-screen banner: 320x180 dp, drawn at xhdpi (640x360)
def banner():
    from PIL import ImageFont
    W, H = 640, 360
    im = Image.new("RGBA", (W * SS, H * SS), BG)
    font = None
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if os.path.exists(f):
            font = ImageFont.truetype(f, 54 * SS)
            break
    if font is None:
        font = ImageFont.load_default()
    d = ImageDraw.Draw(im)
    text = "Zibbit"
    l, t, r, b = d.textbbox((0, 0), text, font=font, anchor="lm")
    tw = (r - l) / SS                      # text width in px
    frac = 0.46                            # the z + dot, as a share of the canvas height
    aw = frac * H                          # art width in px
    gap = 26
    x0 = (W - (aw + gap + tw)) / 2         # left edge of the whole lockup, so it is centred
    art = Image.new("RGBA", (H * SS, H * SS), (0, 0, 0, 0))
    draw_z(art, frac)
    im.alpha_composite(art, (int((x0 - (H - aw) / 2) * SS), 0))
    d.text((int((x0 + aw + gap) * SS), H * SS // 2), text, font=font, fill=WHITE, anchor="lm")
    return im.convert("RGB").resize((W, H), Image.LANCZOS)


os.makedirs("res/drawable-xhdpi", exist_ok=True)
banner().save("res/drawable-xhdpi/banner.png")

# preview: adaptive icon on a circular mask next to the legacy one
prev = Image.new("RGBA", (1100, 560), (230, 232, 236, 255))
fg = foreground(432)
bg = Image.new("RGBA", (432, 432), BG)
bg.alpha_composite(fg)
mask = Image.new("L", (432, 432), 0)
ImageDraw.Draw(mask).ellipse([0, 0, 431, 431], fill=255)
circ = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
circ.paste(bg, (0, 0), mask)
prev.alpha_composite(circ.resize((420, 420), Image.LANCZOS), (60, 70))
prev.alpha_composite(legacy(420), (620, 70))
prev.save("icon_preview.png")
print("ok")
