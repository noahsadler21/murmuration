# -*- coding: utf-8 -*-
"""Peregrine p1: clean and re-pose the scan into the flight frame (metres, head -Y, back +Z, left wing +X).
 1. delete the rock mount, legs and feet (everything below the belly, z < 1.0 scan units, in front of the
    tail plane y < 1.70) and the stray fragments;
 2. level the body: rotate the body axis (fitted to the trunk + tail) to horizontal about the scan's X axis;
    the head keeps its own (horizontal, forward-looking) orientation: the rotation fades out across the neck with
    a smooth weight, so the bend is a soft deformation, not a cut;
 3. remove the residual yaw / sideways offset by a mirror-symmetry fit of the trunk;
 4. scale bill-to-tail to 0.40 m; origin at the body centre at the wing root (the folded wing's shoulder).
Writes models/blend/p1_scan_oriented.blend (object 'scan') and p1_frame.json."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
import bmesh

bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "p0_scan_raw.blend"))
ob = bpy.data.objects["scan"]
me = ob.data
P = verts_np(me)
# ---- 1. delete rock / legs / feet / fragments
kill = (P[:, 2] < 1.0) & (P[:, 1] < 1.70)
kill |= (P[:, 2] < -2.3)
bm = bmesh.new()
bm.from_mesh(me)
bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(kill)[0]], context="VERTS")
# drop small islands
bm.verts.ensure_lookup_table()
seen = set()
islands = []
for v in bm.verts:
    if v.index in seen:
        continue
    st, isl = [v], []
    seen.add(v.index)
    while st:
        a = st.pop()
        isl.append(a)
        for e in a.link_edges:
            b = e.other_vert(a)
            if b.index not in seen:
                seen.add(b.index)
                st.append(b)
    islands.append(isl)
islands.sort(key=len, reverse=True)
small = [v for isl in islands[1:] if len(isl) < 2000 for v in isl]
bmesh.ops.delete(bm, geom=small, context="VERTS")
bm.to_mesh(me)
bm.free()
P = verts_np(me)
log("cleaned: %d verts left (%d islands, %d small removed)" % (len(P), len(islands), len(small)))

# ---- 2. level: body axis from the trunk + tail (below the neck), PCA in the YZ plane
trunk = P[(P[:, 2] < 5.0)]
c = trunk.mean(0)
yz = trunk[:, 1:] - c[1:]
w_, v_ = np.linalg.eigh(yz.T @ yz)
ax = v_[:, np.argmax(w_)]
if ax[0] < 0:
    ax = -ax                        # head -> tail direction points +Y (back), -Z (down)
# rotation about +X by phi maps the axis (ay, az) to (1, 0): ay cos - az sin = 1, ay sin + az cos = 0
phi = math.atan2(-ax[1], ax[0])     # ax = (ay, az) -> phi with tan(phi) = -az / ay
log("trunk axis (y,z) = (%.3f, %.3f): %.1f deg below horizontal, levelling rotation %.1f deg about X"
    % (ax[0], ax[1], math.degrees(math.atan2(-ax[1], ax[0])), math.degrees(phi)))
NECK = np.array([0.0, 0.05, 5.35])      # neck pivot (scan units), between throat and nape
HEADC = np.array([0.0, -0.10, 6.00])    # head centre (scan units)
up_body = np.array([0.0, -ax[0], -ax[1]])   # toward the head along the body axis
if up_body[2] < 0:
    up_body = -up_body
s = (P - NECK) @ up_body
wh = np.clip((s + 0.45) / 0.95, 0, 1)
wh = wh * wh * (3 - 2 * wh)             # 1 = head (keeps its orientation), 0 = body (levelled)
ang = phi * (1 - wh)
ca, sa = np.cos(ang), np.sin(ang)
Q = P - NECK
P2 = P.copy()
P2[:, 1] = Q[:, 1] * ca - Q[:, 2] * sa
P2[:, 2] = Q[:, 1] * sa + Q[:, 2] * ca
# the head keeps its orientation but is carried forward with the levelled neck: it moves by the rotation of its
# centre about the pivot (in flight the head sits in front of the shoulders, not on top of them)
hq = HEADC - NECK
T_head = np.array([0.0, hq[1] * math.cos(phi) - hq[2] * math.sin(phi), hq[1] * math.sin(phi) + hq[2] * math.cos(phi)]) - hq
P2 += NECK + wh[:, None] * T_head[None, :]
log("head carried by %s units" % T_head.round(3))
# ---- 3. sideways offset + yaw by mirror fit on the trunk (y between the shoulder and the tail root)
def mirror_cost(P_, x0, yaw):
    cy, sy = math.cos(yaw), math.sin(yaw)
    x = (P_[:, 0] - x0) * cy - P_[:, 1] * sy
    y = (P_[:, 0] - x0) * sy + P_[:, 1] * cy
    z = P_[:, 2]
    cost = 0.0
    for y_ in np.linspace(np.percentile(y, 25), np.percentile(y, 70), 12):
        m = np.abs(y - y_) < 0.08
        if m.sum() < 50:
            continue
        for z_ in np.linspace(np.percentile(z[m], 15), np.percentile(z[m], 85), 6):
            mm = m & (np.abs(z - z_) < 0.12)
            if mm.sum() < 10:
                continue
            cost += (x[mm].max() + x[mm].min()) ** 2
    return cost
sub = P2[::7]
best = (1e9, 0, 0)
for x0 in np.linspace(-0.4, 0.4, 17):
    for yaw in np.radians(np.linspace(-8, 8, 17)):
        cst = mirror_cost(sub, x0, yaw)
        if cst < best[0]:
            best = (cst, x0, yaw)
for x0 in np.linspace(best[1] - 0.05, best[1] + 0.05, 11):
    for yaw in best[2] + np.radians(np.linspace(-1, 1, 11)):
        cst = mirror_cost(sub, x0, yaw)
        if cst < best[0]:
            best = (cst, x0, yaw)
_, X0, YAW = best
cy, sy = math.cos(YAW), math.sin(YAW)
x = (P2[:, 0] - X0) * cy - P2[:, 1] * sy
y = (P2[:, 0] - X0) * sy + P2[:, 1] * cy
P2[:, 0], P2[:, 1] = x, y
log("mirror fit: x offset %.3f units, yaw %.2f deg" % (X0, math.degrees(YAW)))
# ---- 4. scale + origin
bill = P2[np.argmin(P2[:, 1])]
tailtip = P2[np.argmax(P2[:, 1])]
L = tailtip[1] - bill[1]
S = 0.40 / L
P2 *= S
log("bill y %.3f, tail tip y %.3f units: length %.3f units -> scale %.5f m/unit" % (bill[1], tailtip[1], L, S))
# origin: wing root = 0.34 of the length behind the bill (peregrine: head + neck ~ 0.10 m, shoulder ~ 0.135 m
# behind the bill tip); z = the trunk's mid height there
ybill = P2[:, 1].min()
y_root = ybill + 0.135
sl = P2[np.abs(P2[:, 1] - y_root) < 0.006]
z_mid = float((sl[:, 2].min() + sl[:, 2].max()) / 2)
P2 -= np.array([0.0, y_root, z_mid])
me.vertices.foreach_set("co", P2.ravel().astype(np.float32))
me.update()
ob.location = (0, 0, 0)
ob.rotation_euler = (0, 0, 0)
ob.scale = (1, 1, 1)
lo, hi = P2.min(0), P2.max(0)
log("final bbox min %s max %s (m)" % (lo.round(4), hi.round(4)))
json.dump({"phi_deg": math.degrees(phi), "neck": NECK.tolist(), "x0": X0, "yaw_deg": math.degrees(YAW),
           "scale": S, "y_root_m": y_root, "z_mid_m": z_mid, "bbox": [lo.tolist(), hi.tolist()],
           "bill_y": float(P2[:, 1].min()), "tail_y": float(P2[:, 1].max())},
          open(os.path.join(BLEND, "p1_frame.json"), "w"), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "p1_scan_oriented.blend"))
np.save(os.path.join(BLEND, "p1_verts.npy"), P2[::2].astype(np.float32))
# views
sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "FLAT"
sc.display.shading.color_type = "TEXTURE"
for name, d in (("side_+X", (1, 0, 0)), ("top_+Z", (0, 0, 1)), ("below_-Z", (0, 0, -1)), ("front_-Y", (0, -1, 0))):
    cam = new_cam("c", Vector(d) * 2.0, (0, 0.06, 0), ortho=0.48)
    if name.startswith("top"):
        cam.rotation_euler = (0, 0, 0)
    if name.startswith("below"):
        cam.rotation_euler = (math.pi, 0, 0)
    render_to(sc, cam, os.path.join(PREVIEW, "_p1_%s.png" % name), (700, 700))
    bpy.data.objects.remove(cam)
log("done")
