'use client'

/**
 * 依据、说明里的**编号可以点**。
 *
 * 读者读到「`042`、`043`」时想知道那两段原文写了什么——原来只能自己切到
 * 「原文」页签再找。现在点编号就跳过去、并给一个「返回」。
 *
 * 判据：**三位数字就是编号**（年份一律带「年」字，如「208 年」），
 * 所以在依据/说明这个语境里不会误伤。编号不在本篇范围时不跳——
 * 那种编号本来就不该出现在依据里（编译器另有跨篇提醒）。
 */
export default function CiteText({ text, ids, onJump }) {
  const src = String(text ?? '')
  if (!onJump) return src
  const have = ids ? new Set(ids) : null
  const out = []
  const re = /(?<!\d)(\d{3})(?!\d)/g
  let last = 0, m, k = 0
  while ((m = re.exec(src))) {
    const id = m[1]
    out.push(src.slice(last, m.index))
    const jumpable = !have || have.has(id)
    out.push(
      jumpable
        ? <button key={k++} type="button" className="cite" onClick={() => onJump(id)} title={`看 ${id} 的原文`}>{id}</button>
        : <span key={k++}>{id}</span>
    )
    last = m.index + m[0].length
  }
  out.push(src.slice(last))
  return out
}
