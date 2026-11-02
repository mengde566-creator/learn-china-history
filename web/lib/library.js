'use client'

import { createPersistentStore } from '@/lib/store'
import { useStoreSelector } from '@/lib/use-store'
import { storyKey, isStoryKey } from '@/lib/keys'

/**
 * 收藏（篇级）与将来的朱批都住在这里。
 *
 * **为什么不和进度放一个键**：进度是可丢的（丢了最坏是重读），收藏是读者
 * 亲手挑的（重来等于丢掉他花过的时间）。同一个键意味着设置页那个
 * 「清除阅读进度」会把收藏一起删掉——那是行为与按钮文案不一致的产品事故。
 *
 * **为什么键一律 `人物/篇`**：`01-jingkou` 同时属于 liuyu 与 tandaoji。
 * 只按篇 id 存会把两篇合成一条。
 *
 * 数据结构：
 *   {
 *     v: 1,
 *     stars: { "caocao/09-chibi": { at: 1762… } },
 *     notes: { "caocao/09-chibi#5": { text, at, anchor } },
 *   }
 *
 * **朱批是平表**（`人物/篇#段号`），不嵌套：嵌套会让合并规则变成猜谜，
 * 而这一层已经有一套「按 at 合并」的规则要守。
 */

const KEY = 'guanshi.library.v1'
const NOTE_LIMIT = 120

/** `人物/篇#段号`。段号是数字；`#` 不参与篇名与人物 id。 */
const noteKey = (personId, storyId, beat) => `${storyKey(personId, storyId)}#${beat}`
const isNoteKey = (key) => /^[^/]+\/[^#]+#\d+$/.test(String(key || ''))
const splitNoteKey = (key) => {
  const at = key.lastIndexOf('#')
  return [key.slice(0, at), Number(key.slice(at + 1))]
}

export { storyKey }

/** 形状校验：只认合法的键与有限的时间戳；批注的文字要真的是一句话。 */
function sanitizeLibrary(raw, defaults) {
  const stars = {}
  for (const [key, value] of Object.entries(raw?.stars || {})) {
    if (!isStoryKey(key)) continue
    if (!value || typeof value !== 'object') continue
    const at = Number(value.at)
    stars[key] = { at: Number.isFinite(at) ? at : 0 }
  }
  const notes = {}
  for (const [key, value] of Object.entries(raw?.notes || {})) {
    if (!isNoteKey(key)) continue
    if (!value || typeof value !== 'object') continue
    const text = typeof value.text === 'string' ? value.text.trim().slice(0, NOTE_LIMIT) : ''
    if (!text) continue
    const at = Number(value.at)
    const note = { text, at: Number.isFinite(at) ? at : 0 }
    if (typeof value.anchor === 'string' && value.anchor) note.anchor = value.anchor.slice(0, 40)
    notes[key] = note
  }
  return { ...defaults, stars, notes }
}

export const libraryStore = createPersistentStore({
  key: KEY,
  version: 1,
  defaults: { stars: {}, notes: {} },
  sanitize: sanitizeLibrary,
})

export function isStarred(personId, storyId) {
  return Boolean(libraryStore.get().stars[storyKey(personId, storyId)])
}

/** 一键收藏 / 取消。**不弹窗、不问道理**——读者按下的每一次都是有意的。 */
export function toggleStar(personId, storyId) {
  const key = storyKey(personId, storyId)
  const now = Date.now()
  libraryStore.set((state) => {
    const stars = { ...state.stars }
    if (stars[key]) delete stars[key]
    else stars[key] = { at: now }
    return { ...state, stars }
  })
}

/** 读者亲手留下的一切，按时间倒序。书架与导出都从这里取。 */
export function starList() {
  return Object.entries(libraryStore.get().stars)
    .map(([key, value]) => {
      const [personId, storyId] = key.split('/')
      return { key, personId, storyId, at: value.at || 0 }
    })
    .sort((a, b) => b.at - a.at)
}

export function useStars() {
  return useStoreSelector(libraryStore, (state) => state.stars)
}

export function useNotes() {
  return useStoreSelector(libraryStore, (state) => state.notes)
}

export function noteFor(personId, storyId, beat) {
  return libraryStore.get().notes[noteKey(personId, storyId, beat)] || null
}

/**
 * 写一句批注。空串 = 删除。
 * `anchor` 是这一段开头的字，内容改版后靠它把批注找回同一段。
 */
export function setNote(personId, storyId, beat, text, anchor) {
  const key = noteKey(personId, storyId, beat)
  const clean = String(text || '').trim().slice(0, NOTE_LIMIT)
  const now = Date.now()
  libraryStore.set((state) => {
    const notes = { ...state.notes }
    if (!clean) delete notes[key]
    else notes[key] = { text: clean, at: now, ...(anchor ? { anchor } : {}) }
    return { ...state, notes }
  })
}

export function deleteNote(personId, storyId, beat) {
  setNote(personId, storyId, beat, '')
}

/**
 * 改一条**已经存在**的批注——哪怕它被锚点挪到了别的段。
 *
 * 为什么必须按键改：内容改版后 `#3` 那条可能显示在第 6 段。
 * 若按显示位置再写一次，就会生成 `#6` 而 `#3` 还在，读者看到两条一样的批注。
 */
export function updateNote(key, text, anchor) {
  const clean = String(text || '').trim().slice(0, NOTE_LIMIT)
  if (!isNoteKey(key)) return
  if (!clean) { removeNote(key); return }
  const now = Date.now()
  libraryStore.set((state) => {
    const prev = state.notes[key]
    if (!prev) return state
    const notes = { ...state.notes, [key]: { text: clean, at: now, ...(anchor || prev.anchor ? { anchor: anchor || prev.anchor } : {}) } }
    return { ...state, notes }
  })
}

export function removeNote(key) {
  if (!isNoteKey(key)) return
  libraryStore.set((state) => {
    const notes = { ...state.notes }
    delete notes[key]
    return { ...state, notes }
  })
}

/**
 * 这一篇的批注，按段号排。
 *
 * 内容改版后段号会漂：有锚点的先用锚点找同一段（找不到就留在原段号、标 `moved`），
 * 让读者看得见「这条可能不在原处」，而不是悄悄挂到别人身上。
 */
export function notesFor(personId, storyId, beats) {
  const prefix = `${storyKey(personId, storyId)}#`
  const out = []
  for (const [key, note] of Object.entries(libraryStore.get().notes)) {
    if (!key.startsWith(prefix)) continue
    const [, beat] = splitNoteKey(key)
    let place = beat
    let moved = false
    if (note.anchor && Array.isArray(beats) && beats.length) {
      const strip = (s) => String(s || '').replace(/[\s，。、；：！？「」『』《》（）()·—…“”‘’"'!?,.;:]/g, '')
      const hit = beats.findIndex((b) => strip((b?.prose || [])[0]).includes(strip(note.anchor)))
      if (hit >= 0 && hit + 1 !== beat) { place = hit + 1; moved = true }
      else if (hit < 0 && beat > beats.length) { place = beats.length; moved = true }
    } else if (Array.isArray(beats) && beats.length && beat > beats.length) {
      place = beats.length
      moved = true
    }
    out.push({ key, beat: place, text: note.text, at: note.at, moved })
  }
  return out.sort((a, b) => a.beat - b.beat)
}

export { NOTE_LIMIT }
