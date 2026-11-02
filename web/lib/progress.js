'use client'

import { useEffect, useState } from 'react'
import { createPersistentStore } from '@/lib/store'
import { useStoreSelector } from '@/lib/use-store'

/**
 * 本地阅读进度与复习状态。**只用 localStorage**，不做登录、云同步、提醒或记忆算法。
 *
 * 三条界线（任务书 R12，保留）：
 * 1. **「展开过答案」不等于「已掌握」**——复习卡的状态只能由读者自己按，展开不写状态。
 * 2. **按人物 ID + 故事 ID 存**，不同故事不串（`01-jingkou` 同时属于 liuyu 与 tandaoji）。
 * 3. **存坏了、写不进去，阅读照常**——容错在 `lib/store.js` 里统一做。
 *
 * 数据结构（v2）：
 *   {
 *     v: 2,
 *     read:   { "caocao/09-chibi": { beat, beats, anchor, done, doneAt, phase, at } },
 *     review: { "caocao/09-chibi": { "3": "known" | "todo" } },
 *   }
 *
 * **键名停在 `guanshi.progress.v1`，载荷里的 `v` 才是版本。** 这是刻意的：
 * 旧版代码只认 `read`/`review`，不认 `v`——同一键写 v2 载荷之后，
 * `git revert` 回去的旧版照样读得到；换键名反而做不到（旧版看不见新键）。
 * 代价是名字与内容不一致，所以这句注释必须留着。
 *
 * **`last` 没有了**：全仓无读者，且 `resetStory` 只比篇 id 不比人物，
 * 复位一个会误清另一个。要「最近」，从 `read` 按 `at` 排。
 */

const KEY = 'guanshi.progress.v1'
const EMPTY = { read: {}, review: {} }

export const storyKey = (personId, storyId) => `${personId}/${storyId}`

/* 2026-10-18：三篇把开头的前情移入铺陈与背景，正文段号随之提前。
   这张表只服务**写锚点之前**的旧记录（saved.beats 为空时）；
   之后的每一次内容改动都由 anchor 处理，不再往这里加行。 */
const OPENING_EDITS = {
  'caocao/01-wusebang': { before: 10, after: 7, removed: 3 },
  'caocao/04-xingyang': { before: 9, after: 8, removed: 1 },
  'caocao/06-qingzhou': { before: 10, after: 5, removed: 5 },
}

