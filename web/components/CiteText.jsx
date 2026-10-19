'use client'

import { sourceReferences } from '@/lib/cite-ids.mjs'

/**
 * 依据、说明里的**编号可以点**。
 *
 * 读者读到「`042`、`043`」时想知道那两段原文写了什么——原来只能自己切到
 * 「原文」页签再找。现在点编号就跳过去、并给一个「返回」。
 *
 * 三位数字须在本篇可查范围内（包含明确补入的跨篇参照），
 * 带「年」的纪年与四位以上数字不作为编号。
 */
export default function CiteText({ text, ids, onJump }) {
  const src = String(text ?? '')
  if (!onJump) return src
  const have = ids ? new Set(ids) : null
  const out = []
  let last = 0, k = 0
  for (const m of sourceReferences(src)) {
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
