# _dev 目录说明（开发资料，非交付物）

> ⚠️ 这个目录**不需要拷到其他电脑**。交付物只有根目录的 `创立PDF编辑器.html`。
> 本目录仅用于后续修改代码、重新打包与回归验证。

## 为什么有两个 HTML？

| 文件 | 角色 | 能否双击使用 | 依赖 |
|---|---|---|---|
| 根目录 `创立PDF编辑器.html` | **交付物**（构建产物） | ✅ 可以，拷走即用 | 无（库全部内联） |
| `_dev/index.html` | **开发源码** | ⚠️ 可以，但必须在 `_dev/` 内 | `_dev/lib/` 三个库 |

- 两者是**同一份应用代码**：`_dev/index.html` 里的应用脚本与交付物内的脚本
  **逐字节一致**（可用 `_dev/build_single.cjs` 重建验证）。
- 保留两份的原因：交付物内联了约 3.2MB 压缩过的第三方库，直接在交付物上改代码
  既不可读也易出错；改代码必须改 `_dev/index.html`，再一起打包。
- 所以：**日常使用只用根目录的 `创立PDF编辑器.html`**；
  要改功能才进 `_dev/`。

## 目录结构

```
_dev/
├── index.html         开发版主文件（改这里）
├── lib/               第三方库（供开发版引用、供打包内联）
│   ├── pdf-lib.min.js
│   ├── pdf.min.js
│   ├── pdf.worker.min.js
│   └── heic2any.min.js
├── build_single.cjs   打包脚本：内联全部库 → ../创立PDF编辑器.html
├── docs/              设计文档与历史记录
│   ├── 白底增强算法-设计说明.md      ← 算法原理、参数、取舍（改算法前必读）
│   ├── 合并分析-*.md                 参考项目审计 / 统一架构 / 统一画质
│   ├── 合并实施-画质口径锁定.md
│   ├── 界面风格规范.md
│   └── 任务交接.md
├── verify/            回归验证脚本
│   ├── fixtures/                     无损测试基准图（扫描件样本.png）
│   ├── final_ref.py                  Python 参考实现（算法基准）
│   ├── cross_verify.cjs              JS ↔ Python 逐像素一致性
│   ├── edge_test.cjs                 边界/鲁棒性
│   ├── portable_test.cjs             隔离目录便携性实测
│   ├── ux_test.cjs                   交互功能：导入骨架屏 / 重复投放拦截 / 拖拽插入位
│   ├── ux_geom.cjs                   交互相素与几何核对
│   ├── ux_pdf_test.cjs               真实多页 PDF 的占位展开测试
│   ├── ux_shots.cjs                  生成界面截图（供人工比对）
│   ├── per_page_test.cjs             单页覆盖设置回归（预览内画质/增强）
│   ├── overlay_test.cjs              叠加层回归（水印/页码/马赛克/高亮/文本框/撤销重做/导出）
│   ├── select_edit_test.cjs          标注选中后重新编辑（选中/移动/调边框/删除/双击改字/透明底色）
│   ├── pagenav_test.cjs              预览内左右翻页（按钮在白色面板外/显隐/禁用/不退出预览/方向键/不串页）
│   ├── imgfit_test.cjs               图片页版面：默认触边放大、版面尺寸与 DPI 解耦、缩放/拖拽/撤销
│   ├── swatch_test.cjs               常用色色板：三处选色器自动注入、点选生效/持久化、改色可撤销
│   ├── brush_test.cjs                画笔：绘制/颜色/粗细/命中/移动/删除撤销/禁缩放四条防线（26 项）
│   ├── preview_width_test.cjs        预览面板宽度恒定：横竖版/翻页/旋转/两视口/两工具条文案
│   ├── estimate_test.cjs             体积预估精度：预估 vs 真实导出，要求误差 ≤15%（8 项，含「确已实测校准」）
│   ├── est_race_test.cjs             预估采样竞态：采样在飞时切档位必须自动补跑，不能永久卡「测算中」
│   ├── estimate_probe.cjs            预估探针（非断言）：对任意样本打印 4 档「预估 / 实际 / 偏差」对照表
│   ├── shots_annot.cjs               生成标注选中/透明底色/翻页按钮效果截图到 _shots/
│   ├── shots_brush.cjs               画笔截图：三色三粗细全貌 + 选中态（虚框无控制点）
│   ├── final_accept.cjs              交付物最终验收（隔离目录 + 新功能）
│   ├── _edge.cjs                     无头浏览器生命周期（唯一 profile + 自动空闲端口）
│   ├── run_legacy.cjs                串行跑不自启浏览器的旧套件（共享一个实例，端口走 EDGE_PORT）
│   └── _shots/                       运行时生成的截图目录（脚本会 mkdir 重建，不随仓库留存）
├── test/              只留 3 个小样本 PDF（测试文件A / 说明书B / 扫描图片C，共 3.6KB）
└── lib/               构建时内联进单文件的第三方库
```

