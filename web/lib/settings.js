'use client'

import { useEffect, useState } from 'react'

/**
 * 设置。**全应用共享一份状态。**
 *
 * 原来 `useSettings()` 内部各持一个 `useState`——导航和设置页各调一次，
 * 就有两份独立状态：设置页开了浅色，页面变浅了，**导航还显示「暗场」**。
 * 现在状态放在模块级，所有订阅者读同一份，改动广播给全部。
 *
 * 产品范围：**不做 AI 自由对话**（用户已明确）。所以这里没有 AI 开关，
 * 也没有「开启后可以自己输入问题」这类承诺——静态预置问答是学习资料，不走设置。
 */

const KEY = 'guanshi.settings.v1'

export const DEFAULTS = {
  /** 全局浅色（照顾长时间暗色阅读疲劳） */
  lightStage: false,
}

let state = DEFAULTS
const subs = new Set()

export function loadSettings() {
  if (typeof window === 'undefined') return DEFAULTS
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(next) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
}

/** 改设置：写盘 + 广播给所有订阅者。 */
export function updateSettings(patch) {
  state = { ...state, ...patch }
  saveSettings(state)
  for (const fn of subs) fn(state)
}

export function useSettings() {
  const [settings, setSettings] = useState(state)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    /* 挂载时读盘；**并订阅**——别的组件改了，这里立刻跟上 */
    state = loadSettings()
    setSettings(state)
    setReady(true)
    subs.add(setSettings)
    return () => { subs.delete(setSettings) }
  }, [])

  /* 全局浅色生效。**只在一个地方做**（原来每个订阅者各做一次，
     两份状态各切一次 class，谁最后跑谁说了算）。 */
  useEffect(() => {
    if (!ready) return
    document.body.classList.toggle('light-stage', !!settings.lightStage)
  }, [settings.lightStage, ready])

  return { settings, update: updateSettings, ready }
}
