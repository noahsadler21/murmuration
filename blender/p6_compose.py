# -*- coding: utf-8 -*-
"""Compose the peregrine / tail preview sheets (system python + PIL).  python p6_compose.py [poses|compare|scale|remap|tail|scan|all]
Each sheet is also copied to models/preview/falcon_<what>.png (same image)."""
import os, sys, json, shutil
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compose_sheets import sheet, label, FONT, FONT_S, PV

T = os.path.join(PV, "_tiles_peregrine")
BLEND = os.path.join(os.path.dirname(PV), "blend")


def im(n, d=T):
    return Image.open(os.path.join(d, n)).convert("RGB")


def lab(i, t):
    label(i, t, FONT_S)
    return i


PENDING = []


def out(name, falcon=None):
    p = os.path.join(PV, name)
    if falcon:
        PENDING.append((p, os.path.join(PV, falcon)))
    return p


_sheet = sheet


def sheet(*a, **k):
    _sheet(*a, **k)
    while PENDING:
        s_, d_ = PENDING.pop()
        shutil.copyfile(s_, d_)


def rep():
    r5 = json.load(open(os.path.join(BLEND, "p5_report.json")))
    r4 = json.load(open(os.path.join(BLEND, "p4_real_report.json")))
    m3 = json.load(open(os.path.join(BLEND, "p3_meta.json")))
    return r5, r4, m3


def poses():
    r5, r4, m3 = rep()
    for variant in ("real", "retro"):
        names = [("flap0", "flap 0.00 (top)"), ("flap1", "flap 0.27 (mid-down)"), ("flap2", "flap 0.55 (bottom)"),
                 ("flap3", "flap 0.78 (mid-up)"), ("glide", "glide"), ("stoop", "stoop"), ("flare", "flare")]
        rows = []
        for vn in ("top", "side", "front"):
            rows.append([lab(im("pose_%s_%s_%s.png" % (variant, n, vn)), "%s - %s" % (t, vn)) for n, t in names])
        r = r5[variant]
        sheet(rows, "Peregrine %s (%d tris, %d bones): flap x4 phases, glide, stoop, flare" % (variant, r["tris"], r["bones"]),
              out("peregrine_poses%s.png" % ("" if variant == "real" else "_retro"),
                  "falcon_poses%s.png" % ("" if variant == "real" else "_retro")),
              notes=["flap: one stiff, shallow beat (humerus +28 -> -24 deg, downstroke 55 %, wrist flex 18 deg on the upstroke), played at 4-5 Hz by the runtime.",
                     "glide span %.3f m, length %.3f m; stoop top-view area %.0f %% of the glide, max width %.3f m; flare span %.0f %% of the glide, tail fanned."
                     % (r["glideSpanM"], r["lengthM"], 100 * r["stoopAreaFracOfGlide"], r["stoop"]["topWidthM"], 100 * r["flareSpanFracOfGlide"]),
                     "Top and front views orthographic 1.12 m wide, side 0.62 m. EEVEE, pale overcast dome + soft sun, AgX."])


def compare():
    r5, r4, m3 = rep()
    rows = []
    for vn in ("side", "top", "below", "q34", "head"):
        rows.append([lab(im("cmp_%s_%s.png" % (s, vn)), "%s - %s" % (t, vn)) for s, t in
                     (("scan", "cleaned scan (perched)"), ("real", "realistic, glide"), ("retro", "retro, glide"))])
    sheet(rows, "Peregrine: cleaned museum scan vs realistic (%d tris) vs retro (%d tris)" % (r5["real"]["tris"], r5["retro"]["tris"]),
          out("peregrine_lowpoly_compare.png", "falcon_lowpoly_compare.png"),
          notes=["Scan: The Watt Institution (Inverclyde), CC-BY 4.0; about 1M triangles, a perched mount with folded wings, brown specimen plumage.",
                 "Low-poly: body loft ray-cast from the scan, spread wings built to a peregrine planform and textured from the scan's own feathers,",
                 "with the documented Lab plumage remap toward an adult (slate back, barred cream underparts, black moustache). Same cameras for all three."])


def scale():
    rows = [[lab(im("scale_top.png"), "top (seen from above, head up)")],
            [lab(im("scale_below.png"), "below")],
            [lab(im("scale_front.png"), "front")]]
    sheet(rows, "Scale: peregrine (span 1.0 m) vs European starling (span 0.39 m)", out("peregrine_vs_starling_scale.png", "falcon_vs_starling_scale.png"),
          notes=["Both from their museum scans, glide pose, one orthographic camera 1.62 m wide."])


