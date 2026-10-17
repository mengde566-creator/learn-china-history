'use client'

import { useEffect, useState } from 'react'

/**
 * 本地阅读进度与复习状态。**只用 localStorage**，不做登录、云同步、提醒或记忆算法。
 *
 * 三条界线（任务书 R12）：
 * 1. **「展开过答案」不等于「已掌握」**——复习卡的状态只能由读者自己按，展开不写状态。
 * 2. **按人物 ID + 故事 ID 存**，不同故事不串。
 * 3. **存坏了、写不进去，阅读照常**——所有读写都包在 try 里，坏数据当没有。
 *
 * 数据结构：
 *   {
 *     read:    { "caocao/09-chibi": { beat: 5, done: true, at: 1697… } },
 *     review:  { "caocao/09-chibi": { "3": "known" | "todo" } },
 *     last:    { person: "caocao", story: "09-chibi", at: 1697… },
 *   }
 */

const KEY = 'guanshi.progress.v1'
const EMPTY = { read: {}, review: {}, last: null }

let state = EMPTY
const subs = new Set()

/** 读盘。坏数据一律当没有——**不因为存储坏了就读不了书**。 */
export function loadProgress() {
  if (typeof window === 'undefined') return EMPTY
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return EMPTY
    return {
      read: raw.read && typeof raw.read === 'object' ? raw.read : {},
      review: raw.review && typeof raw.review === 'object' ? raw.review : {},
      last: raw.last && typeof raw.last === 'object' ? raw.last : null,
    }
  } catch {
    return EMPTY
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* 写不进去（隐私模式、配额满）也继续——阅读不该因为存不了而中断 */
  }
}

function emit() { for (const fn of subs) fn(state) }

export const storyKey = (personId, storyId) => `${personId}/${storyId}`

/** 记下读到第几段 / 读完了。 */
export function markRead(personId, storyId, patch) {
  const k = storyKey(personId, storyId)
  const prev = state.read[k] || {}
  state = {
    ...state,
    read: { ...state.read, [k]: { ...prev, ...patch, at: Date.now() } },
    last: { person: personId, story: storyId, at: Date.now() },
  }
  persist(); emit()
}

/** 复习卡状态。`null` = 清掉这条。 */
export function markReview(personId, storyId, cardNo, status) {
  const k = storyKey(personId, storyId)
  const cur = { ...(state.review[k] || {}) }
  if (status === null) delete cur[String(cardNo)]
  else cur[String(cardNo)] = status
  state = { ...state, review: { ...state.review, [k]: cur } }
  persist(); emit()
}

/** 从头读：清掉这一篇的进度，**复习状态保留**（那是两件事）。 */
export function resetStory(personId, storyId) {
  const k = storyKey(personId, storyId)
  const read = { ...state.read }; delete read[k]
  state = { ...state, read, last: state.last?.story === storyId ? null : state.last }
  persist(); emit()
}

/** 清掉本功能保存的全部数据（设置页给一个入口）。 */
export function clearProgress() {
  state = EMPTY
  try { localStorage.removeItem(KEY) } catch {}
  emit()
}

export function useProgress() {
  const [snap, setSnap] = useState(state)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    state = loadProgress()
    setSnap(state)
    setReady(true)
    subs.add(setSnap)
    return () => { subs.delete(setSnap) }
  }, [])
  return { progress: snap, ready }
}
