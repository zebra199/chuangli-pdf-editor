# 在 shots_round9.cjs 抓下来的截图上，按实测的面板边界画红框，
# 便于与用户手工标注的「图例1 / 图例2」直接对比面板宽度是否已一致。
# 用法：python shots_redbox.py
import json
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, '_shots')
with open(os.path.join(SHOTS, 'H-meta.json'), encoding='utf-8') as f:
    meta = json.load(f)

for src, dst in (('H1-竖版.png', 'H1-竖版-红框.png'), ('H2-横版.png', 'H2-横版-红框.png')):
    m = meta[src]
    im = Image.open(os.path.join(SHOTS, src)).convert('RGB')
    d = ImageDraw.Draw(im)
    # 与用户标注一致：贴着面板外缘画一圈粗红线
    pad = 2
    box = (m['bl'] - pad, m['bt'] - pad, m['br'] + pad, m['bb'] + pad)
    for i in range(4):
        d.rectangle((box[0] - i, box[1] - i, box[2] + i, box[3] + i), outline=(255, 0, 0))
    out = os.path.join(SHOTS, dst)
    im.save(out)
    print('{:<20} 面板宽 {:>4}px  x[{},{}]  ->  {}'.format(src, m['bw'], m['bl'], m['br'], dst))

a, b = meta['H1-竖版.png'], meta['H2-横版.png']
print('\n面板宽度：竖版 {}px ｜ 横版 {}px ｜ 差 {}px'.format(a['bw'], b['bw'], abs(a['bw'] - b['bw'])))
print('页面显示：竖版 {}×{} ｜ 横版 {}×{}'.format(a['imgW'], a['imgH'], b['imgW'], b['imgH']))
