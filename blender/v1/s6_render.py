# -*- coding: utf-8 -*-
"""Stage 6: look-test renders (Cycles). Run: blender -b -P s6_render.py -- compare|normals|poses|flock
Tiles go to models/preview/_tiles/, the sheets are composed by compose_sheets.py (PIL)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
from mathutils import Quaternion, Euler
import json
import s5_rig as R

WHAT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "compare"
QUICK = "--quick" in sys.argv
TILES = os.path.join(PREVIEW, "_tiles")
os.makedirs(TILES, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s5_rigged.blend"))
sc = bpy.context.scene
dev = gpu_cycles(sc, 32 if QUICK else 128)
sc.cycles.use_denoising = True
sc.view_settings.view_transform = "AgX"
sc.view_settings.exposure = 0.6
scan = bpy.data.objects["scan"]
real, retro = bpy.data.objects["starling_real"], bpy.data.objects["starling_retro"]
arm_real, arm_retro = bpy.data.objects["rig_real"], bpy.data.objects["rig_retro"]
for o in sc.objects:
    if o.type == "MESH":
        o.hide_render = True


def show(*objs):
    for o in sc.objects:
        if o.type == "MESH":
            o.hide_render = o not in objs


def dusk_lights(sun_from=(-0.55, -1.0, 0.16), sun_e=3.2, sky=0.55):
    for o in list(sc.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o)
    dusk_world(sc, sky)
    sun("sun_warm", sun_from, sun_e, (1.0, 0.56, 0.30), 1.2)


def cam_at(loc, target, lens=85, ortho=None):
    for o in list(sc.objects):
        if o.type == "CAMERA":
            bpy.data.objects.remove(o)
    return new_cam("cam", loc, target, ortho=ortho, lens=lens)


def rtile(name, res, transparent=False):
    sc.render.film_transparent = transparent
    p = os.path.join(TILES, name + ".png")
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.filepath = p
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    bpy.ops.render.render(write_still=True)
    log("tile %s" % name)
    return p


def set_mat(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)


if WHAT == "compare":
    dusk_lights()
    R.apply_pose(arm_real, R.POSES["glide"])
    R.apply_pose(arm_retro, R.POSES["glide"])
    for ob in (real, retro):
        ob.location = (0, 0, 0)
    views = {"q34": ((0.62, -0.78, 0.55), (0.0, 0.0, 0.0), 85),
             "side": ((1.05, 0.0, 0.05), (0.0, -0.005, 0.0), 85)}
    for vn, (loc, tgt, lens) in views.items():
        cam = cam_at(Vector(loc) * (0.78 if vn == "q34" else 0.62), tgt, lens)
        sc.camera = cam
        for name, ob in (("scan", scan), ("real", real), ("retro", retro)):
            show(ob)
            rtile("cmp_%s_%s" % (vn, name), (900, 700) if vn == "q34" else (900, 450))

elif WHAT == "normals":
    dusk_lights(sun_from=(-0.35, -0.6, 0.12), sun_e=3.5, sky=0.45)
    R.apply_pose(arm_real, R.POSES["glide"])
    show(real)
    mats = {m: R.material("real", m) for m in ("flat", "baked", "detail", "texonly")}
    # close range: back + wing from above-behind-left, grazing warm sun
    close = {"close": ((0.30, 0.10, 0.42), (0.06, -0.01, 0.0), 70, (900, 700)),
             "head": ((0.16, -0.20, 0.10), (0.0, -0.06, 0.008), 100, (600, 600))}
    for vn, (loc, tgt, lens, res) in close.items():
        sc.camera = cam_at(loc, tgt, lens)
        for m, mat in mats.items():
            set_mat(real, mat)
            rtile("nrm_%s_%s" % (vn, m), res)
    # distance tests: whole bird, 3/4 from below-side (flock observer), wingspan ~= N px
    sc.camera = cam_at((0.55, -0.55, -0.62), (0, 0, 0), 85)
    # the bird's on-screen span at this framing is ~0.62 of the frame width (measured from the 400 px tile)
    for npx in (400, 80, 20):
        w = int(round(npx / 0.62))
        for m, mat in mats.items():
            set_mat(real, mat)
            sc.cycles.samples = 256 if npx < 100 else 128
            rtile("nrm_%dpx_%s" % (npx, m), (w, int(round(w * 0.75))), transparent=True)
        # render-noise floor: (iii) again with another sampling seed
        sc.cycles.seed = 7
        set_mat(real, mats["detail"])
        rtile("nrm_%dpx_%s" % (npx, "detail_seed2"), (w, int(round(w * 0.75))), transparent=True)
        sc.cycles.seed = 0
    set_mat(real, mats["detail"])

elif WHAT == "poses":
    dusk_lights(sun_from=(-0.4, -1.0, 0.45), sun_e=3.0, sky=0.7)
    for variant, ob, arm in (("real", real, arm_real), ("retro", retro, arm_retro)):
        show(ob)
        for pose in ("upstroke", "downstroke", "glide"):
            R.apply_pose(arm, R.POSES[pose])
            for vn, d in (("top", (0, 0, 1)), ("side", (1, 0, 0)), ("front", (0, -1, 0))):
                cam = cam_at(Vector(d) * 1.0 + Vector((0, -0.005, 0)), (0, -0.005, 0), ortho=0.44)
                if vn == "top":
                    cam.rotation_euler = (0, 0, 0)
                sc.camera = cam
                sc.cycles.samples = 48
                rtile("pose_%s_%s_%s" % (variant, pose, vn), (520, 420))

elif WHAT == "flock":
    sc.view_settings.exposure = 0.0
    for o in list(sc.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o)
    overcast_world(sc, 1.25, ground=True)
    rng = np.random.default_rng(11)
    NPH = 10
    meshes = []
    show(retro)
    for k in range(NPH):
        R.apply_pose(arm_retro, R.cycle_pose(k / NPH))
        meshes.append(R.bake_pose_mesh(retro, "flock_ph%d" % k))
    glide = None
    R.apply_pose(arm_retro, R.POSES["glide"])
    glide = R.bake_pose_mesh(retro, "flock_glide")
    retro.hide_render = True
    col = bpy.data.collections.new("flock")
    sc.collection.children.link(col)
    N = 200
    # murmuration-like blob: a curved, folded sheet (dense) with a looser halo; 1 m nearest-neighbour scale
    pts = []
    while len(pts) < N:
        u, v = rng.uniform(-1, 1, 2)
        x = u * 3.4
        z = v * 1.6 + 0.6 * math.sin(u * 2.2)
        yv = 0.6 * math.sin(v * 3 + u) + rng.normal(0, 0.28)
        if u * u + v * v > 1.0:
            continue
        pts.append((x, yv, z))
    pts = np.array(pts)
    flow = Vector((1.0, 0.25, 0.08)).normalized()
    for i, p in enumerate(pts):
        me = glide if rng.random() < 0.15 else meshes[int(rng.integers(NPH))]
        o = bpy.data.objects.new("b%03d" % i, me)
        col.objects.link(o)
        o.location = Vector(p)
        d = (flow + Vector(rng.normal(0, 0.18, 3))).normalized()
        # bird forward is -Y
        q = Vector((0, -1, 0)).rotation_difference(d)
        bank = Quaternion(d, rng.normal(0, 0.35))
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = bank @ q
    # observer below, looking up and across at ~50 m
    sc.camera = cam_at((-4.0, -29.0, -8.5), (0.0, 0.0, 0.3), 50)
    sc.cycles.samples = 64
    rtile("flock_overcast", (1920, 1080))
    # same flock at dusk for reference
    dusk_world(sc, 0.6)
    sun("sun_warm", (-0.55, -1.0, 0.16), 3.0, (1.0, 0.56, 0.30), 1.2)
    rtile("flock_dusk", (1920, 1080))
log("done")
