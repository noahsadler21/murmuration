# -*- coding: utf-8 -*-
"""Stage 1: clean the scan (drop base plate, rod, branch, legs), orient into the flight frame
(head -Y, back +Z, bird's right wing -X), straighten the head, scale to a 20.5 cm bill-to-tail bird.
Writes models/blend/s1_scan_clean.blend + diagnostic views."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
import bmesh
from mathutils import Quaternion

DIAG = "--diag" in sys.argv
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s0_scan_raw.blend"))
for o in list(bpy.context.scene.objects):
    if o.type in ("CAMERA", "LIGHT"):
        bpy.data.objects.remove(o)
scan = bpy.data.objects["scan_raw"]
scan.name = "scan"
me = scan.data
P = verts_np(me)

# ---------------------------------------------------------------- 1 cut away the mount (raw scan frame, metres)
# base plate: z < 0.024 ; rod: z < 0.135 ; branch: cylinder along X through (y 0.0097, z 0.149) r 0.012 ;
# legs + feet: below the belly line between the branch and the vent
y, z = P[:, 1], P[:, 2]
cut = (z < 0.024) | (z < 0.135)
cut |= ((y - 0.0097) ** 2 + (z - 0.149) ** 2) < 0.0125 ** 2
LEG_Z = float(os.environ.get("LEG_Z", "0.178"))
cut |= (z < LEG_Z) & (y > -0.030) & (y < 0.045)
log("cut %d of %d verts (mount, branch, legs)" % (cut.sum(), len(P)))
bm = bmesh.new()
bm.from_mesh(me)
bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(cut)[0]], context="VERTS")
# drop small floating islands left by the cut
bm.verts.ensure_lookup_table()
seen = set()
islands = []
for v in bm.verts:
    if v.index in seen:
        continue
    stack = [v]
    comp = []
    seen.add(v.index)
    while stack:
        a = stack.pop()
        comp.append(a)
        for e in a.link_edges:
            b = e.other_vert(a)
            if b.index not in seen:
                seen.add(b.index)
                stack.append(b)
    islands.append(comp)
islands.sort(key=len, reverse=True)
small = [v for comp in islands[1:] for v in comp]
log("islands after cut: %s ; dropping %d verts" % ([len(c) for c in islands[:6]], len(small)))
bmesh.ops.delete(bm, geom=small, context="VERTS")
# close the leg stumps (small boundary loops only)
edges = [e for e in bm.edges if e.is_boundary]
res = bmesh.ops.holes_fill(bm, edges=edges, sides=400)
log("filled %d holes" % len(res["faces"]))
bmesh.ops.triangulate(bm, faces=res["faces"])
bm.to_mesh(me)
bm.free()
P = verts_np(me)

# ---------------------------------------------------------------- 2 orient (PCA long axis in the vertical plane)
c = P.mean(0)
Q = P - c
cov = Q.T @ Q / len(Q)
ev, evec = np.linalg.eigh(cov)
a = evec[:, 2]
# sign: toward the head (the head is the high end of the perched bird)
if (Q @ a)[np.argmax(Q[:, 2])] < 0:
    a = -a
f = a / np.linalg.norm(a)
lat = np.cross(f, [0, 0, 1.0]); lat /= np.linalg.norm(lat)
u = np.cross(lat, f); u /= np.linalg.norm(u)
r = np.cross(f, u)
PITCH = float(os.environ.get("PITCH", "0"))  # extra nose-down rotation (deg) about the lateral axis
S = np.stack([f, u, r], 1)
T = np.array([[0, -1, 0], [0, 0, 1], [-1, 0, 0]], dtype=float).T
R = T @ S.T
ang = math.radians(PITCH)
Rx = np.array([[1, 0, 0], [0, math.cos(ang), -math.sin(ang)], [0, math.sin(ang), math.cos(ang)]])
R = Rx @ R
log("PCA long axis %s, tilt from horizontal %.1f deg" % (f.round(3), math.degrees(math.asin(f[2]))))
P = (R @ Q.T).T

# ---------------------------------------------------------------- 2b drop the leg stub (oriented frame), straighten the head
stub = (P[:, 1] > 0.033) & (P[:, 1] < 0.060) & (P[:, 2] < -0.031)
log("leg stub cut: %d verts" % stub.sum())
me.vertices.foreach_set("co", P.astype(np.float64).ravel())
bm = bmesh.new()
bm.from_mesh(me)
bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(stub)[0]], context="VERTS")
edges = [e for e in bm.edges if e.is_boundary]
res = bmesh.ops.holes_fill(bm, edges=edges, sides=400)
bmesh.ops.triangulate(bm, faces=res["faces"])
log("filled %d holes after stub cut" % len(res["faces"]))
bm.to_mesh(me)
bm.free()
P = verts_np(me)
front = P[P[:, 1] < np.percentile(P[:, 1], 12)]
hc = front.mean(0)
bill0 = front[np.argmax(np.linalg.norm(front - hc, axis=1))]
NECK_Y = -0.072
neck = P[np.abs(P[:, 1] - NECK_Y) < 0.003]
pivot = np.array([(neck[:, 0].min() + neck[:, 0].max()) / 2, NECK_Y, (neck[:, 2].min() + neck[:, 2].max()) / 2])
dcur = bill0 - pivot
dcur /= np.linalg.norm(dcur)
BILL_DOWN = float(os.environ.get("BILL_DOWN", "8"))
dtar = np.array([0, -math.cos(math.radians(BILL_DOWN)), -math.sin(math.radians(BILL_DOWN))])
axis = np.cross(dcur, dtar)
full = math.asin(min(1.0, np.linalg.norm(axis)))
if np.dot(dcur, dtar) < 0:
    full = math.pi - full
axis /= np.linalg.norm(axis)
log("head re-pose: pivot %s, bill dir %s -> %s, %.1f deg" % (pivot.round(4), dcur.round(3), dtar.round(3), math.degrees(full)))
t = np.clip((P[:, 1] - (NECK_Y + 0.010)) / (-0.022), 0, 1)  # 0 behind the neck, 1 on the head
w = t * t * (3 - 2 * t)
Kx = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
newP = P.copy()
for k in np.nonzero(w > 0)[0]:
    th = full * w[k]
    Rk = np.eye(3) + math.sin(th) * Kx + (1 - math.cos(th)) * Kx @ Kx
    newP[k] = Rk @ (P[k] - pivot) + pivot
P = newP
# scale to a 20.5 cm bill-to-tail bird, origin at the body centre (wing-root region)
front = P[P[:, 1] < np.percentile(P[:, 1], 5)]
bill_tip = P[np.argmin(P[:, 1])]
tail_tip = P[np.argmax(P[:, 1])]
L = tail_tip[1] - bill_tip[1]
SC = 0.205 / L
body = P[(P[:, 1] > -0.06) & (P[:, 1] < 0.05)]
org = np.array([(body[:, 0].min() + body[:, 0].max()) / 2, 0.0, (body[:, 2].min() + body[:, 2].max()) / 2])
org[1] = (body[:, 1].min() + body[:, 1].max()) / 2
P = (P - org) * SC
log("scaled x%.4f (bill-tail %.4f -> 0.205 m), origin %s" % (SC, L, org.round(4)))

# head roll about the bill axis (found by diag_head_roll.py: mirror-symmetry minimum at +42 deg)
ROLL = float(os.environ.get("ROLL", "41"))
H = P[P[:, 1] < -0.062]
bill = P[np.argmin(P[:, 1])]
piv = np.array([H[:, 0].mean(), -0.055, H[:, 2].mean()])
ax = (bill - piv) / np.linalg.norm(bill - piv)
Kx = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
t = np.clip((P[:, 1] - (-0.050)) / (-0.016), 0, 1)
w = t * t * (3 - 2 * t)
for k in np.nonzero(w > 0)[0]:
    th = math.radians(ROLL) * w[k]
    Rk = np.eye(3) + math.sin(th) * Kx + (1 - math.cos(th)) * Kx @ Kx
    P[k] = Rk @ (P[k] - piv) + piv
log("head roll %.0f deg about the bill axis" % ROLL)

# ---------------------------------------------------------------- 3 landmarks
tail_tip = P[np.argmax(P[:, 1])]
front = P[P[:, 1] < np.percentile(P[:, 1], 12)]
# bill tip: farthest forward-and-up point from the head centroid
hc = front.mean(0)
log("head-region centroid %s" % hc.round(4))
d = front - hc
bill_tip = front[np.argmax(np.linalg.norm(d, axis=1))]
log("bill tip %s  tail tip %s  length %.4f" % (bill_tip.round(4), tail_tip.round(4), np.linalg.norm(bill_tip - tail_tip)))
# body profile along Y (top z, bottom z, half width) every 5 mm
for yy in np.arange(P[:, 1].min(), P[:, 1].max(), 0.006):
    s = P[(P[:, 1] >= yy) & (P[:, 1] < yy + 0.006)]
    if len(s):
        log("y %+.3f: z %+.4f..%+.4f  x %+.4f..%+.4f  n %d" % (yy, s[:, 2].min(), s[:, 2].max(), s[:, 0].min(), s[:, 0].max(), len(s)))
me.vertices.foreach_set("co", P.astype(np.float64).ravel())
me.update()
np.save(os.path.join(BLEND, "s1_landmarks.npy"), np.array([bill_tip, tail_tip, hc]))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND, "s1_scan_oriented.blend"))

# diag renders
sc = bpy.context.scene
gpu_cycles(sc, 16)
sc.view_settings.view_transform = "Standard"
overcast_world(sc, 1.0)
sun("key", (1, -1, 2), 2.0, (1, 0.95, 0.9))
lo, hi = P.min(0), P.max(0)
cc = Vector(((lo + hi) / 2).tolist())
ext = float((hi - lo).max()) * 1.1
for name, dd in {"side": (1, 0, 0), "top": (0, 0, 1), "front": (0, -1, 0), "below": (0, 0, -1)}.items():
    cam = new_cam("c" + name, cc + Vector(dd) * 1.0, cc, ortho=ext)
    if name == "top":
        cam.rotation_euler = (0, 0, 0)
    if name == "below":
        cam.rotation_euler = (math.pi, 0, 0)
    render_to(sc, cam, os.path.join(PREVIEW, "_s1_%s.png" % name), (700, 700))
log("done")
