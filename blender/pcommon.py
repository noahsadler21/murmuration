# -*- coding: utf-8 -*-
"""Shared helpers for the peregrine pipeline (p0..p6). Same frame as the starling (mcommon.py): metres, head -Y,
back +Z, the bird's left wing +X; the GLB export converts to glTF (+Z head, +Y back, +X left wing)."""
import os, sys, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcommon
from mcommon import *

OUTP = os.path.join(ROOT, "models", "out", "peregrine")
ASSETS = os.path.join(ROOT, "assets", "birds")
os.makedirs(OUTP, exist_ok=True)
os.makedirs(ASSETS, exist_ok=True)


def plog(msg):
    print("[peregrine %6.1fs] %s" % (time.time() - T0, msg))
    sys.stdout.flush()


# ---------------------------------------------------------------- captures (p2) and atlas layout (p3/p4)
# Orthographic captures of the cleaned scan, CAP_PPM px per metre, covering x in [-CAP_HX, CAP_HX] and
# y in [CAP_Y0, CAP_Y1]. Pixel (col, row) from the top-left of the stored (top-down) array:
#   top    : col = (x + CAP_HX) * ppm,  row = (CAP_Y1 - y) * ppm      (image up = +Y = tail)
#   below  : col = (x + CAP_HX) * ppm,  row = (y - CAP_Y0) * ppm      (image up = -Y = head)
CAP_PPM = 8000.0
CAP_HX = 0.080
CAP_Y0, CAP_Y1 = -0.145, 0.275


def cap_px(which, x, y):
    col = (x + CAP_HX) * CAP_PPM
    row = (CAP_Y1 - y) * CAP_PPM if which == "top" else (y - CAP_Y0) * CAP_PPM
    return col, row


# Atlas (fractions of a square atlas; layout given at 2048, rows from the top):
#   body loft  : cylindrical unwrap, cols 8.. , rows 8.., BODY_PPM px per metre (seam along the back midline)
#   dorsal cap : the top capture, x in [-CAP_HX, CAP_HX], y in [REG_Y0, REG_Y1], rotated: atlas col <- y, row <- x
#   ventral cap: the below capture, same crop and rotation, under the dorsal one
A = 2048.0
BODY_PPM = 3100.0                              # body band: rows 8 .. ~800 (y), cols centred on 1024 (arc)
BODY_ROW0, BODY_COLC = 8.0, 1024.0
REG_HX = 0.068                                 # capture crop for the atlas: x in [-REG_HX, REG_HX]
REG_Y0, REG_Y1 = -0.100, 0.275
REG_PPM = 4400.0                               # 1650 x 598 px per region at 2048
REG = {"top": (40.0, 805.0), "below": (40.0, 805.0 + 2 * REG_HX * REG_PPM + 10.0)}   # (col0, row0) at 2048


def reg_uv(which, x, y):
    """UV (Blender, v up) of the world point (x, y) seen in the `which` capture region of the atlas"""
    c0, r0 = REG[which]
    y = min(max(y, REG_Y0 + 0.0004), REG_Y1 - 0.0004)
    x = min(max(x, -REG_HX + 0.0004), REG_HX - 0.0004)
    col = c0 + (y - REG_Y0) * REG_PPM
    xx = x if which == "top" else -x       # the ventral capture is mirrored (seen from below)
    row = r0 + (REG_HX - xx) * REG_PPM
    return (col / A, 1.0 - row / A)


def reg_world(which, col, row):
    """inverse of reg_uv in atlas pixels at 2048 (top-down rows): (x, y) world"""
    c0, r0 = REG[which]
    y = REG_Y0 + (col - c0) / REG_PPM
    xx = REG_HX - (row - r0) / REG_PPM
    return (xx if which == "top" else -xx), y


def reg_rect(which):
    c0, r0 = REG[which]
    return c0, r0, c0 + (REG_Y1 - REG_Y0) * REG_PPM, r0 + 2 * REG_HX * REG_PPM
