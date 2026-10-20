# -*- coding: utf-8 -*-
"""Stage 9 (optional extra, not part of murm-vat-1): starling IMPOSTOR sprite atlas for the farthest birds.
SPEC 4.6 draws the far LOD with the 12-triangle 'micro' mesh (min-pixel, alpha coverage); this atlas is an
alternative for a camera-facing sprite LOD if the flock builder wants one. Rendered from the v3 retro starling:
  columns = 18 poses: cycle_pose(k/16), k = 0..15, then glide, bound
  rows    = 24 views: elevation -60, -25, +15 deg x azimuth 0, 45, .. 315 deg in the BIRD frame
            (glTF frame: +Z head, +Y back, +X left wing; az measured from the head toward the left wing, el > 0 =
             seen from above the back). View direction = from the bird toward the camera.
  cell    = 48 px, the bird centred, orthographic, 0.42 m across (span 0.39 m)
RGBA PNG, straight alpha = coverage; RGB = the retro albedo under a soft overcast (flat dome light), sRGB.
Writes assets/birds/starling_impostor.png + .json and models/preview/starling_impostor_preview.png."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
import s5_rig as R

ASSETS = os.path.join(ROOT, "assets", "birds")
CELL, ORTHO = 48, 0.42
NPH = 16
POSE_LIST = [("cycle", k / NPH) for k in range(NPH)] + [("glide", None), ("bound", None)]
ELS = (-60, -25, 15)
AZS = tuple(range(0, 360, 45))
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s5_rigged.blend"))
sc = bpy.context.scene
for o in sc.objects:
    if o.type == "MESH":
        o.hide_render = o.name != "starling_retro"
arm = bpy.data.objects["rig_retro"]
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "FLAT"
sc.display.shading.color_type = "TEXTURE"
sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = CELL * 2      # 2x supersampled, downsampled below
sc.render.resolution_percentage = 100
sc.render.filter_size = 1.2
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
cd = bpy.data.cameras.new("imp")
cd.type = "ORTHO"
cd.ortho_scale = ORTHO
cam = bpy.data.objects.new("imp", cd)
sc.collection.objects.link(cam)
sc.camera = cam
tmp = os.path.join(BLEND, "_imp_tmp.png")
atlas = np.zeros((len(ELS) * len(AZS) * CELL, len(POSE_LIST) * CELL, 4), np.float32)
for ci, (kind, ph) in enumerate(POSE_LIST):
    R.apply_pose(arm, R.cycle_pose(ph) if kind == "cycle" else R.POSES[kind])
    for ei, el in enumerate(ELS):
        for ai, az in enumerate(AZS):
            a, e = math.radians(az), math.radians(el)
            g = Vector((math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)))   # glTF frame
            d = Vector((g.x, -g.z, g.y))                                                       # Blender frame
            cam.location = d * 2.0
            up = Vector((0, 0, 1)) if abs(el) < 80 else Vector((0, -1, 0))
            look_at(cam, (0, 0, 0), up)
            sc.render.filepath = tmp
            bpy.ops.render.render(write_still=True)
            im = bpy.data.images.load(tmp)
            px = img_pixels(im)[::-1].copy()
            bpy.data.images.remove(im)
            pm = px.copy()
            pm[..., :3] *= pm[..., 3:]                            # 2x2 box down-sample in premultiplied space
            pm = pm.reshape(CELL, 2, CELL, 2, 4).mean((1, 3))
            px = pm.copy()
            px[..., :3] = pm[..., :3] / np.maximum(pm[..., 3:], 1e-4)
            r0 = (ei * len(AZS) + ai) * CELL
            atlas[r0:r0 + CELL, ci * CELL:(ci + 1) * CELL] = px
    log("impostor pose %d/%d" % (ci + 1, len(POSE_LIST)))
os.remove(tmp)
save = bpy.data.images.new("imp_atlas", atlas.shape[1], atlas.shape[0], alpha=True)
save.colorspace_settings.name = "Non-Color"
save.alpha_mode = "STRAIGHT"
save.pixels.foreach_set(atlas[::-1].ravel())
save.filepath_raw = os.path.join(ASSETS, "starling_impostor.png")
save.file_format = "PNG"
save.save()
meta = {"format": "murm-impostor-1", "name": "starling_impostor", "source": "starling_retro (v3), blender/s9_impostor.py",
        "cellPx": CELL, "orthoM": ORTHO, "cols": len(POSE_LIST), "rows": len(ELS) * len(AZS),
        "poses": ["cycle %.4f" % p if k == "cycle" else k for k, p in POSE_LIST], "cycleFrames": NPH,
        "colGlide": NPH, "colBound": NPH + 1, "elevationsDeg": list(ELS), "azimuthsDeg": list(AZS),
        "rowIndex": "row = elevationIndex * 8 + azimuthIndex",
        "viewFrame": "direction from the bird to the camera in the glTF bird frame (+Z head, +Y back, +X left wing); az from +Z toward +X, el toward +Y",
        "alpha": "straight, = coverage", "color": "sRGB, retro albedo, flat overcast light",
        "note": "optional; SPEC 4.6 uses starling_micro (min-pixel mesh) for LOD3"}
json.dump(meta, open(os.path.join(ASSETS, "starling_impostor.json"), "w"), indent=1)
log("wrote starling_impostor.png %dx%d" % (atlas.shape[1], atlas.shape[0]))
