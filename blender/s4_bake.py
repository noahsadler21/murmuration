# -*- coding: utf-8 -*-
"""Stage 4: textures.
 body + tail : Cycles selected-to-active bakes from the cleaned scan onto the low-poly UVs
               (albedo / occlusion / spec level / glossiness as EMIT, tangent-space NORMAL)
 wings       : composited from the folded-wing captures (s2), dorsal + derived grey-brown underwing
 detail      : feather-detail normal derived from the albedo (high-pass luminance -> height -> normal),
               RNM-combined with the baked normal
Run: blender -b -P s4_bake.py -- real|retro"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
import json

VARIANT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "real"
RES = 2048 if VARIANT == "real" else 1024
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s3_lowpoly.blend"))
meta = json.load(open(os.path.join(BLEND, "s3_meta.json")))
scan = bpy.data.objects["scan"]
bt = bpy.data.objects[VARIANT + "_bt"]
for o in bpy.context.scene.objects:
    o.hide_render = o not in (scan, bt)
src = scan.data.materials[0]
imgs = {os.path.basename(n.image.filepath): n.image for n in src.node_tree.nodes if n.type == "TEX_IMAGE" and n.image}


def img(key):
    return next(v for k, v in imgs.items() if key in k)


def emit_mat(kind):
    m = bpy.data.materials.new("emit_" + kind)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(em.outputs[0], out.inputs[0])
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img({"albedo": "diffuse", "occ": "occlusion", "spec": "specular", "gloss": "specular"}[kind])
    nt.links.new(t.outputs["Alpha" if kind == "gloss" else "Color"], em.inputs["Color"])
    return m


def normal_mat(with_map):
    """principled with (or without) the scan's own tangent-space normal map"""
    m = bpy.data.materials.new("nrm_%d" % with_map)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bs = nt.nodes.new("ShaderNodeBsdfDiffuse")
    nt.links.new(bs.outputs[0], out.inputs[0])
    if with_map:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img("normal")
        t.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bs.inputs["Normal"])
    return m


sc = bpy.context.scene
gpu_cycles(sc, 4)
sc.cycles.use_denoising = False
bk = sc.render.bake
bk.use_selected_to_active = True
bk.cage_extrusion = 0.012
bk.max_ray_distance = 0.03
bk.margin = 12 if RES == 2048 else 6
bk.margin_type = "EXTEND"
bk.use_clear = True
target_mat = bpy.data.materials.new(VARIANT + "_bake_target")
target_mat.use_nodes = True
tnt = target_mat.node_tree
tnode = tnt.nodes.new("ShaderNodeTexImage")
bt.data.materials.clear()
bt.data.materials.append(target_mat)
bpy.ops.object.select_all(action="DESELECT")
scan.select_set(True)
bt.select_set(True)
bpy.context.view_layer.objects.active = bt


def bake(kind, scan_mat, noncolor=True):
    im = bpy.data.images.new("%s_%s" % (VARIANT, kind), RES, RES, alpha=True, float_buffer=True)
    if noncolor:
        im.colorspace_settings.name = "Non-Color"
    tnode.image = im
    tnt.nodes.active = tnode
    scan.data.materials[0] = scan_mat
    t0 = time.time()
    if kind.startswith("normal"):
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
    else:
        bpy.ops.object.bake(type="EMIT")
    log("baked %s (%d px, %.1f s)" % (kind, RES, time.time() - t0))
    return img_pixels(im)


px = {}
px["albedo"] = bake("albedo", emit_mat("albedo"), noncolor=False)   # linear float values
px["occ"] = bake("occ", emit_mat("occ"))
px["spec"] = bake("spec", emit_mat("spec"))
px["gloss"] = bake("gloss", emit_mat("gloss"))
px["normal"] = bake("normal", normal_mat(True))
px["normal_geo"] = bake("normal_geo", normal_mat(False))
scan.data.materials[0] = src
d = np.abs(px["normal"][..., :3] - px["normal_geo"][..., :3]).mean(-1)
cov = px["albedo"][..., 3] > 0.5 if px["albedo"][..., 3].max() > 0 else None