> 仓库瘦身（2026-09-29）：21 个 `.bak-*` 备份、`_shots/` 截图（8MB）、`test/` 里的两个大样本
> （季度报告 4.3MB、扫描件合集 12.7MB）已删除，共腾出约 63MB。
> **回归脚本与其依赖的小样本全部保留**，所以 `node brush_test.cjs` 等一键回归照旧可用。
> 注意：大样本删了之后 `estimate_probe.cjs` 的默认值已改成 `fixtures/扫描件样本.png`
> （原来默认指向 `test/扫描件合集.pdf`）；`ux_pdf_test.cjs` 取 `test/` 下第一个 PDF，不受影响。
> `shots_redbox.py` 依赖 `_shots/` 里的图做输入，需要先跑 `shots_round9.cjs` 生成再执行。

## 叠加层（Overlay）模块速查

`_dev/index.html` 中相关代码块：搜索 `叠加层（Overlay）` 即可定位。

| 关注点 | 位置 / 函数 |
|---|---|
| 数据模型 | `state.overlay`（水印/页码，全局）与 `page.ops`（马赛克/高亮/文本框，单页）|
| 归一化坐标 | op 一律存最终版面的 0~1 相对坐标；字号以 pt 存储，绘制时按 `k = Hpx / ptH` 换算 |
| 统一绘制入口 | `drawOps(ctx, page, W, H, meta)` → 水印 → 单页 ops → 页码；op 类型 `mos` 马赛克 / `br` 画笔 / `hl` 高亮 / `tx` 文本框 |
| 画笔 | op = `{ t:'br', c:颜色, lw:线宽(相对页宽的比值), pts:[[x,y],…] }`；另维护 `x/y/w/h` 包围盒，命中/选中框/移动直接复用矩形那套 —— **但缩放不适用**，见下方专门说明 |
| 画笔几何 | `updateBrushBounds()`（包围盒要把线宽算进去，否则细笔点不中）· `hitBrush()`/`distToSeg()`（按「靠近笔迹」命中，不是落包围盒）· ~~`scaleBrush()`~~ **已删除**（禁用缩放后成死代码）|
| 三分辨率接入 | `buildPreviewSrc`（预览）、`makeThumbFromOps`（缩略图）、`exportImagePage`/`exportPdfPage`（导出）|
| 强制栅格 | `pageNeedsRaster(page)`；矢量分支与 `passthroughFile()` 都据此判断 |
| 编辑交互 | `bindEditLayer()` IIFE + `#pvOverlay` canvas（只画选中框/绘制框/控制点，成品由 `drawOps` 重渲染）|
| 选中与再编辑 | `hitOp`（命中标注）· `handlePoints`/`hitHandle`/`resizeRect`（8 个控制点缩放）· `selOp`（当前选中项）|
| 属性面板 | `syncSelProps()`（选中项的值回填到颜色/大小控件）· `applyPropToSel()`（连续 input 只推一次历史）|
| 文本框就地编辑 | `openTextEditor()` / `hideTextEditor(keep, noSwitch)`；`noSwitch` 用于调用方自己要切工具时，避免递归反切 |
| 预览翻页 | `previewIndex()`（当前页序号）· `gotoPage(delta)`（切页前先收文本框 + 重置缩放）· `updatePvNav()`（首末页禁用/单页隐藏）· `positionPvNav()`（按 `.box` 矩形定位到**白色面板之外**）|
| 图片页版面 | `planForImage(page,q,s)` 算出 `{pageW,pageH,drawWpt,drawHpt,offX,offY,targetW,targetH}` —— **版面尺寸（pt）只由 fit 规则决定，targetW/H（px）只决定画布精细度，两者必须解耦** |
| 图片页渲染链 | `renderImageCanvas()`（内容 canvas）→ `composeImagePage(plan,cv,maxW)`（摆放+合成）→ `imagePageCanvas()`（预览/缩略图/导出共用）|
| 图片手动摆放 | `page.imgAdj={s,dx,dy}`（缩放入页面宽度比 · 偏移）· `clampImgAdj()`（保证至少一条边贴边）· `imgLive` 缓存 + `imgSig()` 指纹失效 · `liveImgPreview()`（拖拽逐帧复用内容 canvas）|
| 撤销重做 | `snapshotState()` / `pushHistory()` / `restoreSnapshot()`（files 与 thumbCache 存引用副本）|
| 图片页预览画质 | `buildPreviewSrc()` 图片分支：`imagePageCanvas(page, 0, q.dpi ? q : QUALITY['q-high'])` —— **跟随档位**渲染，矢量保真档无 dpi 时按 300 预览 |
| 画质档位联动 | `#qualitySel` 的 `change` 监听里必须补 `syncPreviewTools(pv)` + `refreshPreviewOps(pv)`，否则全局改档位时**预览不重渲染**（图片页表现就是切档位毫无变化）|
| 面板宽度 | `lockPreviewWidth()`：`box.style.width` **只由视口决定**（78vw，再受 94vw 与翻页按钮留位约束），与页面横竖版 / 工具条文案全部解耦 |
| 舞台显示尺寸 | `layoutSheet()`：纯 contain `s = min(sw/nW, shg/nH)`，长边贴边。**不要为了"面积对齐"给横版加宽度上限**——那会把横版 A4 压小 |

