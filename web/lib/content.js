import fs from 'node:fs'
import path from 'node:path'
import { parseRange } from './range.mjs'

/**
 * 读取内容编译产物。
 * 产物由 `npm run content` 从 content/ 生成，不在版本库里。
 */
let cache = null
export function getContent() {
  if (cache) return cache
  const p = path.join(process.cwd(), 'data', 'content.json')
  if (!fs.existsSync(p)) {
    throw new Error(
      '找不到 data/content.json。\n' +
      '请先运行：npm run content\n' +
      '（或直接用 npm run dev / npm run build，它们会自动先编译内容）'
    )
  }
  cache = JSON.parse(fs.readFileSync(p, 'utf8'))
  return cache
}

export function listPeople() {
  return getContent().people
}

export function getPerson(id) {
  return getContent().people.find((p) => p.id === id) || null
}

export function getStory(personId, storyId) {
  const person = getPerson(personId)
  if (!person) return null
  const story = person.stories[storyId]
  if (!story) return null
  return { person, story }
}

/** 首页使用常见朝代阶段，人物页继续保留原有的细时代说明。 */
export function groupByEra(people) {
  const map = new Map()
  for (const p of people) {
    const original = p.era || '未分期'
    const era = ERA_GROUPS.find(group => group.match.test(original))?.era || original
    if (!map.has(era)) map.set(era, [])
    map.get(era).push(p)
  }
  // 同区按已有关键时点的首个明确公元纪年排列，不补造人物生年。
  const firstYear = (person) => {
    for (const point of person.timeline || []) {
      const match = String(point.time).match(/^(?:公元\s*)?(?:约\s*)?(前\s*)?(\d{1,4})(?!\d)/)
      if (match) return Number(match[2]) * (match[1] ? -1 : 1)
    }
    return Infinity
  }
  const rank = (e) => { const i = ERA_ORDER.indexOf(e); return i < 0 ? ERA_ORDER.length : i }
  return [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'zh'))
    .map(([era, list]) => ({
      era,
      list: list.sort((a, b) => firstYear(a) - firstYear(b) || a.name.localeCompare(b.name, 'zh')),
    }))
}

/**
 * 取某个故事用到的原文段落。
 * 范围怎么写（`001–004`、`001 005 010`、`001–004、010`）由 `range.mjs` 说了算，
 * 编译器和这里引的是同一份实现，不会各认各的。
 */
export function sourceRange(person, range) {
  const out = {}
  for (const id of parseRange(range)) if (person.source[id]) out[id] = person.source[id]
  return out
}

/**
 * 计划中的人物 —— 还没有内容，只在总览里占一个位置。
 *
 * **`id` 必须和已实现人物共用一套**：`曹操` 曾经既在这里、又在已实现列表里，
 * 首页于是同时显示「可进入的曹操」和「锁定的曹操」两张卡。
 * 现在按 `id` 去重（见 `app/page.jsx`），所以这里的 id 要和 `people/<id>/` 对得上。
 */
export const PLANNED = [
  { id: 'liuyu', name: '刘裕', era: '东晋 · 南朝宋', book: '《宋书·武帝纪》' },
  { id: 'gaohuan', name: '高欢', era: '东魏 · 北齐', book: '《北齐书·神武帝纪》' },
  { id: 'yuwentai', name: '宇文泰', era: '西魏 · 北周', book: '《周书·文帝纪》' },
]

// 按朝代阶段识别，避免细标签漏表沉底，也不将晋、南北朝或宋、元合并。
const ERA_GROUPS = [
  { era: '春秋战国', match: /^(春秋|战国)/ },
  { era: '秦汉', match: /^(?!.*汉末)(秦|楚汉|西汉|东汉|汉)/ },
  { era: '汉末三国', match: /汉末|三国/ },
  { era: '晋', match: /^(?!.*南朝)(西晋|东晋|两晋|晋)/ },
  { era: '南北朝', match: /南朝|北朝|南北朝|北魏|东魏|西魏|北齐|北周/ },
  { era: '隋朝', match: /^隋/ },
  { era: '唐朝', match: /^唐/ },
  { era: '五代十国', match: /^(五代|十国)/ },
  { era: '宋朝', match: /^(宋|北宋|南宋)/ },
  { era: '元朝', match: /^元/ },
  { era: '明朝', match: /^明/ },
  { era: '清朝', match: /^清/ },
  { era: '近现代', match: /^(近代|现代|近现代|民国|当代)/ },
]
export const ERA_ORDER = ERA_GROUPS.map(group => group.era)
