/** 人物介绍的纯数据校验与正文定位。未标注的正文始终按原文展示。 */
export function preparePersonNotes(story, input, source) {
  if (!input) return { people: [], occurrences: [] }
  if (!Array.isArray(input.people) || !Array.isArray(input.occurrences)) throw new Error('人物介绍数据缺少 people 或 occurrences')
  const ids = new Set()
  const names = new Set()
  for (const person of input.people) {
    if (!person.id || !person.name || ids.has(person.id) || names.has(person.name) || !Array.isArray(person.versions)) throw new Error('人物身份缺失或重复；同名人物须先明确区分')
    ids.add(person.id)
    names.add(person.name)
    for (const [i, version] of person.versions.entries()) {
      if (!Number.isInteger(version.from) || !Number.isInteger(version.to) || version.from < 1 || version.to < version.from || !version.text || !Array.isArray(version.sources) || !version.sources.length) throw new Error(`${person.name}介绍范围或来源无效`)
      if (!story.beats.some(b => b.n === version.from) || !story.beats.some(b => b.n === version.to)) throw new Error(`${person.name}介绍范围超出本篇`)
      const first = story.beats.find(b => b.n === version.from)
      const last = story.beats.find(b => b.n === version.to)
      if (version.fromParagraph != null && (!Number.isInteger(version.fromParagraph) || version.fromParagraph < 0 || version.fromParagraph >= first.prose.length)) throw new Error(`${person.name}介绍起始段落无效`)
      if (version.toParagraph != null && (!Number.isInteger(version.toParagraph) || version.toParagraph < 0 || version.toParagraph >= last.prose.length)) throw new Error(`${person.name}介绍结束段落无效`)
      const start = [version.from, version.fromParagraph ?? 0]
      const end = [version.to, version.toParagraph ?? last.prose.length - 1]
      const compare = (a, b) => a[0] - b[0] || a[1] - b[1]
      if (compare(start, end) > 0) throw new Error(`${person.name}介绍范围倒置`)
      for (const prev of person.versions.slice(0, i)) {
        const prevLast = story.beats.find(b => b.n === prev.to)
        const prevStart = [prev.from, prev.fromParagraph ?? 0]
        const prevEnd = [prev.to, prev.toParagraph ?? prevLast.prose.length - 1]
        if (compare(prevStart, end) <= 0 && compare(start, prevEnd) <= 0) throw new Error(`${person.name}介绍范围重叠`)
      }
      for (const ref of version.sources) {
        if (ref.kind === 'local' && !source[ref.id]) throw new Error(`${person.name}来源编号无效`)
        if (ref.kind === 'external' && (!ref.book || !ref.section || !/^https:\/\//.test(ref.url || ''))) throw new Error(`${person.name}外部来源不完整`)
        if (!['local', 'external'].includes(ref.kind)) throw new Error(`${person.name}来源类型无效`)
      }
    }
  }
  const used = new Map()
  for (const mark of input.occurrences) {
    const beat = story.beats.find(b => b.n === mark.beat)
    const p = beat?.prose?.[mark.paragraph]
    const person = input.people.find(x => x.id === mark.personId)
    if (!person || typeof p !== 'string' || p !== mark.paragraphText || !mark.text) throw new Error('人物标记的正文或身份不匹配')
    if (beat.quotes?.some(q => q.at === mark.paragraph || q.glossAt === mark.paragraph)) throw new Error('人物标记不能放在原文引句或回译中')
    if (!personVersion(person, mark.beat, mark.paragraph)) throw new Error('人物标记缺少当前时点的介绍')
    const start = mark.offset
    if (!Number.isInteger(start) || start < 0 || p.slice(start, start + mark.text.length) !== mark.text) throw new Error('人物标记位置与正文不匹配')
    const slot = `${mark.beat}:${mark.paragraph}`
    const spans = used.get(slot) || []
    const end = start + mark.text.length
    if (spans.some(span => start < span.end && span.start < end)) throw new Error('同一正文段落的人物标记重叠')
    spans.push({ start, end })
    used.set(slot, spans)
  }
  return input
}

export function personVersion(person, beat, paragraph = null) {
  const versions = (person?.versions || []).filter(v => v.from <= beat && beat <= v.to)
  // 当前只知道情节点、但介绍分到段落时，不猜测读者已经读到哪里。
  if (paragraph == null && versions.some(v => (v.from === beat && v.fromParagraph != null) || (v.to === beat && v.toParagraph != null))) return null
  return versions.find(v => (v.from !== beat || v.fromParagraph == null || paragraph >= v.fromParagraph) && (v.to !== beat || v.toParagraph == null || paragraph <= v.toParagraph)) || null
}
