// 分层由带注版本人工核定；编译时只核对无损拼接，不能据此声称完成版本校勘。
export function attachSourceLayers(source, gloss, entries) {
  for (const [id, parts] of Object.entries(entries)) {
    const row = source[id]
    if (!row) throw new Error(`分层编号 ${id} 不存在`)
    if (!Array.isArray(parts) || parts.length < 2) throw new Error(`${id} 分层至少需要两段`)
    for (const part of parts) {
      if (!['正史', '注'].includes(part.tier) || !part.origin?.trim() || !part.text || !part.gloss) {
        throw new Error(`${id} 分层须有档次、具体出处、原文和白话`)
      }
    }
    if (parts.map(p => p.text).join('') !== row.text) throw new Error(`${id} 分层原文拼接与 source.md 不同`)
    if (parts.map(p => p.gloss).join('') !== gloss[id]) throw new Error(`${id} 分层白话拼接与 gloss.md 不同`)
    if (row.tier === '注' && parts.some(p => p.tier !== '注')) throw new Error(`${id} 注文不能分入正文`)
    if (row.tier === '正史' && !parts.some(p => p.tier === '正史')) throw new Error(`${id} 缺正文片段`)
    row.parts = parts.map(p => ({ ...p }))
    if (parts.some(p => p.tier === '正史') && parts.some(p => p.tier === '注')) {
      row.origin = `${row.book} · 正文与裴注合录`
    }
  }
}

export const plainSourceText = text => String(text ?? '').replace(/\*\*|`/g, '')

// 摘句也沿用原文边界：只摘到正文时不冒称注文，跨界时逐片显示。
export function sourceLayersForText(source, excerpt) {
  if (!source?.parts) return null
  if (!excerpt || excerpt === source.text) return source.parts
  const compact = t => plainSourceText(t).replace(/\s/g, '')
  const text = compact(excerpt), full = compact(source.text)
  const start = full.indexOf(text)
  if (!text || start < 0) throw new Error(`${source.id} 摘句不在分层原文中`)
  const end = start + text.length
  let offset = 0
  return source.parts.flatMap(part => {
    const value = compact(part.text), left = Math.max(start, offset), right = Math.min(end, offset + value.length)
    const slice = left < right ? [{ ...part, text: value.slice(left - offset, right - offset) }] : []
    offset += value.length
    return slice
  })
}

export function sourceExcerptOrigin(source, excerpt) {
  const parts = sourceLayersForText(source, excerpt)
  const origins = parts && [...new Set(parts.map(p => p.origin))]
  return origins?.length === 1 ? origins[0] : source?.origin
}

export const hasMixedSourceLayers = source => source?.parts?.some(p => p.tier === '正史') && source.parts.some(p => p.tier === '注')
