'use client'

import { toggleStar, useStars, storyKey } from '@/lib/library'

/**
 * 收藏按钮（篇级）。
 *
 * 用「收」一个字，不用 `★`：`★` 在本项目已经是内容里的「叙事关键句」标记
 * （`content/README.md`），页面上还会被从篇名里删掉。同一个字形表示两件事，
 * 读者分不清哪个是书里的、哪个是自己按的。
 *
 * `aria-pressed` 是状态，不是装饰：读屏要能说出「已收藏」。
 */
export default function StarButton({ personId, storyId, storyName, className = '' }) {
  const stars = useStars()
  const on = Boolean(stars[storyKey(personId, storyId)])
  return (
    <button
      type="button"
      className={`sc-star${on ? ' on' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={on}
      /* 名字固定为「收藏〈篇名〉」，状态交给 aria-pressed。
         名字跟着状态翻转的话，读屏会念成「取消收藏〈X〉，已按下」。 */
      aria-label={`收藏〈${storyName}〉`}
      title={on ? '取消收藏' : '收藏'}
      onClick={(event) => {
        /* 卡片外面是链接：别让按收藏变成进故事。 */
        event.preventDefault()
        event.stopPropagation()
        toggleStar(personId, storyId)
      }}
    >
      收
    </button>
  )
}
