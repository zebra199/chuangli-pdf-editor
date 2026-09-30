# -*- coding: utf-8 -*-
"""白底增强 · Python 参考实现（用于与 JS 逐像素交叉验证）

用法：python _dev/verify/final_ref.py
读取：verify/fixtures/扫描件样本.png（无损基准图）
输出：verify/.tmp/{in.json, in.rgba, ref_light.rgba, ref_standard.rgba}
      供 cross_verify.cjs 与 JS 实现比对。

此实现必须与 _dev/index.html 中的 enhanceCanvas 保持逐像素一致；
任何算法改动都要同步这里，再跑 cross_verify.cjs 确认最大差 ≤ 2。
"""
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "扫描件样本.png")
TMP = os.path.join(HERE, ".tmp")

ENH = {
    "light":    dict(GAMMA=1.00, WR=0.97, BR=0.30, C_LO=3.0, C_HI=14.0, C_BOOST=1.3, C_CAP=120.0),
    "standard": dict(GAMMA=1.30, WR=0.93, BR=0.30, C_LO=3.0, C_HI=14.0, C_BOOST=1.7, C_CAP=120.0),
}
FLOOR_K = 0.72


def enhance_array(d, W, H, level):
    """d: (H,W,4) uint8，就地修改并返回（与 JS 版逐像素对齐）"""
    P = ENH[level]
    flat = d.reshape(-1, 4)
    rgb = flat[:, :3].astype(np.float32).reshape(H, W, 3)
    gray = ((d[:, :, 0].astype(np.uint32) * 54
             + d[:, :, 1].astype(np.uint32) * 183
             + d[:, :, 2].astype(np.uint32) * 19) >> 8).astype(np.uint8)
    gf = gray.astype(np.float32)

    BLOCK = max(16, round(min(W, H) / 17))
    PCT = 90.0

    # Pass 0：全图纸面亮度（90 分位，隔像素抽样）→ 背景下限
    ghist = np.bincount(gray.ravel()[::2], minlength=256)
    gcum = np.cumsum(ghist)
    gP90 = int(np.searchsorted(gcum, ghist.sum() * 0.90, side="left"))
    BG_FLOOR = max(1.0, gP90 * FLOOR_K)

    # Pass 1：分块纸面估计
    bw, bh = int(np.ceil(W / BLOCK)), int(np.ceil(H / BLOCK))
    bm = np.zeros((bh, bw), dtype=np.float32)
    for by in range(bh):
        y1 = min((by + 1) * BLOCK, H)
        for bx in range(bw):
            x1 = min((bx + 1) * BLOCK, W)
            s = gray[by * BLOCK:y1:2, bx * BLOCK:x1:2].ravel()
            hist = np.bincount(s, minlength=256)
            val = int(np.searchsorted(np.cumsum(hist), s.size * PCT / 100.0, side="left"))
            bm[by, bx] = min(val, 255)

    # Pass 2：块级 3x3 最大值膨胀（越界跳过）
    bgB = np.zeros((bh, bw), dtype=np.float32)
    for by in range(bh):
        for bx in range(bw):
            mx = 0.0
            for dy in (-1, 0, 1):
                yy = by + dy
                if yy < 0 or yy >= bh:
                    continue
                for dx in (-1, 0, 1):
                    xx = bx + dx
                    if xx < 0 or xx >= bw:
                        continue
                    v = bm[yy, xx]
                    if v > mx:
                        mx = v
            bgB[by, bx] = mx

    # Pass 3：ratio → 亮度 查表
    RL = 1024
    k = np.arange(RL + 1, dtype=np.float32)
    t = np.clip((k / RL - P["BR"]) / (P["WR"] - P["BR"]), 0, 1)
    rlut = (np.power(t, P["GAMMA"]) * 255.0).astype(np.float32)

    # Pass 4：双线性上采样背景 + 逐像素映射
    ys = np.arange(H, dtype=np.float32)
    fy = np.clip(ys / BLOCK - 0.5, 0, bh - 1)
    y0 = np.floor(fy).astype(np.int32)
    y1 = np.minimum(y0 + 1, bh - 1)
    ty = (fy - y0).astype(np.float32)
    xs = np.arange(W, dtype=np.float32)
    fx = np.clip(xs / BLOCK - 0.5, 0, bw - 1)
    x0 = np.floor(fx).astype(np.int32)
    x1 = np.minimum(x0 + 1, bw - 1)
    tx = (fx - x0).astype(np.float32)

    TX = tx[None, :]
    TY = ty[:, None]
    b00 = bgB[np.ix_(y0, x0)]
    b01 = bgB[np.ix_(y0, x1)]
    b10 = bgB[np.ix_(y1, x0)]
    b11 = bgB[np.ix_(y1, x1)]
    bgv = (b00 * (1 - TX) + b01 * TX) * (1 - TY) + (b10 * (1 - TX) + b11 * TX) * TY
    bgv = np.maximum(bgv, max(BG_FLOOR, 1.0))

    ratio = gf / bgv
    ki = np.clip((ratio * RL).astype(np.int64), 0, RL)
    ng = rlut[ki]

    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    c = mx - mn
    w = np.clip((c - P["C_LO"]) / (P["C_HI"] - P["C_LO"]), 0, 1)
    w = w * w * (3 - 2 * w)
    sc = np.where(c > 1e-6, np.minimum(c * P["C_BOOST"], P["C_CAP"]) * w / np.maximum(c, 1e-6), 0.0)

    out = np.empty((H, W, 3), dtype=np.float32)
    for ch in range(3):
        out[:, :, ch] = np.clip(ng + (rgb[:, :, ch] - gf) * sc, 0, 255)
    res = np.rint(out).astype(np.uint8)

    res[ratio >= P["WR"]] = 255
    d[:, :, :3] = res
    return d


def feat(a):
    d = a.astype(np.float32)
    g = (d[:, :, 0] * 54 + d[:, :, 1] * 183 + d[:, :, 2] * 19) / 256.0
    red = (d[:, :, 0] - d[:, :, 1] > 30) & (d[:, :, 0] > 90)
    dark = g < 100
    return (f"均值={g.mean():6.1f} 纯白%={float((g>=250).mean()*100):5.2f} "
            f"深色%={float(dark.mean()*100):5.2f} 深色亮={g[dark].mean():5.1f} "
            f"红章%={float(red.mean()*100):5.3f} 红章R-G={float((d[:,:,0]-d[:,:,1])[red].mean()):5.1f}")


def main():
    os.makedirs(TMP, exist_ok=True)
    src = np.asarray(Image.open(FIXTURE).convert("RGB"))
    H, W = src.shape[:2]
    print(f"基准图 {os.path.basename(FIXTURE)} {W}x{H}  BLOCK={max(16, round(min(W,H)/17))}")
    print(f"原图      : {feat(src)}")

    rgba = np.dstack([src, np.full((H, W), 255, np.uint8)]).astype(np.uint8).copy()
    rgba.tofile(os.path.join(TMP, "in.rgba"))
    with open(os.path.join(TMP, "in.json"), "w") as f:
        json.dump({"W": W, "H": H}, f)

    for lvl in ("light", "standard"):
        a = rgba.copy()
        out = enhance_array(a, W, H, lvl)
        out.tofile(os.path.join(TMP, f"ref_{lvl}.rgba"))
        Image.fromarray(out[:, :, :3]).save(os.path.join(TMP, f"ref_{lvl}.png"))
        print(f"新算法[{lvl:8s}]: {feat(out[:, :, :3])}")

    print(f"\n输出目录: {TMP}")


if __name__ == "__main__":
    main()
