import { listPeople } from '@/lib/content'
import SettingsClient from '@/components/SettingsClient'

export const metadata = { title: '设置 — 观史' }

export default function SettingsPage() {
  const people = listPeople()
  const ready = []
  for (const p of people) {
    for (const s of p.storyList) if (s.ready) ready.push({ person: p, story: s })
  }

  const stats = {
    implemented: ready.length
      ? ready.map(({ person, story }) => `${person.name} · ${story.name}`).join('、') +
        `：情境铺陈 · 依据展开（四种标记）· 原文 · 背景卡 · 依据映射表 · 对话种子 · 复习卡`
      : '尚无已实现的故事',
    next: `${people.length} 个人物 · ${people.reduce((n, p) => n + p.storyList.length, 0)} 篇故事（已实现 ${ready.length}）· 地图与人物关系图 · AI 自由对话`,
    links: [
      { href: '/', label: '返回总览' },
      ...(ready.length
        ? [{ href: `/p/${ready[0].person.id}`, label: ready[0].person.name },
           { href: `/p/${ready[0].person.id}/${ready[0].story.id}`, label: `进入${ready[0].story.name}` }]
        : []),
    ],
  }

  return <SettingsClient stats={stats} />
}
