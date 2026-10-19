import { plainSourceText, sourceLayersForText } from '@/lib/source-layers.mjs'

/** 同一编号内逐片交代正文、引书和按语；编号、原文及引用目标均不拆迁。 */
export default function SourceText({ source, excerpt, gloss }) {
  const parts = sourceLayersForText(source, excerpt)
  if (!parts) return gloss == null ? plainSourceText(excerpt ?? source.text) : <>
    <p className="src-text">{plainSourceText(source.text)}</p>
    <p className="src-gloss"><span className="lead">白话</span>{plainSourceText(gloss)}</p>
  </>
  return parts.map((part, i) => (
    <section key={i} className="source-layer" data-source-tier={part.tier} style={{ marginTop: i ? 16 : 0 }}>
      <div className="source-layer-heading" style={{ fontSize: 11, color: 'var(--mo-mute)', lineHeight: 1.8 }}>
        <span className="tag" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{part.origin}</span>
      </div>
      {gloss == null
        ? <div className="source-layer-text">{plainSourceText(part.text)}</div>
        : <>
          <p className="src-text">{plainSourceText(part.text)}</p>
          <p className="src-gloss"><span className="lead">白话</span>{plainSourceText(part.gloss)}</p>
        </>}
    </section>
  ))
}
