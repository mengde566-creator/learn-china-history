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
  return { title: person ? `${person.name} · 完整资料 — 观史` : '观史' }
}

/* 号段 → 档次。和编译器里的号段表是同一个口径：
   正史 001–199 · 注 201–399 · 小说 401–599 · 野史 601–799。 */
const bandOf = (id) => {
  const n = Number(id)
  if (n >= 601) return '野史'
  if (n >= 401) return '小说'
  if (n >= 201) return '注'
  return '正史'
}

export default async function SourcePage({ params }) {
  const { person: pid } = await params
  const person = getPerson(pid)
  if (!person) notFound()

  const source = person.source || {}
  const gloss = person.gloss || {}

  /* 按底本分组，组内按编号排。一本书一组，读者一眼看得见「哪一段出自哪本书」。 */
  const groups = []
  for (const b of person.books || []) {
    const ids = (b.ids || []).filter((id) => source[id])
    if (ids.length) groups.push({ book: b.book, tier: b.tier, ids })
  }
  /* `books` 是编译器按档次排好的；万一有段落没归组，补在最后，别让它们消失。 */
  const grouped = new Set(groups.flatMap((g) => g.ids))
  const rest = Object.keys(source).filter((id) => !grouped.has(id)).sort()
  if (rest.length) groups.push({ book: person.sourceBook || '未署名的底本', tier: '正史', ids: rest })

  const total = Object.keys(source).length
  const glossed = Object.keys(gloss).length
  /* 有故事够得着的段：读者在故事里能碰到它们；剩下的只能从这一页进。 */
  const reachable = new Set()
  for (const s of person.storyList || []) {
    for (const r of String(s.sourceRange || '').split(/[、,，]/)) {
      const m = r.trim().match(/^(\d{3})\s*[–—-]\s*(\d{3})$/)
      if (m) for (let i = +m[1]; i <= +m[2]; i++) reachable.add(String(i).padStart(3, '0'))
      else if (/^\d{3}$/.test(r.trim())) reachable.add(r.trim())
    }
  }
  const onlyHere = [...Object.keys(source)].filter((id) => !reachable.has(id)).length

  return (
    <main className="wrap">
      <header className="page-head">
        <div className="crumbs">
          <Link href="/">总览</Link>
          <span>／</span>
          <Link href={`/p/${person.id}`}>{person.name}</Link>
          <span>／</span>
          <span>完整资料</span>
        </div>
        <h1>
          完整资料 <SealMark char="原" />
        </h1>
        <p className="sub" style={{ marginTop: 6 }}>
          底本 <b>{total}</b> 段，全在这里。
          {onlyHere > 0 && <>　其中 <b>{onlyHere}</b> 段没有任何一篇故事够得着——<b>只有这一页能读到</b>。</>}
          {glossed > 0 && <>　已有直译 <b>{glossed}</b> 段。</>}
        </p>
        <p className="note" style={{ marginTop: 10 }}>
          <b>这一页和故事里的白话不是一回事。</b>故事里的白话是给人读的，可以顺语序、补主语；
          这里的<b>直译</b>跟着原文的字序和句法走，不替它顺句子、不补它没说的主语——
          所以读起来生硬，<b>那是有意的</b>：它要让人看见原文长什么样。
        </p>
      </header>

      {groups.map((g) => (
        <section key={g.book} style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 15, letterSpacing: '.08em', margin: '0 0 4px' }}>
            {g.tier === '注' ? '注' : g.tier === '小说' ? '小说' : g.tier === '野史' ? '野史' : '正文'}
            <span style={{ fontWeight: 400, opacity: .7 }}>　·　{g.book}</span>
            <span style={{ fontWeight: 400, opacity: .55, fontSize: 13 }}>　{g.ids.length} 段</span>
          </h2>
          <ol className="src-list">
            {g.ids.map((id) => (
              <li key={id} id={`s-${id}`} className={reachable.has(id) ? 'src-item' : 'src-item src-only'}>
                <div className="src-no">
                  <a href={`#s-${id}`}>{id}</a>
                  {!reachable.has(id) && <span className="tag" title="没有任何一篇故事引用这一段">只此一处</span>}
                </div>
                <p className="src-text">{source[id].text}</p>
                {gloss[id]
                  ? <p className="src-gloss"><span className="lead">直译</span>{gloss[id]}</p>
                  : <p className="src-gloss none"><span className="lead">直译</span>（未做）</p>}
              </li>
            ))}
          </ol>
        </section>
      ))}

      <p className="note" style={{ marginTop: 28 }}>
        段号与故事里的引文编号一一对应——故事里写 <code>042</code>，这里就找 <code>042</code>。
        正文与注分开列：<b>注</b>是后人补的，不是陈寿（或司马迁）写的，它挂在哪一段下面，哪一段就是它要解释的正文。
      </p>
    </main>
  )
}
