import Link from 'next/link'
import { listPeople, groupByEra, PLANNED } from '@/lib/content'
import SealMark from '@/components/SealMark'
import ContinueRead from '@/components/ContinueRead'

export default function Home() {
  const people = listPeople()

  /* 已实现的 + 计划中的，一起按时代分组。
     计划中的那些不做成独立区块——它们本来就是"还没到的时代"。 */
  /* **按 id 去重。** 曹操曾经既在 `PLANNED` 里、又在已实现列表里，
     首页于是同时出现「可进入的曹操」和「锁定的曹操」。 */
  const have = new Set(people.map((p) => p.id))
  const all = [
    ...people.map((p) => ({ ...p, planned: false })),
    ...PLANNED.filter((p) => !have.has(p.id)).map((p) => ({ ...p, planned: true, storyList: [] })),
  ]
  const groups = groupByEra(all)

  /* 「接着读」只认已实现的篇：给客户端一个 130 条的轻量索引，
     不把整份内容（9.5 MB）塞进首页。 */
  const readIndex = {}
  for (const p of people) {
    for (const s of p.storyList) {
      if (!s.ready) continue
      readIndex[`${p.id}/${s.id}`] = {
        personId: p.id,
        personName: p.name,
        storyId: s.id,
        storyName: s.name,
        beats: p.stories[s.id]?.beats.length || 1,
      }
    }
  }

  return (
    <main className="wrap">
      <header className="page-head">
        <h1>观 史</h1>
      </header>

      {/* 有进度才出现；没有进度时这一块整个不渲染（不给新读者画假进度）。 */}
      <ContinueRead index={readIndex} />

      {groups.map(({ era, list }) => (
        <section key={era} className="era-row">
          <div className="era-name">{era}</div>
          <div className="people-grid">
            {list.map((p) =>
              p.planned ? (
                <div key={p.name} className="person-card locked">
                  <div className="nm">{p.name}</div>
                  <div className="bk">{p.book}</div>
                </div>
              ) : (
                <Link key={p.id} href={`/p/${p.id}`} className="person-card">
                  <SealMark />
                  <div className="nm">{p.name}</div>
                  <div className="bk">{p.sourceBook}</div>
                  <div className="mt">{p.storyList.length} 篇</div>
                </Link>
              )
            )}
          </div>
        </section>
      ))}

      <div style={{ height: 80 }} />
    </main>
  )
}
