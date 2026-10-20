# -*- coding: utf-8 -*-
"""Stage 0: import the raw scan, report bounds / components / materials, render 4 raw views (no cleanup)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
import bmesh

wipe()
bpy.ops.import_scene.gltf(filepath=os.path.join(RAW, "scene.gltf"))
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
log("imported %d mesh objects" % len(meshes))
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
scan = bpy.context.view_layer.objects.active
scan.name = "scan_raw"
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(bpy.context.scene.objects):
    if o.type == "EMPTY":
        bpy.data.objects.remove(o)
me = scan.data
P = verts_np(me)
log("verts %d tris %d" % (len(P), tri_count(scan)))
log("bbox min %s max %s" % (P.min(0).round(4), P.max(0).round(4)))
# weld duplicates (gltf split) then components
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
bm.to_mesh(me)
bm.free()
P = verts_np(me)
log("after weld verts %d" % len(P))
# connected components via union find over edges
E = np.empty(len(me.edges) * 2, dtype=np.int64)
me.edges.foreach_get("vertices", E)
E = E.reshape(-1, 2)
par = np.arange(len(P))


def find(a):
    r = a
    while par[r] != r:
        r = par[r]
    while par[a] != r:
        par[a], a = r, par[a]
    return r


for a, b in E:
    ra, rb = find(a), find(b)
    if ra != rb:
        par[ra] = rb
roots = np.array([find(i) for i in range(len(P))])
u, cnt = np.unique(roots, return_counts=True)
order = np.argsort(-cnt)
for k in order[:12]:
    sel = roots == u[k]
    q = P[sel]
    log("component %d: %d verts, bbox %s .. %s" % (k, cnt[k], q.min(0).round(3), q.max(0).round(3)))
log("components total %d" % len(u))
for m in me.materials:
    log("material %s nodes: %s" % (m.name, [n.type for n in m.node_tree.nodes]))
# z histogram for base detection
zs = P[:, 2]
h, edges_ = np.histogram(zs, bins=30)
for i in range(30):
    sl = P[(zs >= edges_[i]) & (zs < edges_[i + 1])]
    ext = (sl.max(0) - sl.min(0)).round(3) if len(sl) else 0
    log("z %.3f..%.3f: %6d verts  extent %s" % (edges_[i], edges_[i + 1], h[i], ext))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "s0_scan_raw.blend"))

# renders: 4 ortho views, flat-ish studio lighting
sc = bpy.context.scene
gpu_cycles(sc, 32)
sc.view_settings.view_transform = "Standard"
w = overcast_world(sc, 1.0)
sun("key", (1, -1, 2), 2.0, (1, 0.95, 0.9))
c = (P.min(0) + P.max(0)) / 2
ext = float((P.max(0) - P.min(0)).max()) * 1.15
c = Vector(c)
views = {"front_-Y": (0, -1, 0), "right_+X": (1, 0, 0), "back_+Y": (0, 1, 0), "top_+Z": (0, 0, 1)}
for name, d in views.items():
    cam = new_cam("cam_" + name, c + Vector(d) * 1.0, c, ortho=ext)
    if name.startswith("top"):
        cam.rotation_euler = (0, 0, 0)
    render_to(sc, cam, os.path.join(PREVIEW, "_raw_%s.png" % name), (700, 700))
log("done")
