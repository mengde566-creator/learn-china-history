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

/** 按时代给人物分组。时代只是一个标签，不做成一级页面。 */
export function groupByEra(people) {
  const map = new Map()
  for (const p of people) {
    const era = p.era || '未分期'
    if (!map.has(era)) map.set(era, [])
    map.get(era).push(p)
  }
  /* **按时代先后排**，不按人物目录的顺序。 */
  const rank = (e) => { const i = ERA_ORDER.indexOf(e); return i < 0 ? ERA_ORDER.length : i }
  return [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'zh'))
    .map(([era, list]) => ({ era, list }))
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

/** 时代的先后。**不能按人物目录的顺序插**——那会先出三国、再出战国末。
    没列进来的时代排在最后（按名字），不静默丢。 */
export const ERA_ORDER = ['战国末', '秦', '西汉', '东汉', '三国', '西晋', '东晋 · 南朝宋', '北魏 · 东魏', '东魏 · 北齐', '西魏 · 北周', '隋', '唐']
