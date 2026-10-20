# contact sheet: python sheet.py out.png cols label1=file1 label2=file2 ...  (each tile = full frame scaled to 1/2)
import sys
from PIL import Image, ImageDraw
out, cols, items = sys.argv[1], int(sys.argv[2]), [a.split('=', 1) for a in sys.argv[3:]]
ims = [(l, Image.open(f).convert('RGB')) for l, f in items]
w, h = ims[0][1].size; sc = float(sys.argv[0] and 0.5)
tw, th = int(w * sc), int(h * sc)
rows = (len(ims) + cols - 1) // cols
S = Image.new('RGB', (cols * tw + (cols + 1) * 6, rows * th + (rows + 1) * 6), (24, 24, 26))
d = ImageDraw.Draw(S)
for i, (l, im) in enumerate(ims):
    x, y = 6 + (i % cols) * (tw + 6), 6 + (i // cols) * (th + 6)
    S.paste(im.resize((tw, th), Image.LANCZOS), (x, y)); d.text((x + 6, y + 4), l, fill=(20, 20, 20))
S.save(out)