> ⚠️ **预览面板的纵向开销必须实测，不能写常数**。`.stage` 的高度是 `min(74vh, 94vh - var(--pvc))`，
> `--pvc` 由 `lockPreviewWidth()` 实测「说明 + 单页工具条 + 标注工具条 + 内边距」后写入 `box.style`。
> 早期写死 `175px`，一旦工具条变高（如新增色板行导致换行），舞台就让不出空间，
> 底部的「删除/撤销/重做」会被挤出面板看不见。**任何改变工具条高度的功能都要靠这条自动适配。**
> 注意顺序：`lockPreviewWidth()` 必须在 `setTool()` / `updateEdNote()` **之后**再调一次
> （`openPagePreview` 里就是这么做的），否则量到的是工具条定稿前的高度。

> ⚠️ **图片页版面最易踩的坑**：不要把「版面物理尺寸」和「渲染像素」混为一谈。
> 早期写成 `drawWpt = targetW * 72 / effDpi`（由 DPI 反推物理尺寸），结果是 300 DPI 预览里图片只占
> A4 宽的 43%，而 150 DPI 导出占 87% —— 预览/缩略图/导出三处大小完全对不上。
> 正确做法见上表 `planForImage`：fit 决定 `drawWpt/drawHpt`，`pxPerPt = dpi/72` 只用来算 `targetW/H`。

> ⚠️ **「横竖版看起来不一样」要找对层：面板宽度 ≠ 页面显示尺寸。走错一层会白改还改坏。**
>
> 用户报过两次，第一次理解成「横版页显示的太大」，于是在 `layoutSheet()` 里加了宽度上限
> `maxW = 舞台高度`，把横版 A4 从 ~990×700 压到 642×454，**横竖版显示面积拉成了相等**。
> 但这不是用户要的 —— 他要的是**面板宽度一致**，横版页本来就该宽而矮。已被要求恢复原样。
>
> 真正的原因在 `lockPreviewWidth()`：旧公式把「当前页按宽高比需要的宽度」也掺进了盒子宽度
> ```
> stageMax = max(300, min(avail, max(fitW×2.4, stageH×0.95)))   // fitW = stageH × 页面宽高比
> box.style.width = min(94vw, vw-navReserve, stageMax+chrome, max(wantW+chrome, toolsW+chrome, 78vw))
> ```
> 横版 A4 ratio=1.414 → fitW≈990 → `stageMax+chrome` 够大，被 78vw 限住 = 1491；
> 竖版 A4 ratio=0.707 → fitW≈495 → `stageMax+chrome`≈1378 反而成了**最紧的约束**。
> 于是同一窗口下横版 1491 / 竖版 1378，红框量出来差 115px。
>
> 修法：盒宽只由视口决定，`fitW / stageMax / wantW / toolsW` 四个量全部删掉。
> 顺带也解决了「下拉选中项文字变长变短 → 盒子宽度跟着抖」的老问题（`toolsW` 就是这么来的）。
>
> 守护用例：`preview_width_test.cjs`（10 项，含逐页翻页、旋转、两种视口、两种工具条文案）。

