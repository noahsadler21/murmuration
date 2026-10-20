# -*- coding: utf-8 -*-
"""Peregrine p6: preview render tiles (EEVEE) -> models/preview/_tiles_peregrine/; sheets by p6_compose.py.
  blender -b -P p6_render.py -- poses     flap x4 phases, glide, stoop, flare x top/side/front (real + retro)
  blender -b -P p6_render.py -- compare   cleaned scan vs real vs retro (glide), side/top/below/q34
  blender -b -P p6_render.py -- scale     peregrine vs starling, same orthographic cameras
  blender -b -P p6_render.py -- remap     specimen colours (raw atlas) vs the documented remap, same cameras
  blender -b -P p6_render.py -- tail      starling v2 vs v3 tail (glide), side/top/below, + measurements (B1)
Lighting: a pale overcast dome (the page's signature sky colour) plus a soft sun, AgX."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pcommon import *
import p5_rig as P

WHAT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "poses"
TILES = os.path.join(PREVIEW, "_tiles_peregrine")
os.makedirs(TILES, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "p5_rigged.blend"))
sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE"
try:
    sc.eevee.taa_render_samples = 32
except Exception:
    pass
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "None"
for o in sc.objects:
    if o.type == "ARMATURE" and o.animation_data:
        for t in o.animation_data.nla_tracks:
            t.mute = True
        o.animation_data.action = None
REAL, RETRO = bpy.data.objects["peregrine_real"], bpy.data.objects["peregrine_retro"]
ARM = {"real": bpy.data.objects["rig_real"], "retro": bpy.data.objects["rig_retro"]}
OBJ = {"real": REAL, "retro": RETRO}
SKY = (0.552, 0.556, 0.565)          # linear of sRGB ~(196,197,199): the page's signature sky


def world(strength=1.0, color=SKY):
    w = bpy.data.worlds.new("sky")
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (*color, 1)
    bg.inputs["Strength"].default_value = strength


def lights(sun_e=2.2, sky=0.9):
    for o in list(sc.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o)
    world(sky)
    sun("sun", (-0.45, -0.6, 0.66), sun_e, (1.0, 0.97, 0.92), 8.0)


def show(*objs):
    for o in sc.objects:
        if o.type == "MESH":
            o.hide_render = o not in objs


def cam(loc, target=(0, 0.04, 0), ortho=None, lens=70, rot=None):
    for o in list(sc.objects):
        if o.type == "CAMERA":
            bpy.data.objects.remove(o)
    c = new_cam("cam", loc, target, ortho=ortho, lens=lens)
    c.data.clip_end = 50
    if rot is not None:
        c.rotation_euler = rot
    sc.camera = c
    return c


def tile(name, res=(480, 360)):
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = os.path.join(TILES, name + ".png")
    bpy.ops.render.render(write_still=True)
    plog("tile " + name)


YC = 0.06
VIEWS = {
    "top": dict(loc=(0, YC, 2.0), target=(0, YC, 0), rot=(0, 0, math.pi)),
    "side": dict(loc=(2.0, YC, 0.0), target=(0, YC, 0)),
    "front": dict(loc=(0, -2.0, 0.0), target=(0, 0, 0)),
    "below": dict(loc=(0, YC, -2.0), target=(0, YC, 0), rot=(math.pi, 0, 0)),
}


def view(vn, ortho):
    v = VIEWS[vn]
    return cam(v["loc"], v["target"], ortho=ortho, rot=v.get("rot"))


def pose_name_list():
    out = [("flap%d" % k, P.cycle_pose(ph), "flap phase %.2f" % ph) for k, ph in enumerate((0.0, 0.27, 0.55, 0.78))]
    return out + [(n, P.POSES[n], n) for n in ("glide", "stoop", "flare")]


if WHAT == "poses":
    lights()
    for variant in ("real", "retro"):
        show(OBJ[variant])
        for pn, pose, _ in pose_name_list():
            P.apply_pose(ARM[variant], pose)
            for vn in ("top", "side", "front"):
                view(vn, 1.12 if vn != "side" else 0.62)
                tile("pose_%s_%s_%s" % (variant, pn, vn), (360, 300))

elif WHAT == "compare":
    lights()
    with bpy.data.libraries.load(os.path.join(BLEND, "p1_scan_oriented.blend")) as (src, dst):
        dst.objects = ["scan"]
    scan = dst.objects[0]
    sc.collection.objects.link(scan)
    for v in ("real", "retro"):
        P.apply_pose(ARM[v], P.POSES["glide"])
    sets = (("scan", scan), ("real", REAL), ("retro", RETRO))
    for name, ob in sets:
        show(ob)
        for vn in ("side", "top", "below"):
            view(vn, 0.50)
            tile("cmp_%s_%s" % (name, vn), (420, 420))
        cam((0.55, -0.62, 0.30), (0, 0.0, 0.0), lens=60)
        tile("cmp_%s_q34" % name, (420, 420))
        cam((0.22, -0.26, 0.06), (0, -0.095, 0.01), lens=70)
        tile("cmp_%s_head" % name, (420, 420))

elif WHAT == "scale":
    lights()
    with bpy.data.libraries.load(os.path.join(BLEND, "s5_rigged.blend")) as (src, dst):
        dst.objects = ["starling_real", "rig_real"]
    st, st_arm = dst.objects
    for o in (st, st_arm):
        sc.collection.objects.link(o)
    st_arm.name = "st_rig"
    import s5_rig as S
    S.apply_pose(st_arm, S.POSES["glide"])
    P.apply_pose(ARM["real"], P.POSES["glide"])
    st_arm.location = (0.56, 0.0, 0.0)
    ARM["real"].location = (-0.20, 0, 0)          # the mesh is parented to its armature
    show(REAL, st)
    for vn, loc, rot in (("top", (0.05, 0.06, 2.0), (0, 0, math.pi)), ("below", (0.05, 0.06, -2.0), (math.pi, 0, 0))):
        cam(loc, (0.05, 0.06, 0), ortho=1.62, rot=rot)
        tile("scale_%s" % vn, (900, 460))
    cam((0.05, -2.0, 0.0), (0.05, 0, 0), ortho=1.62)
    tile("scale_front", (900, 260))

elif WHAT == "remap":
    lights()
    mat = REAL.data.materials[0]
    tex = next(n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and "albedo" in n.image.filepath)
    after = tex.image
    before = bpy.data.images.load(os.path.join(OUTP, "peregrine_real_albedo_raw.png"))
    P.apply_pose(ARM["real"], P.POSES["glide"])
    show(REAL)
    for tag, im in (("before", before), ("after", after)):
        tex.image = im
        for vn in ("below", "top"):
            view(vn, 1.12)
            tile("remap_%s_%s" % (tag, vn), (480, 300))
        cam((0.22, -0.26, 0.04), (0, -0.095, 0.008), lens=70)
        tile("remap_%s_head" % tag, (300, 300))
        cam((-0.24, -0.25, -0.03), (0, -0.095, 0.0), lens=70)
        tile("remap_%s_headR" % tag, (300, 300))

elif WHAT == "tail":
    # starling v2 vs v3 (glide): side / top / below, plus the B1 measurements on the v3 mesh
    import s5_rig as S
    lights()
    res = {}
    for ver, path in (("v2", os.path.join(BLEND, "v2", "s5_rigged.blend")), ("v3", os.path.join(BLEND, "s5_rigged.blend"))):
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = ["starling_real", "rig_real"]
        st, arm = dst.objects
        for o in (st, arm):
            sc.collection.objects.link(o)
        if ver == "v2":
            for m in st.data.materials:
                for n in m.node_tree.nodes:
                    if n.type == "TEX_IMAGE" and n.image:
                        im = n.image.copy()
                        im.filepath = os.path.join(OUT, "v2", os.path.basename(n.image.filepath))
                        im.reload()
                        n.image = im
        S.apply_pose(arm, S.POSES["glide"])
        show(st)
        dg = bpy.context.evaluated_depsgraph_get()
        em = st.evaluated_get(dg).to_mesh()
        co = np.array([tuple(v.co) for v in em.vertices])
        parts = np.empty(len(st.data.polygons), np.int32)
        st.data.attributes["part"].data.foreach_get("value", parts)
        vp = np.zeros(len(co), np.int32)
        for p in st.data.polygons:
            for vi in p.vertices:
                vp[vi] = parts[p.index]
        tail_tip = float(co[vp == 1, 1].max())
        wing_tip_y = float(co[(vp == 2) | (vp == 3), 1].max())
        st.evaluated_get(dg).to_mesh_clear()
        res[ver] = {"tailTipY": round(tail_tip, 4), "wingRearmostY_glide": round(wing_tip_y, 4),
                    "tailBehindWingtipsCm": round((tail_tip - wing_tip_y) * 100, 2)}
        for vn, loc, rot, orth in (("side", (0.9, 0.0, 0.0), None, 0.30), ("top", (0, 0.0, 0.9), (0, 0, math.pi), 0.44),
                                   ("below", (0, 0.0, -0.9), (math.pi, 0, 0), 0.44)):
            cam(loc, (0, 0.0, 0), ortho=orth, rot=rot)
            tile("tail_%s_%s" % (ver, vn), (520, 360) if vn == "side" else (520, 420))
        bpy.data.objects.remove(st)
        bpy.data.objects.remove(arm)
    meta3 = json.load(open(os.path.join(BLEND, "s3_meta.json")))
    res["v3_build"] = {k: meta3[k] for k in ("Y_FOLDTIP", "TAIL_Y0", "TAIL_Y1")}
    json.dump(res, open(os.path.join(TILES, "tail_measure.json"), "w"), indent=1)
    plog("tail measurements %s" % res)
plog("done")