# coverage mask of the body/tail islands: rasterise the UV triangles
def uv_mask(ob, res, part=None):
    me = ob.data
    parts = np.empty(len(me.polygons), np.int32)
    me.attributes["part"].data.foreach_get("value", parts)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers[0].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    m = np.zeros((res, res), bool)
    for p in me.polygons:
        if part is not None and parts[p.index] != part:
            continue
        L = list(p.loop_indices)
        for k in range(1, len(L) - 1):
            tri = uv[[L[0], L[k], L[k + 1]]] * res
            x0, y0 = np.floor(tri.min(0)).astype(int)
            x1, y1 = np.ceil(tri.max(0)).astype(int)
            xs, ys = np.meshgrid(np.arange(max(x0, 0), min(x1 + 1, res)), np.arange(max(y0, 0), min(y1 + 1, res)))
            if xs.size == 0:
                continue
            P_ = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)
            a, b, c = tri
            v0, v1 = b - a, c - a
            den = v0[0] * v1[1] - v1[0] * v0[1]
            if abs(den) < 1e-12:
                continue
            w1 = ((P_[:, 0] - a[0]) * v1[1] - v1[0] * (P_[:, 1] - a[1])) / den
            w2 = (v0[0] * (P_[:, 1] - a[1]) - (P_[:, 0] - a[0]) * v0[1]) / den
            ins = (w1 >= -0.02) & (w2 >= -0.02) & (w1 + w2 <= 1.02)
            m[ys.ravel()[ins], xs.ravel()[ins]] = True
    return m  # rows = v (bottom-up, Blender pixel order)

body_m = uv_mask(bt, RES)
tail_m = uv_mask(bt, RES, part=1)
log("normal map contribution (baked with vs without the scan's normal map), mean |dN| over the islands: %.4f"
    % float(d[body_m].mean()))

# ------------------------------------------------------------------ wing region from the captures
def load_exr(path):
    im = bpy.data.images.load(path)
    a = img_pixels(im).copy()
    bpy.data.images.remove(im)
    return a  # bottom-up rows


def diffuse_fill(a, valid, iters=64):
    a = a.copy()
    a[~valid] = 0
    v = valid.copy()
    for _ in range(iters):
        if v.all():
            break
        acc = np.zeros_like(a)
        cnt = np.zeros(a.shape[:2], np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            vv = np.roll(np.roll(v, dy, 0), dx, 1)
            acc += np.roll(np.roll(a, dy, 0), dx, 1) * vv[..., None]
            cnt += vv
        g = (~v) & (cnt > 0)
        a[g] = acc[g] / cnt[g][:, None]
        v |= g
    return a


def gauss(a, s):
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi * s) ** 2 * (fx * fx + fy * fy))
    if a.ndim == 2:
        return np.fft.irfft2(np.fft.rfft2(a) * g, s=(h, w))
    return np.stack([np.fft.irfft2(np.fft.rfft2(a[..., c]) * g, s=(h, w)) for c in range(a.shape[2])], -1)


CAPD = {}
for kind in ("albedo", "normal", "occ", "spec"):
    a = load_exr(os.path.join(BLEND, "cap_R_%s.exr" % kind))
    a = a[::-1]           # top-down rows (image coordinates as picked in s3)
    a = a[:, ::-1]        # mirror: head left, tail right (as the landmark picks)
    alpha = a[..., 3] > 0.5
    rgb = a[..., :3]
    if kind == "normal":
        n = rgb * 2 - 1
        n[..., 0] *= -1   # mirrored image: tangent x flips
        nb = gauss(np.where(alpha[..., None], n, 0), 18) / np.maximum(gauss(alpha.astype(float), 18), 1e-3)[..., None]
        det = n - nb + np.array([0, 0, 1.0])  # remove the folded wing's own curvature, keep feather relief
        det /= np.linalg.norm(det, axis=-1, keepdims=True) + 1e-6
        rgb = det * 0.5 + 0.5
    rgb = diffuse_fill(rgb, alpha, 80)
    CAPD[kind] = (rgb, alpha)
    log("capture %s loaded %s" % (kind, rgb.shape))
C = meta["CAP"]
x0, y0, x1, y1, s = C["x0"], C["y0"], C["x1"], C["y1"], C["scale"]
f = RES / 2048.0


def resize(a, w, h):
    im = bpy.data.images.new("tmp", a.shape[1], a.shape[0], float_buffer=True)
    full = np.ones((a.shape[0], a.shape[1], 4), np.float32)
    full[..., :a.shape[2]] = a
    im.pixels.foreach_set(full[::-1].ravel())
    im.scale(w, h)
    out = img_pixels(im)[::-1, :, :a.shape[2]].copy()
    bpy.data.images.remove(im)
    return out


def paste(dst_topdown, a, col, row):
    h, w = a.shape[:2]
    dst_topdown[row:row + h, col:col + w, :a.shape[2]] = a


W_ = int(round((x1 - x0) * s * f))
H_ = int(round((y1 - y0) * s * f))
tex = {}
for name in ("albedo", "occ", "spec", "gloss", "normal"):
    tex[name] = px[name][::-1].copy()   # top-down
