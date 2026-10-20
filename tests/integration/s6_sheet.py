# Compose captures/signature_vs_reference.png: the reference's top two panels (left) next to the integrated page in
# the same framing (right): full frame on top, a 2.67x nearest-neighbour centre crop below (as in the reference).
# python -I tests/integration/s6_sheet.py
from PIL import Image, ImageDraw
import os
R = os.path.join(os.path.dirname(__file__), '..', '..')
ref = Image.open(os.path.join(R, 'models/preview/starling_v2_silhouette_flock.png')).convert('RGB')
page = Image.open(os.path.join(R, 'captures/i3_page_flock.png')).convert('RGB')
top = ref.crop((8, 48, 1288, 768)); mid = ref.crop((8, 776, 1288, 1496))
pw, ph = page.size
pg = page.resize((1280, int(ph * 1280 / pw)))
cw, ch = int(pw / 2.67), int(ph / 2.67)
crop = page.crop(((pw - cw) // 2, (ph - ch) // 2, (pw - cw) // 2 + cw, (ph - ch) // 2 + ch)).resize((1280, int(ch * 1280 / cw)), Image.NEAREST)
H = max(top.height, pg.height) + max(mid.height, crop.height) + 90
sheet = Image.new('RGB', (2 * 1280 + 30, H), (24, 25, 27))
d = ImageDraw.Draw(sheet)
d.text((10, 8), 'LEFT: reference (starling_v2_silhouette_flock.png, top two panels: 200 birds, ~30 m)', fill=(230, 230, 230))
d.text((1300, 8), 'RIGHT: integrated page, deterministic URL, watcher view, medium (30,720 birds, ~125 m), 1296x716 @ DPR 1', fill=(230, 230, 230))
y = 30
sheet.paste(top, (0, y)); sheet.paste(pg, (1310, y))
y += max(top.height, pg.height) + 30
sheet.paste(mid, (0, y)); sheet.paste(crop, (1310, y))
d.text((1300, y - 20), 'centre crop, 2.67x nearest (native pixels)', fill=(230, 230, 230))
sheet.save(os.path.join(R, 'captures/signature_vs_reference.png'))
print('saved captures/signature_vs_reference.png', sheet.size)
