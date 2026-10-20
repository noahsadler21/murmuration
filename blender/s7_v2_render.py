# -*- coding: utf-8 -*-
"""Second look test renders (v2). Run:
  blender -b -P s7_v2_render.py -- compare v1|v2   (glide views of one rig version)
  blender -b -P s7_v2_render.py -- cycle           (8 phases, side + front, both variants)
  blender -b -P s7_v2_render.py -- flock           (200 retro birds, v2 cycle)
  blender -b -P s7_v2_render.py -- video           (flap loop mp4, both variants)
Tiles -> models/preview/_tiles_v2/, sheets by compose_v2.py"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
from mathutils import Quaternion
import s5_rig as R

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["compare", "v2"]
WHAT = argv[0]
VER = argv[1] if len(argv) > 1 else "v2"
TILES = os.path.join(PREVIEW, "_tiles_v2")
os.makedirs(TILES, exist_ok=True)
V1_GLIDE = {"humerus": (8, 4, 2), "forearm": (0, 0, 0), "hand": (2, 12, 3), "primaries": (2, 6, 0), "tail": 0.0}

if WHAT == "compare" and VER == "v1":
    bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "v1", "s5_rigged.blend"))
    for im in bpy.data.images:
        b = os.path.basename(im.filepath)
        if b.startswith("starling_"):
            im.filepath = os.path.join(OUT, "v1", b)
            im.reload()
else:
    bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s5_rigged.blend"))
sc = bpy.context.scene
gpu_cycles(sc, 96)
sc.cycles.use_denoising = True
sc.view_settings.view_transform = "AgX"
sc.view_settings.exposure = 0.6
real, retro = bpy.data.objects["starling_real"], bpy.data.objects["starling_retro"]
arm_real, arm_retro = bpy.data.objects["rig_real"], bpy.data.objects["rig_retro"]
for o in sc.objects:
    if o.type == "MESH":
        o.hide_render = True


def show(*objs):
    for o in sc.objects:
        if o.type == "MESH":
            o.hide_render = o not in objs


def lights(sun_from=(-0.55, -1.0, 0.30), sun_e=3.2, sky=0.6):
    for o in list(sc.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o)
    dusk_world(sc, sky)
    sun("sun_warm", sun_from, sun_e, (1.0, 0.56, 0.30), 1.2)


def cam(loc, target, lens=85, ortho=None, rot=None):
    for o in list(sc.objects):
        if o.type == "CAMERA":
            bpy.data.objects.remove(o)
    c = new_cam("cam", loc, target, ortho=ortho, lens=lens)
    if rot is not None:
        c.rotation_euler = rot
    sc.camera = c
    return c


def tile(name, res, transparent=False):
    sc.render.film_transparent = transparent
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = os.path.join(TILES, name + ".png")
    bpy.ops.render.render(write_still=True)
    log("tile " + name)


VIEWS = {
    "side":  dict(loc=(0.62, 0.0, 0.03), target=(0, 0.0, 0.0), lens=85),
    "top":   dict(loc=(0.0, 0.0, 0.9), target=(0, 0, 0), ortho=0.44, rot=(0, 0, math.pi)),
    "below": dict(loc=(0.0, 0.0, -0.9), target=(0, 0, 0), ortho=0.44, rot=(math.pi, 0, 0)),
    "front": dict(loc=(0.0, -0.9, 0.0), target=(0, 0, 0), ortho=0.44),
    "q34":   dict(loc=(0.48, -0.61, 0.36), target=(0, 0, 0), lens=85),
}

if WHAT == "compare":
    lights()
    for variant, ob, arm in (("real", real, arm_real), ("retro", retro, arm_retro)):
        R.apply_pose(arm, V1_GLIDE if VER == "v1" else R.POSES["glide"])
        show(ob)
        for vn, v in VIEWS.items():
            cam(v["loc"], v["target"], v.get("lens", 85), v.get("ortho"), v.get("rot"))
            tile("cmp_%s_%s_%s" % (VER, variant, vn), (600, 400))

elif WHAT == "cycle":
    lights(sun_from=(-0.4, -1.0, 0.45), sun_e=3.0, sky=0.7)
    sc.cycles.samples = 48
    for variant, ob, arm in (("real", real, arm_real), ("retro", retro, arm_retro)):
        show(ob)
        for k in range(8):
            ph = k / 8.0
            R.apply_pose(arm, R.cycle_pose(ph))
            for vn, loc in (("side", (0.9, 0, 0)), ("front", (0, -0.9, 0))):
                cam(loc, (0, 0, 0), ortho=0.46)
                tile("cyc_%s_%s_%d" % (variant, vn, k), (360, 300))
        for extra in ("glide", "bound"):
            R.apply_pose(arm, R.POSES[extra])
            for vn, loc in (("side", (0.9, 0, 0)), ("front", (0, -0.9, 0))):
                cam(loc, (0, 0, 0), ortho=0.46)
                tile("cyc_%s_%s_%s" % (variant, vn, extra), (360, 300))
            cam((0, 0, 0.9), (0, 0, 0), ortho=0.46, rot=(0, 0, math.pi))
            tile("cyc_%s_top_%s" % (variant, extra), (360, 300))

elif WHAT == "flock":
    sc.view_settings.exposure = 0.0
    for o in list(sc.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o)
    overcast_world(sc, 1.25, ground=True)
    rng = np.random.default_rng(11)
    NPH = 16
    show(retro)
    meshes = []
    for k in range(NPH):
        R.apply_pose(arm_retro, R.cycle_pose(k / NPH))
        meshes.append(R.bake_pose_mesh(retro, "v2_ph%d" % k))
    R.apply_pose(arm_retro, R.POSES["glide"])
    glide = R.bake_pose_mesh(retro, "v2_glide")
    R.apply_pose(arm_retro, R.POSES["bound"])
    bound = R.bake_pose_mesh(retro, "v2_bound")
    retro.hide_render = True
    col = bpy.data.collections.new("flock")
    sc.collection.children.link(col)
    N = 200
    pts = []
    while len(pts) < N:
        u, v = rng.uniform(-1, 1, 2)
        if u * u + v * v > 1.0:
            continue
        pts.append((u * 3.4, 0.6 * math.sin(v * 3 + u) + rng.normal(0, 0.28), v * 1.6 + 0.6 * math.sin(u * 2.2)))
    flow = Vector((1.0, 0.25, 0.08)).normalized()
    nst = {"flap": 0, "glide": 0, "bound": 0}
    for i, p in enumerate(pts):
        r = rng.random()
        if r < 0.70:
            me = meshes[int(rng.integers(NPH))]
            nst["flap"] += 1
        elif r < 0.90:
            me = glide
            nst["glide"] += 1
        else:
            me = bound
            nst["bound"] += 1
        o = bpy.data.objects.new("b%03d" % i, me)
        col.objects.link(o)
        o.location = Vector(p)
        d = (flow + Vector(rng.normal(0, 0.18, 3))).normalized()
        q = Vector((0, -1, 0)).rotation_difference(d)
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = Quaternion(d, rng.normal(0, 0.35)) @ q
    log("flock states %s" % nst)
    cam((-4.0, -29.0, -8.5), (0.0, 0.0, 0.3), 50)
    sc.cycles.samples = 64
    tile("flock_overcast", (1920, 1080))
    dusk_world(sc, 0.6)
    sun("sun_warm", (-0.55, -1.0, 0.16), 3.0, (1.0, 0.56, 0.30), 1.2)
    tile("flock_dusk", (1920, 1080))

elif WHAT == "video":
    lights(sun_from=(-0.5, -1.0, 0.35), sun_e=3.2, sky=0.65)
    show(real, retro)
    arm_real.location = (-0.22, 0, 0)
    arm_retro.location = (0.22, 0, 0)
    cam((0.55, -1.25, 0.45), (0, 0, 0), 50)
    sc.cycles.samples = 24
    FPC = 24          # frames per wingbeat: 24 fps video = 13.3 Hz wingbeat slowed ~13x
    NCYC = 3
    frames = FPC * NCYC + 24   # three wingbeats, then 1 s blend into a glide
    sc.frame_start, sc.frame_end = 1, frames
    sc.render.fps = 24
    for arm in (arm_real, arm_retro):
        for b in arm.pose.bones:
            b.rotation_mode = "QUATERNION"
    for fr in range(1, frames + 1):
        if fr <= FPC * NCYC:
            pose = R.cycle_pose((fr - 1) / FPC)
        else:
            t = (fr - FPC * NCYC) / 24.0
            t = t * t * (3 - 2 * t)
            pose = R.lerp_pose(R.cycle_pose(0.0), R.POSES["glide"], t)
        for arm in (arm_real, arm_retro):
            R.apply_pose(arm, pose)
            for b in arm.pose.bones:
                b.keyframe_insert("rotation_quaternion", frame=fr)
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    sc.render.film_transparent = False
    out = os.path.join(PREVIEW, "starling_v2_flap.mp4")
    try:
        sc.render.image_settings.media_type = "VIDEO"
    except Exception:
        pass
    sc.render.image_settings.file_format = "FFMPEG"
    sc.render.ffmpeg.format = "MPEG4"
    sc.render.ffmpeg.codec = "H264"
    sc.render.ffmpeg.constant_rate_factor = "HIGH"
    sc.render.filepath = out
    bpy.ops.render.render(animation=True)
    log("video -> %s" % out)
log("done")
