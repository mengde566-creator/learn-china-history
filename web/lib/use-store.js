'use client'

import { useRef, useSyncExternalStore } from 'react'

const PLAIN = (v) => v !== null && typeof v === 'object'

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true
  /* 数组单独比：内容相同的两个新数组要算相等。
     漏掉这一支的话，selector 返回数组时缓存永远不命中，
     每次广播都换引用，渲染就停不下来。 */
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => Object.is(item, b[i]))
  }
  if (!PLAIN(a) || !PLAIN(b)) return false
  if (Array.isArray(a) || Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.is(a[k], b[k]))
}

/**
 * 订阅存储的一部分。
 *
 * `selector` 必须返回**引用稳定**的值（原始值，或每次重建但浅相等的对象/数组）——
 * 否则 useSyncExternalStore 会认为状态一直在变。这里用一层缓存把浅相等的返回值固定住。
 *
 * `getServerSnapshot` 也必须缓存：React 在 hydration 时会把两次调用结果做 `===` 比较，
 * 每次新建对象会在开发环境里打 "The result of getServerSnapshot should be cached"。
 */
export function useStoreSelector(store, selector) {
  const cache = useRef({ has: false, value: undefined })
  const serverCache = useRef({ has: false, value: undefined })

  const getSnapshot = () => {
    const next = selector(store.get())
    if (!cache.current.has || !shallowEqual(cache.current.value, next)) {
      cache.current = { has: true, value: next }
    }
    return cache.current.value
  }

  /* 服务端没有本机数据，用默认值——本机记录不该出现在首屏。 */
  const getServerSnapshot = () => {
    const next = selector(store.defaults)
    if (!serverCache.current.has || !shallowEqual(serverCache.current.value, next)) {
      serverCache.current = { has: true, value: next }
    }
    return serverCache.current.value
  }

  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot)
}

/** 写不进去（隐私模式、配额满）时，界面要能看见这件事。 */
export function useStoreStatus(store) {
  return useSyncExternalStore(store.subscribe, () => store.getStatus(), () => 'ok')
}
