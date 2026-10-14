/**
 * 「原文范围」怎么写，只有一个地方说了算。
 *
 * 三种写法，可以混：
 *   `054–058`       一段连续的
 *   `001 005 010`   几个单号
 *   `001–004、010`  连续的一段，外加后面某个单号
 *
 * 第三种是曹操那篇逼出来的：那一段用 001–004（刺董那一节），
 * 结尾要用 010（陈留起兵，以诛卓）；中间 005–009 是家世和早年，
 * 属于别处，不能跟着进来。
 *
 * **这个文件被两边同时引用**（`lib/content.js` 渲染、`scripts/build-content.mjs` 校验），
 * 所以必须是 `.mjs`：`web/package.json` 没有 `"type": "module"`，
 * 叫 `.js` 的话 Node 会按 CommonJS 解析，编译器直接 import 不动。
 *
 * 原来只在渲染层里内联了一段正则，写 `001–004、010` 时它会先咬住 `001–004`，
 * 把 010 整个丢掉——而页面只是**少一段原文**，标题照样印着完整的范围，不报错。
 */
export function parseRange(range) {
  const ids = []
  const re = /(\d{3})\s*[–\-—~]\s*(\d{3})|(\d{3})/g
  let m
  while ((m = re.exec(String(range || '')))) {
    if (m[1] && m[2]) {
      const from = Number(m[1])
      const to = Number(m[2])
      /* 倒着写（`010–004`）当作写错，不要静默产出空数组 */
      if (to < from) continue
      for (let i = from; i <= to; i++) ids.push(String(i).padStart(3, '0'))
    } else if (m[3]) {
      ids.push(m[3])
    }
  }
  return [...new Set(ids)]
}

/**
 * `parseRange` 的反向：一串编号 → 它最省字的写法。
 *
 *   ['001','002','003','008'] → `001–003、008`
 *
 * 用来在人物页写「底本 32 段，正史 001–020、注 101–103、小说 201–209」。
 * 原来那一句是拿段数硬拼出来的——`编号 001–{段数}`，32 段就写成 `001–032`，
 * 而实际编号是 001–020、101–103、201–209。**页面上印了一句不存在的话**，
 * 谁也没报错，因为它是拼出来的，不是从编号来的。
 * 凡是能算出来的，就不要手写。
 */
export function formatRanges(ids) {
  /* 非编号的东西直接丢掉。今天进来的都被 `^\d{3}$` 过了一遍，触发不了；
     但 `formatRanges(['001','abc','002'])` 原来会拼出「001、NaN、002」印到人物页上。
     算得出来的东西就不要让它算出 NaN。 */
  const n = [...new Set(ids)].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < n.length; ) {
    let j = i
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++
    const pad = (v) => String(v).padStart(3, '0')
    parts.push(j > i ? `${pad(n[i])}–${pad(n[j])}` : pad(n[i]))
    i = j + 1
  }
  return parts.join('、')
}