> ⚠️ `#pvOverlay` 的 `pointer-events` 只在 `.pv-sheet.editing` 下放开，而 `.editing` 由 `setTool()` 恒定添加。
> 早期版本写成 `toggle('editing', tool !== 'select')`，导致切到「选择」时点击被 `<img>` 吃掉、
> 标注永远选不中 —— 改动这里务必确认 select 模式下 `pointer-events` 仍是 `auto`。

> 新增一种叠加元素时：① 在 `drawOps` 里加绘制分支；② op 结构用归一化坐标 + pt 字号；
> ③ 导出/预览/缩略图三处都调用同一个 `drawOps`，不要各写一套。
> ④ 非矩形的元素（如画笔）也要补 `x/y/w/h` 包围盒，才能白捡「选中 / 移动 / 删除」一整套交互。
> （画笔**故意不要**「缩放」——包围盒只用于命中、选中虚框和整体平移，见上文四条防线。）

> ⚠️ **画笔移动必须按「起点 → 当前指针」整体平移，不能按 `op.x` 逐帧递推**。
> 递推会把每帧的位移累积进去，笔画越拖越偏。现在在 mousedown 时记下 `sx/sy/bx0/by0/bw0/bh0/pts0`，
> 每帧用 `pts0` 重新算一遍，天然无漂移。
>
> ⚠️ 画笔按下时先判 `hitHandle` 再判命中：扁笔画的包围盒很矮，8 个控制点紧贴笔迹，
> 拿笔迹上的点去按很容易误命中控制点（变成缩放而不是移动）。这是**既有行为**（矩形标注也一样），
> 但写测试时要挑离控制点足够远的按下点，否则会测出「移动后形状变了」的假失败。
> （注：现已禁用画笔缩放，这条只对高亮 / 文本框 / 马赛克仍然成立。）

> ⚠️ **画笔笔迹不支持缩放，是硬约束，不是"暂时没做"**。用户明确要求：选中笔迹后只能
> **删除 / 撤销重做 / 换颜色 / 拖动**，不提供「改粗细」，也不允许拉边框缩放。
> 四条防线缺一不可 —— 只堵一条，另三条里随便哪条都能把笔迹改变形：
>
> | 防线 | 位置 | 做法 |
> |---|---|---|
> | ① 命中不了控制点 | `hitHandle()` | `if (… \|\| o.t === 'br') return null;` 恒 null → 按下必然落到 `hitOp` 走「移动」|
> | ② 不画控制点 | `drawOverlayLayer()` | `if (o.t !== 'br') handlePoints(o).forEach(…)` → 只留虚框表示"已选中"，画了控制点就是误导 |
> | ③ 没有缩放代码 | `mousemove` 的 `resize` 分支 + `scaleBrush()` | 分支里只写 `op.x/y/w/h = r.*`，函数整体删除 —— **不留死代码，不留将来被误打开的口子** |
> | ④ 面板不露滑条 | `syncSelProps()` | 命中 `op.t === 'br'` 时 `#edSizeWrap` 整组 `display:none`；`edSize` 的 `input` 处理里**没有** br 分支 |
>
> 配套语义：工具条的「大小」滑条只在**下笔前**有意义（`state.edit.brW` 决定下一笔粗细）。
> 选中笔迹时整组隐藏 → 想改粗细就点回「画笔」按钮重画一笔，选中态清掉、滑条自动回来。
> 注意 ③ 之后 `scaleBrush()` 已不存在，`grep scaleBrush` 只应命中注释。
>
> 守护用例：`brush_test.cjs` ⑫⑬⑰⑱（隐藏大小组 / 强改也改不动 / `hitHandle` 为 null / 拉边框尺寸粗细都不变）。

