# -*- coding: utf-8 -*-
"""Peregrine p4: textures for one variant (real 2048^2 / retro 1024^2), then the documented PLUMAGE REMAP.
  body/head : Cycles selected-to-active EMIT bake of the scan's base colour (+ tangent NORMAL bake for real); the
              trunk (below the neck) is re-projected from the p2 captures where the surface faces up / down, because
              the bake ray first hits the folded wings lying on the specimen's flanks
  wings/tail: the capture regions of the atlas are filled from the p2 captures (wing strips are UV-mapped into them)
  normal    : body = baked from the scan geometry; capture regions = the scan normal seen by the capture, high-passed
              (the folded wing's own curvature removed), rotated into the atlas tangent frame
PLUMAGE REMAP (CIE Lab, D65; no painting, no AI). The specimen is brown-backed with buff, spotted underparts; the
target is an adult:
  dorsal     : L* kept (shifted by one constant so the mean matches the target), a*/b* moved to the slate target
               (sRGB 78,84,92) keeping 15 % of the specimen's chroma
  underparts : the specimen's dark marks (luminance high-pass below -2.5 L*, x2.0; highlights x0.15) on a cream-white
               base (sRGB 225,220,205); dark bars desaturate to grey. The underwing flight feathers and the undertail (the
               barred-flank part of the ventral capture) get a greyer base (L* 74) and x2.4 bars, as on an adult
  dorsal     : feather contrast x0.75 around the target mean
  head       : geometric masks from the low-poly surface position: hood (crown, nape, the neck sides behind the cheek)
               to dark slate, the malar (moustache) stripe below and behind the eye to L* <= 20, cheek/throat white
               and unbarred; the eye (dark disc + yellow orbital ring) and the bill (dark tip, blue-grey, yellow cere) are
               geometric bands / discs on the same surface positions
Run: blender -b -P p4_bake.py -- real|retro. Writes models/out/peregrine/peregrine_<v>_{albedo,albedo_raw,normal}.png
and models/blend/p4_<v>_report.json."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pcommon import *

VARIANT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "real"
RES = 2048 if VARIANT == "real" else 1024
SC = RES / 2048.0
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "p3_lowpoly.blend"))
meta = json.load(open(os.path.join(BLEND, "p3_meta.json")))
scan = bpy.data.objects["scan"]
bt = bpy.data.objects[VARIANT + "_bt"]
for o in bpy.context.scene.objects:
    o.hide_render = o not in (scan, bt)
orig = [s.material for s in scan.material_slots]


def tex_of(m):
    return next(n.image for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)


def emit_mat(m):
    e = bpy.data.materials.new("emit_" + m.name)
    e.use_nodes = True
    nt = e.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = tex_of(m)
    nt.links.new(t.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs[0])
    return e


def diffuse_mat():
    e = bpy.data.materials.new("dif")
    e.use_nodes = True
    nt = e.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    d = nt.nodes.new("ShaderNodeBsdfDiffuse")
    nt.links.new(d.outputs[0], out.inputs[0])
    return e


sc = bpy.context.scene
gpu_cycles(sc, 4)
sc.cycles.use_denoising = False
bk = sc.render.bake
bk.use_selected_to_active = True
bk.cage_extrusion = 0.02
bk.max_ray_distance = 0.045
bk.margin = 8 if RES == 2048 else 4
bk.margin_type = "EXTEND"
bk.use_clear = True
tm = bpy.data.materials.new("bake_target")
tm.use_nodes = True
tnode = tm.node_tree.nodes.new("ShaderNodeTexImage")
bt.data.materials.clear()
bt.data.materials.append(tm)
bpy.ops.object.select_all(action="DESELECT")
scan.select_set(True)
bt.select_set(True)
bpy.context.view_layer.objects.active = bt


def bake(kind, mats):
    im = bpy.data.images.new("%s_%s" % (VARIANT, kind), RES, RES, alpha=True, float_buffer=True)
    if kind == "normal":
        im.colorspace_settings.name = "Non-Color"
    tnode.image = im
    tm.node_tree.nodes.active = tnode
    for i, s in enumerate(scan.material_slots):
        s.material = mats[i]
    t0 = time.time()
    if kind == "normal":
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
    else:
        bpy.ops.object.bake(type="EMIT")
    plog("baked %s (%d px, %.1f s)" % (kind, RES, time.time() - t0))
    return img_pixels(im)[::-1].copy()      # top-down rows


BAKE_ALB = bake("albedo", [emit_mat(m) for m in orig])[..., :3]
dm = diffuse_mat()
BAKE_NRM = bake("normal", [dm, dm])[..., :3] if VARIANT == "real" else None
for i, s in enumerate(scan.material_slots):
    s.material = orig[i]


# ------------------------------------------------------------------ rasterise the body UVs: position + normal
def raster(ob, res, part_ids):
    me = ob.data
    me.calc_loop_triangles()
    parts = np.empty(len(me.polygons), np.int32)
    me.attributes["part"].data.foreach_get("value", parts)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers[0].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    co = verts_np(me)
    ln = np.empty(len(me.loops) * 3, np.float32)
    me.corner_normals.foreach_get("vector", ln)
    ln = ln.reshape(-1, 3)
    M = np.zeros((res, res), bool)
    PP = np.zeros((res, res, 3), np.float32)
    NN = np.zeros((res, res, 3), np.float32)
    for t in me.loop_triangles:
        if parts[t.polygon_index] not in part_ids:
            continue
        L = list(t.loops)
        tri = uv[L] * res
        tri[:, 1] = res - tri[:, 1]                  # top-down rows
        x0, y0 = np.floor(tri.min(0)).astype(int) - 1
        x1, y1 = np.ceil(tri.max(0)).astype(int) + 1
        xs, ys = np.meshgrid(np.arange(max(x0, 0), min(x1 + 1, res)), np.arange(max(y0, 0), min(y1 + 1, res)))
        if xs.size == 0:
            continue
        Q = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)
        a, b, c = tri
        v0, v1 = b - a, c - a
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        w1 = ((Q[:, 0] - a[0]) * v1[1] - v1[0] * (Q[:, 1] - a[1])) / den
        w2 = (v0[0] * (Q[:, 1] - a[1]) - (Q[:, 0] - a[0]) * v0[1]) / den
        w0 = 1 - w1 - w2
        ins = (w1 >= -0.03) & (w2 >= -0.03) & (w0 >= -0.03)
        r, cc = ys.ravel()[ins], xs.ravel()[ins]
        W = np.stack([w0[ins], w1[ins], w2[ins]], 1)
        vi = [me.loops[l].vertex_index for l in L]
        M[r, cc] = True
        PP[r, cc] = W @ co[vi]
        NN[r, cc] = W @ ln[L]
    NN /= np.maximum(np.linalg.norm(NN, axis=-1, keepdims=True), 1e-6)
    return M, PP, NN


BM, BP, BN = raster(bt, RES, (0,))
plog("body raster: %d texels" % BM.sum())


# ------------------------------------------------------------------ captures
def load_exr(name):
    im = bpy.data.images.load(os.path.join(BLEND, name))
    a = img_pixels(im)[::-1].copy()
    bpy.data.images.remove(im)
    return a


def gauss(a, s):
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi * s) ** 2 * (fx * fx + fy * fy))
    if a.ndim == 2:
        return np.fft.irfft2(np.fft.rfft2(a) * g, s=(h, w))
    return np.stack([np.fft.irfft2(np.fft.rfft2(a[..., c]) * g, s=(h, w)) for c in range(a.shape[2])], -1)


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
    if not v.all():
        a[~v] = a[v].mean(0)
    return a


CAPS = {}
for view in ("top", "below"):
    al = load_exr("pcap_%s_albedo.exr" % view)
    nr = load_exr("pcap_%s_normal.exr" % view)
    alpha = al[..., 3] > 0.5
    n = nr[..., :3] * 2 - 1
    # high-pass: remove the folded body / wing curvature (sigma 2.5 mm), keep feather relief
    s = 0.0025 * CAP_PPM
    nb = gauss(np.where(alpha[..., None], n, 0), s) / np.maximum(gauss(alpha.astype(np.float64), s), 1e-3)[..., None]
    det = n - nb + np.array([0, 0, 1.0])
    det /= np.linalg.norm(det, axis=-1, keepdims=True) + 1e-6
    CAPS[view] = (diffuse_fill(al[..., :3], alpha, 40), diffuse_fill(det, alpha, 40), alpha)
    plog("capture %s: %s, coverage %.2f" % (view, al.shape, alpha.mean()))


def sample(img, col, row):
    h, w = img.shape[:2]
    col = np.clip(col - 0.5, 0, w - 1.001)
    row = np.clip(row - 0.5, 0, h - 1.001)
    c0, r0 = np.floor(col).astype(int), np.floor(row).astype(int)
    fc, fr = (col - c0)[..., None], (row - r0)[..., None]
    return (img[r0, c0] * (1 - fc) * (1 - fr) + img[r0, c0 + 1] * fc * (1 - fr) +
            img[r0 + 1, c0] * (1 - fc) * fr + img[r0 + 1, c0 + 1] * fc * fr)


def cap_sample(view, x, y, which=0):
    col, row = cap_px(view, x, y)
    return sample(CAPS[view][which], col, row)


# ------------------------------------------------------------------ compose the linear albedo + normal atlas
ALB = np.zeros((RES, RES, 3), np.float32)
NRM = np.zeros((RES, RES, 3), np.float32)
NRM[..., 2] = 1.0
VALID = np.zeros((RES, RES), bool)
KIND = np.zeros((RES, RES), np.int8)            # 0 none, 1 body, 2 top region, 3 below region
# body: bake on the head/neck and the flanks; top / below capture projections where the trunk faces up / down
r, c = np.nonzero(BM)
p, nn = BP[r, c], BN[r, c]
w_head = np.clip((-0.058 - p[:, 1]) / 0.016, 0, 1)
w_head = w_head * w_head * (3 - 2 * w_head)
wt = np.clip((nn[:, 2] - 0.20) / 0.35, 0, 1) * (1 - w_head)
wb = np.clip((-nn[:, 2] - 0.20) / 0.35, 0, 1) * (1 - w_head)
# bake misses (no scan surface within reach: black texels) fall back to the projections
bv = BAKE_ALB[r, c].sum(-1) > 1e-4
miss = ~bv
wt = np.where(miss, np.where(nn[:, 2] >= 0, 1.0, 0.0), wt)
wb = np.where(miss, np.where(nn[:, 2] < 0, 1.0, 0.0), wb)
plog("body bake misses: %.2f %% of the body texels (filled from the captures)" % (100 * miss.mean()))
proj = cap_sample("top", p[:, 0], p[:, 1]) * wt[:, None] + cap_sample("below", p[:, 0], p[:, 1]) * wb[:, None]
ALB[r, c] = BAKE_ALB[r, c] * (1 - wt - wb)[:, None] + proj
VALID[r, c] = True
KIND[r, c] = 1
if BAKE_NRM is not None:
    NRM[r, c] = BAKE_NRM[r, c] * 2 - 1
for view, kind in (("top", 2), ("below", 3)):
    c0, r0, c1, r1 = reg_rect(view)
    rows = np.arange(int(r0 * SC), int(math.ceil(r1 * SC)))
    cols = np.arange(int(c0 * SC), int(math.ceil(c1 * SC)))
    CC, RR = np.meshgrid(cols, rows)
    x, y = reg_world(view, (CC + 0.5) / SC, (RR + 0.5) / SC)
    ALB[RR, CC] = cap_sample(view, x, y, 0)
    d = cap_sample(view, x, y, 1)
    # capture frame (image right, image up, toward camera) -> atlas tangent frame (U = col, V = row up)
    if view == "top":
        t_, b_ = d[..., 1], d[..., 0]
    else:
        t_, b_ = -d[..., 1], -d[..., 0]
    n3 = np.stack([t_ * 0.8, b_ * 0.8, d[..., 2]], -1)
    NRM[RR, CC] = n3 / np.linalg.norm(n3, axis=-1, keepdims=True)
    VALID[RR, CC] = True
    KIND[RR, CC] = kind
ALB = diffuse_fill(ALB, VALID, int(24 * SC) + 8)
NRM = diffuse_fill(NRM, VALID, int(24 * SC) + 8)


# ------------------------------------------------------------------ Lab
def srgb_enc(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb_dec(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


M_XYZ = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
WHITE = np.array([0.95047, 1.0, 1.08883])


def lin_to_lab(rgb):
    xyz = rgb @ M_XYZ.T / WHITE
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(np.maximum(xyz, 0)), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_lin(lab):
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], -1)
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * WHITE
    return np.clip(xyz @ np.linalg.inv(M_XYZ).T, 0, 1)


def lab_of_srgb(c):
    return lin_to_lab(srgb_dec(np.array(c, float) / 255.0))


LAB = lin_to_lab(ALB.astype(np.float64))
L = LAB[..., 0]
L_hp = L - gauss(L, 4.0 * 3.1 * SC)          # ~1.3 mm at the body density, 0.9 mm in the regions
SLATE = lab_of_srgb((78, 84, 92))
CREAM = lab_of_srgb((225, 220, 205))

# ---- masks
D = np.zeros((RES, RES))
D[KIND == 2] = 1.0
D[KIND == 0] = 0.5
bodyD = np.clip((BN[..., 2] + 0.10) / 0.40, 0, 1)
D = np.where(KIND == 1, bodyD, D)
EX, EY, EZ = 0.016, meta["EYE"][1], meta["EYE"][2]
Px, Py, Pz = np.abs(BP[..., 0]), BP[..., 1], BP[..., 2]


def ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


body = KIND == 1
head = body * (1 - ss(-0.074, -0.060, Py))
side = ss(0.006, 0.009, Px)                          # the sides of the head (not the chin / crown midline)
# hood: crown and the eye region down to 6 mm below the eye; behind the cheek it runs down the neck sides
z_thr = EZ - 0.006 - ss(EY + 0.014, EY + 0.030, Py) * 0.030
hood = ss(z_thr - 0.002, z_thr + 0.002, Pz)
# malar (moustache): a broad wedge from the eye down and slightly back, joined to the hood
y_m = EY + 0.002 + 0.22 * (EZ - Pz)
hw_m = 0.0085 - 0.0025 * np.clip((EZ - Pz) / 0.032, 0, 1)
malar = (1 - ss(hw_m - 0.0012, hw_m + 0.0006, np.abs(Py - y_m))) * ss(EZ - 0.036, EZ - 0.030, Pz) *     (1 - ss(EZ - 0.002, EZ + 0.002, Pz)) * side
# eye: dark iris with the yellow orbital ring (geometric disc on the side of the head)
r_eye = np.sqrt((Py - EY) ** 2 + (Pz - EZ) ** 2)
eye_w = side * (1 - ss(0.0036, 0.0042, r_eye))
ring_w = side * ss(0.0036, 0.0042, r_eye) * (1 - ss(0.0050, 0.0056, r_eye))
w_m = malar
w_h = hood * (1 - w_m)
w_c = (1 - hood) * (1 - w_m)
D = np.where(body, D * (1 - head) + (w_h + 0.5 * w_m) * head, D)

# ---- dorsal: L* kept (one constant shift so the mean matches the target; feather contrast x0.75), a*/b* -> slate
#      + 15 % of the specimen chroma
mean_L_d = float(L[KIND == 2].mean())
dL = SLATE[0] - mean_L_d
dors = np.stack([np.clip(SLATE[0] + 0.75 * (L - mean_L_d), 4, 90), SLATE[1] + 0.15 * LAB[..., 1], SLATE[2] + 0.15 * LAB[..., 2]], -1)
# ---- underparts: cream base + the specimen's dark marks (luminance high-pass below -2.5 L*), bars greyer
dark = np.minimum(L_hp + 2.5, 0)
Lv = np.clip(CREAM[0] + 2.0 * dark + 0.15 * np.maximum(L_hp, 0), 30, 97)
gch = ss(50, 85, Lv)
vent = np.stack([Lv, CREAM[1] * gch, CREAM[2] * gch + 1.0 * (1 - gch)], -1)
# ---- underwing flight feathers + undertail (the barred-flank part of the ventral capture region): greyer and more
#      densely barred than the body underparts, as on an adult's underwing
fx, fy = np.zeros((RES, RES)), np.zeros((RES, RES))
rr_, cc_ = np.nonzero(KIND == 3)
wx_, wy_ = reg_world("below", (cc_ + 0.5) / SC, (rr_ + 0.5) / SC)
fx[rr_, cc_], fy[rr_, cc_] = wx_, wy_
flank = (KIND == 3) * ss(-0.050, -0.046, fx) * (1 - ss(-0.006, -0.002, fx)) * ss(-0.028, -0.024, fy) * (1 - ss(0.068, 0.072, fy))
Lw = np.clip(74 + 2.4 * dark + 0.15 * np.maximum(L_hp, 0), 28, 92)
uw = np.stack([Lw, np.full_like(L, CREAM[1] * 0.4), np.full_like(L, CREAM[2] * 0.4)], -1)
vent = vent * (1 - flank[..., None]) + uw * flank[..., None]
# ---- head: hood dark slate, malar black, cheek / throat white, eye + ring
hood_lab = np.stack([np.clip(26 + 0.4 * L_hp, 14, 36), np.full_like(L, SLATE[1] * 0.7), np.full_like(L, SLATE[2] * 0.7)], -1)
mal_lab = np.stack([np.clip(12 + 0.2 * L_hp, 6, 17), np.full_like(L, SLATE[1] * 0.5), np.full_like(L, SLATE[2] * 0.5)], -1)
chk_lab = np.stack([np.clip(93 + 0.25 * L_hp, 82, 98), np.full_like(L, CREAM[1] * 0.5), np.full_like(L, CREAM[2] * 0.5)], -1)
out = D[..., None] * dors + (1 - D[..., None]) * vent
hd = head[..., None]
hl = w_h[..., None] * hood_lab + w_c[..., None] * chk_lab + w_m[..., None] * mal_lab
eye_lab = np.broadcast_to(np.array([9.0, 0.0, 0.0]), out.shape)
ring_lab = np.broadcast_to(lab_of_srgb((222, 186, 72)), out.shape)
hl = hl * (1 - eye_w[..., None] - ring_w[..., None]) + eye_w[..., None] * eye_lab + ring_w[..., None] * ring_lab
out = out * (1 - hd) + hd * hl
# ---- bill: dark tip, blue-grey bill, yellow cere (geometric bands along the bill)
yb = Py - meta["Y_TIP"]
billm = body * (yb < 0.0135)
bill_lab = np.where((yb < 0.0055)[..., None], lab_of_srgb((52, 54, 60)), lab_of_srgb((118, 124, 136)))
bill_lab = np.where(((yb > 0.0100) & (yb < 0.0135))[..., None], lab_of_srgb((214, 182, 70)), bill_lab)
out = np.where(billm[..., None], bill_lab, out)
malar = w_m * head
hood = w_h * head
ALB2 = lab_to_lin(out)

# ------------------------------------------------------------------ measurements (B4) and outputs
enc_before = srgb_enc(ALB)
enc = srgb_enc(ALB2)
codes = enc * 255.0
# dorsal: the wing/tail-dorsal capture region as used by the wing strips + the dorsal body (D > 0.8)
dmask = (KIND == 2) | (body & (D > 0.8) & (head < 0.5))
dm_rgb = codes[dmask].mean(0)
mx, mn = codes[dmask].max(-1), codes[dmask].min(-1)
sat = float(np.mean((mx - mn) / np.maximum(mx, 1)))
umask = ((KIND == 3) & (flank < 0.5)) | (body & (D < 0.2) & (head < 0.5))
uwmask = flank > 0.9
u_L = float(out[umask][:, 0].mean())
lum = codes @ np.array([0.2126, 0.7152, 0.0722])
hp_codes = lum - gauss(lum, 4.0 * 3.1 * SC)
u_bar = float(hp_codes[umask].std())
mal_m = (malar > 0.9) & body
mal_L = float(out[mal_m][:, 0].mean()) if mal_m.any() else -1.0
uw_L = float(out[uwmask][:, 0].mean())
rep = {"variant": VARIANT, "res": RES, "dorsalMeanSRGB": [round(float(v), 1) for v in dm_rgb],
       "dorsalSaturation": round(sat, 3), "dorsalLshift": round(dL, 2), "specimenDorsalMeanL": round(mean_L_d, 2),
       "underpartsMeanL": round(u_L, 2), "underpartsBarHighpassStdCodes": round(u_bar, 2),
       "malarMeanL": round(mal_L, 2), "underwingMeanL": round(uw_L, 2), "malarTexels": int(mal_m.sum()),
       "targets": {"slate": [78, 84, 92], "cream": [225, 220, 205]}}
plog("report %s" % rep)
json.dump(rep, open(os.path.join(BLEND, "p4_%s_report.json" % VARIANT), "w"), indent=1)


def save_srgb(a, path):
    save_px(a[::-1].astype(np.float32), path, os.path.basename(path), noncolor=True)


pre = os.path.join(OUTP, "peregrine_%s_" % VARIANT)
save_srgb(enc, pre + "albedo.png")
save_srgb(enc_before, pre + "albedo_raw.png")
if VARIANT == "real":
    save_px((NRM * 0.5 + 0.5)[::-1].astype(np.float32), pre + "normal.png", "nrm", noncolor=True)
# mask preview for the colour-remap sheet: R = dorsal weight, G = hood, B = malar
save_px(np.stack([D, hood * 1.0, malar * 1.0], -1)[::-1].astype(np.float32), os.path.join(BLEND, "p4_%s_masks.png" % VARIANT), "m")
plog("done")
