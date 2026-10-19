// 摘句必须来自同一编号内的连续原文；全文、编号及其他来源始终保留。
const compact = value => String(value).replace(/\s/g, '')

export function validateEvidenceExcerpts(beat, source) {
  for (const [id, excerpt] of Object.entries(beat.sourceExcerpts || {})) {
    if (!beat.sources.includes(id)) throw new Error(`摘句${id}未列入本段依据`)
    if (!excerpt?.trim() || !source[id] || !compact(source[id].text).includes(compact(excerpt))) {
      throw new Error(`摘句${id}不是对应编号内的连续原文`)
    }
  }
}

export function evidenceExcerpt(beat, id, full) {
  const legacy = String(beat?.sourceCell || '').match(/^(\d{3})\s+([\s\S]+)$/)
  const excerpt = beat?.sourceExcerpts?.[id] ?? (legacy?.[1] === id ? legacy[2].trim() : null)
  if (!excerpt) return null
  const part = compact(excerpt), whole = compact(full)
  return part !== whole && whole.includes(part) ? excerpt : null
}
