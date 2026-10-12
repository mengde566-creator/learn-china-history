import fs from 'node:fs'
import path from 'node:path'

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

/** 按时代给人物分组。时代只是一个标签，不做成一级页面。 */
export function groupByEra(people) {
  const map = new Map()
  for (const p of people) {
    const era = p.era || '未分期'
    if (!map.has(era)) map.set(era, [])
    map.get(era).push(p)
  }
  return [...map.entries()].map(([era, list]) => ({ era, list }))
}

/**
 * 取某个故事用到的原文段落。
 * 故事的 sourceRange 形如 "054–058" 或 "001–016"。
 */
export function sourceRange(person, range) {
  const out = {}
  const m = String(range || '').match(/(\d{3})\s*[–\-—~]\s*(\d{3})/)
  if (m) {
    for (let i = Number(m[1]); i <= Number(m[2]); i++) {
      const id = String(i).padStart(3, '0')
      if (person.source[id]) out[id] = person.source[id]
    }
  } else {
    for (const id of String(range || '').match(/\d{3}/g) || []) {
      if (person.source[id]) out[id] = person.source[id]
    }
  }
  return out
}

/** 计划中的人物 —— 还没有内容，只在总览里占一个位置 */
export const PLANNED = [
  { name: '曹操', era: '三国', book: '《三国志·武帝纪》' },
  { name: '刘裕', era: '东晋 · 南朝宋', book: '《宋书·武帝纪》' },
  { name: '高欢', era: '东魏 · 北齐', book: '《北齐书·神武帝纪》' },
  { name: '宇文泰', era: '西魏 · 北周', book: '《周书·文帝纪》' },
]
