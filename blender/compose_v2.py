# -*- coding: utf-8 -*-
"""Compose the v2 look-test sheets (system python + PIL): python compose_v2.py [compare|cycle|flock|all]"""
import os, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compose_sheets import sheet, label, FONT, FONT_S, PV

T = os.path.join(PV, "_tiles_v2")


def im(n):
    return Image.open(os.path.join(T, n)).convert("RGB")


def compare():
    rows = []
    for vn in ("side", "top", "below", "front", "q34"):
        r = []
        for variant in ("real", "retro"):
            for ver in ("v1", "v2"):
                i = im("cmp_%s_%s_%s.png" % (ver, variant, vn))
                label(i, "%s %s - glide - %s" % (variant, ver, vn), FONT_S)
                r.append(i)
        rows.append(r)
    sheet(rows, "v1 vs v2 (glide): realistic v1 | realistic v2 | retro v1 | retro v2",
          os.path.join(PV, "starling_v2_compare.png"),
          notes=["v2: short square slightly notched fanned tail with thickness, textured from the scan's own tail; wing root on the upper flank with a body-textured,",
                 "body-normal fairing strip; cambered airfoil (thick leading edge, thin trailing edge); glide dihedral 5 deg with lowered hands. Same cameras and light for v1 and v2."])


def cycle():
    names = {0: "top of stroke", 1: "early downstroke", 2: "mid-downstroke", 3: "mid/late downstroke",
             4: "late downstroke", 5: "early upstroke (bottom 0.57 just passed)", 6: "mid-upstroke (flexed)", 7: "late upstroke"}
    rows = []
    for variant in ("real", "retro"):
        for vn in ("side", "front"):
            r = []
            for k in range(8):
                i = im("cyc_%s_%s_%d.png" % (variant, vn, k))
                ph = k / 8.0
                label(i, "%s %s  phase %.3f  %s" % (variant, vn, ph, "DOWN" if ph < 0.57 else "UP"), FONT_S)
                label(i, names[k], FONT_S, (10, 272))
                r.append(i)
            for extra in ("glide", "bound"):
                i = im("cyc_%s_%s_%s.png" % (variant, vn, extra))
                label(i, "%s %s  %s (non-flapping)" % (variant, vn, extra), FONT_S)
                r.append(i)
            rows.append(r)
    rows.append([im("cyc_real_top_glide.png"), im("cyc_real_top_bound.png"), im("cyc_retro_top_glide.png"), im("cyc_retro_top_bound.png")])
    for i, t in zip(rows[-1], ("real top glide", "real top bound", "retro top glide", "retro top bound")):
        label(i, t, FONT_S)
    sheet(rows, "v2 flap cycle: 8 phases (downstroke = 0 to 0.57 of the cycle), plus glide and bound - realistic and retro",
          os.path.join(PV, "starling_v2_flap_cycle.png"),
          notes=["Smooth periodic spline through 6 keys (top 0, mid-down 0.28, bottom 0.57, early-up 0.68, mid-up 0.80, late-up 0.91); 13.3 Hz in real time (Ben-Gida et al. 2013).",
                 "Orthographic, 0.46 m frame. Upstroke: wrist flexed, hand swept back close to the body and supinated; downstroke: extended, swept slightly forward."])


def flock():
    a = im("flock_overcast.png")
    b = im("flock_dusk.png")
    w, h = a.size
    crop = a.crop((w // 2 - 240, h // 2 - 135, w // 2 + 240, h // 2 + 135)).resize((1280, 720), Image.NEAREST)
    a2 = a.resize((1280, 720), Image.LANCZOS)
    label(a2, "v2: 200 retro birds, 70% flapping (16 phases of the v2 cycle), 20% gliding, 10% bounding; overcast dome over dark ground, ~30 m", FONT_S)
    label(crop, "centre crop, 2.67x nearest (native pixels)", FONT_S)
    b2 = b.resize((1280, 720), Image.LANCZOS)
    label(b2, "same flock, dusk light", FONT_S)
    sheet([[a2], [crop], [b2]], "v2 silhouette / flock read test (retro low-poly, v2 cycle)", os.path.join(PV, "starling_v2_silhouette_flock.png"))


if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "all"
    for k, f in (("compare", compare), ("cycle", cycle), ("flock", flock)):
        if w in (k, "all"):
            f()
