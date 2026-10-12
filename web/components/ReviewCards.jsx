'use client'

import { useState } from 'react'
import RichText from '@/components/RichText'

/**
 * 复习卡。默认只显示问题，点开看答案——这样才叫复习，不是读一遍。
 */
export default function ReviewCards({ cards }) {
  const [open, setOpen] = useState(() => new Set())

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
                        <span><RichText text={m.v} /></span>
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
              <button
                onClick={() => toggle(c.n)}
                style={{ marginTop: 14, fontSize: 11.5, color: 'var(--mo-mute)', letterSpacing: '.08em', textAlign: 'left' }}
              >
                收起
              </button>
            )}
          </article>
        )
      })}
    </div>
  )
}
