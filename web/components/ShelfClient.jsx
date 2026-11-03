'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import StarButton from '@/components/StarButton'
import { useProgress, resolveResume } from '@/lib/progress'
import { useStars } from '@/lib/library'

/**
 * 书架：同一页的两面。
 *
 * 「我的」放读者自己留下的东西（读到哪、收藏了什么），
 * 「全部篇章」是全书目录（19 位人物、130 篇）。两面互切，默认「我的」。
 *
 * **切换不写进网址**：写 `?view=all` 就得在服务端读 query，页面会从静态变成动态。
 * 一个页面内的视图切换不值得那个代价。
 *
 * 这里只列，不作数：不显示阅读时长、不显示百分比、不做「待读队列」。
 * 书架是架子，不是待办。
 */
export default function ShelfClient({ index }) {
  const [view, setView] = useState('mine')
  const { progress, ready } = useProgress()
  const stars = useStars()

  /* 键 → 篇的元信息。130 条，客户端只做查表，不重新遍历内容。 */
  const meta = useMemo(() => {
    const map = new Map()
    for (const person of index) {
      for (const story of person.stories) {
        map.set(`${person.personId}/${story.id}`, {
          personId: person.personId,
          personName: person.personName,
          era: person.era,
          storyId: story.id,
          name: story.name,
          beats: story.beats,
        })
      }
    }
    return map
  }, [index])

  const total = meta.size

  const readList = useMemo(() => Object.entries(progress.read || {})
    .map(([key, record]) => {
      const info = meta.get(key)
      if (!info) return null
      const { beat } = resolveResume(info.personId, info.storyId, record, info.beats)
      return { key, ...info, record, beat, at: record.at || 0 }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at), [progress.read, meta])

  const starList = useMemo(() => Object.entries(stars || {})
    .map(([key, value]) => {
      const info = meta.get(key)
      return info ? { key, ...info, at: value.at || 0 } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at), [stars, meta])

  if (!ready) {
    return (
      <main className="wrap">
        <header className="page-head"><h1>书 架</h1></header>
        <div style={{ height: 120 }} />
      </main>
    )
  }

  const inProgress = readList.filter((item) => !item.record.done)
  const finished = readList.filter((item) => item.record.done)

  const groupByPerson = (list) => {
    const groups = []
    for (const item of list) {
      const group = groups.find((g) => g.personId === item.personId)
      if (group) group.items.push(item)
      else groups.push({ personId: item.personId, personName: item.personName, items: [item] })
    }
    return groups
  }

  const row = (item, { showStar = false } = {}) => (
    <div className="shelf-row" key={item.key}>
      <Link href={`/p/${item.personId}/${item.storyId}`} className="shelf-hit">
        <span className="nm">{item.name}</span>
        <span className="mt">
          {item.record?.done
            ? '已读完'
            : item.record
              ? `读到 ${item.beat} / ${item.beats}`
              : `${item.beats} 段`}
        </span>
      </Link>
      {showStar && (
        <StarButton personId={item.personId} storyId={item.storyId} storyName={item.name} className="in-shelf" />
      )}
    </div>
  )

  const starGroups = groupByPerson(starList)

  return (
    <main className="wrap">
      <header className="page-head">
        <h1>书 架</h1>
        <p className="sub">
          {inProgress.length > 0 ? `在读 ${inProgress.length} 篇` : finished.length > 0 ? `读完 ${finished.length} 篇` : '还没有读过一篇'}
          {finished.length > 0 && inProgress.length > 0 && `　·　读完 ${finished.length} 篇`}
          {starList.length > 0 && `　·　收藏 ${starList.length} 篇`}
          {`　·　共 ${total} 篇`}
        </p>
        <div className="shelf-switch" role="tablist" aria-label="书架视图">
          <button role="tab" aria-selected={view === 'mine'} aria-current={view === 'mine' ? 'true' : undefined} onClick={() => setView('mine')}>我的</button>
          <button role="tab" aria-selected={view === 'all'} aria-current={view === 'all' ? 'true' : undefined} onClick={() => setView('all')}>全部篇章</button>
        </div>
      </header>

      {view === 'mine' ? (
        readList.length === 0 && starList.length === 0 ? (
          <div className="shelf-empty">
            <p>这里还是空的。</p>
            <p className="mt">从<Link href="/">总览</Link>挑一个人物读下去，读过的篇目会出现在这里；在篇目卡上按「藏」，就会进收藏。</p>
          </div>
        ) : (
          <>
            {/* 读到一半的不止一篇：都列出来，按最近推进排序。 */}
            {inProgress.length > 0 && (
              <section className="sec">
                <h2 className="sec-title">在读 · {inProgress.length} 篇</h2>
                {groupByPerson(inProgress).map((group) => (
                  <div key={group.personId} className="shelf-group">
                    <div className="shelf-person">{group.personName}</div>
                    {group.items.map((item) => row(item))}
                  </div>
                ))}
              </section>
            )}

            {starList.length > 0 && (
              <section className="sec">
                <h2 className="sec-title">收藏 · {starList.length} 篇</h2>
                {starGroups.map((group) => (
                  <div key={group.personId} className="shelf-group">
                    <div className="shelf-person">{group.personName}</div>
                    {group.items.map((item) => row({ ...item, record: progress.read[item.key] }, { showStar: true }))}
                  </div>
                ))}
              </section>
            )}

            {finished.length > 0 && (
              <section className="sec">
                <h2 className="sec-title">读完 · {finished.length} 篇</h2>
                {groupByPerson(finished).map((group) => (
                  <div key={group.personId} className="shelf-group">
                    <div className="shelf-person">{group.personName}</div>
                    {group.items.map((item) => row(item))}
                  </div>
                ))}
              </section>
            )}
          </>
        )
      ) : (
        <section className="sec">
          <h2 className="sec-title">全部篇章 · {total} 篇</h2>
          {index.map((person) => (
            <div key={person.personId} className="shelf-group">
              <div className="shelf-person">
                <Link href={`/p/${person.personId}`}>{person.personName}</Link>
                <span className="era">{person.era}　·　{person.stories.length} 篇</span>
              </div>
              {person.stories.map((story) => {
                const key = `${person.personId}/${story.id}`
                const record = progress.read[key]
                const { beat } = record
                  ? resolveResume(person.personId, story.id, record, story.beats)
                  : { beat: 1 }
                return row({
                  key,
                  personId: person.personId,
                  personName: person.personName,
                  storyId: story.id,
                  name: story.name,
                  beats: story.beats,
                  record,
                  beat,
                }, { showStar: true })
              })}
            </div>
          ))}
        </section>
      )}

      <div style={{ height: 90 }} />
    </main>
  )
}
