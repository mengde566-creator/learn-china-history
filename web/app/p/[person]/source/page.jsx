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
/* 底本和直译里夹着写作时的记号：`**` 是「这句是我说的、不是原文」，
   `` ` `` 是编号。规范（content/README.md「**粗体** 不渲染，这是有意的」）说
   **界面上不渲染它们**——所以这里剥掉，而不是交给 RichText 变成 <b>，
   更不是把未处理的 HTML 塞进页面。 */
const plain = (t) => String(t ?? '').replace(/\*\*/g, '').replace(/`/g, '')

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
        {/* 这一页原来有一整块自我说明（「底本 232 段全在这里……那是有意的」）。
            **读者打开一页资料，先读了一段产品说明书。** 删掉：页面上只留数字。 */}
        <p className="sub" style={{ marginTop: 6 }}>
          {total} 段{glossed > 0 && <>　·　直译 {glossed} 段</>}
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
                </div>
                {/* **原文和直译必须在同一个正文列里。**
                    原来是三个并列子元素（编号／原文／直译），而栅格只有两列——
                    直译自动落到第二行第一列，宽度只有编号列那么宽（64px）。
                    见 docs/问题清单与研发整改任务书-2026-10-17.md 的 R01。 */}
                <div className="src-body">
                  <p className="src-text">{plain(source[id].text)}</p>
                  {gloss[id]
                    ? <p className="src-gloss"><span className="lead">直译</span>{plain(gloss[id])}</p>
                    : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}

      {/* 页尾原来还有一段解释「段号和引文编号一一对应」「注是后人补的」——
          也是同一类。读者要看的是原文，不是这一页怎么设计的。 */}

    </main>
  )
}
