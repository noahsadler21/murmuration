# -*- coding: utf-8 -*-
"""Peregrine p0: import the Watt Institution scan (models/raw/peregrine/scene.gltf, CC-BY 4.0), join the 13 meshes,
weld, list connected components and the z histogram, render 4 raw views. Writes models/blend/p0_scan_raw.blend."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
import bmesh, json

RAWP = os.path.join(ROOT, "models", "raw", "peregrine")
wipe()
bpy.ops.import_scene.gltf(filepath=os.path.join(RAWP, "scene.gltf"))
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
log("imported %d meshes" % len(meshes))
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(bpy.context.scene.objects):
    if o != ob:
        bpy.data.objects.remove(o)
ob.name = "scan"
me = ob.data
bm = bmesh.new()
bm.from_mesh(me)
nv0 = len(bm.verts)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
log("weld: %d -> %d verts, %d faces" % (nv0, len(bm.verts), len(bm.faces)))
# components
bm.verts.ensure_lookup_table()
seen = np.zeros(len(bm.verts), bool)
comps = []
for v in bm.verts:
    if seen[v.index]:
        continue
    stack = [v]
    seen[v.index] = True
    ids = []
    while stack:
        a = stack.pop()
        ids.append(a.index)
        for e in a.link_edges:
            b = e.other_vert(a)
            if not seen[b.index]:
                seen[b.index] = True
                stack.append(b)
    comps.append(ids)
bm.to_mesh(me)
bm.free()
P = verts_np(me)
comps.sort(key=len, reverse=True)
info = []
for c in comps[:12]:
    q = P[c]
    info.append({"n": len(c), "min": [round(float(x), 3) for x in q.min(0)], "max": [round(float(x), 3) for x in q.max(0)]})
    log("component %7d verts  min %s  max %s" % (len(c), info[-1]["min"], info[-1]["max"]))
log("components: %d total" % len(comps))
log("bbox min %s max %s" % (P.min(0).round(3), P.max(0).round(3)))
h, edges = np.histogram(P[:, 2], 40)
for a, b in zip(edges[:-1], h):
    log("z %+7.3f  %7d  %s" % (a, b, "#" * int(60 * b / h.max())))
json.dump({"components": info, "bbox": [P.min(0).tolist(), P.max(0).tolist()]},
          open(os.path.join(BLEND, "p0_info.json"), "w"), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "p0_scan_raw.blend"))
# views (unlit scan textures, Eevee/workbench texture)
sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "FLAT"
sc.display.shading.color_type = "TEXTURE"
c = (P.min(0) + P.max(0)) / 2
ext = float((P.max(0) - P.min(0)).max()) * 1.15
for name, d in (("front_-Y", (0, -1, 0)), ("right_+X", (1, 0, 0)), ("back_+Y", (0, 1, 0)), ("top_+Z", (0, 0, 1))):
    cam = new_cam("c", Vector(c) + Vector(d) * ext * 3, Vector(c), ortho=ext)
    cam.data.clip_end = ext * 10
    if name.startswith("top"):
        cam.rotation_euler = (0, 0, 0)
    render_to(sc, cam, os.path.join(PREVIEW, "_p0_raw_%s.png" % name), (700, 700))
    bpy.data.objects.remove(cam)
log("done")
