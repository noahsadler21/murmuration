# -*- coding: utf-8 -*-
"""Stage 3: build the two low-poly starlings from the cleaned scan.
  body  : loft of ray-cast cross-sections of the scan (symmetrised, folded-wing bulge removed), cylindrical UVs
  tail  : closed two-sided fan fitted to the scan's tail (spread later, after the bake)
  wings : spread flight wings built from a starling planform (9 secondaries, 9 visible primaries + P10 hidden,
          coverts band), two-sided shell, per-feather UV strips into the folded-wing capture (s2)
Atlas layout (fractions of a square atlas, rows from the top): body + tail rows 0..1770/2048, dorsal wing
capture rows 1780..2035 cols 8..1021, derived underwing cols 1027..2040.
Writes models/blend/s3_lowpoly.blend with objects real_bt, real_wings, retro_bt, retro_wings (+ scan)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
from mathutils.bvhtree import BVHTree
import bmesh
import json

bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s1_scan_oriented.blend"))
for o in list(bpy.context.scene.objects):
    if o.type in ("CAMERA", "LIGHT"):
        bpy.data.objects.remove(o)
scan = bpy.data.objects["scan"]
dg = bpy.context.evaluated_depsgraph_get()
bvh = BVHTree.FromObject(scan, dg)
P = verts_np(scan.data)
Y_TIP = float(P[:, 1].min())
TAIL_TIP = float(P[:, 1].max())
A = 2048.0  # layout reference resolution


def zc_at(y, band=0.003):
    s = P[np.abs(P[:, 1] - y) < band]
    if len(s) < 10:
        return 0.0
    return float((s[:, 2].min() + s[:, 2].max()) / 2)


def ray_r(c, d, reach=0.09):
    o = Vector(c) + Vector(d) * reach
    loc, nrm, idx, dist = bvh.ray_cast(o, -Vector(d), reach + 0.02)
    if loc is None:
        return None
    return float((loc - Vector(c)).dot(Vector(d)))


def bump(y, a0, a1, b0, b1):
    if y <= a0 or y >= b1:
        return 0.0
    if y < a1:
        return (y - a0) / (a1 - a0)
    if y > b0:
        return (b1 - y) / (b1 - b0)
    return 1.0


# ------------------------------------------------------------------------------------------------ body loft
def body_rings(stations, N, wing_trim=0.0035):
    # centreline: slice mid-height, smoothed
    zc = np.array([zc_at(y) for y in stations])
    z15 = zc_at(0.015)
    for i, y in enumerate(stations):
        if y > 0.015:
            f = min(1.0, (y - 0.015) / 0.032)
            zc[i] = z15 + (0.0060 - z15) * f
    zs = zc.copy()
    for i in range(1, len(zc) - 1):
        zs[i] = 0.25 * zc[i - 1] + 0.5 * zc[i] + 0.25 * zc[i + 1]
    rings = []
    for y, z in zip(stations, zs):
        c = (0.0, y, z)
        rr = []
        for k in range(N):
            th = (k + 0.5) * 2 * math.pi / N
            d = (math.sin(th), 0.0, math.cos(th))
            r = ray_r(c, d)
            rr.append(0.0012 if r is None or r < 0 else r)
        rr = np.array(rr)
        rr = 0.5 * (rr + rr[::-1])  # mirror k <-> N-1-k
        # folded-wing bulge on the flanks / back (scan has the wings folded on the body)
        bw = bump(y, -0.050, -0.030, 0.035, 0.060)
        for k in range(N):
            th = (k + 0.5) * 2 * math.pi / N
            rr[k] = max(0.0012, rr[k] - wing_trim * bw * abs(math.sin(th)) ** 1.5)
        rings.append((c, rr))
    # smooth radii along y (not the bill)
    R = np.array([r for _, r in rings])
    Rs = R.copy()
    for i in range(1, len(R) - 1):
        if stations[i] > -0.082:
            Rs[i] = 0.25 * R[i - 1] + 0.5 * R[i] + 0.25 * R[i + 1]
    st = np.array(stations)
    # neck: no waist between the head and the shoulders (flying starlings carry a thick, short neck)
    ia, ib = int(np.argmin(np.abs(st + 0.075))), int(np.argmin(np.abs(st + 0.035)))
    for i in range(ia + 1, ib):
        f = (st[i] - st[ia]) / (st[ib] - st[ia])
        Rs[i] = np.maximum(Rs[i], (1 - f) * Rs[ia] + f * Rs[ib])
    # rump: the scan's rear body is padded by the folded tertials / primaries; taper to the tail root
    i0 = int(np.argmin(np.abs(st - 0.0)))
    ths = (np.arange(N) + 0.5) * 2 * math.pi / N
    a_s, b_t, b_b = 0.0080, 0.0030, 0.0060
    root = np.array([1 / math.sqrt((math.sin(t) / a_s) ** 2 + (math.cos(t) / (b_t if math.cos(t) > 0 else b_b)) ** 2) for t in ths])
    for i in range(i0 + 1, len(st)):
        f = min(1.0, (st[i] - st[i0]) / (0.049 - st[i0])) ** 1.25
        cap = (1 - f) * Rs[i0] + f * root
        Rs[i] = np.minimum(Rs[i], cap)
    return [(c, Rs[i]) for i, (c, _) in enumerate(rings)]


def build_loft(name, stations, N, rear_y, D):
    rings = body_rings(stations, N)
    V, F, UV, PART = [], [], [], []
    ring_idx = []
    for c, rr in rings:
        ids = []
        for k in range(N):
            th = (k + 0.5) * 2 * math.pi / N
            V.append((c[0] + rr[k] * math.sin(th), c[1], c[2] + rr[k] * math.cos(th)))
            ids.append(len(V) - 1)
        ring_idx.append(ids)
    tip = len(V)
    V.append((0.0, Y_TIP, zc_at(Y_TIP + 0.001, 0.002)))
    rear = len(V)
    V.append((0.0, rear_y, rings[-1][0][2]))
    # arc lengths per ring starting at vertex k0 = N//2 (just past the belly midline)
    k0 = N // 2
    arcs = []
    for ids in ring_idx:
        pts = [Vector(V[ids[(k0 + j) % N]]) for j in range(N + 1)]
        a = [0.0]
        for j in range(N):
            a.append(a[-1] + (pts[j + 1] - pts[j]).length)
        arcs.append(a)
    circ_max = max(a[-1] for a in arcs) * 1000
    Db = min(D, 1330.0 / circ_max)
    log("%s: max circumference %.1f mm, body texel density %.2f px/mm @2048" % (name, circ_max, Db))

    def uv_body(ri, j):
        a = arcs[ri]
        col = 680 + (a[j] - a[-1] / 2) * 1000 * Db
        row = 40 + (stations[ri] - Y_TIP) * 1000 * Db
        return (col / A, 1 - row / A)
    for ri in range(len(rings) - 1):
        for j in range(N):
            k, kn = (k0 + j) % N, (k0 + j + 1) % N
            a, b = ring_idx[ri][k], ring_idx[ri][kn]
            c_, d_ = ring_idx[ri + 1][kn], ring_idx[ri + 1][k]
            # winding: outward normal (rings go -Y -> +Y, k increases from top toward +X)
            F.append((a, d_, c_, b))
            UV.append((uv_body(ri, j), uv_body(ri + 1, j), uv_body(ri + 1, j + 1), uv_body(ri, j + 1)))
            PART.append(0)
    # bill tip fan
    row_t = 40 + 0 * Db
    for j in range(N):
        k, kn = (k0 + j) % N, (k0 + j + 1) % N
        F.append((tip, ring_idx[0][k], ring_idx[0][kn]))
        F[-1] = (ring_idx[0][kn], ring_idx[0][k], tip)
        ut = (680 + (arcs[0][j] + arcs[0][j + 1] - arcs[0][-1]) / 2 * 1000 * Db) / A
        UV.append((uv_body(0, j + 1), uv_body(0, j), (ut, 1 - row_t / A)))
        PART.append(0)
    # rear cap (hidden under the tail): planar UV in a spare corner
    last = ring_idx[-1]
    cy = rings[-1][0]
    for j in range(N):
        k, kn = (k0 + j) % N, (k0 + j + 1) % N
        F.append((last[k], last[kn], rear))

        def puv(vi):
            x, _, z = V[vi]
            return ((1550 + x * 1000 * 6) / A, 1 - (800 - (z - cy[2]) * 1000 * 6) / A)
        UV.append((puv(last[k]), puv(last[kn]), puv(rear)))
        PART.append(0)
    return V, F, UV, PART, rings


# ------------------------------------------------------------------------------------------------ tail
def build_tail(cols, rows, D, V, F, UV, PART):
    """closed two-sided tail matching the scan (dorsal/ventral planar UVs). cols = number of strips across."""
    y0, y1 = 0.030, TAIL_TIP - 0.0005
    ys = np.linspace(y0, y1, rows + 1)
    base = len(V)
    hw = []
    for y in ys:
        yq = max(y, 0.056)
        zb = None
        for xo in (0.0, 0.003, -0.003):
            h = bvh.ray_cast(Vector((xo, yq, -0.08)), Vector((0, 0, 1)), 0.2)
            if h[0] is not None:
                zb = h[0].z if zb is None else min(zb, h[0].z)
        zc = (zb if zb is not None else 0.0) + 0.0016
        s = P[(np.abs(P[:, 1] - y) < 0.002)]
        if y > 0.055 and len(s) > 20:
            w = float(np.percentile(np.abs(s[:, 0]), 97))
        else:
            w = 0.010
        hw.append((w, zc))
    # smooth half-width monotone-ish
    W = np.array([h[0] for h in hw])
    W = np.maximum.accumulate(np.clip(W, 0.008, 0.018))
    Zc = np.array([h[1] for h in hw])
    cf = np.polyfit(ys, Zc, 1)
    Zc = np.polyval(cf, ys)
    log("tail: half-width %s, z %s" % (W.round(4), Zc.round(4)))
    top, bot = {}, {}
    for i, y in enumerate(ys):
        for j in range(cols + 1):
            u = -1 + 2 * j / cols
            x = u * W[i]
            th = 0.0032 * (1 - u * u) * (1 - 0.75 * i / rows)
            # square tail, very slight notch
            yy = y - (0.0015 * (1 - abs(u)) if i == rows else 0.0)
            edge = (j == 0 or j == cols or i == rows)
            if edge:
                V.append((x, yy, Zc[i]))
                top[(i, j)] = bot[(i, j)] = len(V) - 1
            else:
                V.append((x, yy, Zc[i] + th))
                top[(i, j)] = len(V) - 1
                V.append((x, yy, Zc[i] - th * 0.8))
                bot[(i, j)] = len(V) - 1
    def tuv(vi, ventral):
        x, y, _ = V[vi]
        col = (1860 if ventral else 1560) + x * 1000 * D
        row = 40 + (y - y0) * 1000 * D
        return (col / A, 1 - row / A)
    for i in range(rows):
        for j in range(cols):
            q = (top[(i, j)], top[(i, j + 1)], top[(i + 1, j + 1)], top[(i + 1, j)])
            F.append((q[0], q[3], q[2], q[1]))
            UV.append(tuple(tuv(v, False) for v in (q[0], q[3], q[2], q[1])))
            PART.append(1)
            q = (bot[(i, j)], bot[(i, j + 1)], bot[(i + 1, j + 1)], bot[(i + 1, j)])
            F.append(q)
            UV.append(tuple(tuv(v, True) for v in q))
            PART.append(1)
    return W, Zc, ys


# ------------------------------------------------------------------------------------------------ wings
SPAN = 0.185          # root (x = 0.010) to tip: total span 0.39 m
ROOT = Vector((0.010, -0.034, 0.012))
WS = 0.34 * SPAN      # wrist
CH_ROOT, CH_WRIST = 0.062, 0.064
CAP = {"x0": 700, "y0": 300, "x1": 2050, "y1": 640, "scale": 0.75, "dorsal_at": (8, 1780), "ventral_at": (1027, 1780)}
K = 10.9              # capture px per mm (2400 px / 220 mm)
TPL = {"sec": ((1000, 500), (1600, 400), 26), "pri": ((1150, 600), (2000, 318), 24)}
COV = (720, 1080, 340, 560)


def le_point(u):
    """leading edge, u in [0,1] from shoulder to tip"""
    W = np.array([WS, -0.006])
    H = np.array([0.60 * SPAN, 0.002])
    T = np.array([SPAN, 0.045])
    uw = WS / SPAN
    if u <= uw:
        f = u / uw
        return np.array([WS * f, -0.006 * f ** 0.7])
    f = (u - uw) / (1 - uw)
    return (1 - f) ** 2 * W + 2 * f * (1 - f) * H + f * f * T


def te_hand(p):
    E0 = np.array([WS, CH_WRIST])
    C = np.array([0.64 * SPAN, 0.066])
    T = np.array([SPAN, 0.045])
    return (1 - p) ** 2 * E0 + 2 * p * (1 - p) * C + p * p * T


def cap_to_atlas(px, ventral=False):
    x0, y0, s = CAP["x0"], CAP["y0"], CAP["scale"]
    ax, ay = CAP["ventral_at" if ventral else "dorsal_at"]
    col = ax + (px[0] - x0) * s
    row = ay + (px[1] - y0) * s
    return (col / A, 1 - row / A)


def wing_planform(n_sec, n_pri, rows, serrate):
    """ribs: list of (root(s,c), tip(s,c)); arm ribs 0..n_sec, hand ribs n_sec..n_sec+n_pri"""
    ribs = []
    for k in range(n_sec + 1):
        s = WS * k / n_sec
        le = le_point(s / SPAN)
        ch = CH_ROOT + (CH_WRIST - CH_ROOT) * k / n_sec
        ribs.append((le, np.array([s, ch]), "sec"))
    uw = WS / SPAN
    uh = 0.60
    for j in range(1, n_pri + 1):
        # roots along the hand leading edge (wrist .. hand end), the last rib runs along the leading edge
        f = j / n_pri
        root = le_point(uw + (uh - uw) * min(1.0, f * 1.0))
        p = f ** 0.85
        tip = te_hand(p)
        if j == n_pri:
            root = le_point(uh)
            tip = np.array([SPAN, 0.045])
        ribs.append((root, tip, "pri"))
    return ribs


def build_wing(variant, side, V, F, UV, PART, ATTR):
    if variant == "real":
        n_sec, n_pri, rows, serrate = 9, 9, [0.0, 0.2, 0.42, 0.7], True
    else:
        n_sec, n_pri, rows, serrate = 3, 4, [0.0, 0.42], False
    ribs = wing_planform(n_sec, n_pri, rows, serrate)
    nr = len(ribs)
    rng = np.random.default_rng(7)
    offs = rng.uniform(-28, 10, nr)
    covy = rng.uniform(COV[2], COV[3] - 75, nr)

    def th(s):
        return 0.0034 * (1 - s / SPAN) + 0.0005

    def bumpt(t):
        return t / 0.3 if t < 0.3 else (1 - t) / 0.7

    def place(s, c, z):
        return (ROOT.x + side * s, ROOT.y + c, ROOT.z + z)
    top, bot, notch, tips = {}, {}, {}, {}
    INSET = {"sec": 0.0005, "pri": 0.0014}
    for i, (r0, r1, kind) in enumerate(ribs):
        L = np.linalg.norm(r1 - r0)
        for ri, t in enumerate(rows):
            p = r0 + (r1 - r0) * t
            if t == 0.0:
                V.append(place(p[0], p[1], 0.0))
                top[(i, ri)] = bot[(i, ri)] = len(V) - 1
            else:
                V.append(place(p[0], p[1], th(p[0]) * bumpt(t)))
                top[(i, ri)] = len(V) - 1
                V.append(place(p[0], p[1], -0.35 * th(p[0]) * bumpt(t)))
                bot[(i, ri)] = len(V) - 1
            ATTR.append((p[0] / SPAN, t))
            if t != 0.0:
                ATTR.append((p[0] / SPAN, t))
        ins = INSET[kind] if serrate and 0 < i < nr - 1 else 0.0
        pn = r1 - (r1 - r0) / L * ins
        V.append(place(pn[0], pn[1], 0.0))
        notch[i] = len(V) - 1
        ATTR.append((pn[0] / SPAN, 1.0))
    for i in range(nr - 1):
        if serrate:
            r0a, r1a, _ = ribs[i]
            r0b, r1b, _ = ribs[i + 1]
            da = (r1a - r0a) / np.linalg.norm(r1a - r0a)
            db = (r1b - r0b) / np.linalg.norm(r1b - r0b)
            dm = (da + db) / np.linalg.norm(da + db)
            ft = (r1a + r1b) / 2 + dm * (0.0003 if i < n_sec else 0.0008)
            V.append(place(ft[0], ft[1], 0.0))
            tips[i] = len(V) - 1
            ATTR.append((ft[0] / SPAN, 1.0))
    # ------------------------------------------------ UVs per strip
    COV_T = 0.42

    def suv(i, t, which, zone, ventral):
        """UV of a strip corner. zone 'cov': coverts patch (isotropic, native scale, local frame at rib i root);
        zone 'fl': flight-feather template line (feather length along the template, rib i / i+1 = -hw / +hw)"""
        r0a, r1a, _ = ribs[i]
        r0b, r1b, _ = ribs[i + 1]
        La = np.linalg.norm(r1a - r0a)
        Lb = np.linalg.norm(r1b - r0b)
        if zone == "cov":
            e1 = (r1a - r0a) / La
            e2 = np.array([e1[1], -e1[0]])
            p = (r0a + (r1a - r0a) * t) if which == "a" else (r0b + (r1b - r0b) * t)
            d = p - r0a
            px = (COV[0] + 8 + float(d @ e1) * 1000 * K, covy[i] + abs(float(d @ e2)) * 1000 * K)
            return cap_to_atlas(px, ventral)
        kind = "sec" if i < n_sec else "pri"
        (sx, sy), (ex, ey), hw = TPL[kind]
        ax = np.array([ex - sx, ey - sy], float)
        Lt = np.linalg.norm(ax)
        ax /= Lt
        nrm = np.array([ax[1], -ax[0]])
        Lf = min((1 - COV_T) * (La + Lb) / 2 * 1000 * K, Lt)
        f = (t - COV_T) / (1 - COV_T)
        along = Lt - Lf * (1 - f)
        across = {"a": -hw, "b": hw, "tip": 0.0}[which]
        q = np.array([sx, sy], float) + ax * along + nrm * (across + offs[i])
        return cap_to_atlas((q[0], q[1]), ventral)

    li = len(rows) - 1
    for i in range(nr - 1):
        for surf, ventral in ((top, False), (bot, True)):
            for ri in range(li):
                zone = "cov" if rows[ri + 1] <= COV_T + 1e-6 else "fl"
                q = [surf[(i, ri)], surf[(i + 1, ri)], surf[(i + 1, ri + 1)], surf[(i, ri + 1)]]
                uvq = [suv(i, rows[ri], "a", zone, ventral), suv(i, rows[ri], "b", zone, ventral),
                       suv(i, rows[ri + 1], "b", zone, ventral), suv(i, rows[ri + 1], "a", zone, ventral)]
                F.append(q)
                UV.append(uvq)
                PART.append(2 if side > 0 else 3)
            a, b = surf[(i, li)], surf[(i + 1, li)]
            tl = rows[li]
            if serrate:
                poly = [a, b, notch[i + 1], tips[i], notch[i]]
                uvp = [suv(i, tl, "a", "fl", ventral), suv(i, tl, "b", "fl", ventral), suv(i, 1.0, "b", "fl", ventral),
                       suv(i, 1.0, "tip", "fl", ventral), suv(i, 1.0, "a", "fl", ventral)]
            else:
                poly = [a, b, notch[i + 1], notch[i]]
                uvp = [suv(i, tl, "a", "fl", ventral), suv(i, tl, "b", "fl", ventral), suv(i, 1.0, "b", "fl", ventral),
                       suv(i, 1.0, "a", "fl", ventral)]
            F.append(poly)
            UV.append(uvp)
            PART.append(2 if side > 0 else 3)
    return ribs


def wing_faces_fix(F, UV, PART, start, side):
    """orient: top surface faces up (+Z), bottom down; mirrored wing reversed"""
    pass


def make_object(name, V, F, UV, PART, smooth):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in V], [], [tuple(f) for f in F])
    me.update()
    uvl = me.uv_layers.new(name="UVMap")
    li = 0
    for pi, p in enumerate(me.polygons):
        for k, l in enumerate(p.loop_indices):
            uvl.data[l].uv = UV[pi][k]
    pa = me.attributes.new("part", "INT", "FACE")
    pa.data.foreach_set("value", np.array(PART, dtype=np.int32))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = smooth
    return ob


def orient_wing_faces(ob):
    """make every wing face point away from the wing's mid-surface: top faces +Z, bottom faces -Z
    (top / bottom told apart by the face centre z relative to its neighbours' shared LE/TE)"""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()


def mirror_faces(F, UV, start):
    for i in range(start, len(F)):
        F[i] = tuple(reversed(F[i]))
        UV[i] = tuple(reversed(UV[i]))


def build_variant(variant):
    D = 8.6
    if variant == "real":
        stations = [-0.104, -0.100, -0.095, -0.090, -0.085, -0.081, -0.077, -0.073, -0.069, -0.064, -0.059,
                    -0.054, -0.048, -0.042, -0.035, -0.027, -0.019, -0.011, -0.003, 0.005, 0.013, 0.021, 0.029,
                    0.036, 0.042, 0.047]
        N = 16
        tcols, trows = 6, 4
    else:
        stations = [-0.097, -0.086, -0.077, -0.066, -0.054, -0.040, -0.022, -0.004, 0.014, 0.030, 0.044]
        N = 8
        tcols, trows = 3, 2
    V, F, UV, PART, rings = build_loft(variant + "_bt", stations, N, 0.051, D)
    W, Zc, ys = build_tail(tcols, trows, D, V, F, UV, PART)
    bt = make_object(variant + "_bt", V, F, UV, PART, smooth=(variant == "real"))
    bm = bmesh.new()
    bm.from_mesh(bt.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(bt.data)
    bm.free()
    # wings
    V2, F2, UV2, P2, AT = [], [], [], [], []
    ribs = build_wing(variant, +1, V2, F2, UV2, P2, AT)
    n_left = len(F2)
    nv_left = len(V2)
    build_wing(variant, -1, V2, F2, UV2, P2, AT)
    wings = make_object(variant + "_wings", V2, F2, UV2, P2, smooth=(variant == "real"))
    # fix winding per face: top surface (z above the vertex-row mid) up, bottom down, by face centre vs
    # the plane through the leading edge (z = ROOT.z)
    me = wings.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        cz = f.calc_center_median().z
        f.normal_update()
        want_up = cz >= ROOT.z
        if (f.normal.z > 0) != want_up:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    me.update()
    # per-vertex wing coordinates for the rig: s (span fraction), x sign
    for o in (bt, wings):
        o["variant"] = variant
    log("%s: body+tail %d tris, wings %d tris, total %d" % (variant, tri_count(bt), tri_count(wings), tri_count(bt) + tri_count(wings)))
    return bt, wings, rings, (W, Zc, ys)


real_bt, real_w, real_rings, real_tail = build_variant("real")
retro_bt, retro_w, retro_rings, _ = build_variant("retro")
for o in (retro_bt, retro_w):
    for p in o.data.polygons:
        p.use_smooth = False
# print the measured profile of the realistic body (for LOOKTEST.md)
for c, rr in real_rings[::3] + real_rings[-5:]:
    log("ring y %+.3f zc %+.4f  r_top %.4f r_side %.4f r_bot %.4f" % (c[1], c[2], rr[0], rr[4], rr[8]))
meta = {"SPAN": SPAN, "ROOT": list(ROOT), "WS": WS, "Y_TIP": Y_TIP, "TAIL_TIP": TAIL_TIP, "CAP": CAP, "K": K}
with open(os.path.join(BLEND, "s3_meta.json"), "w") as f:
    json.dump(meta, f, indent=1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "s3_lowpoly.blend"))

# ---------------------------------------------------------------- diagnostic: silhouettes vs scan
sc = bpy.context.scene
gpu_cycles(sc, 8)
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "OBJECT"
sc.display.shading.show_xray = False
scan.color = (0.9, 0.5, 0.2, 1)
for o, col in ((real_bt, (0.2, 0.4, 0.9, 1)), (real_w, (0.2, 0.8, 0.4, 1)), (retro_bt, (0.9, 0.2, 0.6, 1)), (retro_w, (0.9, 0.9, 0.2, 1))):
    o.color = col
for setname, objs in (("real", (real_bt, real_w)), ("retro", (retro_bt, retro_w)), ("scan", (scan,))):
    for o in (scan, real_bt, real_w, retro_bt, retro_w):
        o.hide_render = o not in objs
    for vname, d in (("side", (1, 0, 0)), ("top", (0, 0, 1)), ("front", (0, -1, 0))):
        cam = new_cam("c", Vector(d) * 1.0, (0, 0, 0), ortho=0.42 if vname != "side" else 0.24)
        if vname == "top":
            cam.rotation_euler = (0, 0, 0)
        render_to(sc, cam, os.path.join(PREVIEW, "_s3_%s_%s.png" % (setname, vname)), (900, 900) if vname != "side" else (900, 450))
        bpy.data.objects.remove(cam)
log("done")
