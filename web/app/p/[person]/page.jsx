import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPerson, listPeople } from '@/lib/content'
import { formatRanges } from '@/lib/range'
import SealMark from '@/components/SealMark'
import StarButton from '@/components/StarButton'
import RecentRead from '@/components/RecentRead'

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
  const books = person.books || []

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

      {/* 最近阅读与完整资料。**不挂在「引子」里**——它们和引子没有关系；
          原来的位置只要哪个人物没有 why，这两块就一起消失。
          两块共用一层 `.sec`：有进度时是 58 / 26 的节奏；没有进度时
          26 与 58 折叠成 58，和其他分节一致。 */}
      <section className="sec">
        <RecentRead personId={person.id} stories={person.storyList.map((story) => ({
          ...story, beatTotal: person.stories[story.id]?.beats.length || 1,
        }))} />

        <section style={{ marginTop: 26 }}>
          <Link href={`/p/${person.id}/source`} className="entry-card">
            <b>完整资料</b>
            <span>{person.sourceCount} 段原文，附逐段白话</span>
          </Link>
        </section>
      </section>

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
                    /* 收藏按钮是链接的**兄弟**，不是子节点：<a> 里放 <button>
                       是非法嵌套，键盘与读屏都会出问题。整卡仍可点（链接铺满）。 */
                    <div key={s.id} className="story-card ready">
                      <Link href={`/p/${person.id}/${s.id}`} className="sc-body">
                        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                          {s.img && <img className="thumb" src={s.img} alt="" aria-hidden="true" />}
                          <div style={{ minWidth: 0, flex: 1 }}>{inner}</div>
                        </div>
                      </Link>
                      <StarButton personId={person.id} storyId={s.id} storyName={s.name} />
                      <SealMark />
                    </div>
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
            表中的绝对年代不是{person.sourceBook || '底本'}原文所载，系后世考证。
          </p>
        </section>
      )}

      <p className="footnote" style={{ marginTop: 44 }}>
        {/* 编号按**底本**分组写，并且把书名带出来。
            这里原来是 `编号 001–{段数}`——32 段就印成「编号 001–032」，
            而真正的编号是 001–020、101–103、201–209，**页面上写了一句不存在的话**。
            而且那三个号段就是三本书，读者该看到的是书名，不是「底本」两个字。 */}
        <b>底本</b>（这一页所依据的书）{person.sourceCount} 段{books.length > 1 ? `，分 ${books.length} 组` : ''}：
        {books.map((b) => `${b.book} ${formatRanges(b.ids)}`).join(' · ')}。
      </p>

      <div style={{ height: 90 }} />
    </main>
  )
}