wing_alb = resize(CAPD["albedo"][0][y0:y1, x0:x1], W_, H_)
wing_nrm = resize(CAPD["normal"][0][y0:y1, x0:x1], W_, H_)
wing_occ = resize(CAPD["occ"][0][y0:y1, x0:x1], W_, H_)
wing_spec = resize(CAPD["spec"][0][y0:y1, x0:x1], W_, H_)
# underwing: grey-brown (starling underwing coverts / flight-feather undersides), keeping the dorsal feather
# structure as low-contrast luminance detail; no buff fringes, no white spots
lum = (wing_alb * np.array([0.2126, 0.7152, 0.0722])).sum(-1)
hp = lum - gauss(lum, 6 * f)
base = np.array([0.135, 0.112, 0.094])     # linear, ~ sRGB (103, 94, 86)
under = base[None, None, :] * np.clip(1.0 + 4.0 * hp[..., None] / max(1e-4, lum.mean()), 0.45, 1.9)
under = under * (0.85 + 0.15 * (wing_alb / np.maximum(lum[..., None], 1e-4)).clip(0.6, 1.4))
dc, dr = [int(round(v * f)) for v in C["dorsal_at"]]
vc, vr = [int(round(v * f)) for v in C["ventral_at"]]
paste(tex["albedo"], wing_alb, dc, dr)
paste(tex["albedo"], under, vc, vr)
paste(tex["normal"], wing_nrm, dc, dr)
un = wing_nrm * 2 - 1
un[..., :2] *= 0.5
un /= np.linalg.norm(un, axis=-1, keepdims=True)
paste(tex["normal"], un * 0.5 + 0.5, vc, vr)
for nm_, a in (("occ", wing_occ), ("spec", wing_spec)):
    paste(tex[nm_], a, dc, dr)
    paste(tex[nm_], a, vc, vr)
tex["gloss"][dr:dr + H_, dc:dc + W_, :3] = 0.70
tex["gloss"][vr:vr + H_, vc:vc + W_, :3] = 0.70
# ------------------------------------------------------------------ v2 tail: the scan's own tail feathers
# (s2b top / bottom orthographic captures; behind the crossed wingtips on top, undertail coverts + rectrix
# undersides below), pasted where the tail strips' UVs point
TC = {"top": {"x0": 440, "y0": 140, "x1": 800, "y1": 680, "scale": 1.0, "at": (1390, 45)},
      "bot": {"x0": 440, "y0": 250, "x1": 820, "y1": 1460, "scale": 0.48, "at": (1800, 45)}}
tail_rects = []
for which, c in TC.items():
    caps = {}
    for kind in ("albedo", "normal", "occ"):
        a = load_exr(os.path.join(BLEND, "tcap_%s_%s.exr" % (which, kind)))[::-1]
        alpha = a[..., 3] > 0.5
        rgb = a[..., :3]
        if kind == "normal":
            n = rgb * 2 - 1
            nb = gauss(np.where(alpha[..., None], n, 0), 30) / np.maximum(gauss(alpha.astype(float), 30), 1e-3)[..., None]
            det = n - nb + np.array([0, 0, 1.0])
            det /= np.linalg.norm(det, axis=-1, keepdims=True) + 1e-6
            rgb = det * 0.5 + 0.5
        rgb = diffuse_fill(rgb, alpha, 120)
        crop = rgb[c["y0"]:c["y1"], c["x0"]:c["x1"]]
        w_ = int(round((c["x1"] - c["x0"]) * c["scale"] * f))
        h_ = int(round((c["y1"] - c["y0"]) * c["scale"] * f))
        caps[kind] = resize(crop, w_, h_)
    col, row = int(round(c["at"][0] * f)), int(round(c["at"][1] * f))
    for kind, key in (("albedo", "albedo"), ("normal", "normal"), ("occ", "occ")):
        paste(tex[key], caps[kind], col, row)
    hh, ww = caps["albedo"].shape[:2]
    tex["gloss"][row:row + hh, col:col + ww, :3] = 0.70
    tex["spec"][row:row + hh, col:col + ww, :3] = 0.3
    tail_rects.append((row, col, hh, ww))
    log("tail capture %s pasted at (%d, %d) %dx%d" % (which, col, row, ww, hh))
cover = body_m[::-1].copy()
for (r_, c_, h_, w_) in tail_rects:
    cover[r_:r_ + h_, c_:c_ + w_] = True
cover[dr:dr + H_, dc:dc + W_] = True
cover[vr:vr + H_, vc:vc + W_] = True
wingregion = np.zeros_like(cover)
wingregion[dr:dr + H_, dc:dc + W_] = True
wingregion[vr:vr + H_, vc:vc + W_] = True

