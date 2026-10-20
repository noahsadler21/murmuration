# -*- coding: utf-8 -*-
"""Stage 5: join body+tail+wings per variant, spread the tail (after the bake, UVs kept), build the flight rig
(body, neck, head, tail; per wing humerus / forearm / hand / primaries), procedural skin weights, materials,
and three poses (upstroke, mid-downstroke, glide) stored as pose-library actions + a flap-cycle function.
Writes models/blend/s5_rigged.blend and GLB exports to models/out/starling/."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
from mathutils import Quaternion, Matrix
import json

meta = json.load(open(os.path.join(BLEND, "s3_meta.json")))
SPAN, WS = meta["SPAN"], meta["WS"]
ROOT = Vector(meta["ROOT"])
TAIL_TIP = meta.get("TAIL_Y1", meta["TAIL_TIP"])   # v3: the tail bone ends at the new tail tip
X0 = ROOT.x
S_ELBOW, S_WRIST, S_HAND = 0.030, WS, 0.110
C_AX = 0.012  # joint line behind the leading edge


def join(variant):
    bt = bpy.data.objects[variant + "_bt"]
    w = bpy.data.objects[variant + "_wings"]
    bt.data.materials.clear()
    w.data.materials.clear()
    bpy.ops.object.select_all(action="DESELECT")
    bt.select_set(True)
    w.select_set(True)
    bpy.context.view_layer.objects.active = bt
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = "starling_" + variant
    ob.data.name = "starling_" + variant
    # v2: the tail is built fanned (s3), no post-bake spread
    me = ob.data
    parts = np.empty(len(me.polygons), np.int32)
    me.attributes["part"].data.foreach_get("value", parts)
    return ob, parts


def build_armature(name):
    ad = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, ad)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = ad.edit_bones

    def bone(n, h, t, parent=None, roll=0.0):
        b = eb.new(n)
        b.head = Vector(h)
        b.tail = Vector(t)
        b.roll = roll
        if parent:
            b.parent = eb[parent]
            b.use_connect = (Vector(h) - eb[parent].tail).length < 1e-6
        return b
    bone("body", (0, 0.035, 0.002), (0, -0.040, 0.004))
    bone("neck", (0, -0.040, 0.004), (0, -0.062, 0.010), "body")
    bone("head", (0, -0.062, 0.010), (0, -0.100, 0.006), "neck")
    bone("tail", (0, 0.040, 0.005), (0, TAIL_TIP, 0.004), "body")
    for side, sx in (("L", 1), ("R", -1)):
        def wp(s):
            # joint positions on the planform's quarter-chord line
            return (sx * (X0 + s), ROOT.y + C_AX + (0.004 if s > S_WRIST else 0.0) * (s - S_WRIST) / 0.05, ROOT.z)
        bone("humerus." + side, wp(0.0), wp(S_ELBOW), "body")
        bone("forearm." + side, wp(S_ELBOW), wp(S_WRIST), "humerus." + side)
        bone("hand." + side, wp(S_WRIST), wp(S_HAND), "forearm." + side)
        bone("primaries." + side, wp(S_HAND), (sx * (X0 + SPAN), ROOT.y + 0.045, ROOT.z), "hand." + side)
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def ramp(x, a, b):
    return np.clip((x - a) / (b - a), 0, 1)


def skin(ob, arm, parts):
    me = ob.data
    V = verts_np(me)
    nv = len(V)
    vpart = np.zeros(nv, np.int32)
    for p in me.polygons:
        for vi in p.vertices:
            vpart[vi] = parts[p.index]
    W = {}
    y = V[:, 1]
    # body chain by y
    head = ramp(-y, 0.060, 0.070)
    neck = ramp(-y, 0.036, 0.048) * (1 - head)
    tailw = np.where(vpart == 1, ramp(y, 0.036, 0.050), 0.0)
    body = 1 - head - neck - tailw
    for side, part_id, sx in (("L", 2, 1), ("R", 3, -1)):
        m = vpart == part_id
        s = np.zeros(nv)
        me.attributes["wing_s"].data.foreach_get("value", s) if "wing_s" in me.attributes else None
        if "wing_s" not in me.attributes:
            s = np.abs(V[:, 0]) - X0
        hum = 1 - ramp(s, S_ELBOW - 0.006, S_ELBOW + 0.006)
        fore = ramp(s, S_ELBOW - 0.006, S_ELBOW + 0.006) * (1 - ramp(s, S_WRIST - 0.007, S_WRIST + 0.005))
        hand = ramp(s, S_WRIST - 0.007, S_WRIST + 0.005) * (1 - ramp(s, S_HAND - 0.010, S_HAND + 0.010))
        prim = ramp(s, S_HAND - 0.010, S_HAND + 0.010)
        # v2 fairing: rib 0 (s = 0, on the body surface) is pure body, rib 1 (s = 10 mm) pure humerus;
        # the fairing strip between them stretches like skin
        rootb = 1 - ramp(s, 0.0005, 0.0100)
        for n, w in (("humerus", hum), ("forearm", fore), ("hand", hand), ("primaries", prim)):
            W.setdefault(n + "." + side, np.zeros(nv))[m] = (w * (1 - rootb))[m]
        body = np.where(m, rootb, body)
        head = np.where(m, 0, head)
        neck = np.where(m, 0, neck)
        tailw = np.where(m, 0, tailw)
    W["body"], W["neck"], W["head"], W["tail"] = body, neck, head, tailw
    tot = sum(W.values())
    for n in W:
        vg = ob.vertex_groups.new(name=n)
        w = W[n] / np.maximum(tot, 1e-6)
        for i in np.nonzero(w > 1e-4)[0]:
            vg.add([int(i)], float(w[i]), "REPLACE")
    mod = ob.modifiers.new("rig", "ARMATURE")
    mod.object = arm
    ob.parent = arm


# ------------------------------------------------------------------ poses (angles in degrees, LEFT wing,
# axes in the rest frame: flap = raise about the body's long axis, sweep = tip back about Z, pitch = LE down about X)
POSES = {
    # v2, from reference (see LOOKTEST.md v2): cruising starling ~13 Hz, tip amplitude ~28 cm peak-to-peak on a
    # ~19 cm semispan (about +48 / -42 deg at the shoulder), downstroke ~57 % of the cycle, extended and slightly
    # swept forward on the downstroke, strongly flexed "feathered" upstroke (wrist bent, hand swept back close to
    # the body, primaries rotated / supinated), flap-gliding on nearly flat wings, bounds on partly folded wings.
    #                 humerus (flap, sweep, pitch)  forearm          hand             primaries         tail pitch
    "top":        {"humerus": (48, -4, 4),  "forearm": (0, 4, 0),   "hand": (4, 6, 4),    "primaries": (6, 4, 0),    "tail": 2.0},
    "downstroke": {"humerus": (2, -10, 10), "forearm": (0, 0, 2),   "hand": (2, -5, 8),   "primaries": (7, -1, 4),   "tail": 0.0},
    "bottom":     {"humerus": (-40, -2, 6), "forearm": (0, 0, 0),   "hand": (-4, 8, 4),   "primaries": (6, 6, 0),    "tail": -3.0},
    "upstroke":   {"humerus": (-26, 14, -6), "forearm": (4, -40, 0), "hand": (8, 62, -16), "primaries": (10, 16, -18), "tail": 0.0},
    "midup":      {"humerus": (8, 24, -10), "forearm": (6, -60, 0), "hand": (12, 100, -22), "primaries": (10, 22, -28), "tail": 3.0},
    "lateup":     {"humerus": (34, 10, -4), "forearm": (2, -30, 0), "hand": (8, 45, -8),  "primaries": (8, 10, -10), "tail": 3.0},
    "glide":      {"humerus": (5, 3, 2),    "forearm": (0, 0, 0),   "hand": (-6, 10, 2),  "primaries": (-2, 4, 0),   "tail": 0.0},
    "bound":      {"humerus": (-4, 45, -2), "forearm": (0, -85, 0), "hand": (0, 100, 0),  "primaries": (0, 25, 0),   "tail": 0.0},
}
# cycle keys and their phase (0 = top of stroke); downstroke 0 -> 0.57
CYCLE = [("top", 0.00), ("downstroke", 0.28), ("bottom", 0.57), ("upstroke", 0.68), ("midup", 0.80), ("lateup", 0.91)]
DOWNSTROKE = 0.57
WINGBEAT_HZ = 13.3


def apply_pose(arm, pose):
    pb = arm.pose.bones
    for b in pb:
        b.rotation_mode = "QUATERNION"
        b.rotation_quaternion = (1, 0, 0, 0)
    for side, sx in (("L", 1), ("R", -1)):
        for n in ("humerus", "forearm", "hand", "primaries"):
            flap, sweep, pitch = pose[n]
            b = pb[n + "." + side]
            Mi = b.bone.matrix_local.to_3x3().inverted()
            # left wing: raise = about -Y, sweep back = about +Z, LE down = about +X ; mirrored (pseudo-vector)
            q = Quaternion(Mi @ Vector((0, -1 * sx, 0)), math.radians(flap))
            q = Quaternion(Mi @ Vector((0, 0, 1 * sx)), math.radians(sweep)) @ q
            q = Quaternion(Mi @ Vector((1, 0, 0)), math.radians(pitch)) @ q
            b.rotation_quaternion = q
    tb = pb["tail"]
    Mi = tb.bone.matrix_local.to_3x3().inverted()
    tb.rotation_quaternion = Quaternion(Mi @ Vector((1, 0, 0)), math.radians(pose["tail"]))
    hb = pb["head"]
    bpy.context.view_layer.update()


def _flat(p):
    v = []
    for n in ("humerus", "forearm", "hand", "primaries"):
        v += list(p[n])
    return np.array(v + [p["tail"]], float)


def _unflat(v):
    out = {}
    for k, n in enumerate(("humerus", "forearm", "hand", "primaries")):
        out[n] = tuple(float(x) for x in v[3 * k:3 * k + 3])
    out["tail"] = float(v[12])
    return out


def cycle_pose(phase):
    """smooth periodic cubic (Catmull-Rom, non-uniform knots) through the CYCLE keys; no stops at keys"""
    ts = [t for _, t in CYCLE]
    ps = [_flat(POSES[n]) for n, _ in CYCLE]
    n = len(ts)
    et = [ts[-1] - 1.0] + ts + [ts[0] + 1.0, ts[1] + 1.0]
    ep = [ps[-1]] + ps + [ps[0], ps[1]]
    x = phase % 1.0
    i = max(k for k in range(1, n + 1) if et[k] <= x)
    t0, t1 = et[i], et[i + 1]
    m0 = (ep[i + 1] - ep[i - 1]) / (et[i + 1] - et[i - 1])
    m1 = (ep[i + 2] - ep[i]) / (et[i + 2] - et[i])
    h = t1 - t0
    u = (x - t0) / h
    h00, h10, h01, h11 = 2 * u ** 3 - 3 * u * u + 1, u ** 3 - 2 * u * u + u, -2 * u ** 3 + 3 * u * u, u ** 3 - u * u
    return _unflat(h00 * ep[i] + h10 * h * m0 + h01 * ep[i + 1] + h11 * h * m1)


def lerp_pose(a, b, t):
    return _unflat(_flat(a) + (_flat(b) - _flat(a)) * t)


def bake_pose_mesh(ob, name):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    me.name = name
    return me


def material(variant, nmode):
    """nmode: flat (albedo only) | baked | detail ; retro always flat-shaded albedo"""
    pre = os.path.join(OUT, "starling_%s_" % variant)
    m = bpy.data.materials.new("starling_%s_%s" % (variant, nmode))
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bs.outputs[0], out.inputs[0])

    def tex(name, noncolor):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(pre + name + ".png", check_existing=True)
        if noncolor:
            t.image.colorspace_settings.name = "Non-Color"
        t.interpolation = "Linear"
        return t
    ta = tex("albedo", False)
    tm = tex("mask", True)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tm.outputs["Color"], sep.inputs[0])
    # AO: multiply 60 %
    ao = nt.nodes.new("ShaderNodeMix")
    ao.data_type = "RGBA"
    ao.blend_type = "MULTIPLY"
    ao.inputs["Factor"].default_value = 0.6
    nt.links.new(ta.outputs["Color"], ao.inputs["A"])
    comb = nt.nodes.new("ShaderNodeCombineColor")
    for i in range(3):
        nt.links.new(sep.outputs[0], comb.inputs[i])
    nt.links.new(comb.outputs[0], ao.inputs["B"])
    nt.links.new(ao.outputs["Result"], bs.inputs["Base Color"])
    # roughness: matt feather, glossier on the dark iridescent body feathers
    r = nt.nodes.new("ShaderNodeMath")
    r.operation = "MULTIPLY_ADD"
    r.inputs[1].default_value = -0.22
    r.inputs[2].default_value = 0.62
    nt.links.new(sep.outputs[2], r.inputs[0])
    nt.links.new(r.outputs[0], bs.inputs["Roughness"])
    if "Thin Film Thickness" in bs.inputs:
        th = nt.nodes.new("ShaderNodeMath")
        th.operation = "MULTIPLY"
        th.inputs[1].default_value = 480.0
        nt.links.new(sep.outputs[2], th.inputs[0])
        nt.links.new(th.outputs[0], bs.inputs["Thin Film Thickness"])
        bs.inputs["Thin Film IOR"].default_value = 1.55
    if "Sheen Weight" in bs.inputs:
        bs.inputs["Sheen Weight"].default_value = 0.25
        bs.inputs["Sheen Roughness"].default_value = 0.5
    if variant == "real" and nmode != "flat":
        tn = tex({"baked": "normal_baked", "detail": "normal_detail", "texonly": "normal_texonly"}[nmode], True)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.uv_map = "UVMap"
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bs.inputs["Normal"])
    return m


# ------------------------------------------------------------------ v3: far LODs (SPEC 6.2)
# LOD2 'sil' (40-64 tris) and LOD3 'micro' (<= 12 tris), built from the retro bird's own surface and planform,
# parented to the retro armature (one rig for retro / sil / micro; the real rig has identical bones). Weights come
# from the same procedural rule as the retro bird (skin(): part + wing_s attributes), which is what a data transfer
# of the retro weights would reproduce on this geometry; UVs are the nearest point on the retro surface, so the
# far LODs can sample the retro atlas if the shader wants to (they normally use meta.albedoLinear).
CH_ROOT, CH_WRIST = 0.062, 0.064


def le_point(u):
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


def _surface_lookup(ob):
    from mathutils.bvhtree import BVHTree
    from mathutils.geometry import barycentric_transform
    me = ob.data
    me.calc_loop_triangles()
    V = [v.co.copy() for v in me.vertices]
    uvl = me.uv_layers[0].data
    parts = np.empty(len(me.polygons), np.int32)
    me.attributes["part"].data.foreach_get("value", parts)
    tris = [tuple(t.vertices) for t in me.loop_triangles]
    tuv = [[uvl[l].uv.copy() for l in t.loops] for t in me.loop_triangles]
    tpart = [int(parts[t.polygon_index]) for t in me.loop_triangles]
    bvh_all = BVHTree.FromPolygons(V, tris)
    body_idx = [k for k, p in enumerate(tpart) if p == 0]
    bvh_body = BVHTree.FromPolygons(V, [tris[k] for k in body_idx])

    def uv(co):
        loc, nrm, k, d = bvh_all.find_nearest(Vector(co))
        a, b, c = (V[i] for i in tris[k])
        ua, ub, uc = (u.to_3d() for u in tuv[k])
        return tuple(barycentric_transform(loc, a, b, c, ua, ub, uc).to_2d())

    def ray(o, d):
        hit = bvh_body.ray_cast(Vector(o), Vector(d), 0.2)
        return hit[0]
    return uv, ray, np.array([tuple(v) for v in V])


def build_far_lod(kind, retro, arm, Y_TIP, TT):
    uv, ray, RV = _surface_lookup(retro)
    V, F, PART, WSV = [], [], [], []

    def add(p, s=0.0):
        V.append(tuple(float(x) for x in p))
        WSV.append(float(s))
        return len(V) - 1

    def body_section(y):
        # centre height from the retro body (part 0) slice, radii by rays from the centre (top, left, bottom, right)
        sl = RV[np.abs(RV[:, 1] - y) < 0.006]
        zc = float((sl[:, 2].min() + sl[:, 2].max()) / 2) if len(sl) else 0.0
        out = []
        for d in ((0, 0, 1), (1, 0, 0), (0, 0, -1), (-1, 0, 0)):
            o = Vector((0, y, zc)) + Vector(d) * 0.06
            h = ray(o, -Vector(d))
            r = (h - Vector((0, y, zc))).length if h is not None else 0.004
            out.append(r)
        return zc, out
    tail_root, tail_tip = 0.040, TT
    zt = None
    if kind == "sil":
        stations = [-0.086, -0.064, -0.032, 0.004, 0.040]
        rings = []
        for y in stations:
            zc, rr = body_section(y)
            ids = [add((0, y, zc + rr[0])), add((rr[1], y, zc)), add((0, y, zc - rr[2])), add((-rr[3], y, zc))]
            rings.append(ids)
        zt = body_section(0.040)[0]
        for a, b in zip(rings[:-1], rings[1:]):
            for k in range(4):
                F.append((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
                PART.append(0)
        tip = add((0, Y_TIP, body_section(-0.086)[0] - 0.002))
        for k in range(4):
            F.append((rings[0][(k + 1) % 4], rings[0][k], tip))
            PART.append(0)
        rear = add((0, 0.050, zt))
        for k in range(4):
            F.append((rings[-1][k], rings[-1][(k + 1) % 4], rear))
            PART.append(0)
        # wings: 4 quads per wing (root-elbow, elbow-wrist, wrist-hand, hand-tip), single sheet (DoubleSide)
        ribs = [(le_point(0.0), np.array([0.0, CH_ROOT])),
                (le_point(0.030 / SPAN), np.array([0.030, CH_ROOT + (CH_WRIST - CH_ROOT) * 0.030 / WS])),
                (le_point(WS / SPAN), np.array([WS, CH_WRIST])),
                (le_point(0.60), te_hand(0.45)),
                (np.array([SPAN, 0.045]), te_hand(0.86))]
    else:
        zc, rr = body_section(-0.020)
        zf, rf = body_section(-0.080)
        B = add((0, Y_TIP, zf - 0.002))
        Rr = add((0, 0.046, body_section(0.036)[0]))
        T = add((0, -0.022, zc + rr[0] * 0.95))
        D = add((0, -0.022, zc - rr[2] * 0.95))
        L = add((rr[1] * 0.95, -0.022, zc))
        Rt = add((-rr[3] * 0.95, -0.022, zc))
        zt = body_section(0.040)[0]
        for f in ((B, T, Rr), (B, Rr, D), (B, L, Rr), (B, Rr, Rt)):   # crossed vertical + horizontal diamonds
            F.append(f)
            PART.append(0)
        ribs = None
    # tail: one quad (2 tris), fanned 1.7 -> 3.8 cm, square end
    t0, t1 = add((0.0085, tail_root, zt + 0.001)), add((-0.0085, tail_root, zt + 0.001))
    t2, t3 = add((-0.019, tail_tip, zt - 0.0015)), add((0.019, tail_tip, zt - 0.0015))
    F.append((t0, t1, t2, t3))
    PART.append(1)
    for side, pid in ((1, 2), (-1, 3)):
        def place(sc_):
            return (ROOT.x + side * sc_[0], ROOT.y + sc_[1], ROOT.z)
        if kind == "sil":
            ids = [(add(place(le), le[0]), add(place(te), te[0])) for le, te in ribs]
            for (a, b), (c, d) in zip(ids[:-1], ids[1:]):
                F.append((a, b, d, c) if side > 0 else (a, c, d, b))
                PART.append(pid)
        else:
            # pentagon fan from the wrist LE: arm triangle + 2 hand triangles
            rle, rte = np.array([0.0, -0.002]), np.array([0.0, CH_ROOT])
            wle, hte, tipp = le_point(WS / SPAN), te_hand(0.40), np.array([SPAN, 0.045])
            a, b, w, h, t = (add(place(p), p[0]) for p in (rle, rte, wle, hte, tipp))
            for tri in ((w, a, b), (w, b, h), (w, h, t)):
                F.append(tri if side > 0 else tri[::-1])
                PART.append(pid)
    me = bpy.data.meshes.new("starling_" + kind)
    me.from_pydata(V, [], F)
    me.update()
    uvl = me.uv_layers.new(name="UVMap")
    for p in me.polygons:
        for l in p.loop_indices:
            uvl.data[l].uv = uv(me.vertices[me.loops[l].vertex_index].co)
    pa = me.attributes.new("part", "INT", "FACE")
    pa.data.foreach_set("value", np.array(PART, np.int32))
    wa = me.attributes.new("wing_s", "FLOAT", "POINT")
    wa.data.foreach_set("value", np.array(WSV, np.float32))
    ob = bpy.data.objects.new("starling_" + kind, me)
    bpy.context.scene.collection.objects.link(ob)
    # consistent outward winding for the closed body; wings are single sheets (DoubleSide in three.js)
    for p in me.polygons:
        p.use_smooth = False
    skin(ob, arm, np.array(PART, np.int32))
    if retro.data.materials:
        ob.data.materials.append(retro.data.materials[0])
    log("%s: %d tris, %d verts" % (kind, tri_count(ob), len(me.vertices)))
    return ob


if __name__ == "__main__":
    bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s3_lowpoly.blend"))
    for o in list(bpy.context.scene.objects):
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o)
    rigs = {}
    for variant in ("real", "retro"):
        ob, parts = join(variant)
        arm = build_armature("rig_" + variant)
        skin(ob, arm, parts)
        ob.data.materials.append(material(variant, "detail" if variant == "real" else "flat"))
        rigs[variant] = (ob, arm)
        # sanity: weights sum, tri count
        log("%s: %d tris, %d verts, %d bones" % (variant, tri_count(ob), len(ob.data.vertices), len(arm.data.bones)))
        # export a GLB in rest pose (+Z up in Blender -> +Y up glTF)
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        arm.select_set(True)
        try:
            bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "starling_%s.glb" % variant), use_selection=True,
                                      export_format="GLB", export_animations=False, export_skins=True,
                                      export_image_format="AUTO")
            log("exported starling_%s.glb" % variant)
        except Exception as e:
            log("glb export failed: %s" % e)
    # far LODs on the retro rig (tail tip from the rebuilt tail: rear-most vertex of the retro tail part)
    ob_r, arm_r = rigs["retro"]
    Vr = verts_np(ob_r.data)
    pr = np.empty(len(ob_r.data.polygons), np.int32)
    ob_r.data.attributes["part"].data.foreach_get("value", pr)
    tail_v = sorted({vi for p in ob_r.data.polygons if pr[p.index] == 1 for vi in p.vertices})
    TT = float(Vr[tail_v, 1].max())
    for kind in ("sil", "micro"):
        build_far_lod(kind, ob_r, arm_r, meta["Y_TIP"], TT)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "s5_rigged.blend"))
    log("done")
