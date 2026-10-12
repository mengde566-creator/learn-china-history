'use client'

import { useRef, useEffect } from 'react'
import gsap from 'gsap'

/**
 * 朱批印：笔圈 + 「知」。
 *
 * **它不是纹样，是印章。** 古代批阅的形式——读史是为了"知"——印文用「知」。
 * 它在线上已在用的那个字体分片里，**不增加任何体积**。
 * 选它而不是「悟」：`口`是实心方块、`矢`是斜线，收放分明，
 * 缩到 46px 仍然立得住；「悟」的 `忄` 是细竖，小尺寸下会变淡，而且要 +89.7 KB。
 * 同一片里还同时有 入 之 可 是 正 行 学 明 通，以后换字或加状态也不用加体积。
 *
 * 笔圈是**自己划出来的**：conic 遮罩从 -60° 扫一圈（0.52s），
 * 扫完字再浮现（0.22s）。不是淡入——淡入像图标，划出来像有人刚批的。
 *
 * 造型上刻意不圆：半径有低频起伏（手不稳），线宽随行笔变化
 * （起笔顿、行笔提、收笔再顿），收笔处叠过起笔 16°（快速画圈必然过头）。
 * 正圆看起来像图标，这个看起来像有人划的。
 */
export default function SealMark({ active = false }) {
  const ring = useRef(null)

  useEffect(() => {
    const el = ring.current
    const card = el?.closest('.story-card, .person-card')
    if (!el || !card) return

    gsap.set(el, { '--sweep': '0deg' })
    const tl = gsap.timeline({ paused: true })
      .to(el, { '--sweep': '360deg', duration: 0.52, ease: 'power2.inOut' }, 0)
      .add(() => el.classList.add('on'), 0.44)

    const enter = () => tl.restart()
    const leave = () => {
      tl.pause(0)
      el.classList.remove('on')
      gsap.set(el, { '--sweep': '0deg' })
    }

    card.addEventListener('mouseenter', enter)
    card.addEventListener('mouseleave', leave)
    card.addEventListener('focus', enter)
    card.addEventListener('blur', leave)
    return () => {
      card.removeEventListener('mouseenter', enter)
      card.removeEventListener('mouseleave', leave)
      card.removeEventListener('focus', enter)
      card.removeEventListener('blur', leave)
      tl.kill()
    }
  }, [])

  return (
    <span ref={ring} className={`seal${active ? ' on' : ''}`} aria-hidden="true">
      <img src="/textures/brush-ring.svg" alt="" />
      <b>知</b>
    </span>
  )
}
