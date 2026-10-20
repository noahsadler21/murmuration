# -*- coding: utf-8 -*-
"""Compose the look-test sheets from the render tiles (system python + PIL).
python compose_sheets.py [scan|compare|normals|poses|flock|all]"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PV = os.path.join(ROOT, "models", "preview")
T = os.path.join(PV, "_tiles")
try:
    FONT = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 22)
    FONT_S = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 17)
    FONT_B = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 28)
except Exception:
    FONT = FONT_S = FONT_B = ImageFont.load_default()
BG = (24, 24, 26)
FG = (235, 235, 235)
DIM = (170, 170, 170)


def im(p):
    return Image.open(p if os.path.isabs(p) else os.path.join(T, p))


def label(img, text, font=FONT, xy=(10, 6), fill=FG):
    d = ImageDraw.Draw(img)
    x, y = xy
    d.text((x + 1, y + 1), text, font=font, fill=(0, 0, 0))
    d.text((x, y), text, font=font, fill=fill)


def sheet(rows, title, out, pad=8, head=48, notes=None):
    """rows: list of lists of PIL images (RGB)"""
    widths = [sum(i.size[0] for i in r) + pad * (len(r) - 1) for r in rows]
    W = max(widths) + 2 * pad
    H = head + sum(max(i.size[1] for i in r) for r in rows) + pad * (len(rows) + 1)
    nl = len(notes) if notes else 0
    H += nl * 24 + (10 if nl else 0)
    S = Image.new("RGB", (W, H), BG)
    label(S, title, FONT_B, (pad + 4, 8))
    y = head
    for r in rows:
        x = pad
        for i in r:
            S.paste(i.convert("RGB"), (x, y))
            x += i.size[0] + pad
        y += max(i.size[1] for i in r) + pad
    if notes:
        y += 4
        for n in notes:
            label(S, n, FONT_S, (pad + 4, y), DIM)
            y += 24
    S.save(out)
    print("wrote", out, S.size)


def over(rgba, bg):
    rgba = rgba.convert("RGBA")
    b = Image.new("RGBA", rgba.size, bg)
    b.alpha_composite(rgba)
    return b.convert("RGB")


def scan_sheet():
    raw = [("_raw_front_-Y.png", "raw: from -Y"), ("_raw_right_+X.png", "raw: from +X"),
           ("_raw_back_+Y.png", "raw: from +Y"), ("_raw_top_+Z.png", "raw: from +Z (top)")]
    cl = [("_s1_side.png", "cleaned, flight frame: side (+X)"), ("_s1_top.png", "top (+Z), head -Y"),
          ("_s1_front.png", "front (-Y)"), ("_s1_below.png", "below (-Z)")]
    r1 = []
    for f, t in raw:
        i = im(os.path.join(PV, f)).convert("RGB").resize((560, 560), Image.LANCZOS)
        label(i, t)
        r1.append(i)
    r2 = []
    for f, t in cl:
        i = im(os.path.join(PV, f)).convert("RGB").resize((560, 560), Image.LANCZOS)
        label(i, t)
        r2.append(i)
    sheet([r1, r2], "Starling scan (Tomek museum MP 314, CC0): raw mount vs cleaned + re-posed", os.path.join(PV, "starling_scan_views.png"),
          notes=["Row 1: raw scan, 328k tris, 8k textures, on branch + wooden base.  Row 2: base/rod/branch/legs removed, body levelled (PCA, 42.8 deg),",
                 "head yaw/pitch straightened (39 deg) and rolled (41 deg, mirror-symmetry fit), scaled to 20.5 cm bill-to-tail. Frame: head -Y, back +Z, bird's right wing -X."])


def compare_sheet():
    meta = {"scan": "museum scan (328k tris, wings folded)", "real": "realistic low-poly (1,576 tris, 2k atlas)",
            "retro": "retro low-poly (312 tris, flat, 1k atlas)"}
    rows = []
    for vn in ("q34", "side"):
        r = []
        for n in ("scan", "real", "retro"):
            i = im("cmp_%s_%s.png" % (vn, n)).convert("RGB")
            label(i, meta[n])
            r.append(i)
        rows.append(r)
    sheet(rows, "Scan vs realistic low-poly vs retro low-poly - same cameras, dusk light (warm low sun, cool sky fill)",
          os.path.join(PV, "starling_lowpoly_compare.png"),
          notes=["Low-poly birds in the glide pose with the built spread wings; the scan keeps its folded wings (it is the bake source, not a flight model)."])


def normals_sheet():
    modes = [("flat", "(i) albedo only"), ("baked", "(ii) + baked normal"), ("detail", "(iii) + baked + texture-derived detail")]
    rows = []
    for vn in ("close", "head"):
        r = []
        for m, t in modes:
            i = im("nrm_%s_%s.png" % (vn, m)).convert("RGB")
            label(i, t)
            r.append(i)
        rows.append(r)
    notes = []
    sky = (122, 112, 128)
    for npx, up in ((400, 1), (80, 4), (20, 12)):
        r = []
        arrs = {}
        for m, t in modes:
            a = im("nrm_%dpx_%s.png" % (npx, m)).convert("RGBA")
            arrs[m] = np.asarray(a).astype(float)
            i = over(a, sky + (255,))
            if up > 1:
                i = i.resize((i.size[0] * up, i.size[1] * up), Image.NEAREST)
            label(i, "%s  @%d px span%s" % (t.split(" ")[0], npx, "" if up == 1 else " (x%d nearest)" % up), FONT_S)
            r.append(i)
        rows.append(r)
        mask = arrs["detail"][..., 3] > 8
        def dif(a, b):
            return float(np.abs(arrs[a][..., :3] - arrs[b][..., :3]).mean(-1)[mask].mean())
        lum = float(arrs["detail"][..., :3].mean(-1)[mask].mean())
        arrs["seed2"] = np.asarray(im("nrm_%dpx_detail_seed2.png" % npx).convert("RGBA")).astype(float)
        notes.append("@%3d px: mean |difference| on bird pixels (0-255): (i)->(ii) %.1f, (ii)->(iii) %.1f, (i)->(iii) %.1f ; render-noise floor %.1f  (bird mean level %.0f, %d px)"
                     % (npx, dif("flat", "baked"), dif("baked", "detail"), dif("flat", "detail"), dif("detail", "seed2"), lum, int(mask.sum())))
    print("\n".join(notes))
    json.dump(notes, open(os.path.join(T, "normals_metrics.json"), "w"), indent=1)
    sheet(rows, "Normal maps on the realistic low-poly: (i) albedo only / (ii) baked scan normal / (iii) baked + feather detail from the diffuse",
          os.path.join(PV, "starling_normals_compare.png"), notes=notes)


def poses_sheet():
    rows = []
    for variant in ("real", "retro"):
        for vn in ("top", "side", "front"):
            r = []
            for pose in ("upstroke", "downstroke", "glide"):
                i = im("pose_%s_%s_%s.png" % (variant, pose, vn)).convert("RGB")
                if vn == "top":
                    i = i.rotate(180)
                label(i, "%s - %s - %s" % (variant, pose, vn), FONT_S)
                r.append(i)
            rows.append(r)
    sheet(rows, "Flight poses: upstroke (flexed), mid-downstroke, glide - realistic (rows 1-3) and retro (rows 4-6)",
          os.path.join(PV, "starling_flight_poses.png"),
          notes=["Orthographic, same scale (0.44 m frame). Top views shown head-up."])


def flock_sheet():
    a = im("flock_overcast.png").convert("RGB")
    b = im("flock_dusk.png").convert("RGB")
    w, h = a.size
    crop = a.crop((w // 2 - 240, h // 2 - 135, w // 2 + 240, h // 2 + 135)).resize((960, 540), Image.NEAREST)
    a2 = a.resize((1280, 720), Image.LANCZOS)
    label(a2, "200 retro birds, 10 flap phases + 15% gliding, bright overcast sky, ~30 m (nominal span ~35 px at 1920 wide, 10-30 px as seen)", FONT_S)
    b2 = b.resize((1280, 720), Image.LANCZOS)
    label(b2, "same flock, dusk light", FONT_S)
    c2 = crop.resize((1280, 720), Image.NEAREST)
    label(c2, "centre crop, 2.67x nearest (native pixels)", FONT_S)
    sheet([[a2], [c2], [b2]], "Silhouette / flock read test (Blender instancing, retro low-poly)",
          os.path.join(PV, "starling_silhouette_flock_test.png"))


if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "all"
    for k, f in (("scan", scan_sheet), ("compare", compare_sheet), ("normals", normals_sheet), ("poses", poses_sheet), ("flock", flock_sheet)):
        if w in (k, "all"):
            f()
