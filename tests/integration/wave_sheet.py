# models/preview/page_agitation_wave.png from the three page_agitation_wave_{a,b,c}.png frames (python -I ...)
from PIL import Image, ImageDraw
import os
P = os.path.join(os.path.dirname(__file__), '..', '..', 'models', 'preview')
fr = [Image.open(os.path.join(P, f'page_agitation_wave_{k}.png')).convert('RGB') for k in 'abc']
w, h = 800, 450
sheet = Image.new('RGB', (3 * w + 40, h + 40), (24, 25, 27))
d = ImageDraw.Draw(sheet)
for i, (im, lab) in enumerate(zip(fr, ['at the strike (falcon in the flock)', '+0.6 s', '+1.5 s'])):
    sheet.paste(im.resize((w, h), Image.LANCZOS), (10 + i * (w + 10), 30))
    d.text((14 + i * (w + 10), 10), lab, fill=(230, 230, 230))
sheet.save(os.path.join(P, 'page_agitation_wave.png'))
print('saved', sheet.size)
