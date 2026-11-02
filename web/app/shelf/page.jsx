import { listPeople } from '@/lib/content'
import ShelfClient from '@/components/ShelfClient'

export const metadata = { title: '书架 — 观史' }

/**
 * 书架是静态页：全部篇章的目录在构建期就定好，
 * 读者的进度与收藏在客户端叠上去（不经过服务端，也就没有登录那一层）。
 */
export default function ShelfPage() {
  const index = listPeople().map((person) => ({
    personId: person.id,
    personName: person.name,
    era: person.era,
    stories: person.storyList
      .filter((story) => story.ready)
      .map((story) => ({
        id: story.id,
        name: story.name,
        beats: person.stories[story.id]?.beats.length || 1,
      })),
  }))
  return <ShelfClient index={index} />
}
