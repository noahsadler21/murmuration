# -*- coding: utf-8 -*-
"""Peregrine p5: join body+tail+wings per variant, build the 14-bone rig 'peregrine_rig' (the starling's 12 bone
names + tailfan.L / tailfan.R), procedural skin weights, materials (the p4 atlas), the four clips and the GLB export.
Clips (actions, exported with export_animation_mode='ACTIONS', no Draco, PNG textures embedded):
  flap  : one stiff, shallow beat over 1.0 s (the runtime sets 4-5 Hz with timeScale): humerus +28 -> -24 deg,
          downstroke 55 %, a small wrist flex on the upstroke (hand swept 18 deg)
  glide : wings flat, +3 deg dihedral, hands swept back 10 deg, tail closed
  stoop : teardrop: wings folded tight along the flanks (feathers edge-down), primaries over the tail, tail closed,
          head forward
  flare : wings ~60 % open and raised +20 deg, high angle of attack, tail fanned to 0.14 m
Pose angles are ABSOLUTE deltas from the rest pose in the body frame (pitch about the span axis first, then sweep
about Z, then flap about the long axis); each bone's local rotation is derived from its parent's (pose_bone_rot).
Writes models/blend/p5_rigged.blend, assets/birds/peregrine_{real,retro}.glb, models/blend/p5_report.json."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pcommon import *
from mathutils import Quaternion, Matrix

meta = json.load(open(os.path.join(BLEND, "p3_meta.json")))
SEMI, X0W, SW, SF = meta["SEMI"], meta["X0W"], meta["SW"], meta["SF"]
ROOTW = Vector(meta["ROOTW"])
S_ELBOW, S_HAND = 0.090, 0.330
TAIL_Y0, TAIL_Y1, Z_TAIL = meta["TAIL_Y0"], meta["TAIL_Y1"], meta["Z_TAIL"]
FPS = 24


def le_c(s):
    """leading-edge chord position (same planform as p3)"""
    uw = SW / SEMI
    u = s / SEMI
    if u <= uw:
        return -0.018 * (u / uw) ** 0.7
    f = (u - uw) / (1 - uw)
    W, H, T = np.array([SW, -0.018]), np.array([0.70 * SEMI, -0.013]), np.array([SEMI, 0.098])
    return float(((1 - f) ** 2 * W + 2 * f * (1 - f) * H + f * f * T)[1])


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
    ob.name = "peregrine_" + variant
    ob.data.name = "peregrine_" + variant
    parts = np.empty(len(ob.data.polygons), np.int32)
    ob.data.attributes["part"].data.foreach_get("value", parts)
    return ob, parts


def build_armature(name):
    ad = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, ad)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = ad.edit_bones

    def bone(n, h, t, parent=None):
        b = eb.new(n)
        b.head, b.tail = Vector(h), Vector(t)
        b.roll = 0.0
        if parent:
            b.parent = eb[parent]
            b.use_connect = (Vector(h) - eb[parent].tail).length < 1e-6
        return b
    bone("body", (0, 0.070, 0.0), (0, -0.050, 0.004))
    bone("neck", (0, -0.050, 0.004), (0, -0.080, 0.012), "body")
    bone("head", (0, -0.080, 0.012), (0, -0.128, 0.012), "neck")
    bone("tail", (0, TAIL_Y0, Z_TAIL), (0, TAIL_Y1, Z_TAIL - 0.004), "body")
    for side, sx in (("L", 1), ("R", -1)):
        bone("tailfan." + side, (sx * 0.006, TAIL_Y0 + 0.004, Z_TAIL), (sx * 0.026, TAIL_Y1, Z_TAIL - 0.004), "tail")

        def wp(s):
            return (sx * (X0W + s), ROOTW.y + le_c(s) + 0.030, ROOTW.z)
        bone("humerus." + side, wp(0.0), wp(S_ELBOW), "body")
        bone("forearm." + side, wp(S_ELBOW), wp(SW), "humerus." + side)
        bone("hand." + side, wp(SW), wp(S_HAND), "forearm." + side)
        bone("primaries." + side, wp(S_HAND), (sx * (X0W + SEMI), ROOTW.y + 0.098, ROOTW.z), "hand." + side)
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
    s = np.zeros(nv, np.float32)
    me.attributes["wing_s"].data.foreach_get("value", s)
    tu = np.zeros(nv, np.float32)
    me.attributes["tail_u"].data.foreach_get("value", tu)
    y = V[:, 1]
    W = {}
    head = ramp(-y, 0.074, 0.088)
    neck = ramp(-y, 0.040, 0.056) * (1 - head)
    tailall = np.where(vpart == 1, ramp(y, TAIL_Y0 + 0.008, TAIL_Y0 + 0.028), 0.0)
    fanL = tailall * np.clip(tu, 0, 1) * ramp(y, TAIL_Y0 + 0.01, TAIL_Y0 + 0.05)
    fanR = tailall * np.clip(-tu, 0, 1) * ramp(y, TAIL_Y0 + 0.01, TAIL_Y0 + 0.05)
    tailw = tailall - fanL - fanR
    body = 1 - head - neck - tailall
    for side, pid in (("L", 2), ("R", 3)):
        m = vpart == pid
        hum = 1 - ramp(s, S_ELBOW - 0.012, S_ELBOW + 0.012)
        fore = ramp(s, S_ELBOW - 0.012, S_ELBOW + 0.012) * (1 - ramp(s, SW - 0.014, SW + 0.010))
        hand = ramp(s, SW - 0.014, SW + 0.010) * (1 - ramp(s, S_HAND - 0.020, S_HAND + 0.020))
        prim = ramp(s, S_HAND - 0.020, S_HAND + 0.020)
        rootb = 1 - ramp(s, 0.0005, SF)
        for n, w in (("humerus", hum), ("forearm", fore), ("hand", hand), ("primaries", prim)):
            W.setdefault(n + "." + side, np.zeros(nv))[m] = (w * (1 - rootb))[m]
        body = np.where(m, rootb, body)
        head = np.where(m, 0, head)
        neck = np.where(m, 0, neck)
        tailw = np.where(m, 0, tailw)
        fanL = np.where(m, 0, fanL)
        fanR = np.where(m, 0, fanR)
    W["body"], W["neck"], W["head"], W["tail"], W["tailfan.L"], W["tailfan.R"] = body, neck, head, tailw, fanL, fanR
    tot = sum(W.values())
    for n in W:
        vg = ob.vertex_groups.new(name=n)
        w = W[n] / np.maximum(tot, 1e-6)
        for i in np.nonzero(w > 1e-4)[0]:
            vg.add([int(i)], float(w[i]), "REPLACE")
    mod = ob.modifiers.new("rig", "ARMATURE")
    mod.object = arm
    ob.parent = arm


# ------------------------------------------------------------------ poses
# per wing bone: (flap, sweep, pitch) in degrees, ABSOLUTE in the body frame for the LEFT wing (mirrored for the
# right); flap = raise the tip, sweep = tip back, pitch = leading edge down. "tail": pitch (deg, + = tip down),
# "fan": each tail-fan bone's outward rotation (deg). "head": pitch (deg, + = bill down).
WING = ("humerus", "forearm", "hand", "primaries")
POSES = {
    # flap cycle keys (stiff, shallow: the arm moves the whole wing, little flexion except a small wrist flex on
    # the upstroke); phase 0 = top, downstroke 0 -> 0.55
    "top":    {"humerus": (28, 0, -2), "forearm": (28, 0, -2), "hand": (32, 4, -2), "primaries": (34, 5, -1), "tail": 0, "fan": 0, "head": 0},
    "middown": {"humerus": (2, -3, 5), "forearm": (2, -3, 6), "hand": (2, -4, 8), "primaries": (6, -3, 8), "tail": 1, "fan": 1, "head": 0},
    "bottom": {"humerus": (-24, -1, 3), "forearm": (-24, -1, 3), "hand": (-27, 2, 2), "primaries": (-24, 3, 0), "tail": -1, "fan": 0, "head": 0},
    "midup":  {"humerus": (2, 6, -4), "forearm": (2, 2, -4), "hand": (8, 18, -8), "primaries": (10, 20, -9), "tail": 0, "fan": 0, "head": 0},
    "glide":  {"humerus": (3, 0, 1), "forearm": (3, 0, 1), "hand": (3, 10, 1), "primaries": (3, 10, 0), "tail": 0, "fan": 0, "head": 0},
    # stoop: the folded wing's feathers overlap and slide under each other, which a rigid shell cannot do; the
    # wing is folded (arm back, forearm forward with the secondaries edge-down on the flank, hand + primaries back
    # over the rump and tail) AND scaled uniformly by "wscale" at the shoulder, standing in for that overlap
    "stoop":  {"humerus": (-6, 76, -60), "forearm": (-6, -80, -88), "hand": (-4, 92, -40), "primaries": (-4, 96, -30), "tail": 0, "fan": -2, "head": -4, "wscale": 0.55},
    "flare":  {"humerus": (20, 30, -22), "forearm": (20, -5, -22), "hand": (22, 58, -18), "primaries": (24, 66, -12), "tail": 12, "fan": 16, "head": 6},
}
CYCLE = [("top", 0.00), ("middown", 0.27), ("bottom", 0.55), ("midup", 0.78)]
DOWNSTROKE = 0.55


def _flat(p):
    v = []
    for n in WING:
        v += list(p[n])
    return np.array(v + [p["tail"], p["fan"], p["head"], p.get("wscale", 1.0)], float)


def _unflat(v):
    out = {n: tuple(float(x) for x in v[3 * k:3 * k + 3]) for k, n in enumerate(WING)}
    out["tail"], out["fan"], out["head"], out["wscale"] = float(v[12]), float(v[13]), float(v[14]), float(v[15])
    return out


def cycle_pose(phase):
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


def _delta(flap, sweep, pitch, sx):
    """absolute rotation (body frame): pitch about the span axis X, then sweep about Z, then flap about the long axis"""
    qp = Quaternion((1, 0, 0), math.radians(pitch))
    qs = Quaternion((0, 0, sx), math.radians(sweep))
    qf = Quaternion((0, -sx, 0), math.radians(flap))
    return qf @ qs @ qp


def apply_pose(arm, pose):
    pb = arm.pose.bones
    D = {}
    for b in pb:
        b.rotation_mode = "QUATERNION"
        b.rotation_quaternion = (1, 0, 0, 0)
        b.scale = (1, 1, 1)

    def set_rel(name, d_abs, parent):
        b = pb[name]
        R = b.bone.matrix_local.to_quaternion()
        dp = D.get(parent, Quaternion())
        rel = dp.inverted() @ d_abs
        b.rotation_quaternion = R.inverted() @ rel @ R
        D[name] = d_abs
    D["body"] = Quaternion()
    for side, sx in (("L", 1), ("R", -1)):
        parent = "body"
        for n in WING:
            f, s, p = pose[n]
            set_rel(n + "." + side, _delta(f, s, p, sx), parent)
            parent = n + "." + side
    ws = pose.get("wscale", 1.0)
    for side in ("L", "R"):
        pb["humerus." + side].scale = (ws, ws, ws)
    tq = Quaternion((1, 0, 0), math.radians(-pose["tail"]))
    set_rel("tail", tq, "body")
    for side, sx in (("L", 1), ("R", -1)):
        set_rel("tailfan." + side, tq @ Quaternion((0, 0, -sx), math.radians(pose["fan"])), "tail")
    set_rel("neck", Quaternion(), "body")
    set_rel("head", Quaternion((1, 0, 0), math.radians(pose["head"])), "neck")
    bpy.context.view_layer.update()


def material(variant):
    pre = os.path.join(OUTP, "peregrine_%s_" % variant)
    m = bpy.data.materials.new("peregrine_%s" % variant)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bs.outputs[0], out.inputs[0])
    ta = nt.nodes.new("ShaderNodeTexImage")
    ta.image = bpy.data.images.load(pre + "albedo.png", check_existing=True)
    nt.links.new(ta.outputs["Color"], bs.inputs["Base Color"])
    bs.inputs["Roughness"].default_value = 0.78
    if "Sheen Weight" in bs.inputs:
        bs.inputs["Sheen Weight"].default_value = 0.2
    if variant == "real" and os.path.exists(pre + "normal.png"):
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = bpy.data.images.load(pre + "normal.png", check_existing=True)
        tn.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.uv_map = "UVMap"
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bs.inputs["Normal"])
    return m


def make_actions(arm):
    arm.animation_data_create()
    acts = {}

    def key_all(fr):
        for b in arm.pose.bones:
            b.keyframe_insert("rotation_quaternion", frame=fr)
            b.keyframe_insert("scale", frame=fr)
    # flap: 25 keys over 1.0 s (frame 0 = frame 24 = top of the stroke)
    for name in ("flap", "glide", "stoop", "flare"):
        act = bpy.data.actions.new(name)
        arm.animation_data.action = act
        if name == "flap":
            for fr in range(FPS + 1):
                apply_pose(arm, cycle_pose(fr / FPS))
                key_all(fr)
        else:
            apply_pose(arm, POSES[name])
            key_all(0)
            key_all(12)
        act.use_fake_user = True
        acts[name] = act
        arm.animation_data.action = None      # no NLA: the glTF exporter (ACTIONS mode) samples each action alone
    return acts


def top_area_width(ob):
    """top-view silhouette area (m^2) and max width (m) of the evaluated mesh, rasterised at 1 mm"""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    em = ev.to_mesh()
    M = ob.matrix_world
    co = np.array([tuple(M @ v.co) for v in em.vertices])
    em.calc_loop_triangles()
    tris = np.array([tuple(t.vertices) for t in em.loop_triangles])
    ev.to_mesh_clear()
    res = 0.001
    lo = co[:, :2].min(0) - 0.002
    hi = co[:, :2].max(0) + 0.002
    W_, H_ = (np.ceil((hi - lo) / res)).astype(int)
    img = np.zeros((H_, W_), bool)
    for t in tris:
        p = (co[t, :2] - lo) / res
        x0, y0 = np.floor(p.min(0)).astype(int)
        x1, y1 = np.ceil(p.max(0)).astype(int)
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        Q = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)
        a, b, c = p
        v0, v1 = b - a, c - a
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        w1 = ((Q[:, 0] - a[0]) * v1[1] - v1[0] * (Q[:, 1] - a[1])) / den
        w2 = (v0[0] * (Q[:, 1] - a[1]) - (Q[:, 0] - a[0]) * v0[1]) / den
        ins = (w1 >= 0) & (w2 >= 0) & (w1 + w2 <= 1)
        img[np.clip(ys.ravel()[ins], 0, H_ - 1), np.clip(xs.ravel()[ins], 0, W_ - 1)] = True
    area = img.sum() * res * res
    cols = np.nonzero(img.any(0))[0]
    width = (cols.max() - cols.min() + 1) * res
    ext = co.max(0) - co.min(0)
    return float(area), float(width), [float(e) for e in ext]


def export(variant, ob, arm):
    ob.name, ob.data.name, arm.name = "peregrine", "peregrine", "peregrine_rig"
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    path = os.path.join(ASSETS, "peregrine_%s.glb" % variant)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format="GLB", export_animations=True,
                              export_animation_mode="ACTIONS", export_skins=True, export_image_format="AUTO",
                              export_def_bones=False, export_force_sampling=True, export_frame_range=False,
                              export_anim_slide_to_zero=True)
    ob.name, ob.data.name, arm.name = "peregrine_" + variant, "peregrine_" + variant, "rig_" + variant
    plog("exported %s (%.0f kB)" % (path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "p3_lowpoly.blend"))
    sc = bpy.context.scene
    sc.render.fps = FPS
    bpy.data.objects["scan"].hide_render = True
    bpy.data.objects["scan"].hide_viewport = True
    report = {}
    for variant in ("real", "retro"):
        ob, parts = join(variant)
        arm = build_armature("rig_" + variant)
        skin(ob, arm, parts)
        ob.data.materials.append(material(variant))
        make_actions(arm)
        r = {"tris": tri_count(ob), "verts": len(ob.data.vertices), "bones": len(arm.data.bones)}
        for pn in ("glide", "stoop", "flare"):
            apply_pose(arm, POSES[pn])
            a, w, ext = top_area_width(ob)
            r[pn] = {"topAreaM2": round(a, 5), "topWidthM": round(w, 4), "extentXYZ": [round(e, 4) for e in ext]}
        r["stoopAreaFracOfGlide"] = round(r["stoop"]["topAreaM2"] / r["glide"]["topAreaM2"], 3)
        r["glideSpanM"] = r["glide"]["extentXYZ"][0]
        r["lengthM"] = r["glide"]["extentXYZ"][1]
        r["flareSpanFracOfGlide"] = round(r["flare"]["extentXYZ"][0] / r["glide"]["extentXYZ"][0], 3)
        apply_pose(arm, POSES["glide"])
        report[variant] = r
        plog("%s: %s" % (variant, r))
        export(variant, ob, arm)
        for act in list(bpy.data.actions):       # the next variant's export must not pick these up (same bone names)
            bpy.data.actions.remove(act)
    json.dump(report, open(os.path.join(BLEND, "p5_report.json"), "w"), indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "p5_rigged.blend"))
    plog("done")