> 📌 **截图脚本的坑**：`shots_brush.cjs` 里画完一笔时 `mouseup` 会自动 `setTool('select')`
> 并选中刚画的笔迹（`state.edit.sel = page.ops.length - 1`）。所以拍「三笔干净全貌」之前
> **必须先 `sel = -1` 再 `drawOverlayLayer()`**，否则 I1 本身就带选中框，和 I2 拍出来字节完全一样。
> 脚本末尾已加 `I1/I2` 文件 `equals()` 断言，避免再拍出两张相同的图。

> ⚠️ **`applyPropToSel()` 里快照必须在 `mut(op)` 之前推**。历史快照走 `JSON.stringify(state.pages)`，
> 若先 `mut` 再 `pushHistory`，快照里存的就是**改后**的值，撤销等于没撤（这个坑真实存在过）。
> 现写法：`prev = JSON.parse(before)` → `mut` → 若变了且 `!edPropDirty` 则「临时还原 → pushHistory → 写回新值」，
> 既保证快照是旧值，又保持「连续拖动/连续点击只算一次撤销步骤」。

## 常用色快捷色板

三处选色器（水印 `#wmColor` / 页码 `#pnColor` / 标注工具条 `#edColor`）下方各有一行经典色。

| 关注点 | 位置 / 函数 |
|---|---|
| 色表 | `SWATCH_COLORS`（12 色：黑/白/浅灰/深灰/红/橙/黄/绿/青/蓝/紫/粉）|
| 注入 | `buildSwatches()` —— 启动时遍历**所有** `input[type=color]`；在 `<label>` 里（竖排设置卡）插到 label **之后**独占一行，否则（横排工具条）插到 input **之后**即选色器**右侧**；**以后新增选色器无需改代码，自动生效** |
| 点选 | 只做 `input.value = 色值` + 派发 `input` **和** `change` 两个事件（水印/页码监听 change、标注工具条监听 input），下游零改动 |
| 选中态 | `markSwatchOn(input)` 按 value 匹配 `.on` 类；`setTool()` 与 `syncSelProps()` 里**直接赋值 `edColor.value` 的地方必须补调一次**，否则高亮框不同步 |
| 样式 | `.swatches .swc`（16×16、白块有 1px 描边不会在白底消失）；工具条内缩到 14×14、gap 3 |
| 马赛克 | 马赛克取原图区域、无颜色概念 → `syncSelProps()` 里把 `#edColorWrap` 整组 `display:none`（有选中项时按 op 类型判，无选中时按工具判）|

> 色板放在 `<label class="sl">` **外面**（作为兄弟节点）：`.scard label` 是 flex，且点 label 会触发
> 原生 color picker，塞进去会出现「点色块却弹出色轮」。

## 改代码后的标准流程

