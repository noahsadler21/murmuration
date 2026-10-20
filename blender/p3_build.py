# -*- coding: utf-8 -*-
"""Peregrine p3: build the realistic and retro low-poly falcons from the cleaned scan (p1) and its captures (p2).
  body : loft of ray-cast cross-sections of the scan (mirror-symmetrised; the folded wings on the flanks and back
         trimmed off; rump tapered into the tail root), cylindrical UVs with the seam along the back midline
  tail : closed block, 0.155 m root to tip, narrow (6.0 cm closed at the tip), square to slightly rounded,
         with thickness; per-vertex 'tail_u' (-1..1 across) for the tail-fan bones
  wings: spread flight wings (span 1.00 m in the glide, root chord 0.17 m, wrist chord 0.14 m, hand 55 % of the
         semi-span, P9/P10 forming a sharp tip, nearly straight trailing edge to the wrist), two-sided cambered
         shell, a body-textured fairing strip at the root; every feather strip gets UVs in the falcon's own
         captures: the dorsal flight feathers from the folded primaries / secondaries (top capture), the coverts
         from the mantle and scapulars, the UNDERWING from the barred flanks and the spotted breast (below capture)
Atlas layout: pcommon.py (body band at the top, the two capture regions below it).
Writes models/blend/p3_lowpoly.blend (objects real_bt, real_wings, retro_bt, retro_wings, scan) and p3_meta.json."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pcommon import *
from mathutils.bvhtree import BVHTree
import bmesh

bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "p1_scan_oriented.blend"))
for o in list(bpy.context.scene.objects):
    if o.type in ("CAMERA", "LIGHT"):
        bpy.data.objects.remove(o)
scan = bpy.data.objects["scan"]
dg = bpy.context.evaluated_depsgraph_get()
bvh = BVHTree.FromObject(scan, dg)
P = verts_np(scan.data)
Y_TIP = float(P[:, 1].min())
TAIL_TIP_SCAN = float(P[:, 1].max())
RUMP_Y = 0.125                  # end of the body loft (the scan's undertail ends at y ~ 0.105)
TAIL_Y0, TAIL_Y1 = 0.110, 0.265  # tail root (hidden in the rump) .. tip: 0.155 m; bill-to-tail 0.400 m
TAIL_W0, TAIL_W1 = 0.021, 0.030  # half widths at the root / tip: 6.0 cm closed at the tip
Z_TAIL = 0.010                   # tail mid-plane height at the root (continues the back line)


def zc_at(y, band=0.004):
    s = P[np.abs(P[:, 1] - y) < band]
    if len(s) < 10:
        return 0.0
    return float((s[:, 2].min() + s[:, 2].max()) / 2)


def ray_r(c, d, reach=0.11):
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


def sstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------------------ body loft
def body_rings(stations, N):
    zc = np.array([zc_at(y) for y in stations])
    # behind y = 0.05 the scan's slice is dominated by the drooping folded primaries: blend the centre line to the
    # tail root height
    z50 = zc_at(0.050)
    for i, y in enumerate(stations):
        if y > 0.050:
            f = sstep(0.050, RUMP_Y, y)
            zc[i] = z50 + (Z_TAIL - 0.002 - z50) * f
    zs = zc.copy()
    for i in range(1, len(zc) - 1):
        zs[i] = 0.25 * zc[i - 1] + 0.5 * zc[i] + 0.25 * zc[i + 1]
    ths = (np.arange(N) + 0.5) * 2 * math.pi / N        # theta 0 = top (+Z), increasing toward +X
    rings = []
    for y, z in zip(stations, zs):
        c = (0.0, y, z)
        rr = []
        for th in ths:
            r = ray_r(c, (math.sin(th), 0.0, math.cos(th)))
            rr.append(0.0012 if r is None or r < 0 else r)
        rr = np.array(rr)
        rr = 0.5 * (rr + rr[::-1])                       # mirror k <-> N-1-k
        # folded wings on the flanks (up to 1.5 cm) and over the back (0.5 cm)
        bw = bump(y, -0.060, -0.030, 0.090, 0.125)
        for k, th in enumerate(ths):
            trim = bw * (0.015 * abs(math.sin(th)) ** 1.5 + 0.005 * max(0.0, math.cos(th)) ** 2)
            rr[k] = max(0.0015, rr[k] - trim)
        rings.append((c, rr))
    R = np.array([r for _, r in rings])
    Rs = R.copy()
    st = np.array(stations)
    for i in range(1, len(R) - 1):
        if st[i] > -0.118:
            Rs[i] = 0.25 * R[i - 1] + 0.5 * R[i] + 0.25 * R[i + 1]
    # neck: no waist between the head and the shoulders
    ia, ib = int(np.argmin(np.abs(st + 0.090))), int(np.argmin(np.abs(st + 0.045)))
    for i in range(ia + 1, ib):
        f = (st[i] - st[ia]) / (st[ib] - st[ia])
        Rs[i] = np.maximum(Rs[i], (1 - f) * Rs[ia] + f * Rs[ib])
    # rump: taper into an ellipse around the tail root
    i0 = int(np.argmin(np.abs(st - 0.060)))
    a_s, b_t, b_b = 0.024, 0.008, 0.013
    root = np.array([1 / math.sqrt((math.sin(t) / a_s) ** 2 + (math.cos(t) / (b_t if math.cos(t) > 0 else b_b)) ** 2) for t in ths])
    for i in range(i0 + 1, len(st)):
        f = min(1.0, (st[i] - st[i0]) / (RUMP_Y - st[i0])) ** 1.3
        Rs[i] = np.minimum(Rs[i], (1 - f) * Rs[i0] + f * root)
    return [(c, Rs[i]) for i, (c, _) in enumerate(rings)], ths


def build_loft(name, stations, N):
    rings, ths = body_rings(stations, N)
    V, F, UV, PART = [], [], [], []
    ring_idx = []
    for c, rr in rings:
        ids = []
        for k, th in enumerate(ths):
            V.append((c[0] + rr[k] * math.sin(th), c[1], c[2] + rr[k] * math.cos(th)))
            ids.append(len(V) - 1)
        ring_idx.append(ids)
    tip = len(V)
    V.append((0.0, Y_TIP, zc_at(Y_TIP + 0.002, 0.002)))
    rear = len(V)
    V.append((0.0, RUMP_Y + 0.004, rings[-1][0][2]))
    # arc length per ring, starting at the back midline (between k = N-1 and k = 0) -> seam on the back
    arcs = []
    for ids in ring_idx:
        pts = [Vector(V[ids[j % N]]) for j in range(N + 1)]
        top = (Vector(V[ids[-1]]) + Vector(V[ids[0]])) / 2
        a = [(pts[0] - top).length]
        for j in range(N):
            a.append(a[-1] + (pts[j + 1] - pts[j]).length)
        arcs.append(a)
    circ = max(a[-1] for a in arcs)
    k1 = min(BODY_PPM, 2030.0 / circ)

    def uv_body(ri, j):
        a = arcs[ri]
        col = BODY_COLC + (a[j] - a[-1] / 2) * k1
        row = BODY_ROW0 + 6 + (stations[ri] - Y_TIP) * k1
        return (col / A, 1 - row / A)
    for ri in range(len(rings) - 1):
        for j in range(N):
            a, b = ring_idx[ri][j % N], ring_idx[ri][(j + 1) % N]
            c_, d_ = ring_idx[ri + 1][(j + 1) % N], ring_idx[ri + 1][j % N]
            F.append((a, d_, c_, b))
            UV.append((uv_body(ri, j), uv_body(ri + 1, j), uv_body(ri + 1, j + 1), uv_body(ri, j + 1)))
            PART.append(0)
    for j in range(N):
        F.append((ring_idx[0][(j + 1) % N], ring_idx[0][j % N], tip))
        ut = (BODY_COLC + ((arcs[0][j] + arcs[0][j + 1]) / 2 - arcs[0][-1] / 2) * k1) / A
        UV.append((uv_body(0, j + 1), uv_body(0, j), (ut, 1 - (BODY_ROW0 + 2) / A)))
        PART.append(0)
    last = ring_idx[-1]
    for j in range(N):
        F.append((last[j % N], last[(j + 1) % N], rear))
        UV.append(tuple(reg_uv("below", V[v][0], 0.105 + (V[v][2] - rings[-1][0][2])) for v in (last[j % N], last[(j + 1) % N], rear)))
        PART.append(0)
    plog("%s: %d rings x %d, max circumference %.1f mm, body texel density %.2f px/mm @2048"
         % (name, len(rings), N, circ * 1000, k1 / 1000))
    return V, F, UV, PART, rings


# ------------------------------------------------------------------------------------------------ tail
TAIL_TOP_SRC = (-0.014, 0.016, 0.096, 0.181)    # barred tertials / upper-tail region of the top capture: xc, hw, y0, y1
TAIL_BOT_SRC = (-0.027, 0.016, -0.022, 0.066)   # barred flank region of the below capture


def build_tail(cols, rows, V, F, UV, PART, TU):
    y0, y1 = TAIL_Y0, TAIL_Y1
    fs = list(np.linspace(0, 1, rows + 1) ** 0.85)
    top, bot = {}, {}
    for i, f in enumerate(fs):
        W = TAIL_W0 + (TAIL_W1 - TAIL_W0) * f
        T = 0.0085 + (0.0045 - 0.0085) * f           # total thickness 8.5 -> 4.5 mm
        zc = Z_TAIL - 0.004 * f
        for j in range(cols + 1):
            u = -1 + 2 * j / cols
            y = y0 + (y1 - y0) * f
            if i == rows:
                y -= 0.006 * u * u                   # slightly rounded end
            p = 1 - 0.35 * u * u
            V.append((u * W, y, zc + 0.45 * T * p))
            top[(i, j)] = len(V) - 1
            TU.append(u)
            V.append((u * W, y, zc - 0.55 * T * p))
            bot[(i, j)] = len(V) - 1
            TU.append(u)

    def uvv(vi, which):
        x, y, z = V[vi]
        f = min(max((y - y0) / (y1 - y0), 0), 1)
        W = TAIL_W0 + (TAIL_W1 - TAIL_W0) * f
        u = max(-1.0, min(1.0, x / W))
        xc, hw, a, b = TAIL_TOP_SRC if which == "top" else TAIL_BOT_SRC
        return reg_uv(which, xc + u * hw, a + (b - a) * f)
    for i in range(rows):
        for j in range(cols):
            q = [top[(i, j)], top[(i + 1, j)], top[(i + 1, j + 1)], top[(i, j + 1)]]
            F.append(q)
            UV.append([uvv(v, "top") for v in q])
            PART.append(1)
            q = [bot[(i, j)], bot[(i, j + 1)], bot[(i + 1, j + 1)], bot[(i + 1, j)]]
            F.append(q)
            UV.append([uvv(v, "below") for v in q])
            PART.append(1)
        for j in (0, cols):
            q = [top[(i, j)], bot[(i, j)], bot[(i + 1, j)], top[(i + 1, j)]]
            if j == cols:
                q = q[::-1]
            F.append(q)
            UV.append([uvv(v, "top") for v in q])
            PART.append(1)
    for j in range(cols):
        q = [top[(rows, j)], top[(rows, j + 1)], bot[(rows, j + 1)], bot[(rows, j)]]
        F.append(q)
        UV.append([uvv(q[0], "top"), uvv(q[1], "top"), uvv(q[2], "top"), uvv(q[3], "top")])
        PART.append(1)


# ------------------------------------------------------------------------------------------------ wings
SEMI = 0.488                 # root (x = X0W) to tip: rest span 2 * (X0W + SEMI) = 1.036 m (glide ~1.00 m)
X0W = 0.030
ROOTW = Vector((X0W, -0.048, 0.022))
SW = 0.45 * SEMI             # wrist: the hand is 55 % of the semi-span
SF = 0.014                   # fairing strip: rib 0 on the body, rib 1 at s = SF
C_ROOT, C_WRIST = 0.170, 0.140
LE_WRIST = -0.018
TIP = np.array([SEMI, 0.098])


def le_point(u):
    """leading edge (s, c), u in [0,1] from shoulder to tip; c > 0 is backward (+Y)"""
    uw = SW / SEMI
    if u <= uw:
        f = u / uw
        return np.array([SW * f, LE_WRIST * f ** 0.7])
    f = (u - uw) / (1 - uw)
    W = np.array([SW, LE_WRIST])
    H = np.array([0.70 * SEMI, -0.013])
    return (1 - f) ** 2 * W + 2 * f * (1 - f) * H + f * f * TIP


def te_arm(s):
    return C_ROOT + (LE_WRIST + C_WRIST - C_ROOT) * (s / SW)


def te_hand(p):
    E0 = np.array([SW, LE_WRIST + C_WRIST])
    C = np.array([0.64 * SEMI, 0.134])
    return (1 - p) ** 2 * E0 + 2 * p * (1 - p) * C + p * p * TIP


def wing_planform(n_sec, n_pri):
    ribs = [(le_point(0.0), np.array([0.0, C_ROOT]), "fair")]
    for k in range(n_sec + 1):
        s = SF + (SW - SF) * k / n_sec
        ribs.append((le_point(s / SEMI), np.array([s, te_arm(s)]), "sec"))
    uw, uh = SW / SEMI, 0.66
    for j in range(1, n_pri + 1):
        f = j / n_pri
        root = le_point(uw + (uh - uw) * f)
        tip = te_hand(f ** 0.8)
        if j == n_pri:
            root, tip = le_point(uh), TIP.copy()
        ribs.append((root, tip, "pri"))
    return ribs


# capture templates (world x, y of the capture): dorsal flight feathers along the folded primaries (the bird's
# left wing, lying on the right of the top capture) and the folded secondaries; coverts from the mantle and
# scapulars; underwing flight feathers from the barred flanks, underwing coverts from the spotted breast
TPL = {"pri": ((0.050, -0.022), (0.016, 0.168), 0.0055),
       "pri2": ((0.042, -0.030), (0.022, 0.150), 0.0050),
       "sec": ((0.048, -0.010), (0.030, 0.110), 0.0060)}
COV_TOP = (-0.050, 0.035, -0.036, 0.052)     # x0, x1, y0, y1
UND_FL = (-0.044, -0.010, -0.022, 0.066)
UND_COV = (0.002, 0.046, -0.038, 0.058)
COV_T = 0.42


def build_wing(variant, side, V, F, UV, PART, ATTR):
    if variant == "real":
        n_sec, n_pri, rows, serrate = 11, 10, [0.0, 0.06, 0.2, 0.42, 0.70, 0.86], True
    else:
        n_sec, n_pri, rows, serrate = 4, 5, [0.0, 0.12, 0.42], False
    ribs = wing_planform(n_sec, n_pri)
    nr = len(ribs)
    rng = np.random.default_rng(11 if side > 0 else 23)
    offs = rng.uniform(-0.6, 0.6, nr)
    cov_o = np.stack([rng.uniform(COV_TOP[0], COV_TOP[1] - 0.03, nr), rng.uniform(COV_TOP[2], COV_TOP[2] + 0.012, nr)], 1)
    und_x = rng.uniform(UND_FL[0] + 0.006, UND_FL[1] - 0.006, (nr, 2))
    ucov_o = np.stack([rng.uniform(UND_COV[0], UND_COV[1] - 0.03, nr), rng.uniform(UND_COV[2], UND_COV[2] + 0.02, nr)], 1)
    pri_tpl = ["pri" if rng.random() < 0.6 else "pri2" for _ in range(nr)]

    def th(s):
        return 0.0012 + 0.0150 * max(0.0, 1 - s / SEMI) ** 1.6

    def cam(s):
        return 0.0015 + 0.0060 * max(0.0, 1 - s / SEMI)

    def naca(t):
        return 5 * (0.2969 * math.sqrt(t) - 0.1260 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4)

    def z_top(s, t):
        return cam(s) * 4 * t * (1 - t) + th(s) * naca(t) * 1.2

    def z_bot(s, t):
        return cam(s) * 4 * t * (1 - t) - th(s) * naca(t) * 0.8

    def place(s, c, z):
        return (side * (ROOTW.x + s), ROOTW.y + c, ROOTW.z + z)
    top, bot, notch, tips = {}, {}, {}, {}
    for i, (r0, r1, kind) in enumerate(ribs):
        L = np.linalg.norm(r1 - r0)
        for ri, t in enumerate(rows):
            p = r0 + (r1 - r0) * t
            if t == 0.0:
                V.append(place(p[0], p[1], 0.0))
                top[(i, ri)] = bot[(i, ri)] = len(V) - 1
                ATTR.append((p[0], t))
            else:
                V.append(place(p[0], p[1], z_top(p[0], t)))
                top[(i, ri)] = len(V) - 1
                ATTR.append((p[0], t))
                V.append(place(p[0], p[1], z_bot(p[0], t)))
                bot[(i, ri)] = len(V) - 1
                ATTR.append((p[0], t))
        ins = (0.0010 if kind == "sec" else 0.0030) if serrate and 1 < i < nr - 1 else 0.0
        pn = r1 - (r1 - r0) / L * ins
        V.append(place(pn[0], pn[1], 0.0))
        notch[i] = len(V) - 1
        ATTR.append((pn[0], 1.0))
    for i in range(1, nr - 1):
        if serrate:
            r0a, r1a, _ = ribs[i]
            r0b, r1b, _ = ribs[i + 1]
            da = (r1a - r0a) / np.linalg.norm(r1a - r0a)
            db = (r1b - r0b) / np.linalg.norm(r1b - r0b)
            dm = (da + db) / np.linalg.norm(da + db)
            ft = (r1a + r1b) / 2 + dm * (0.0008 if i - 1 < n_sec else 0.0025)
            V.append(place(ft[0], ft[1], 0.0))
            tips[i] = len(V) - 1
            ATTR.append((ft[0], 1.0))

    def suv(i, t, which, zone, ventral, seg=None):
        r0a, r1a, _ = ribs[i]
        r0b, r1b, _ = ribs[i + 1]
        La, Lb = np.linalg.norm(r1a - r0a), np.linalg.norm(r1b - r0b)
        p = (r0a + (r1a - r0a) * t) if which == "a" else (r0b + (r1b - r0b) * t) if which == "b" else \
            ((r0a + r0b) / 2 + ((r1a + r1b) / 2 - (r0a + r0b) / 2) * t)
        if zone == "cov":
            d = p - r0a                      # native scale: span -> capture x, chord (backward) -> capture +y
            if not ventral:
                o = cov_o[i]
                return reg_uv("top", o[0] + d[0], o[1] + d[1])
            o = ucov_o[i]
            return reg_uv("below", o[0] + d[0], o[1] + d[1])
        across = {"a": -1.0, "b": 1.0, "tip": 0.0}[which]
        if not ventral:
            kind = "sec" if i - 1 < n_sec else pri_tpl[i]
            (sx, sy), (ex, ey), hw = TPL[kind]
            ax = np.array([ex - sx, ey - sy])
            Lt = np.linalg.norm(ax)
            ax /= Lt
            nrm = np.array([ax[1], -ax[0]])
            Lf = min((1 - COV_T) * (La + Lb) / 2, Lt)
            f = (t - COV_T) / (1 - COV_T)
            along = Lt - Lf * (1 - f)
            q = np.array([sx, sy]) + ax * along + nrm * hw * (across + offs[i])
            return reg_uv("top", q[0], q[1])
        # underwing flight feathers: the barred flanks, bars across the feather; two repeats along a long feather
        segs = [(COV_T, 1.0)] if seg is None else [seg]
        a0, a1 = segs[0]
        f = (t - a0) / (a1 - a0)
        Lseg = (a1 - a0) * (La + Lb) / 2
        Lt = UND_FL[3] - UND_FL[2]
        along = f * min(Lseg, Lt)
        xc = und_x[i, 0 if a0 < 0.6 else 1]
        return reg_uv("below", xc + 0.005 * across, UND_FL[2] + along)

    if BODY is not None:
        r0ids = set([top[(0, ri)] for ri in range(len(rows))] + [bot[(0, ri)] for ri in range(len(rows))] + [notch[0]])
        for vi in r0ids:
            o = Vector(V[vi])
            d = Vector((side, 0.0, 0.25 * (1 if o.z >= ROOTW.z else -1))).normalized()
            hit = BODY.bvh.ray_cast(o - d * 0.03, d, 0.08)
            if hit[0] is not None:
                V[vi] = tuple(hit[0] - d * 0.0005)
    li = len(rows) - 1
    wing_part = 2 if side > 0 else 3
    for i in range(nr - 1):
        if i == 0 and BODY is not None:
            for surf in (top, bot):
                for ri in range(li):
                    q = [surf[(0, ri)], surf[(1, ri)], surf[(1, ri + 1)], surf[(0, ri + 1)]]
                    F.append(q)
                    UV.append([BODY.uv(V[v]) for v in q])
                    PART.append(wing_part)
                q = [surf[(0, li)], surf[(1, li)], notch[1], notch[0]]
                F.append(q)
                UV.append([BODY.uv(V[v]) for v in q])
                PART.append(wing_part)
            continue
        for surf, ventral in ((top, False), (bot, True)):
            for ri in range(li):
                zone = "cov" if rows[ri + 1] <= COV_T + 1e-6 else "fl"
                seg = None
                if zone == "fl" and ventral and variant == "real":
                    seg = (COV_T, 0.70) if rows[ri + 1] <= 0.70 + 1e-6 else (0.70, 1.0)
                q = [surf[(i, ri)], surf[(i + 1, ri)], surf[(i + 1, ri + 1)], surf[(i, ri + 1)]]
                uvq = [suv(i, rows[ri], "a", zone, ventral, seg), suv(i, rows[ri], "b", zone, ventral, seg),
                       suv(i, rows[ri + 1], "b", zone, ventral, seg), suv(i, rows[ri + 1], "a", zone, ventral, seg)]
                F.append(q)
                UV.append(uvq)
                PART.append(wing_part)
            a, b = surf[(i, li)], surf[(i + 1, li)]
            tl = rows[li]
            seg = (0.70, 1.0) if (ventral and variant == "real") else None
            if serrate:
                poly = [a, b, notch[i + 1], tips[i], notch[i]]
                uvp = [suv(i, tl, "a", "fl", ventral, seg), suv(i, tl, "b", "fl", ventral, seg),
                       suv(i, 1.0, "b", "fl", ventral, seg), suv(i, 1.0, "tip", "fl", ventral, seg),
                       suv(i, 1.0, "a", "fl", ventral, seg)]
            else:
                poly = [a, b, notch[i + 1], notch[i]]
                uvp = [suv(i, tl, "a", "fl", ventral, seg), suv(i, tl, "b", "fl", ventral, seg),
                       suv(i, 1.0, "b", "fl", ventral, seg), suv(i, 1.0, "a", "fl", ventral, seg)]
            F.append(poly)
            UV.append(uvp)
            PART.append(wing_part)
    return ribs


class BodyLookup:
    """nearest-point UV / normal on the low-poly body (for the wing-root fairing)"""
    def __init__(self, ob):
        me = ob.data
        me.update()
        self.V = [v.co.copy() for v in me.vertices]
        self.N = [v.normal.copy() for v in me.vertices]
        uvl = me.uv_layers[0].data
        parts = np.empty(len(me.polygons), np.int32)
        me.attributes["part"].data.foreach_get("value", parts)
        self.tris, self.tuv = [], []
        for p in me.polygons:
            if parts[p.index] != 0:
                continue
            L = list(p.loop_indices)
            for k in range(1, len(L) - 1):
                ls = (L[0], L[k], L[k + 1])
                self.tris.append([me.loops[l].vertex_index for l in ls])
                self.tuv.append([uvl[l].uv.copy() for l in ls])
        self.bvh = BVHTree.FromPolygons(self.V, self.tris)

    def _near(self, co):
        loc, nrm, k, d = self.bvh.find_nearest(Vector(co))
        a, b, c = (self.V[i] for i in self.tris[k])
        return loc, k, a, b, c

    def uv(self, co):
        from mathutils.geometry import barycentric_transform
        loc, k, a, b, c = self._near(co)
        ua, ub, uc = (u.to_3d() for u in self.tuv[k])
        return tuple(barycentric_transform(loc, a, b, c, ua, ub, uc).to_2d())

    def normal(self, co):
        from mathutils.geometry import barycentric_transform
        loc, k, a, b, c = self._near(co)
        na, nb, nc = (self.N[i] for i in self.tris[k])
        w = barycentric_transform(loc, a, b, c, Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        return (na * w.x + nb * w.y + nc * w.z).normalized()


BODY = None


def make_object(name, V, F, UV, PART, smooth):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in V], [], [tuple(f) for f in F])
    me.update()
    uvl = me.uv_layers.new(name="UVMap")
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


def recalc(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def build_variant(variant):
    if variant == "real":
        stations = [-0.131, -0.126, -0.121, -0.116, -0.110, -0.104, -0.098, -0.091, -0.084, -0.077, -0.069, -0.060,
                    -0.050, -0.040, -0.028, -0.016, -0.004, 0.008, 0.020, 0.032, 0.044, 0.056, 0.068, 0.080, 0.090,
                    0.099, 0.107, 0.114, 0.120, 0.125]
        N, tcols, trows = 24, 6, 5
    else:
        stations = [-0.128, -0.118, -0.104, -0.088, -0.070, -0.050, -0.025, 0.000, 0.030, 0.060, 0.088, 0.110, 0.125]
        N, tcols, trows = 8, 3, 2
    V, F, UV, PART, rings = build_loft(variant + "_bt", stations, N)
    nv_body = len(V)
    TU = [0.0] * nv_body
    build_tail(tcols, trows, V, F, UV, PART, TU)
    bt = make_object(variant + "_bt", V, F, UV, PART, smooth=(variant == "real"))
    recalc(bt)
    tu = bt.data.attributes.new("tail_u", "FLOAT", "POINT")
    tu.data.foreach_set("value", np.array(TU, np.float32))
    global BODY
    BODY = BodyLookup(bt)
    V2, F2, UV2, P2, AT = [], [], [], [], []
    ribs = build_wing(variant, +1, V2, F2, UV2, P2, AT)
    build_wing(variant, -1, V2, F2, UV2, P2, AT)
    wings = make_object(variant + "_wings", V2, F2, UV2, P2, smooth=(variant == "real"))
    recalc(wings)
    me = wings.data
    ws = me.attributes.new("wing_s", "FLOAT", "POINT")
    ws.data.foreach_set("value", np.array([a[0] for a in AT], dtype=np.float32))
    wt = me.attributes.new("wing_t", "FLOAT", "POINT")
    wt.data.foreach_set("value", np.array([a[1] for a in AT], dtype=np.float32))
    tu = me.attributes.new("tail_u", "FLOAT", "POINT")
    tu.data.foreach_set("value", np.zeros(len(me.vertices), np.float32))
    if variant == "real":
        me.update()
        vn = [v.normal.copy() for v in me.vertices]
        ln = []
        for l in me.loops:
            vi = l.vertex_index
            w = min(1.0, max(0.0, AT[vi][0] / 0.022))
            if w < 1.0:
                nb = BODY.normal(me.vertices[vi].co)
                if nb.dot(vn[vi]) < -0.2:
                    nb = vn[vi]
                ln.append(tuple((nb * (1 - w) + vn[vi] * w).normalized()))
            else:
                ln.append(tuple(vn[vi]))
        me.normals_split_custom_set(ln)
    plog("%s: body+tail %d tris, wings %d tris, total %d" % (variant, tri_count(bt), tri_count(wings),
                                                             tri_count(bt) + tri_count(wings)))
    return bt, wings, ribs


real_bt, real_w, ribs_real = build_variant("real")
retro_bt, retro_w, _ = build_variant("retro")
for o in (retro_bt, retro_w):
    for p in o.data.polygons:
        p.use_smooth = False


# planform numbers (glide = flat rest pose; the pose dihedral changes the projected span by < 0.2 %)
def planform_area():
    s = np.linspace(0, SEMI, 400)
    le = np.array([le_point(x / SEMI)[1] for x in s])
    te = np.where(s <= SW, te_arm(s), 0)
    ps = np.linspace(0, 1, 2000)
    th_ = np.array([te_hand(p) for p in ps])
    te_h = np.interp(s, th_[:, 0], th_[:, 1])
    te = np.where(s <= SW, te, te_h)
    chord = np.clip(te - le, 0, None)
    return float((getattr(np, "trapezoid", None) or np.trapz)(chord, s)), chord


wa, chord = planform_area()
span = 2 * (X0W + SEMI)
body_w = 2 * X0W
S_total = 2 * wa + body_w * C_ROOT
plog("planform: span %.3f m, root chord %.3f, wrist chord %.3f, hand %.0f %% of the semi-span, wing area %.4f m^2 "
     "(both wings + body strip %.4f), aspect ratio %.2f" % (span, C_ROOT, C_WRIST, 100 * (1 - SW / SEMI), 2 * wa, S_total,
                                                             span ** 2 / S_total))
# eye (for the malar / hood masks in p4): ray from the side at the eye height seen in the side view
EYE_Y, EYE_Z = -0.113, 0.019
hit = bvh.ray_cast(Vector((0.08, EYE_Y, EYE_Z)), Vector((-1, 0, 0)), 0.2)
EYE_X = float(hit[0].x) if hit[0] is not None else 0.020
meta = {"Y_TIP": Y_TIP, "TAIL_Y0": TAIL_Y0, "TAIL_Y1": TAIL_Y1, "RUMP_Y": RUMP_Y, "Z_TAIL": Z_TAIL,
        "TAIL_W1": TAIL_W1, "SEMI": SEMI, "X0W": X0W, "ROOTW": list(ROOTW), "SW": SW, "SF": SF,
        "C_ROOT": C_ROOT, "C_WRIST": C_WRIST, "span": span, "wingArea": 2 * wa, "areaTotal": S_total,
        "AR": span ** 2 / S_total, "EYE": [EYE_X, EYE_Y, EYE_Z], "lengthBillTail": TAIL_Y1 - Y_TIP,
        "tris": {"real": tri_count(real_bt) + tri_count(real_w), "retro": tri_count(retro_bt) + tri_count(retro_w)}}
plog("eye at %s, bill-to-tail %.3f m" % (np.round(meta["EYE"], 4), meta["lengthBillTail"]))
with open(os.path.join(BLEND, "p3_meta.json"), "w") as f:
    json.dump(meta, f, indent=1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "p3_lowpoly.blend"))

# ---------------------------------------------------------------- diagnostic: silhouettes vs scan
sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "OBJECT"
scan.color = (0.9, 0.5, 0.2, 1)
for o, col in ((real_bt, (0.2, 0.4, 0.9, 1)), (real_w, (0.2, 0.8, 0.4, 1)), (retro_bt, (0.9, 0.2, 0.6, 1)), (retro_w, (0.9, 0.9, 0.2, 1))):
    o.color = col
for setname, objs in (("real", (real_bt, real_w)), ("retro", (retro_bt, retro_w)), ("scan", (scan,)), ("overlay", (scan, real_bt))):
    for o in (scan, real_bt, real_w, retro_bt, retro_w):
        o.hide_render = o not in objs
    for vname, d in (("side", (1, 0, 0)), ("top", (0, 0, 1)), ("front", (0, -1, 0))):
        if setname == "overlay" and vname == "front":
            continue
        tgt = (0, 0.06, 0) if setname in ("scan", "overlay") or vname == "side" else (0, 0.10, 0)
        cam = new_cam("c", Vector(tgt) + Vector(d) * 2.0, tgt, ortho=1.1 if (vname != "side" and setname not in ("scan", "overlay")) else 0.46)
        if vname == "top":
            cam.rotation_euler = (0, 0, 0)
        render_to(sc, cam, os.path.join(PREVIEW, "_p3_%s_%s.png" % (setname, vname)), (900, 900) if vname != "side" else (900, 450))
        bpy.data.objects.remove(cam)
plog("done")
