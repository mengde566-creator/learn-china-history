'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import RichText, { Marker, Legend } from '@/components/RichText'
import SeedSheet from '@/components/SeedSheet'
import ReviewCards from '@/components/ReviewCards'

/* 界面上只放短标签。长说明在图例里出现一次就够——
   原来每个标记都重复一遍「出自原文，可逐字核对」，纯属噪音。 */
const TITLES = {
  '◆': '出自原文',
  '○': '合理推演',
  '△': '存疑',
  '—': '史书未载',
}
const MARK_CLASS = { '◆': 'g-source', '○': 'g-infer', '△': 'g-doubt', '—': 'g-silent' }

const TABS = [
  { k: 'evidence',    label: '依据' },
  { k: 'source',      label: '原文' },
  { k: 'backgrounds', label: '背景' },
  { k: 'ground',      label: '映射' },
  { k: 'present',     label: '在场' },
]

/** 面包屑：导航只放全局入口，层级靠这里走 */
function Crumbs({ person, story }) {
  return (
    <div className="crumbs">
      <Link href="/">总览</Link>
      <span>／</span>
      <Link href={`/p/${person.id}`}>{person.name}</Link>
      <span>／</span>
      <span>{story.name}</span>
    </div>
  )
}

/** 判断「依据」正文是否只是在重复旁边已经引过的原文。
 *  是的话就不渲染——原文本身就是证据，标记负责说明它的地位。
 *  比对的是该段**全部**底本（sources），不只「原文」栏那一条。
 *  编号本身不算内容：作者常写「012〈…〉；013 鞠武谏；014」这种指路条，
 *  把编号剥掉之后它就只是引文的拼接，和上面列的重复。 */
function evidenceAdds(beat, source) {
  const strip = (s) => (s || '')
    .replace(/`?\d{3}`?/g, '')
    .replace(/[「」『』。，、；：！？·\s（）()]/g, '')
  const g = strip(beat?.ground)
  if (!g || g.length <= 4) return false
  const hay = (beat?.sources || []).map((id) => strip(source[id]?.text)).join('')
  return !hay.includes(g)
}

