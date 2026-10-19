'use client'

import { useState } from 'react'
import RichText, { Marker } from '@/components/RichText'
import CiteText from '@/components/CiteText'
import { useProgress, markReview, storyKey } from '@/lib/progress'

/**
 * 复习卡。默认只显示问题，点开看答案——这样才叫复习，不是读一遍。
 *
 * **「展开过答案」不写任何状态。** 掌握与否只能由读者自己按——
 * 展开就记成「已掌握」，那是替读者下结论（任务书 R12 明说）。
 */
export default function ReviewCards({ cards, personId, storyId, sourceIds, onJump }) {
  const [open, setOpen] = useState(() => new Set())
  const { progress, ready } = useProgress()
  const mine = (progress.review[storyKey(personId, storyId)] || {})

  const toggle = (n) =>
    setOpen((prev) => {
      const next = new Set(prev)
      next.has(n) ? next.delete(n) : next.add(n)
      return next
    })

  return (
    <div className="cards">
      {cards.map((c) => {
        const shown = open.has(c.n)
        return (
          <article key={c.n} className="card">
            <span className="tag">{c.type}</span>
            <div className="q"><RichText text={c.q} /></div>

            {shown ? (
              <div className="a anim-fade">
                {(c.blocks || []).map((b, i) =>
                  b.t === 'p' ? (
                    <p key={i} style={{ marginBottom: '.6em' }}><RichText text={b.v} /></p>
                  ) : b.t === 'pre' ? (
                    <pre key={i} className="review-code">{b.v}</pre>
                  ) : (
                    <table key={i} className="mini-table">
                      <thead>
                        <tr>{b.head.map((h, j) => <th key={j}><RichText text={h} /></th>)}</tr>
                      </thead>
                      <tbody>
                        {b.rows.map((r, ri) => (
                          <tr key={ri}>
                            {r.map((cell, ci) => <td key={ci}><RichText text={cell} /></td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}
                {c.meta.length > 0 && (
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--zhi-3)', fontSize: 11.5, color: 'var(--mo-mute)' }}>
                    {c.meta.map((m, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, padding: '2px 0' }}>
                        <span style={{ flex: 'none', width: 46 }}>{m.k}</span>
                        <span>
                          {/* 「标记」这一行渲染成徽章，和种子清单一致——
                              原来它只是一行灰字，读者看到的是一串「◆ 出自原文」，
                              而标记的颜色是这套东西里区分史料等级的唯一手段。 */}
                          {m.k === '标记' && c.marker
                            ? <><Marker ch={c.marker} size={11} /> {m.v.replace(/^[◆◇○△—]\s*/, '')}</>
                            : m.k === '依据' ? <CiteText text={m.v} ids={sourceIds} onJump={onJump} /> : <RichText text={m.v} />}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                className="a"
                onClick={() => toggle(c.n)}
                style={{ textAlign: 'left', color: 'var(--mo-dim)', cursor: 'pointer' }}
              >
                点开看答案 ▸
              </button>
            )}

            {shown && (
              <>
                <button
                  onClick={() => toggle(c.n)}
                  style={{ marginTop: 14, fontSize: 11.5, color: 'var(--mo-mute)', letterSpacing: '.08em', textAlign: 'left' }}
                >
                  收起
                </button>
                {/* **掌握与否由读者按。** 展开只是展开，不写状态。 */}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  {[['todo', '待复习'], ['known', '已掌握']].map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => markReview(personId, storyId, c.n, mine[c.n] === k ? null : k)}
                      aria-pressed={ready && mine[c.n] === k}
                      style={{
                        fontSize: 11.5, letterSpacing: '.06em', padding: '3px 9px', cursor: 'pointer',
                        borderRadius: 2, background: 'none',
                        border: `1px solid ${mine[c.n] === k ? 'var(--zhu)' : 'var(--zhi-3, rgba(0,0,0,.16))'}`,
                        color: mine[c.n] === k ? 'var(--zhu)' : 'var(--mo-mute)',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  {mine[c.n] && (
                    <span style={{ fontSize: 11, color: 'var(--mo-mute)' }}>已记在本机（再按一次可取消）</span>
                  )}
                </div>
              </>
            )}
            <div className="inline-panel-host" data-panel-host />
          </article>
        )
      })}
    </div>
  )
}
