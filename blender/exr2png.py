# diagnostic: convert EXR captures to sRGB PNG previews.  blender -b -P exr2png.py -- in.exr out.png [scale] [noncolor]
import sys, bpy
import numpy as np
a = sys.argv[sys.argv.index("--") + 1:]
src, dst = a[0], a[1]
sc = float(a[2]) if len(a) > 2 else 1.0
nc = len(a) > 3 and a[3] == "noncolor"
im = bpy.data.images.load(src)
w, h = im.size
px = np.empty(w * h * 4, np.float32)
im.pixels.foreach_get(px)
px = px.reshape(h, w, 4)
rgb = px[..., :3]
if not nc:
    rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(np.clip(rgb, 0, None), 1 / 2.4) - 0.055)
al = px[..., 3:4]
bg = np.array([1.0, 1.0, 1.0])
rgb = rgb * al + bg * (1 - al)
out = bpy.data.images.new("o", w, h, alpha=False)
out.colorspace_settings.name = "Non-Color"
full = np.ones((h, w, 4), np.float32)
full[..., :3] = np.clip(rgb, 0, 1)
out.pixels.foreach_set(full.ravel())
if sc != 1.0:
    out.scale(int(w * sc), int(h * sc))
out.filepath_raw = dst
out.file_format = "PNG"
out.save()
print("wrote", dst)
