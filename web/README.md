## 命令

| 命令 | 做什么 | 什么时候跑 |
|---|---|---|
| `npm run content` | 内容编译：`content/**` → `data/content.json` | 改完内容 |
| `npm run font` | 印章字体子集化：`config/seal-chars.txt` → `public/fonts/seal.woff2` | 改了字表 |
| `npm run check` | **只校验不写文件**（内容 262 项 + 字体覆盖） | 提交前 |
| `npm run verify` | **浏览器验证**（路由/对比度/几何/动画/字体 6 项） | 改完界面 |
| `npm run dev` | content + 开发服务器 | 日常 |
| `npm run build` | content + font + 生产构建 | 发布 |

**`npm run verify` 需要服务器先跑着。** 可以筛单项：

```bash
npm run verify contrast     # 只跑名字里含 contrast 的
```

---

## 为什么有 `verify.mjs`

做界面改动时我写过七八个一次性脚本（`scripts/_xxx.mjs`），跑完就删。
结果是**验证方法没有沉淀**——下次要测同样的东西还得从零写，
而且很容易写出错的探针。

`scripts/verify.mjs` 把方法固化下来。**加一项检查就加一个 `check(...)`。**
每项检查都必须**能失败**——写完全绿的检查等于没写。

---

# 观史 · M2a

> **无 AI 的完整循环。** 不需要任何 API key，`npm run dev` 就能跑。

---

## 跑起来

```bash
cd web
npm install     # 首次
npm run dev     # 打开 http://localhost:3000
```

内容会在启动前自动编译。改完 `../content/` 里的 Markdown，重启即可生效。

---

## 这一版有什么

| | |
|---|---|
| 情境铺陈 | 进入场景前，先给你看这四行里哪句是原文、哪句不是 |
| 五个情节点 | 逐个推进，每处都能点开「依据」 |
| 依据面板 | 四种标记 ◆ ○ △ —，附原文与推演链条 |
| 原文 / 背景卡 / 依据映射表 | 侧栏三个全景视图 |
| **60 条预置问答** | 按人物分组，全部经人工审校，带依据标注 |
| 8 张复习卡 | 默认折叠，点开才看答案 |
| 设置页 | AI 开关（M2b 生效）、场景区浅色 |

**没有 AI 也走得通完整循环。** 降级不是错误态——界面不会出现"功能不可用"。

---

## 内容是怎么进来的

```
content/*.md  ──scripts/build-content.mjs──▶  web/data/content.json  ──▶  页面
   （人读）              （编译 + 校验）              （程序读）
```

**单一数据源。** `content/*.md` 是唯一的源，`data/content.json` 是产物（不进版本库）。

### 编译器会做的事

1. 解析 `01-原文底本.md` → 91 段原文（编号 / 优先级 / ★ / 异文 / 压缩）
2. 解析 `04-场景06-易水送别.md` → 情境 / 5 情节点 / 6 背景卡 / 依据映射表
3. 解析 `seeds/06-易水送别.md` → 60 条问答
4. 解析 `05-复习卡.md` → 8 张卡
5. **交叉校验**：所有被引用的编号必须真实存在

**任何一步失败都会带着行号报错，绝不静默跳过。**

---

## ⚠️ 改内容时的注意事项

编译器读的是 Markdown 的**结构**，不只是文字。以下结构不能改：

| 文件 | 不能动的结构 |
|---|---|
| `01-原文底本.md` | `## 场景 N · 名称` 小节；`\| 编号 \| 原文 \| 优先级 \|` 三列表格 |
| `04-场景06…md` | `## 一、`～`## 六、` 六个二级标题；`### 情节点 N · 标题`；情节点正文用 `> ` 引用块，**元数据表之后的引用块会被当作编辑批注、不进正文** |
| `seeds/06…md` | `## 分组名`；`**Q：问题**`；回答用 `> `；元数据用 `\| 标记 \| X \|` |
| `05-复习卡.md` | `### 卡 N · 题型`；`**问：…**`；`答：…` |

改完跑一次 `npm run check`——它会告诉你哪里解析不了。

---

## 目录

```
web/
  app/
    layout.jsx          全局布局 + 导航
    page.jsx            总览（七个场景入口）
    scene/page.jsx      场景 06（服务端：读内容）
    settings/page.jsx   设置
    globals.css         设计系统（从 design/style-tile.html 移植）
    icon.svg
  components/
    Nav.jsx             导航（含明暗切换）
    SceneClient.jsx     场景主体验（客户端：交互）
    SeedSheet.jsx       提问面板
    ReviewCards.jsx     复习卡
    RichText.jsx        标记与轻量 Markdown 渲染
  lib/
    content.js          读编译产物
    settings.js         设置存取（localStorage）
  scripts/
    build-content.mjs   内容编译器
    screenshots.mjs     开发用：走一遍流程并截图
  data/content.json     编译产物（自动生成，不进版本库）
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

## 下一版（M2b）要做的

1. 服务端 API Route（**key 永不进浏览器**）
2. 能力探测：前端问一次 `/api/capabilities`，有 AI 才显示自由输入
3. 系统提示词：知识边界（知/度/禁）＋ 模态层 / 确认层 / 时态层
4. **输入侧未来内容检测**（红队结论：唯一能封住"确认式泄露"的办法）
5. ⓘ 层走前端注入，**不进模型上下文**
6. 缓存 + 会话额度

**验收**：红队那 12 条攻击做成回归用例，每条跑 5 次，突破率 > 0 即不通过。
