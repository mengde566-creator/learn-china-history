# 观史 · web

> Next.js 15（App Router）＋ React 19，**纯 CSS**，没有 Tailwind。
>
> **产品范围：静态预置内容 ＋ 沉浸阅读。** 2026-10-17 定：**不做 AI 自由对话**——
> 没有模型接入、没有 API key、没有能力探测、没有额度与计费，也没有开关。
> 读者能问的话，全部来自 `content/people/<id>/seeds/<篇>.md` 里人工审校过的预置问答。

---

## 跑起来

```bash
cd web
npm install     # 首次
npm run dev     # 打开 http://localhost:3000
```

`npm run dev` 就是 `npm run content && next dev`：内容会在启动前先编译一遍。
改完 `../content/` 里的 Markdown，重启即可生效。

---

## 命令

下表照 `web/package.json` 的 `scripts` 抄，第二列是它实际执行什么。

| 命令 | 实际执行 | 做什么 | 什么时候跑 |
|---|---|---|---|
| `npm run content` | `node scripts/build-content.mjs` | 内容编译：`content/**` → `data/content.json` | 改完内容 |
| `npm run check` | `build-content --check` ＋ `build-font --check` ＋ `check-ui-words` | **只校验不写文件**：内容结构与编号、字体子集覆盖、界面文案 | 提交前 |
| `npm run check-sources` | `node scripts/check-sources.mjs` | 逐字核对 `source.md` 与 `.refs/` 里的公版电子本 | 动过原文 |
| `npm run font` | `node scripts/build-font.mjs` | 印章字体子集化：`config/seal-chars.txt` → `public/fonts/seal.woff2` | 改了字表 |
| `npm run build` | `content` ＋ `font` ＋ `next build` | 生产构建 | 发布 |
| `npm run start` | `next start` | 跑生产构建（先 `npm run build`） | 发布 |
| `npm run dev` | `content` ＋ `next dev` | 开发服务器 | 日常 |
| `npm run verify` | `node scripts/verify.mjs` | 浏览器端验证套件，**需要服务器先跑着**，可筛单项 | 改完界面 |
| `npm run shots` | `node scripts/screenshots.mjs` | 开发用：走一遍流程并截图（默认 `http://127.0.0.1:3100`） | 自查视觉 |
| `npm run refs` | `node scripts/fetch-refs.mjs` | 把核对用的参考文本取到 `.refs/`（不进版本库） | 首次 / 换机器 |
| `npm run ref-grep` | `node scripts/ref-grep.mjs` | 在已核对的底本里检索句子（繁转简、跨底本定位已做好） | 写原文 |
| `npm run new-story` | `node scripts/new-story.mjs` | 从「故事一览」那一行 ＋ 底本范围生成故事骨架 | 加一篇故事 |
| `npm run renumber` | `node scripts/renumber.mjs` | 给故事改编号（含文件、种子、复习卡、全部引用） | 调整篇序 |
| `npm run test-visible` | `node scripts/test-visible-fields.mjs` | 回归：在隔离副本里注入审校批注，断言读者可见字段的扫描真的扫得到 | 动扫描规则 |

`scripts/merge-gloss.mjs`（把 `gloss-parts/*.md` 合进 `gloss.md`）没有进 `scripts`，
直接 `node scripts/merge-gloss.mjs [人物id]`。

**`npm run verify` 需要服务器先跑着**（`npm run dev` 或 `npm start`）。可以筛单项：

```bash
npm run verify contrast     # 只跑名字里含 contrast 的
```

**数字以命令输出为准，不要照抄文档。** `npm run check` 自己会报当前有多少段、多少项、
多少条文案；写死在文档里的数字迟早对不上——这就是 `content/README.md`
「会同时写在好几个地方的数字」那一节存在的理由。

---

## 路由

`app/` 下的实际文件，一行一个：

