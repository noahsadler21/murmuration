# -*- coding: utf-8 -*-
"""Find the head roll (about the bill axis) that makes the head mirror-symmetric about x=0."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
from mathutils.kdtree import KDTree

bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s1_scan_oriented.blend"))
P = verts_np(bpy.data.objects["scan"].data)
H = P[P[:, 1] < -0.062]
rng = np.random.default_rng(0)
H = H[rng.choice(len(H), min(4000, len(H)), replace=False)]
bill = P[np.argmin(P[:, 1])]
piv = np.array([H[:, 0].mean(), -0.055, H[:, 2].mean()])
ax = (bill - piv) / np.linalg.norm(bill - piv)
log("bill %s pivot %s axis %s" % (bill.round(4), piv.round(4), ax.round(3)))
Kx = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
best = None
for deg in range(-60, 61, 3):
    th = math.radians(deg)
    R = np.eye(3) + math.sin(th) * Kx + (1 - math.cos(th)) * Kx @ Kx
    Q = (R @ (H - piv).T).T + piv
    # symmetry plane x = bill x
    kd = KDTree(len(Q))
    for i, q in enumerate(Q):
        kd.insert(q, i)
    kd.balance()
    xm = bill[0]
    err = 0.0
    for q in Q[::4]:
        m = (2 * xm - q[0], q[1], q[2])
        err += kd.find(m)[2]
    err /= len(Q[::4])
    log("roll %+3d deg: mirror err %.5f" % (deg, err))
    if best is None or err < best[1]:
        best = (deg, err)
log("best roll %s" % (best,))
