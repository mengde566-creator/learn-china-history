'use client'

import { useEffect, useState, useCallback } from 'react'

const KEY = 'guanshi.settings.v1'

export const DEFAULTS = {
  /** AI 对话开关。M2a 尚未接入——此值先存下来，M2b 直接读它。 */
  aiEnabled: false,
  /** 全局浅色（照顾长时间暗色阅读疲劳） */
  lightStage: false,
}

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

export function useSettings() {
  const [settings, setSettings] = useState(DEFAULTS)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setSettings(loadSettings())
    setReady(true)
  }, [])

  const update = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])

  // 全局浅色生效
  useEffect(() => {
    if (!ready) return
    document.body.classList.toggle('light-stage', !!settings.lightStage)
  }, [settings.lightStage, ready])

  return { settings, update, ready }
}