const STRIP = /[\s，。、；：！？「」『』《》（）()·—…“”‘’"'!?,.;:]/g
const normalize = (s) => String(s || '').replace(STRIP, '')

/** 这一段的「锚点」：段首自然段去标点后前 16 字。内容改版后靠它找回同一段。 */
export function beatAnchor(beat) {
  return normalize((beat?.prose || [])[0]).slice(0, 16)
}

/** v1 → v2：`beatCount` 改名 `beats`，`last` 丢弃，记录里多余的键不保留。 */
function migrateV1(raw) {
  const read = {}
  for (const [k, v] of Object.entries(raw?.read || {})) {
    if (!v || typeof v !== 'object') continue
    read[k] = { ...v, beats: v.beats ?? v.beatCount }
  }
  return { read, review: raw?.review && typeof raw.review === 'object' ? raw.review : {} }
}

/** 形状校验：不认识的字段不进状态，`beat` 一定是个正整数。 */
export function sanitizeProgress(raw, defaults) {
  const out = { ...defaults, read: {}, review: {} }
  for (const [k, v] of Object.entries(raw?.read || {})) {
    if (!v || typeof v !== 'object') continue
    const beat = Math.floor(Number(v.beat))
    if (!Number.isFinite(beat) || beat < 1) continue
    const rec = { beat, at: Number(v.at) || 0, done: Boolean(v.done) }
    const beats = Math.floor(Number(v.beats))
    if (Number.isFinite(beats) && beats > 0) rec.beats = beats
    if (typeof v.anchor === 'string' && v.anchor) rec.anchor = v.anchor.slice(0, 40)
    if (Number.isFinite(Number(v.doneAt))) rec.doneAt = Number(v.doneAt)
    if (v.phase === 'live') rec.phase = 'live'
    out.read[k] = rec
  }
  for (const [k, v] of Object.entries(raw?.review || {})) {
    if (!v || typeof v !== 'object') continue
    const cards = {}
    for (const [no, status] of Object.entries(v)) {
      if (status === 'known' || status === 'todo') cards[String(no)] = status
    }
    if (Object.keys(cards).length) out.review[k] = cards
  }
  return out
}

export const progressStore = createPersistentStore({
  key: KEY,
  version: 2,
  defaults: EMPTY,
  migrate: migrateV1,
  sanitize: sanitizeProgress,
})

/**
 * 这一段该从第几段接。返回 `{ beat, adjusted }`。
 *
 * 顺序：段数没变就照旧；旧记录先过历史改动表；有锚点就在现在的正文里找同一段；
 * 都找不到就 clamp——**clamp 是唯一不撒谎的选择，所以 `adjusted` 必须让读者看见**。
 */
export function resolveResume(personId, storyId, saved, count, beats) {
  const total = Math.max(1, count)
  if (!saved || !saved.beat) return { beat: 1, adjusted: false }
  const raw = Math.floor(Number(saved.beat) || 1)
  const clamp = (n) => Math.min(Math.max(1, n), total)
  if (saved.done) return { beat: total, adjusted: false }
  if (saved.beats === total) return { beat: clamp(raw), adjusted: false }

  /* 旧改动表：**先减段再 clamp**。反过来会先把 7 夹到 5、再减 5 变成 1，
     而读者停的其实是第 2 段（原 7 段减去被移走的 5 段）。 */
  const edit = OPENING_EDITS[storyKey(personId, storyId)]
  if (edit && total === edit.after && (saved.beats == null || saved.beats === edit.before)) {
    return { beat: clamp(raw - edit.removed), adjusted: true }
  }

  const anchor = normalize(saved.anchor)
  if (anchor && Array.isArray(beats) && beats.length) {
    const hit = beats.findIndex((b) => normalize((b?.prose || [])[0]).includes(anchor))
    if (hit >= 0) return { beat: hit + 1, adjusted: hit + 1 !== clamp(raw) }
  }
  return { beat: clamp(raw), adjusted: saved.beats != null && saved.beats !== total }
}

/** 兼容用的薄包装：只关心段号的地方调它。 */
export function resumeBeat(personId, storyId, saved, count, beats) {
  return resolveResume(personId, storyId, saved, count, beats).beat
}

/** 记下读到第几段 / 读完了。锚点是「读到那一段的开头」，供改版后重定位。 */
export function markRead(personId, storyId, patch) {
  const k = storyKey(personId, storyId)
  const now = Date.now()
  progressStore.set((state) => {
    const prev = state.read[k] || {}
    return {
      ...state,
      read: { ...state.read, [k]: { ...prev, ...patch, at: now } },
    }
  })
}

/** 复习卡状态。`null` = 清掉这条。 */
export function markReview(personId, storyId, cardNo, status) {
  const k = storyKey(personId, storyId)
  progressStore.set((state) => {
    const cur = { ...(state.review[k] || {}) }
    if (status === null) delete cur[String(cardNo)]
    else cur[String(cardNo)] = status
    return { ...state, review: { ...state.review, [k]: cur } }
  })
}

/** 从头读：清掉这一篇的进度，**复习状态保留**（那是两件事）。 */
export function resetStory(personId, storyId) {
  const k = storyKey(personId, storyId)
  progressStore.set((state) => {
    const read = { ...state.read }
    delete read[k]
    return { ...state, read }
  })
}

/** 清掉本功能保存的全部数据（设置页给一个入口，已加二次确认）。 */
export function clearProgress() {
  progressStore.reset()
}

export function useProgress() {
  const progress = useStoreSelector(progressStore, (state) => state)
  const status = useStoreSelector(progressStore, () => progressStore.getStatus())
  /* **`ready` 不能省。** 首帧（含 hydration 那一次）拿到的是
     `getServerSnapshot` = 默认值；这时读 `progress.read` 会误判成「没有进度」。
     StoryClient 的恢复逻辑靠 `ready` 让过这一帧，早先的 `restoredRef` 一旦
     在这一帧被锁死，就再也不恢复了。 */
  const [ready, setReady] = useState(false)
  useEffect(() => { setReady(true) }, [])
  return { progress, ready, status }
}
