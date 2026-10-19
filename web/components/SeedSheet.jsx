'use client'

import { useState, useMemo, useEffect, useRef, useId } from 'react'
import RichText, { Marker } from '@/components/RichText'
import CiteText from '@/components/CiteText'

/**
 * 提问面板。
 *
 * ⚠️ 这是「无 AI 模式」的形态：不是禁用输入框，而是换成一份可选的问题清单。
 * 降级不是错误态，是另一种形态——用户不该感觉到"少了什么"。
 * **产品不做 AI 自由对话**（用户已明确），所以这里只有这份清单——不会再加上自由输入。
 */
export default function SeedSheet({ seeds, source = {}, onClose }) {
  const [active, setActive] = useState(0)
  const [citation, setCitation] = useState(null)
  const dialog = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleId = useId()

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
    const origin = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector('button')?.focus({ preventScroll: true })
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); return }
      if (e.key !== 'Tab') return
      const items = [...(dialog.current?.querySelectorAll('button,a[href],[tabindex="0"]') || [])].filter(el => el.getClientRects().length)
      if (!items.length) return
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus() }
      else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      if (origin?.isConnected) origin.focus({ preventScroll: true })
    }
  }, [])

  let idx = -1

  return (
    <div className="sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet-inner" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sheet-head">
          <h2 id={titleId}>读 后 追 问</h2>
          <span className="note">
            共 {seeds.length} 个预置问题，附史料依据
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
                      onClick={() => { setActive(mine); setCitation(null) }}
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
                  ) : seed.sys ? null : (
                    /* **有 sys 就别印「（没有回答）」。**
                       系统层的 ⓘ 写在围栏代码块里时会解析成 sys，回答行是空的，
                       于是界面先印一行灰字「（没有回答）」、紧接着把那段解释贴出来——
                       自相矛盾。最刺眼的是「为什么有的回答是"没有回答"？」那一条，
                       它自己被显示成「没有回答」。
                       全库 10 篇、58 条中招，因为形状踩在渲染兜底上，编译器一路全绿。
                       兜底只该用在**真的什么都没有**的种子上。 */
                    <p className="stage-dir">（没有回答）</p>
                  )}
                </div>

                {/* **走 RichText，不走明文。** 系统说明里写了 `` `013` `` 这种编号，
                    明文渲染会把反引号一起印给读者（全库 250 条 sys 里 13 条含 markdown）。
                    粗体不渲染（见 README「`**粗体**` 不渲染，这是有意的」）——
                    解析时已经剥掉，这里只管把反引号变成 <code>。 */}
                {seed.sys && <div className="sys-note"><RichText text={seed.sys} /></div>}

                {seed.meta.length > 0 && (
                  <div className="seed-meta">
                    {seed.meta.map((m, i) => (
                      <div className="row" key={i}>
                        <span className="k">{m.k}</span>
                        <span className="v">{m.k === '依据' ? <CiteText text={m.v} ids={Object.keys(source)} onJump={setCitation} /> : <RichText text={m.v} />}</span>
                      </div>
                    ))}
                  </div>
                )}
                {citation && source[citation] && (
                  <section className="seed-citation">
                    <button type="button" onClick={() => setCitation(null)}>收起原文</button>
                    <p>{source[citation].origin} · {citation}</p>
                    <blockquote>{source[citation].text}</blockquote>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