# ------------------------------------------------------------------ feather-detail normal from the albedo
alb = tex["albedo"][..., :3]
L = (alb * np.array([0.2126, 0.7152, 0.0722])).sum(-1)
L = np.power(np.clip(L, 0, 1), 1 / 2.2)  # perceptual luminance
m = cover.astype(float)
SIG = 5.0 * f  # ~0.6 mm on the body at 8.6 px/mm
mb = np.maximum(gauss(m, SIG), 1e-3)
hpL = (L - gauss(L * m, SIG) / mb) * m
# soft-clip so the white spot tips read as raised scale tips, not as spikes
height = np.tanh(hpL / 0.12) * 0.12
height = gauss(height, 0.8 * f)
gy, gx = np.gradient(height)
# feather overlap: each feather's tip edge casts a step -> emphasise the luminance edge facing the tip direction
STRENGTH = float(os.environ.get("DETAIL_STRENGTH", "6.0")) * f
er = cover.copy()
for _ in range(2):
    er = er & np.roll(er, 1, 0) & np.roll(er, -1, 0) & np.roll(er, 1, 1) & np.roll(er, -1, 1)
nx = -gx * STRENGTH
ny = gy * STRENGTH        # image rows run top-down, +v (OpenGL green) runs up
nx[~er] = 0
ny[~er] = 0
det = np.stack([nx, ny, np.ones_like(nx)], -1)
det /= np.linalg.norm(det, axis=-1, keepdims=True)
base_n = tex["normal"][..., :3] * 2 - 1
# tail: the scan's tail is covered by the crossed wingtips, its baked relief is meaningless on a spread tail
# (v2: the tail normal comes from its own capture, pasted above)
base_n /= np.linalg.norm(base_n, axis=-1, keepdims=True) + 1e-6
# RNM (reoriented normal mapping) blend
t_ = base_n + np.array([0, 0, 1.0])
u_ = det * np.array([-1, -1, 1.0])
r_ = t_ * (t_ * u_).sum(-1, keepdims=True) / t_[..., 2:3] - u_
r_ /= np.linalg.norm(r_, axis=-1, keepdims=True) + 1e-6
log("detail normal: mean tilt %.2f deg (baked %.2f deg, combined %.2f deg)" % (
    float(np.degrees(np.arccos(np.clip(det[..., 2][cover], -1, 1))).mean()),
    float(np.degrees(np.arccos(np.clip(base_n[..., 2][cover], -1, 1))).mean()),
    float(np.degrees(np.arccos(np.clip(r_[..., 2][cover], -1, 1))).mean())))

# ------------------------------------------------------------------ gloss / iridescence mask
spec = tex["spec"][..., 0]
gloss = tex["gloss"][..., 0]
Lp = L
sat = (alb.max(-1) - alb.min(-1)) / np.maximum(alb.max(-1), 1e-4)
irid = np.clip((0.30 - Lp) / 0.14, 0, 1) * np.clip((0.55 - sat) / 0.3, 0, 1)
irid[wingregion] *= 0.35   # flight feathers are mostly matt brown on starlings
irid = gauss(irid, 1.0 * f) * cover
corr = float(np.corrcoef(spec[cover], L[cover])[0, 1])
log("spec level vs albedo luminance correlation on the low-poly atlas: %.3f ; gloss mean %.3f std %.3f"
    % (corr, float(gloss[cover].mean()), float(gloss[cover].std())))
occ = tex["occ"][..., 0]

# ------------------------------------------------------------------ write
pre = os.path.join(OUT, "starling_%s_" % VARIANT)
def out(name, a, noncolor=True):
    save_px(a[::-1].astype(np.float32), pre + name + ".png", "o_" + name, noncolor)
    log("wrote %s%s.png" % (os.path.basename(pre), name))

alb_fill = diffuse_fill(alb, cover, 24)
def to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
out("albedo", to_srgb(alb_fill), noncolor=False)
out("normal_baked", diffuse_fill(base_n * 0.5 + 0.5, cover, 24))
out("normal_detail", diffuse_fill(r_ * 0.5 + 0.5, cover, 24))
out("normal_texonly", diffuse_fill(det * 0.5 + 0.5, cover, 24))
out("mask", np.stack([diffuse_fill(occ[..., None], cover, 24)[..., 0], gloss, irid], -1))
np.save(os.path.join(BLEND, "s4_%s_stats.npy" % VARIANT), np.array([float(d[body_m].mean()), corr]))
log("done")
