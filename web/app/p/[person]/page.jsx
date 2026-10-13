import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPerson, listPeople } from '@/lib/content'
import SealMark from '@/components/SealMark'

export function generateStaticParams() {
  return listPeople().map((p) => ({ person: p.id }))
}

export async function generateMetadata({ params }) {
  const { person: pid } = await params
  const person = getPerson(pid)
  return { title: person ? `${person.name} — 观史` : '观史' }
}

export default async function PersonPage({ params }) {
  const { person: pid } = await params
  const person = getPerson(pid)
  if (!person) notFound()

  const ready = person.storyList.filter((s) => s.ready).length

  return (
    <main className="wrap">
      <header className="page-head">
        <div className="crumbs">
          <Link href="/">总览</Link>
          <span>／</span>
          <span>{person.era}</span>
        </div>
        <h1>{person.name}</h1>
        <p className="sub" style={{ marginTop: 4 }}>
          {person.sourceBook}
          {person.died && <>　·　卒于 {person.died}</>}
          　·　{person.storyList.length} 篇
        </p>
      </header>

      {person.portrait && (
        <div className="portrait">
          <img src={person.portrait} alt={person.name} />
        </div>
      )}

      {person.intro.length > 0 && (
        <section className="prose-block">
          {person.intro.map((p, i) => <p key={i}>{p}</p>)}
        </section>
      )}

      {person.why.length > 0 && (
        <section className="sec">
          <h2 className="sec-title">引子</h2>
          <div className="prose-block why">
            {person.why.map((p, i) => <p key={i}>{p}</p>)}
          </div>
        </section>
      )}

      <section className="sec">
        <h2 className="sec-title">故事</h2>
        {/* 按「### 阶段名」分组（曹操那种几十篇的人物要用）。
            没有阶段时只有一个分组，和原来一模一样——荆轲那八篇不受影响。
            每一组各自是一张纸：阶段之间换纸，比在同一张纸上堆五十条清楚。 */}
        {(() => {
          const groups = []
          for (const s of person.storyList) {
            const g = groups.find((x) => x.stage === s.stage)
            if (g) g.items.push(s)
            else groups.push({ stage: s.stage, items: [s] })
          }
          return groups.map((g, gi) => (
            <div key={gi}>
              {g.stage && <h3 className="stage-label">{g.stage}</h3>}
              <div className="story-list">
                {g.items.map((s) => {
                  const inner = (
                    <>
                      {/* 墨痕挂在标题下面——它是"给这一条划的重点"，
                          不是卡片的装饰边框 */}
                      <div className="q">{s.scene || s.question}</div>
                      <div className="nm">{s.name}</div>
                      <div className="mt">
                        {s.time}
                        {s.duration && <>　·　{s.duration}</>}
                        {s.sourceRange && <>　·　原文 {s.sourceRange}</>}
                      </div>
                    </>
                  )
                  return s.ready ? (
                    <Link key={s.id} href={`/p/${person.id}/${s.id}`} className="story-card ready">
                      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                        {s.img && <img className="thumb" src={s.img} alt="" aria-hidden="true" />}
                        <div style={{ minWidth: 0, flex: 1 }}>{inner}</div>
                      </div>
                      <SealMark />
                    </Link>
                  ) : (
                    <div key={s.id} className="story-card locked">
                      {inner}
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        })()}
      </section>

      {person.timeline?.length > 0 && (
        <section className="sec">
          <h2 className="sec-title">行迹</h2>
          <div className="timeline">
            {person.timeline.map((t, i) => (
              <div key={i} className="tl-row">
                <span className="tl-time">{t.time}</span>
                <span className="tl-event">{t.event}</span>
                <span className="tl-story">{t.story}</span>
              </div>
            ))}
          </div>
          <p className="footnote">
            表中的绝对年代不是《史记》原文所载，系后世考证。
          </p>
        </section>
      )}

      <p className="footnote" style={{ marginTop: 44 }}>
        底本 {person.sourceCount} 段，编号 001–{String(person.sourceCount).padStart(3, '0')}。
        <b>尚未与实体书核对。</b>
      </p>

      <div style={{ height: 90 }} />
    </main>
  )
}
