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
TAIL_TIP = meta["TAIL_TIP"]
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
    # tail spread (rest pose of the flying bird): fan the closed scan tail open ~1.45x at the tip
    me = ob.data
    parts = np.empty(len(me.polygons), np.int32)
    me.attributes["part"].data.foreach_get("value", parts)
    tv = set()
    for p in me.polygons:
        if parts[p.index] == 1:
            tv.update(p.vertices)
    for i in tv:
        v = me.vertices[i].co
        f = max(0.0, (v.y - 0.040) / (TAIL_TIP - 0.040))
        v.x *= 1 + 0.45 * f
    me.update()
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
        s = np.abs(V[:, 0]) - X0
        hum = 1 - ramp(s, S_ELBOW - 0.006, S_ELBOW + 0.006)
        fore = ramp(s, S_ELBOW - 0.006, S_ELBOW + 0.006) * (1 - ramp(s, S_WRIST - 0.007, S_WRIST + 0.005))
        hand = ramp(s, S_WRIST - 0.007, S_WRIST + 0.005) * (1 - ramp(s, S_HAND - 0.010, S_HAND + 0.010))
        prim = ramp(s, S_HAND - 0.010, S_HAND + 0.010)
        # wing root inside the body follows the body a little
        rootb = 1 - ramp(s, -0.002, 0.010)
        for n, w in (("humerus", hum), ("forearm", fore), ("hand", hand), ("primaries", prim)):
            W.setdefault(n + "." + side, np.zeros(nv))[m] = (w * (1 - 0.5 * rootb))[m]
        body = np.where(m, 0.5 * rootb, body)
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
    "glide":      {"humerus": (8, 4, 2), "forearm": (0, 0, 0), "hand": (2, 12, 3), "primaries": (2, 6, 0), "tail": 0.0},
    "downstroke": {"humerus": (-12, -6, 6), "forearm": (0, 0, 2), "hand": (6, -4, 8), "primaries": (8, 2, 4), "tail": 0.0},
    "upstroke":   {"humerus": (52, 22, -4), "forearm": (6, -48, 0), "hand": (14, 80, -12), "primaries": (10, 18, -6), "tail": 4.0},
    # extra cycle keys for the flock (not rendered on their own)
    "top":        {"humerus": (62, -4, 4), "forearm": (2, 0, 0), "hand": (8, 6, 4), "primaries": (6, 4, 0), "tail": 2.0},
    "bottom":     {"humerus": (-48, 2, 8), "forearm": (0, -6, 2), "hand": (-4, 10, 10), "primaries": (10, 6, 4), "tail": -2.0},
}
CYCLE = ["top", "downstroke", "bottom", "upstroke"]


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


def lerp_pose(a, b, t):
    out = {}
    for k in a:
        if k == "tail":
            out[k] = a[k] + (b[k] - a[k]) * t
        else:
            out[k] = tuple(a[k][i] + (b[k][i] - a[k][i]) * t for i in range(3))
    return out


def cycle_pose(phase):
    """phase 0..1 through top -> downstroke -> bottom -> upstroke -> top (smoothstep between keys)"""
    n = len(CYCLE)
    x = (phase % 1.0) * n
    i = int(x)
    t = x - i
    t = t * t * (3 - 2 * t)
    return lerp_pose(POSES[CYCLE[i]], POSES[CYCLE[(i + 1) % n]], t)


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
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "s5_rigged.blend"))
    log("done")