```bash
# 1. 改 _dev/index.html
# 2. 重新打包
node _dev/build_single.cjs

# 3. 回归验证（改过白底增强算法时必跑 3.1–3.3）
cd _dev/verify
python final_ref.py          # 3.1 生成参考基准（需 uv + numpy + pillow）
node cross_verify.cjs        # 3.2 JS 与 Python 一致性：要求最大差 ≤ 2
node edge_test.cjs           # 3.3 边界/鲁棒性：要求全绿
node ux_test.cjs             # 3.4 导入骨架屏 / 重复投放拦截 / 拖拽插入位
node ux_geom.cjs             # 3.5 交互几何与像素核对
node ux_pdf_test.cjs         # 3.6 真实多页 PDF 的灰格展开
node per_page_test.cjs       # 3.7 单页覆盖设置 + 预览缩放（滚轮/滑条/导航图）+ 卡片无条纹 + 预览框宽度锁定与放大（24 项）
node overlay_test.cjs        # 3.8 叠加层回归：水印/页码三档位置、旋转不漂移、排序重编号、马赛克/高亮/文本框、撤销重做、导出接入（25 项）
node select_edit_test.cjs    # 3.8b 标注选中后重新编辑：选中/移动/调边框/删除/双击改字/文本框透明底色（21 项）
node pagenav_test.cjs        # 3.8c 预览内翻页：按钮在白色面板外、显隐与禁用、不退出预览、方向键、翻页不串页（22 项）
node brush_test.cjs          # 3.8c-2 画笔：按钮/颜色/粗细/绘制像素/缩略图/改色/移动/删除撤销/栅格化/禁缩放四条防线（26 项）
node shots_brush.cjs         # 3.8c-3 画笔人工确认截图：三色三粗细全貌 + 选中态（虚框无控制点）→ _shots/
node preview_width_test.cjs  # 3.8d-0 预览面板宽度恒定：横竖版/翻页/旋转/两种视口/两种工具条文案（10 项）
node imgfit_test.cjs         # 3.8d 图片页版面：默认触边放大、版面尺寸与 DPI 解耦、缩放/拖拽/撤销、导出像素、预览随档位变化（21 项）
node swatch_test.cjs         # 3.8e 常用色色板
node shots_round8.cjs        # 3.8g 人工确认截图：竖版 / 横版 / 精简档预览 → _shots/
node shots_round9.cjs && python shots_redbox.py   # 3.8h 1912×948 视口抓图并按面板边界画红框（对比面板宽度）
node estimate_test.cjs       # 3.8f 体积预估精度：预估 vs 真实导出，误差 ≤15%（图片页 + PDF 页 + 混合文档）
node est_race_test.cjs       # 3.8f-2 预估采样竞态：采样在飞时切档位必须自动补跑，不能永久卡「测算中」
node estimate_probe.cjs "../test/某文件.pdf"   # 对任意样本打印 4 档预估/实际对照表（校准用）：三处选色器注入、点选生效、持久化、选中标注改色可撤销（17 项）
node final_accept.cjs        # 3.9 交付物最终验收（隔离目录，最接近真实拷贝）
```

3.4–3.6 与 3.9 这几个**不自启浏览器**的旧套件，端口写死过 9333，现已改为读 `EDGE_PORT`；
用 `run_legacy.cjs` 一次串行跑完（它会起一个带唯一 profile + 空闲端口的共享实例）：

```bash
node run_legacy.cjs                      # 默认跑 ux_test / final_accept / ux_geom / ux_pdf_test / portable_test
node run_legacy.cjs final_accept.cjs     # 也可只指定某几个
```

> ⚠️ **新写/迁移旧脚本时，端口必须读 `EDGE_PORT`**（`+(process.env.EDGE_PORT || 9333)`）。
> `ux_test.cjs` 就因为漏改这一处、写死 9333，被 `run_legacy.cjs` 带跑时直接 `ECONNREFUSED`，
> 而且因为它不在默认清单里，这个问题藏了很久才发现。

> ⚠️ **测「导入骨架屏」必须给 `window.toBitmap` 打桩加延迟**。测试图是纯色 PNG，
> 解码只要几毫秒，骨架帧一闪而过，25ms 采样根本抓不到 → 误报「骨架卡数量 0」。
> 打桩后还要**轮询 `state.importing` 等收尾**，不能定长等待（三张图各 1.5s 桩，
> 定长 1500ms 会在中途收尾，导致「骨架未清除 / 只导入 1 页」的连锁假失败）。
> 原函数只留一份 `window.__origToBitmap` 且**不要删除**，否则后续用例再套一层桩会拿到 `undefined`。

`per_page_test.cjs` 与 `overlay_test.cjs` 默认验证 `_dev/index.html`；要验证打包产物（单文件）可传路径：

```bash
node per_page_test.cjs "C:/…/创立PDF编辑器.html" 9333
node overlay_test.cjs  "C:/…/创立PDF编辑器.html" 9333
```

需要真实浏览器的脚本会通过 CDP 驱动无头 Edge。现在的做法是**脚本自启自管的专属实例**，
不需要手工预先启动：每次运行都会自动挑选空闲端口，并配一个唯一的 `--user-data-dir`。

```bash
node overlay_test.cjs                      # 直接跑，实例自动起、跑完自动回收
node overlay_test.cjs "C:/…/创立PDF编辑器.html" # 验证打包产物（第二个参数省略端口）

msedge --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\edge-dev --no-first-run --disable-gpu
node overlay_test.cjs "" 9333              # 也支持连已有的调试实例
```