export default function StoryClient({ person, story, source }) {
  const [phase, setPhase] = useState('opening') // opening | live
  const [revealed, setRevealed] = useState(1)
  const [tab, setTab] = useState('evidence')
  const [following, setFollowing] = useState(1)  // 读到第几段（依据面板跟着它走）
  const [sheet, setSheet] = useState(false)
  const stageRef = useRef(null)

  const beats = story.beats
  const isLast = revealed >= beats.length
  const shownBeat = beats[following - 1] || beats[0]

  /* 读完一篇直接进下一篇。顺序取人物页的篇目顺序，只数已实现的——
     未实现的排进去会点进一个空页。 */
  const readyList = person.storyList.filter((s) => s.ready)
  const at = readyList.findIndex((s) => s.id === story.id)
  const prevStory = at > 0 ? readyList[at - 1] : null
  const nextStory = at >= 0 && at < readyList.length - 1 ? readyList[at + 1] : null

  /* 把某一段滚到滚动区中央。
     桌面是阅读器布局——场景区自己是滚动容器，所以滚它，不滚页面。
     内容还没超出容器时什么都不做（此时本来也不需要滚）。 */
  const scrollToBeat = useCallback((n) => {
    const stage = stageRef.current
    const el = document.getElementById(`beat-${n}`)
    if (!stage || !el) return
    if (stage.scrollHeight <= stage.clientHeight + 4) return
    const top = el.offsetTop - stage.clientHeight / 2 + el.clientHeight / 2
    stage.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [])

  /* 进入场景时把页面拉回顶部。
     页面本身只负责露出下面的复习卡；阅读发生在场景区内部。 */
  useEffect(() => {
    if (phase === 'live') window.scrollTo({ top: 0 })
  }, [phase])

  useEffect(() => {
    if (phase === 'live') scrollToBeat(revealed)
  }, [revealed, phase, scrollToBeat])

  /* 依据面板跟随阅读位置：
     取「穿过滚动区中线」的那个情节点，左右就不会各看各的。 */
  useEffect(() => {
    if (phase !== 'live') return
    const stage = stageRef.current
    const els = document.querySelectorAll('.beat[data-n]')
    if (!els.length) return
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (hit) setFollowing(Number(hit.target.dataset.n))
      },
      {
        root: stage && stage.scrollHeight > stage.clientHeight + 4 ? stage : null,
        rootMargin: '-45% 0px -45% 0px',
        threshold: 0,
      }
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [phase, revealed])

  /* 时间地点戳：铺陈代码块的第一行就是它 */
  const stamp = story.intro.lines[0]?.text || story.time || ''

  /* ── 入口：情境铺陈 ───────────────────────── */
  if (phase === 'opening') {
    const lines = story.intro.lines.filter((l) => l.text !== stamp)
    return (
      <>
      <main className="wrap">
        <div style={{ paddingTop: 28 }}>
          <Crumbs person={person} story={story} />
        </div>
        <div className={`opening${story.img ? ' has-img' : ''}`}>
          {story.img && (
            <>
              <img className="opening-bg" src={story.img} alt="" aria-hidden="true" />
              <div className="opening-veil" />
            </>
          )}
          <div className="when">{stamp}</div>
          <div className="lines">
            {lines.map((l, i) => (
              <p key={i} className={i >= 2 ? 'dim' : undefined}>
                {l.text}
                {l.marker && <span style={{ marginLeft: 10 }}><Marker ch={l.marker.trim()[0]} size={11} /></span>}
              </p>
            ))}
          </div>
          <button className="cta" onClick={() => setPhase('live')}>
            进 入 {story.place || story.name}
          </button>
        </div>

        <div className="wrap-narrow" style={{ paddingBottom: 90 }}>
          <div className="note-box">
            {(() => {
              const ib = story.intro.basis || []
              if (!ib.length) {
                return <b>{story.intro.lines.length} 行铺陈，尚无逐行依据。</b>
              }
              const orig = ib.filter((r) => r.marker.includes('◆')).length
              return (
                <>
                  <b>
                    铺陈 {story.intro.lines.length} 行 · 逐行依据 {ib.length} 条 · 其中 {orig} 条出自原文。
                  </b>
                  <div style={{ marginTop: 6 }}>
                    {ib.map((r, i) => (
                      <div key={i} className="mark-block">
                        <div className="hd">
                          <span className="label">{r.line}</span>
                          <span
                            className="src mk"
                            style={{ color: r.marker.includes('◆') ? 'var(--zhu)' : 'var(--accent)' }}
                          >
                            {r.marker}
                          </span>
                        </div>
                        <div className="body">{r.basis}</div>
                      </div>
                    ))}
                  </div>
                </>
              )
            })()}
            <div style={{ marginTop: 14 }}><Legend /></div>
          </div>
        </div>
      </main>

      </>
    )
  }

  /* ── 主体：双面 ───────────────────────────── */
  const shownMark = shownBeat?.marker || '—'
  /* 在场人物来自故事文件（`## 在场人物` 一节），不在组件里写死——
     写死的话换个故事就全错了。 */
  const presentHere = story.present.filter((p) => p.here)
  const presentAway = story.present.filter((p) => !p.here)

  return (
    <>
      <main className="wrap" style={{ paddingBottom: 80 }}>
        <div style={{ paddingTop: 24 }}>
          <Crumbs person={person} story={story} />
        </div>
        <div className="face">
          {/* 暗场 */}
          <section className="stage" ref={stageRef}>
            <div className="scene-meta">{stamp}</div>

            <div className="beats">
              {beats.slice(0, revealed).map((b) => {
                /* b.quotes 由编译器给：只有**逐字对得上底本**的那些行才算原文。
                   本地不要再用「有没有引号」去猜——白话对白也带引号。
                   就地渲染，不抽到段末：抽走的话，紧跟其后的白话回译会跑到引文前面。
                   回译跟着引文一起走，就是 06 段 5「——始终没有回头。」那个形状。 */
                const quotes = b.quotes || []
                const glossAt = new Set(quotes.map((q) => q.glossAt).filter((x) => x !== null))
                return (
                  <article key={b.n} data-n={b.n} id={`beat-${b.n}`} className="beat active">
                    <div className="narration anim-emerge">
                      {b.prose.map((p, i) => {
                        const q = quotes.find((x) => x.at === i)
                        if (q) {
                          return (
                            <div key={i} className="emerge anim-emerge d2">
                              <cite>{q.text}</cite>
                              {q.gloss && <span className="gloss">{q.gloss}</span>}
                            </div>
                          )
                        }
                        if (glossAt.has(i)) return null
                        return <p key={i}>{p}</p>
                      })}
                    </div>

                    {/* 插图位：内容里填了「图」才渲染，没填就什么都不占 */}
                    {b.img && (
                      <figure className="beat-figure">
                        <img src={b.img} alt={b.imgCaption || ''} loading="lazy" />
                        {b.imgCaption && <figcaption>{b.imgCaption}</figcaption>}
                      </figure>
                    )}

                    <button
                      className="ground anim-fade d3"
                      onClick={() => { setTab('evidence'); scrollToBeat(b.n) }}
                      title={TITLES[b.marker] || ''}
                    >
                      <b className={MARK_CLASS[b.marker] || 'g-silent'}>{b.marker || '—'}</b>
                      <span className="sep">·</span>
                      依据
                      {b.source && <span className="src-id">{b.source}</span>}
                    </button>
                  </article>
                )
              })}
            </div>

            <div className="ask">
              {!isLast ? (
                <button className="continue" onClick={() => setRevealed((n) => n + 1)}>
                  <span className="word">再 往 前</span>
                  <span className="dots">
                    {beats.map((_, i) => <i key={i} className={i < revealed ? 'on' : ''} />)}
                  </span>
                </button>
              ) : (prevStory || nextStory) ? (
                /* 读完之后，场景底部的这条常驻位换成出口。
                   和「继续」用同一套语言：贴着场景底的一条细线、暗场的字；
                   不是贴一张纸进来（纸是「查账」那边的语言，属于场景外）。 */
                <nav className="next-bar">
                  {prevStory
                    ? <Link href={`/p/${person.id}/${prevStory.id}`} className="prev">
                        <span className="k">上一篇</span><span className="t">{prevStory.name}</span>
                      </Link>
                    : <span />}
                  {nextStory
                    ? <Link href={`/p/${person.id}/${nextStory.id}`} className="next">
                        <span className="k">下一篇</span><span className="t">{nextStory.name}</span>
                      </Link>
                    : <span />}
                </nav>
              ) : (
                /* 这个人物只有这一篇时，上一篇/下一篇都不存在——
                   不留下一条空栏。退回到人物页，别让读者走到死路。 */
                <nav className="next-bar">
                  <span />
                  <Link href={`/p/${person.id}`} className="next">
                    <span className="k">回到</span><span className="t">{person.name}</span>
                  </Link>
                </nav>
              )}
            </div>
          </section>

          {/* 纸面 */}
          <aside className="panel">
            <div className="panel-tabs">
              {TABS.map((t) => (
                <button
                  key={t.k}
                  aria-current={tab === t.k}
                  onClick={() => setTab(t.k)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="panel-body">
              {tab === 'evidence' && shownBeat && (
                <div className="panel-face paper anim-fade" key={shownBeat.n}>
                  <h3>这 一 处 的 依 据</h3>

                  {/* 把这一段依赖的**全部**底本都列出来，不只「原文」栏那一条。
                      场景里常有两三句白话，各自出自不同段落；只引一条，
                      读者会以为译文多出来一段——这正是被指出的那个问题。 */}
                  {(shownBeat.sources || []).map((id) => (
                    <div key={id} className="lead">
                      「{source[id]?.text}」
                      <div style={{ fontSize: 11, color: 'var(--mo-mute)', marginTop: 6, letterSpacing: '.06em' }}>
                        {person.sourceBook} {id}
                      </div>
                    </div>
                  ))}

                  <div className={`mark-block ${
                    shownMark === '◆' ? 'source' : shownMark === '○' ? 'infer' : shownMark === '△' ? 'doubt' : 'silent'
                  }`}>
                    <div className="hd">
                      <span className="glyph mk"><Marker ch={shownMark} size={13} /></span>
                      <span className="label">{TITLES[shownMark]}</span>
                    </div>
                    {/* 依据正文只有在本段底本里找不到时才显示。
                        没有可显示的就不显示——不再补一句「引文即证据，见上」。
                        标记本身已经说完了。 */}
                    {evidenceAdds(shownBeat, source) && (
                      <div className="body"><RichText text={shownBeat.ground} /></div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'source' && (
                <div className="panel-face paper anim-fade">
                  <h3>本 篇 原 文 · {story.sourceRange}</h3>
                  {Object.values(source).map((s) => (
                    <div key={s.id} className="mark-block source">
                      <div className="hd">
                        <span className="glyph mk"><Marker ch="◆" size={11} /></span>
                        <span className="src">{person.sourceBook} {s.id}</span>
                      </div>
                      <div className="quote">{s.text}</div>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'backgrounds' && (
                <div className="panel-face paper anim-fade">
                  <h3>背 景 卡 · {story.backgrounds.length} 张</h3>
                  {story.backgrounds.map((bg, i) => (
                    <div key={i} className="mark-block">
                      <div className="hd">
                        <span className="label" style={{ color: 'var(--mo)' }}>{bg.name}</span>
                        {bg.marker && <span className="glyph mk"><Marker ch={bg.marker} size={11} /></span>}
                      </div>
                      {bg.body.map((p, j) => (
                        <div key={j} className="body" style={{ marginBottom: 8 }}><RichText text={p} /></div>
                      ))}
                      {bg.basis && (
                        <div className="body" style={{ fontSize: 11.5, color: 'var(--mo-mute)', marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--zhi-3)' }}>
                          <RichText text={bg.basis} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {tab === 'ground' && (
                <div className="panel-face paper anim-fade">
                  <h3>依 据 映 射 表 · {story.groundTable.length} 条</h3>
                  {story.groundTable.map((row, i) => (
                    <div key={i} className="mark-block">
                      <div className="hd">
                        <span className="label" style={{ color: 'var(--mo)', fontWeight: 400, fontSize: 13 }}>{row.claim}</span>
                        <span className="src"><RichText text={row.marker} /></span>
                      </div>
                      <div className="body" style={{ fontSize: 12 }}><RichText text={row.basis} /></div>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'present' && (
                <div className="panel-face anim-fade">
                  <h3>此 刻 在 场</h3>
                  {presentHere.map((p) => (
                    <div key={p.name} className="person">
                      <span className="dot" /><span className="n">{p.name}</span><span className="r">{p.role}</span>
                    </div>
                  ))}

                  {presentAway.length > 0 && (
                    <>
                      <h4 style={{ marginTop: 24, fontSize: 11, letterSpacing: '.24em', color: 'var(--su-dim)', fontWeight: 400, marginBottom: 12 }}>
                        已 不 在 场
                      </h4>
                      {presentAway.map((p) => (
                        <div key={p.name} className="person dead">
                          <span className="dot" /><span className="n">{p.name}</span>
                          <span className="r">{p.state.replace(/^不在场[（(]?/, '').replace(/[）)]$/, '')}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>

        {/* 读完之后 */}
        {isLast && (
          <section style={{ marginTop: 56 }}>
            {story.cards.length > 0 ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
                  <h2 style={{ fontFamily: 'var(--f-song)', fontSize: 17, letterSpacing: '.14em', fontWeight: 600 }}>
                    读完之后 · {story.cards.length} 张复习卡
                  </h2>
                </div>
                <ReviewCards cards={story.cards} />
              </>
            ) : (
              <div className="card-hint" style={{ textAlign: 'left' }}>
                本篇暂无复习卡
              </div>
            )}

            {/* 提问入口。原来贴在场景底部，现在挪到复习卡之后——
                读完之后先看这一篇的账（复习卡），再开口问。
                仍然是和「继续」同一种形态：一条细线、左侧光标、右侧提示。 */}
            {story.seeds.length > 0 ? (
              <button className="ask-btn ask-after" onClick={() => setSheet(true)}>
                <span className="caret" />
                <span>你想说什么</span>
                <span className="hint">{story.seeds.length} 个问题可选</span>
              </button>
            ) : (
              /* 还没有对话种子时，不显示一个点了没反应的入口 */
              <div className="ask-empty ask-after">本篇暂无可问的问题</div>
            )}

            <div className="note-box" style={{ marginTop: 34 }}>
              <Link href={`/p/${person.id}`} style={{ color: 'var(--accent)' }}>← {person.name}</Link>
              {' · '}
              <Link href="/settings" style={{ color: 'var(--accent)' }}>设置</Link>
              {' · '}
              <Link href="/" style={{ color: 'var(--accent)' }}>返回总览</Link>
            </div>
          </section>
        )}
      </main>

      {sheet && <SeedSheet seeds={story.seeds} onClose={() => setSheet(false)} />}
    </>
  )
}
