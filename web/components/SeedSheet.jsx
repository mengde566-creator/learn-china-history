'use client'

import { useState, useMemo, useEffect } from 'react'
import RichText, { Marker } from '@/components/RichText'

/**
 * 提问面板。
 *
 * ⚠️ 这是「无 AI 模式」的形态：不是禁用输入框，而是换成一份可选的问题清单。
 * 降级不是错误态，是另一种形态——用户不该感觉到"少了什么"。
 * M2b 接入 AI 后，这里会再加上自由输入，但清单仍然保留（缓存 + 范例）。
 */
export default function SeedSheet({ seeds, onClose }) {
  const [active, setActive] = useState(0)

  const grouped = useMemo(() => {
    const map = new Map()
    for (const s of seeds) {
      if (!map.has(s.group)) map.set(s.group, [])
      map.get(s.group).push(s)
    }
    return [...map.entries()]
  }, [seeds])

  const flat = useMemo(() => grouped.flatMap(([, arr]) => arr), [grouped])
  const seed = flat[active]

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  let idx = -1

  return (
    <div className="sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2>你 此 刻 想 问 谁 ？</h2>
          <span className="note">
            当前为无 AI 模式 · 共 {seeds.length} 个问题，全部经人工审校
          </span>
          <button className="x" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="sheet-body">
          <nav className="seed-nav">
            {grouped.map(([group, arr]) => (
              <div key={group}>
                <div className="grp">
                  {group.replace(/^[一二三四五六七八九十]+、/, '')} · {arr.length}
                </div>
                {arr.map((s) => {
                  idx += 1
                  const mine = idx
                  return (
                    <button
                      key={mine}
                      aria-current={mine === active}
                      onClick={() => setActive(mine)}
                    >
                      {s.q}
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          <div className="seed-view">
            {seed && (
              <div key={active} className="anim-fade">
                <div className="q">
                  {seed.q}
                  {seed.marker && <span style={{ marginLeft: 12 }}><Marker ch={seed.marker} size={12} /></span>}
                </div>

                <div className="a">
                  {seed.answer.length > 0 ? (
                    seed.answer.map((line, i) => {
                      /* 判断一行是「台词」还是「舞台指示 / 叙述」——
                         不能靠角色名（那等于把人物写死在组件里）。
                         结构判据：带「」的是台词；有冒号没引号的是舞台指示。 */
                      const isSpeech = /[「『]/.test(line)
                      const isDir = !isSpeech && (line.includes('：') || line.length < 18)
                      return (
                        <p key={i} className={isDir ? 'stage-dir' : undefined} style={{ animationDelay: `${i * 90}ms` }}>
                          {line}
                        </p>
                      )
                    })
                  ) : (
                    <p className="stage-dir">（没有回答）</p>
                  )}
                </div>

                {seed.sys && <div className="sys-note">{seed.sys}</div>}

                {seed.meta.length > 0 && (
                  <div className="seed-meta">
                    {seed.meta.map((m, i) => (
                      <div className="row" key={i}>
                        <span className="k">{m.k}</span>
                        <span className="v"><RichText text={m.v} /></span>
                      </div>
                    ))}
                  </div>
                )}              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