> ⚠️ 之所以必须「每实例唯一 profile + 空闲端口」：多个 Edge 共用同一个 `--user-data-dir` 时，
> 先到的进程会持有 `SingletonLock`，后续进程的 `--headless` / `--remote-debugging-port` 会被忽略，
> 表现为「进程起来了但端口连不上」。固定端口（如 9333）在多任务并发时同样会撞。
> 这两条由 `verify/_edge.cjs` 统一处理，新写脚本直接 `require('./_edge.cjs').ensure(端口)` 即可。

> 注意：file:// 下 localStorage 按 null origin 共享，同一 `--user-data-dir` 里跑多个脚本会互相污染设置。
> `overlay_test.cjs` 已在开头 `localStorage.clear()`；新写脚本时建议照做。

> ⚠️ **测试里要显式设视口**，否则 headless 默认窗口很窄（约 800px），会命中 `@media (max-width:1080px)`
> 的响应式分支，把元素尺寸量小。`pagenav_test.cjs` 里用
> `Emulation.setDeviceMetricsOverride({width:1440,height:900})` 对齐常见桌面视口 ——
> 不设的话翻页按钮会量成 44×88，看起来像"改错了"。

> ⚠️ 用 `.bak-*` 后缀的备份文件跑测试时，**先复制成 `.html`**：Chromium 对未知扩展名会当成下载处理，
> 页面根本不会渲染，`$ is not defined` 就是这么来的。

## 备份与归档

改代码前会在两处各留一份带日期后缀的备份（`创立PDF编辑器.html.bak-<日期>` 与 `_dev/index.html.bak-<日期>`），
便于随时回退。历史归档目录 `_bak_archive/` 已于 2026-09-28 按用户确认**删除**（18 个文件 / 35MB）；
当前保留 `*.bak-20260928b`~`f`、`*.bak-20260929a`、`*.bak-20260929b`（每轮改动前各留一份，
含 `创立PDF编辑器.html` 与 `_dev/index.html` 成对），确认稳定后可继续清理。

> 站规：**改前先在同路径复制一份备份，源文件不动**。
> - `*.bak-20260929a` = 第八轮（图片预览跟随档位 / 横竖版显示面积）改动前
> - `*.bak-20260929b` = 第九轮（面板宽度恒定 / 恢复横版 A4 尺寸）改动前
>
> `_dev/index.html.bak-*` 也可用反向补丁重建：源码中如果已经改完来不及先备份，
> 就写一个 `(from, to)` 反向替换脚本、校验每处只匹配 1 次后再落盘，
> 比手工回退可靠（第九轮就是这么拿到干净回滚点的）。

> 本机**无法用回收站删文件**：PowerShell 的 `Add-Type`（加载 `Microsoft.VisualBasic` 走
> `SendToRecycleBin`）和 `New-Object -ComObject Shell.Application` 都被安全策略拦掉，
> 只剩 `Remove-Item` 这种永久删除。所以清理备份首选「移动到归档目录、确认无需回退后再整体删除」，
> 比直接删当前文件稳妥。

## 体积预估（不再用固定 bytesPerPixel）

| 关注点 | 位置 / 函数 |
|---|---|
| 唯一渲染出口 | `pageRasterJpeg(page, q)` → `{jpg, pageW, pageH, px}`；**导出与预估共用**，所以预估口径必然等于导出口径 |
| 落页 | `embedRasterPage(outDoc, page, q)`；`exportImagePage` / `exportPdfPage` 都只调它 |
| 预估 | `estimateBytes()`（同步，矢量页均摊 + 栅格页按 bpp）· `runEstSample()`（异步采样至多 3 页）· `paintEstimate()`（只画界面）· `updateEstimate()` = paint + `scheduleEstSample()`（350ms 防抖）|
| 缓存签名 | `currentEstSig()` = 档位 + 增强 + overlay + 每页(uid/rot/镜像/单页设置/标注数/图片缩放)；变了才重采样 |

