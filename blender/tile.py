# -*- coding: utf-8 -*-
"""tiny PIL grid helper: python tile.py out.png cols scale img1 img2 ...  (system python, not Blender)"""
import sys
from PIL import Image

out, cols, scale = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
ims = [Image.open(p).convert("RGB") for p in sys.argv[4:]]
w = max(i.size[0] for i in ims)
h = max(i.size[1] for i in ims)
rows = (len(ims) + cols - 1) // cols
W = Image.new("RGB", (cols * w, rows * h), (30, 30, 30))
for k, im in enumerate(ims):
    W.paste(im, ((k % cols) * w, (k // cols) * h))
W = W.resize((int(W.size[0] * scale), int(W.size[1] * scale)), Image.LANCZOS)
W.save(out)