| 路径 | 文件 | 页面 |
|---|---|---|
| `/` | `app/page.jsx` | 总览：按时代分组的人物（已实现的可进入，未实现的锁着） |
| `/p/<person>` | `app/p/[person]/page.jsx` | 人物页：他是谁 / 为什么读他 / 故事列表 / 关键时点 |
| `/p/<person>/<story>` | `app/p/[person]/[story]/page.jsx` | 故事页：情境铺陈 → 情节点 → 原文 / 背景卡 / 依据映射表 → 复习卡 → 提问 |
| `/p/<person>/source` | `app/p/[person]/source/page.jsx` | **完整资料页**：全篇底本 ＋ 逐段直译，按号段分档 |
| `/settings` | `app/settings/page.jsx` | 设置页 |

**没有 `app/api/`。** 这一版没有任何服务端接口：内容在构建期就编译进 `data/content.json`，
页面按 id 静态生成（`generateStaticParams`）。

---

## 产品范围：不做 AI 自由对话

2026-10-17 定。下面这些是**不做**，不是「下一版做」：

- 生成式对话 / 自由输入
- 模型接入 / API key 配置
- 能力探测（**不存在** `/api/capabilities`）
- 额度与计费
- 提示词防护（没有提示词，就没有要防的东西）

**保留的是静态预置问答**（`seeds/<篇>.md`）：它本来就是学习资料——人工审校、逐条带依据标记、
不经过任何模型。设置页因此只剩本地设置，**没有 AI 开关**；导航上也没有「无 AI 模式」这类标签。
**AI 不是产品里的一个模式，它现在不在产品里。**

---

## 这一版有什么

| | |
|---|---|
| 情境铺陈 | 进入场景前，先给你看这四行里哪句是原文、哪句不是 |
| 情节点 | 逐个推进，每处都能点开「依据」 |
| 依据面板 | 六个标记（◆ ◇ ○ △ — ⓘ），附原文与推演链条 |
| 原文 / 背景卡 / 依据映射表 | 侧栏三个全景视图 |
| **预置问答** | 按分组排列，全部经人工审校，带依据标注 |
| 复习卡 | 默认折叠，点开才看答案 |
| **完整资料页** | `/p/<person>/source`：全篇底本 ＋ 直译 |
| 设置页 | 本地设置（存在这台设备的浏览器里，不上传） |

界面不会出现「功能不可用」这类话——**没有要降级的东西**。

---

## 为什么有 `verify.mjs`

做界面改动时我写过七八个一次性脚本（`scripts/_xxx.mjs`），跑完就删。
结果是**验证方法没有沉淀**——下次要测同样的东西还得从零写，而且很容易写出错的探针。

`scripts/verify.mjs` 把方法固化下来。**加一项检查就加一个 `check(...)`。**
每项检查都必须**能失败**——写完全绿的检查等于没写。

---

## 内容是怎么进来的

```
content/people/<person>/*.md  ──scripts/build-content.mjs──▶  web/data/content.json  ──▶  页面
        （人读）                        （编译 + 校验）              （程序读）
```

**单一数据源。** `content/**/*.md` 是唯一的源，`data/content.json` 是产物（不进版本库）。

### 编译器会做的事

1. 解析 `people/<id>/source.md` → 底本段落（编号 / 优先级 / ★ / 异文）
2. 解析 `people/<id>/stories/<篇>.md` → 情境 / 情节点 / 背景卡 / 依据映射表
3. 解析 `people/<id>/seeds/<篇>.md` → 预置问答
4. 解析 `people/<id>/cards/<篇>.md` → 复习卡
5. 解析 `people/<id>/person.md`、`stories.md`、`cast.md` → 人物、故事一览、本篇人物的知识边界
6. 解析 `people/<id>/gloss.md` → 完整资料页的逐段直译（`gloss-parts/` 是写作分片，由 `merge-gloss.mjs` 合并）
7. **交叉校验**：所有被引用的编号必须真实存在

**任何一步失败都会带着行号报错，绝不静默跳过。**

---

## ⚠️ 改内容时的注意事项

编译器读的是 Markdown 的**结构**，不只是文字。以下结构不能改：

