import { notFound } from 'next/navigation'
import { getStory, listPeople, sourceRange } from '@/lib/content'
import StoryClient from '@/components/StoryClient'

export function generateStaticParams() {
  const out = []
  for (const p of listPeople()) {
    for (const s of p.storyList) {
      if (s.ready) out.push({ person: p.id, story: s.id })
    }
  }
  return out
}

export async function generateMetadata({ params }) {
  const { person: pid, story: sid } = await params
  const hit = getStory(pid, sid)
  return { title: hit ? `${hit.story.name} — ${hit.person.name} — 观史` : '观史' }
}

export default async function StoryPage({ params }) {
  const { person: pid, story: sid } = await params
  const hit = getStory(pid, sid)
  if (!hit) notFound()

  const { person, story } = hit
  const src = sourceRange(person, story.sourceRange)

  /* **只喂 StoryClient 真正用到的字段。**
     原来传整个 `person`，于是每一页都把这一篇根本不用的东西发给浏览器：
     实测 `/p/caocao/08-guandu` 是 571 KB，其中
       `person.stories`（十篇的种子和复习卡）399 KB
       `person.source`（整部《武帝纪》232 段）136 KB
     而 StoryClient 只用 `person.{id,name,books,sourceBook,storyList}`——
     真在用的大约 73 KB。底本全收之后这个差距只会更大。 */
  const brief = {
    id: person.id,
    name: person.name,
    books: person.books,
    sourceBook: person.sourceBook,
    storyList: person.storyList,
  }
  return <StoryClient person={brief} story={story} source={src} />
}
