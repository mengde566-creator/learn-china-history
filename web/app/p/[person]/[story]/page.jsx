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

  return <StoryClient person={person} story={story} source={src} />
}
