import { sourceReferences } from './cite-ids.mjs'

/** 查证范围包含正文以及明确列出的补充参照；年份和叙事文字不参与编号识别。 */
export function supplementaryIds(story, available, declared = new Set()) {
  const ids = new Set()
  const scan = (value) => {
    for (const match of sourceReferences(value)) {
      if (available[match[1]] && !declared.has(match[1])) ids.add(match[1])
    }
  }
  for (const row of story.intro?.basis || []) scan(row.basis)
  for (const beat of story.beats || []) { scan(beat.ground); scan(beat.sourceCell) }
  for (const row of story.groundTable || []) scan(row.basis)
  for (const bg of story.backgrounds || []) scan(bg.basis)
  for (const item of [...(story.seeds || []), ...(story.cards || [])]) {
    for (const row of item.meta || []) if (row.k === '依据') scan(row.v)
    scan(item.ground)
  }
  return [...ids]
}
