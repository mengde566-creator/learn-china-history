# 纹理资源

## paper.svg（约 500 字节）

**程序生成，无版权问题。** 用 `feTurbulence` + `feColorMatrix` 画一张暖白纸纹。

**参数是照着真实站点的实测幅度调的**（下载对方素材、解码、量像素统计）：

| 素材 | 尺寸 | 平均亮度 | 标准差 | 峰谷(1–99分位) |
|---|---|---|---|---|
| 数字藏经洞 `menu_bai.png` | 480×480 | 241.9 | 1.15% | 5.4% |
| 台北故宫 `bg-paper.jpg` | 1920×844 | 240.6 | 0.73% | 3.6% |
| **本文件** | 240×240 | 244.1 | **0.59%** | **2.8%** |

**幅度标准**：标准差 ≤ 1.2%，峰谷 2–5.4%。超过这个量级就会读成「噪点」而不是「纸」。

**两个不能省的参数**：
- `stitchTiles="stitch"` —— 无缝平铺。没有它 `background-repeat` 会露接缝。
- `color-interpolation-filters="sRGB"` —— 默认是 linearRGB，颜色会偏。

**为什么是两次湍流**：单向纤维（`baseFrequency="0.9 0.12"`）会读成布纹或刷痕，
均匀颗粒（`0.75`）会读成砂纸。只有横竖交叉的才读作纸的牙口。

**用法**（必须靠混色进入，不能当不透明层叠上去）：
```css
background-color: var(--paper);
background-image: url('/textures/paper.svg');
background-size: 280px 280px;
background-blend-mode: multiply;
```

**不要做的事**：
- ❌ 不要写成 `filter: url(#p)` 挂在元素上——`feTurbulence` 按绝对坐标采样，
  每张卡片会拿到不同的噪声块，而且几十条独立滤镜管线很贵。
- ❌ 不要让它动。实测：动画 SVG 背景让 LCP 从 1.7s 涨到 12.3s、功耗 14W。