def remap():
    r5, r4, m3 = rep()
    rows = []
    for vn, t in (("below", "below"), ("top", "top")):
        rows.append([lab(im("remap_before_%s.png" % vn), "specimen colours - " + t), lab(im("remap_after_%s.png" % vn), "remapped (adult) - " + t)])
    heads = [lab(im("remap_%s_%s.png" % (tag, v)), "%s - head %s" % (tag, s)) for tag in ("before", "after") for v, s in (("head", "left"), ("headR", "right"))]
    rows.append(heads)
    a = Image.open(os.path.join(os.path.dirname(PV), "out", "peregrine", "peregrine_real_albedo_raw.png")).convert("RGB").resize((480, 480))
    b = Image.open(os.path.join(os.path.dirname(PV), "out", "peregrine", "peregrine_real_albedo.png")).convert("RGB").resize((480, 480))
    m = Image.open(os.path.join(BLEND, "p4_real_masks.png")).convert("RGB").resize((480, 480))
    rows.append([lab(a, "atlas before"), lab(b, "atlas after"), lab(m, "masks: R dorsal, G hood, B malar")])
    sheet(rows, "Peregrine plumage: documented CIE Lab remap (no painting, no AI)", out("peregrine_colour_remap.png", "falcon_colour_remap.png"),
          notes=["Dorsal: L* pattern kept (mean shifted by %.1f to the target, contrast x0.75), a*/b* -> slate sRGB(78,84,92) + 15 %% of the specimen chroma; measured mean sRGB %s, saturation %.3f."
                 % (r4["dorsalLshift"], tuple(int(round(v)) for v in r4["dorsalMeanSRGB"]), r4["dorsalSaturation"]),
                 "Underparts: cream sRGB(225,220,205) + the specimen's dark marks (high-pass x2.0), bars desaturate to grey; mean L* %.1f, bar high-pass std %.1f codes;"
                 % (r4["underpartsMeanL"], r4["underpartsBarHighpassStdCodes"]),
                 "underwing flight feathers / undertail from the barred flanks on a greyer base (mean L* %.1f)." % r4["underwingMeanL"],
                 "Head: geometric masks on the low-poly surface: hood (crown, nape, neck sides) dark slate; malar wedge below/behind the eye mean L* %.1f;"
                 % r4["malarMeanL"],
                 "cheek and throat white; eye = dark disc + yellow orbital ring; bill = dark tip, blue-grey, yellow cere (bands along the bill)."])


def tail():
    meas = json.load(open(os.path.join(T, "tail_measure.json")))
    rows = []
    for vn in ("side", "top", "below"):
        r = []
        for ver in ("v2", "v3"):
            i = im("tail_%s_%s.png" % (ver, vn))
            W, H = i.size
            orth = 0.30 if vn == "side" else 0.44
            ppm = W / orth
            y = meas[ver]["wingRearmostY_glide"]
            d = ImageDraw.Draw(i)
            if vn == "side":
                x = W / 2 + y * ppm
                d.line([(x, 0), (x, H)], fill=(200, 30, 30), width=2)
            else:
                yy = H / 2 + y * ppm
                d.line([(0, yy), (W, yy)], fill=(200, 30, 30), width=2)
            lab(i, "%s - glide - %s  (tail %.1f cm behind the wingtips)" % (ver, vn, meas[ver]["tailBehindWingtipsCm"]))
            r.append(i)
        rows.append(r)
    m = meas["v3_build"]
    sheet(rows, "Starling tail: v2 vs v3 (SPEC 6.1), glide; red line = rear-most wingtip", out("starling_v3_tail.png"),
          notes=["v3: tip just behind the folded wingtips (Y_foldTip %.4f m from the s2b capture; tip %.4f m),"
                 % (m["Y_FOLDTIP"], m["TAIL_Y1"]),
                 "root-to-tip %.2f cm, square with real thickness (10.4 / 6.5 / 6.2 mm at root / 60 %% / tip), fanned 1.7 -> 3.8 cm,"
                 % ((m["TAIL_Y1"] - m["TAIL_Y0"]) * 100),
                 "2.2 mm notch, texture re-mapped to the new length. Glide check: %.1f cm behind the wingtips (limit 4.0; v2 %.1f)."
                 % (meas["v3"]["tailBehindWingtipsCm"], meas["v2"]["tailBehindWingtipsCm"])])


def scan():
    pv = PV
    r1 = [lab(Image.open(os.path.join(pv, f)).convert("RGB").resize((420, 420)), t) for f, t in
          (("_p0_raw_front_-Y.png", "raw scan: -Y"), ("_p0_raw_right_+X.png", "raw: +X"), ("_p0_raw_back_+Y.png", "raw: +Y"), ("_p0_raw_top_+Z.png", "raw: top"))]
    r2 = [lab(Image.open(os.path.join(pv, f)).convert("RGB").resize((420, 420)), t) for f, t in
          (("_p1_side_+X.png", "cleaned, flight frame: side"), ("_p1_top_+Z.png", "top (head down)"), ("_p1_below_-Z.png", "below"), ("_p1_front_-Y.png", "front"))]
    sheet([r1, r2], "Peregrine falcon scan (The Watt Institution, Inverclyde, CC-BY 4.0): raw, then cleaned", out("peregrine_scan_views.png", "falcon_scan_views.png"),
          notes=["Raw: ~1M triangles, 13 meshes, perched taxidermy mount on a rock. Cleaned (p1): rock, legs and feet removed, body levelled (61.7 deg),",
                 "head carried forward with a smooth neck blend, mirror-fit yaw, scaled bill-to-tail 0.400 m; origin at the wing root."])


W = sys.argv[1] if len(sys.argv) > 1 else "all"
for k, f in (("poses", poses), ("compare", compare), ("scale", scale), ("remap", remap), ("tail", tail), ("scan", scan)):
    if W in (k, "all"):
        f()