> ⚠️ **采样必须按【来源文件】分组，每组各自算系数**（`key = 档位 + '|' + page.fileId`）。
> 图片页没有 DPI 封顶、PDF 页有（源图分辨率不足时导出会降 DPI），两类页的系数能差 **13 倍**。
> 混在一起用一套系数外推，混合文档（图片 + PDF）就会系统性高估 1.3~1.6 倍
> （用户实测：高清 3.13/2、标准 1.64/1.1、精简 1.03/0.79）。
> 取样策略：每个文件先取中间那页，页多的文件再补一页，总上限 `EST_SAMPLE_MAX = 4`。

> ⚠️ **`estBpp` 只保留本次采样结果，不要 `Object.assign` 累加旧值**。
> 清空重导后 `fileId` 会复用，旧 key 会让某一组拿到别组的陈旧系数（曾导致混合文档低估到 ×0.24）。

> ⚠️ 系数组成为 `{ bpp, ratio }`：`bpp = 字节 / 实际像素`，`ratio = 实际像素 / 估算像素(estRasterPx)`。
> 外推时 `estRasterPx(page) × ratio × bpp`。ratio 用来吸收 DPI 封顶等「估算像素 ≠ 实际像素」的差异。

> ⚠️ **采样完成后必须自己 `paintEstimate()`**，不要只靠调用方重绘 —— 被抢先调用时
> `runEstSample()` 会因签名已匹配而返回 false，界面就永远停在旧值上。

> ⚠️ **「实测校准」文案必须比对签名**（`estSig === currentEstSig()`）。`estBpp` 一旦非空就恒为真，
> 直接判 `estBpp` 会导致切档位后、本档位还没采样就宣称已校准。

> ⚠️ **采样被 `estBusy` 丢掉时必须在跑完后补跑一次**（`runEstSample` 的 `finally` 里
> `if (state.pages.length && estSig !== currentEstSig()) scheduleEstSample()`）。
> 光有开头那句 `if (estBusy ...) return false` 不够：防抖定时器**已经烧掉**，这一轮请求就没人再排，
> 界面会**永久停在「测算中」**并一直用兜底常数（系统性偏低）—— 快切档位时真实可触发。
> 用签名比对而不是无条件重跑，收敛条件是「跑完的签名 == 当前签名」，不会死循环。
> 守护用例：`est_race_test.cjs`（把 `pageRasterJpeg` 拖慢 3s 来确定性复现，未修版本实测卡死 23s+ 仍不校准）。

> ⚠️ **测试等「实测校准」的预算不要抠**。`estimate_test.cjs` 早期只等 12s：连着跑一堆浏览器套件、
> CPU 被占住时首次采样做不完，脚本就带着兜底系数把预估读走了 —— 表现为系统性低估 13~20%
> （图片页 0.84 vs 实际 0.97、PDF 页 0.18 vs 0.23），**看着像预估算法坏了，其实是测试抢跑**，
> 机器一空闲就复现不出来，极坑人。现在预算 90s（正常 2s 内就 break，给足不花钱），
> 并把「是否真的校准了」记进断言，抢跑会明确报「未校准」而不是伪装成精度问题。

> ⚠️ 测试里若调用 `clearAll()`，**先覆盖 `window.confirm = () => true`** ——
> 它内部有 `confirm()`，无头环境没有 dialog handler 会一直阻塞（曾让测试卡死 7 分钟）。

## 语法检查（改完无需浏览器即可快速排雷）

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');
const i=h.indexOf('<script>\n\'use strict\'');const j=h.indexOf('</script>',i);
fs.writeFileSync('_tmp.js',h.slice(i+9,j),{encoding:'utf8'});" && node --check _tmp.js && rm _tmp.js
```

## 打包脚本做了什么

把 `index.html` 中三处外部引用替换为内联脚本，并额外注入 base64 的 pdf.js worker：

- `<script src="lib/pdf-lib.min.js">` → 内联
- `<script src="lib/pdf.min.js">` → 内联
- `<script src="lib/heic2any.min.js">` → 内联
- 注入 `window.__PDFJS_WORKER_B64__`（worker 以 data URL 方式启动，避免 file:// 下取不到 worker 文件）

替换全部使用函数式 `replace`，避免库代码里的 `$` 被当作替换模式。
脚本会校验无残留 `lib/` 引用，并用非零退出码报告失败。