| 文件 | 不能动的结构 |
|---|---|
| `source.md` | `## 底本N · 档次 · 书名` 小节；`\| 编号 \| 原文 \| 优先级 \|` 三列表格（四列表是 `\| 编号 \| 原文 \| 出处 \| 优先级 \|`） |
| `stories/<篇>.md` | `## 一、`～`## 六、` 六个二级标题；`### 情节点 N · 标题`；情节点正文用 `> ` 引用块，**元数据表之后的引用块会被当作编辑批注、不进正文** |
| `seeds/<篇>.md` | `## 分组名`；`**Q：问题**`；回答用 `> `；元数据用 `\| 标记 \| X \|` |
| `cards/<篇>.md` | `### 卡 N · 题型`；`**问：…**`；`答：…` |

改完跑一次 `npm run check`——它会告诉你哪里解析不了。
写完整规范（号段、标记、依据怎么写、种子规则）在 `../content/README.md`。

---

## 目录

```
web/
  app/
    layout.jsx            全局布局 ＋ 导航
    page.jsx              总览（按时代分组）
    p/[person]/page.jsx           人物页
    p/[person]/[story]/page.jsx   故事页（服务端：读内容；交互在 StoryClient）
    p/[person]/source/page.jsx    完整资料页（底本 ＋ 直译）
    settings/page.jsx             设置
    globals.css           设计系统（从 design/style-tile.html 移植）
    icon.svg
  components/
    Nav.jsx               导航（含明暗切换）
    StoryClient.jsx       故事主体验（客户端：交互）
    SeedSheet.jsx         预置问答面板
    ReviewCards.jsx       复习卡
    RichText.jsx          标记与轻量 Markdown 渲染
    CiteText.jsx          依据里的编号与引文
    SealMark.jsx          印章字
    SettingsClient.jsx    设置（客户端）
  lib/
    content.js            读编译产物
    range.mjs             「原文范围」的唯一实现（编译器和渲染层共用）
    cite.mjs              「拼出处」的唯一实现（编译器和骨架生成器共用）
    settings.js           本地设置存取（localStorage）
  scripts/                见上面的命令表
  data/content.json       编译产物（自动生成，不进版本库）
```

---

## 两个已知的工程细节

### 1. npm 缓存

系统全局缓存（`~/.npm`）里有 root 属主的文件，直接 `npm install` 会报 EPERM。
`web/.npmrc` 已把缓存改到项目内（`.npm-cache/`），**不需要 sudo**。该目录可随时删除。

### 2. 为什么不用 Tailwind

设计文档原本写的是 Next.js + Tailwind。实际用了**纯 CSS**：

- `design/style-tile.html` 里已经有一份审过的 CSS，Tailwind 意味着把它重写成工具类
- 竖排（`writing-mode`）、浮现动画、双面明暗切换这些，用工具类反而更难写

**保真度优先于时髦。** 整个设计系统在 `app/globals.css` 一个文件里。

---

## 历史：单场景时期（已不适用）

下面这些是 M1 / M2a 时期的样子，保留作记录，**不要照着做**：

| 当时 | 现在 |
|---|---|
| `content/01-原文底本.md`、`content/04-场景06-易水送别.md`、`content/05-复习卡.md`、`seeds/06-易水送别.md` | `content/people/<id>/source.md`、`stories/<篇>.md`、`cards/<篇>.md`、`seeds/<篇>.md` |
| `app/scene/page.jsx`、`components/SceneClient.jsx` | `app/p/[person]/[story]/page.jsx`、`components/StoryClient.jsx` |
| 只有荆轲一个场景（易水送别），全库 93 段原文 | 荆轲 8 篇 ＋ 曹操 10 篇，人物按目录加 |
| 「下一版（M2b）要做的」：服务端 API Route、`/api/capabilities` 能力探测、系统提示词、输入侧未来内容检测、会话额度 | **整节删去。** 这些对应的是 AI 自由对话，已明确不做；**不存在「下一版接入 AI」的承诺** |
| 标题「观史 · M2a」、副标题「无 AI 的完整循环」 | AI 不是产品的一个模式——它就是不在产品里 |
