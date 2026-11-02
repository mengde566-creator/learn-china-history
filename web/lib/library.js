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
 *   { v: 1, stars: { "caocao/09-chibi": { at: 1762… } } }
 * 将来加朱批：`notes: { "caocao/09-chibi#5": { text, at, anchor } }`——平表，不嵌套。
 */

const KEY = 'guanshi.library.v1'

export { storyKey }

/** 形状校验：只认 `人物/篇` 且时间戳是数字的记录。 */
function sanitizeLibrary(raw, defaults) {
  const stars = {}
  for (const [key, value] of Object.entries(raw?.stars || {})) {
    if (!isStoryKey(key)) continue
    if (!value || typeof value !== 'object') continue
    const at = Number(value.at)
    stars[key] = { at: Number.isFinite(at) ? at : 0 }
  }
  return { ...defaults, stars }
}

export const libraryStore = createPersistentStore({
  key: KEY,
  version: 1,
  defaults: { stars: {} },
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
