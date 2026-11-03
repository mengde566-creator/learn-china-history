'use client'

import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import RichText, { Marker, Legend } from '@/components/RichText'
import CiteText from '@/components/CiteText'
import { useProgress, markRead, resetStory, storyKey, resolveResume, beatAnchor } from '@/lib/progress'
import SeedSheet from '@/components/SeedSheet'
import StarButton from '@/components/StarButton'
import ReviewCards from '@/components/ReviewCards'
import SourceText from '@/components/SourceText'
import { hasMixedSourceLayers, sourceExcerptOrigin } from '@/lib/source-layers.mjs'
import { evidenceExcerpt } from '@/lib/evidence.mjs'
import { personVersion } from '@/lib/person-notes.mjs'
import { notesFor, setNote, addSelectionNote, updateNote, removeNote, NOTE_LIMIT, useNotes } from '@/lib/library'

/* 界面上只放短标签。长说明在图例里出现一次就够——
   原来每个标记都重复一遍「出自原文，可逐字核对」，纯属噪音。 */
const TITLES = {
  '◆': '出自原文',
  '◇': '出自小说',
  '○': '合理推演',
  '△': '存疑',
  '—': '史书未载',
  'ⓘ': '产品说明',
}
const MARK_CLASS = { '◆': 'g-source', '◇': 'g-fiction', '○': 'g-infer', '△': 'g-doubt', '—': 'g-silent', 'ⓘ': 'g-info' }

/* 非史书的两档。它们用同一个字形 ◇ 和同一个紫色——
   「这不是史书写的」是同一个意思，区别在书名，不在标记。 */
const FOREIGN_TIERS = new Set(['小说', '野史'])

/* 这一页用到的某一档底本，都叫什么书。
   书名是内容里的东西——`source.md` 的底本小节写着「## 底本三 · 小说 ·《三国演义》」。
   界面不自己编一个，也不假装「小说」两个字就够了：
   读者要能一眼看出这一句出自哪本书，才谈得上信不信。 */
const booksOfTier = (person, tier) =>
  (person?.books || []).filter((b) => b.tier === tier).map((b) => b.book)

/** 这一页用到的**非史书底本**（小说、野史），按档次分好。图例按它生成。 */
const foreignBooks = (person) => ['小说', '野史']
  .flatMap((tier) => booksOfTier(person, tier).map((book) => ({ tier, book })))

/** 标记的短标签。只有 ◇ 要补书名——别的档次，书名在「原文」的分节标题上。
    补哪一本，看**这一段实际引的编号**，不看人物的底本清单：
    同一个人可能既有演义又有野史，而这一段只引了其中一本。 */
function titleOf(marker, person, beat, source) {
  if (marker !== '◇') return TITLES[marker] || ''
  const cited = [...new Set((beat?.sources || []).map((id) => source?.[id]?.tier))]
  const tiers = ['小说', '野史'].filter((t) => cited.includes(t))
  const use = tiers.length ? tiers : ['小说', '野史']
  const books = [...new Set(use.flatMap((t) => booksOfTier(person, t)))]
  if (!books.length) return TITLES['◇']
  return `出自${use[0]}${books.join('、')}`
}

const TABS = [
  { k: 'evidence',    label: '依据' },
  { k: 'source',      label: '原文' },
  { k: 'backgrounds', label: '背景' },
  { k: 'ground',      label: '映射' },
  { k: 'present',     label: '人物' },
  /* 第六签：读者自己的批注。**不进正文**——批注一多，读者读的就是自己写的话。 */
  { k: 'notes',       label: '批注' },
]

/** 面包屑：导航只放全局入口，层级靠这里走 */
function Crumbs({ person, story }) {
  return (
    <div className="crumbs">
      <Link href="/">总览</Link>
      <span>／</span>
      <Link href={`/p/${person.id}`}>{person.name}</Link>
      <span>／</span>
      <span>{story.name}</span>
    </div>
  )
}

/** 判断「依据」正文是否只是在重复旁边已经引过的原文。
 *  是的话就不渲染——原文本身就是证据，标记负责说明它的地位。
 *  比对的是该段**全部**底本（sources），不只「原文」栏那一条。
 *  编号本身不算内容：作者常写「012〈…〉；013 鞠武谏；014」这种指路条，
 *  把编号剥掉之后它就只是引文的拼接，和上面列的重复。 */
function evidenceAdds(beat, source) {
  const strip = (s) => (s || '')
    .replace(/`?\d{3}`?/g, '')
    .replace(/[「」『』。，、；：！？·\s（）()]/g, '')
  const g = strip(beat?.ground)
  if (!g || g.length <= 4) return false
  const hay = (beat?.sources || []).map((id) => strip(source[id]?.text)).join('')
  return !hay.includes(g)
}

export default function StoryClient({ person, story, source }) {
  const [phase, setPhase] = useState('opening') // opening | live
  const [revealed, setRevealed] = useState(1)
  const [afterVisible, setAfterVisible] = useState(false)
  const [openingNotesOpen, setOpeningNotesOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const panelTrigger = useRef(null)
  const panelReturn = useRef(null)
  const panelDock = useRef(null)
  const panelPositioning = useRef(false)
  const panelScrolled = useRef(false)
  const closePanelRef = useRef(null)
  const [panelBeat, setPanelBeat] = useState(1)
  const [panelHost, setPanelHost] = useState(null)
  const [widePanel, setWidePanel] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1081px)')
    const update = () => setWidePanel(query.matches)
    update(); query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const restoring = useRef(true)
  /* 进正文时读者落在哪里。用来区分「他自己滚到页底」和「这篇短、恢复位置本来就在页底」。 */
  const entryScrollY = useRef(null)
  useEffect(() => {
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    return () => { window.history.scrollRestoration = previous }
  }, [])

  const [tab, setTab] = useState('evidence')
  const [personVisit, setPersonVisit] = useState(null)
  const [personTarget, setPersonTarget] = useState(null)
  const [personCitationReturn, setPersonCitationReturn] = useState(null)
  /* 引用跳转之前在哪——原文那一段上给一个「返回」 */
  const [cameFrom, setCameFrom] = useState(null)
  const sourceReturnCleanup = useRef(null)
  useEffect(() => () => sourceReturnCleanup.current?.(), [])
  const citingFromOpening = Boolean(cameFrom?.entrance)
  /* 本篇「原文」页签里真的有的编号——依据里的编号只有在这范围内才给跳，
     范围外的点了会落空（那种编号本来也不该出现，编译器另有跨篇提醒）。 */
  const sourceIds = useMemo(() => new Set(Object.keys(source || {})), [source])
  const [following, setFollowing] = useState(1)  // 读到第几段（依据面板跟着它走）
  const [sheet, setSheet] = useState(false)

  /* 朱批：{ beat, draft }。`beat` 在编辑期间**锁住**——滚正文换了段也不跟着换，
     否则写着第 5 段、抬头变成第 9 段。 */
  const [editing, setEditing] = useState(null)
  /* 批注页停在「你点开它的那一段」，**不跟着滚动走**：
     批注是定点动作，不是随文查阅；写完一句就被滚动带走到别的段，是最糟的体验。 */
  const [noteBeat, setNoteBeat] = useState(null)
  /* 从批注列表跳到某一段时，**不要**让面板的对齐逻辑把这一段顶出屏幕：
     面板跟着段走，对齐面板等于把正文推上去。这一段由我们自己滚。 */
  const skipAlign = useRef(false)
  const composing = useRef(false)
  /* 选中一句后浮出来的「评」按钮。null = 没有选中的句子。 */
  const [pendingQuote, setPendingQuote] = useState(null)
  /* 「评」按钮点下去时读这个 ref，而不是读 state：mouseup 可能先把 state 清掉，
     闭包里拿到的就是 null，于是点了没反应。 */
  const pendingQuoteRef = useRef(null)
  const notes = useNotes()
  /* 这一段有没有批注：**任何一条都算**（整段一条、或某句一条）。 */
  /* 这里还不能用 `beats` 常量（下面才声明），直接取 story.beats。 */
  const noteList = notesFor(person.id, story.id, story.beats)
  const noteHas = (n) => noteList.some((note) => note.beat === n)
  const quoteNotes = noteList.filter((note) => note.quote && Number.isInteger(note.para))
  /* 选中正文里的一句话：在选区上方浮出一个「评」。
     只在正文段落里生效，不跨段；选中的字就是引文。 */
  useEffect(() => {
    if (phase !== 'live') return
    const onPick = () => {
      const sel = window.getSelection()
      const text = sel?.toString().trim() || ''
      if (!text || text.length < 2) { setPendingQuote(null); return }
      const range = sel.getRangeAt(0)
      const node = range.commonAncestorContainer
      const el = node.nodeType === 1 ? node : node.parentElement
      const paraEl = el?.closest?.('[data-para]')
      const beatEl = el?.closest?.('.beat[data-n]')
      if (!paraEl || !beatEl || !el.closest('.reader')) { pendingQuoteRef.current = null; setPendingQuote(null); return }
      const rect = range.getBoundingClientRect()
      /* 选区不在屏幕里（程序化选中、或滚走之后）就不要浮按钮。 */
      if (rect.bottom < 0 || rect.top > window.innerHeight) { pendingQuoteRef.current = null; setPendingQuote(null); return }
      /* 选区贴着屏幕顶端时，「评」浮在上面会跑出屏幕——那就放到下方。
         左右也夹在视口内，免得在手机边缘点不到。 */
      const below = rect.top < 96
      const picked = {
        beat: Number(beatEl.dataset.n),
        para: Number(paraEl.dataset.para),
        text: text.slice(0, 120),
        x: Math.min(Math.max(rect.left + rect.width / 2, 30), window.innerWidth - 30),
        y: below ? rect.bottom + 10 : rect.top,
        below,
      }
      pendingQuoteRef.current = picked
      setPendingQuote(picked)
    }
    const onDown = (event) => {
      if (event.target.closest?.('.zhupi-pick')) return
      pendingQuoteRef.current = null
      setPendingQuote(null)
    }
    document.addEventListener('mouseup', onPick)
    document.addEventListener('touchend', onPick)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mouseup', onPick)
      document.removeEventListener('touchend', onPick)
      document.removeEventListener('mousedown', onDown)
    }
  }, [phase])

  const saveNote = () => {
    if (!editing) return
    const anchor = beatAnchor(beats[editing.beat - 1])
    /* 改已有批注按**原来的键**写：它可能因为内容改版被锚点挪到了别的段，
       按新段号再写一次会变成两条。 */
    if (editing.key) updateNote(editing.key, editing.draft, anchor)
    else if (editing.quote) addSelectionNote(person.id, story.id, editing.beat, {
      text: editing.draft, quote: editing.quote, para: editing.para, anchor,
    })
    else setNote(person.id, story.id, editing.beat, editing.draft, anchor)
    setEditing(null)
  }
  const cancelNote = () => setEditing(null)
  const stageRef = useRef(null)

  // 只有一个查证面板。手机挂载位置固定在打开的段落，独立于桌面滚动联动。
  useLayoutEffect(() => {
    if (phase !== 'live') { setPanelHost(null); return }
    const context = panelTrigger.current?.closest('.beat, .card')
    const inline = !widePanel && panelScrolled.current && !context?.matches('.card')
      ? document.querySelector(`#beat-${following} [data-panel-host]`)
      : context?.querySelector('[data-panel-host]') || document.querySelector(`#beat-${panelBeat} [data-panel-host]`)
    setPanelHost(widePanel && !context?.matches('.card') ? panelDock.current : inline)
  }, [phase, panelOpen, panelBeat, widePanel])
  useLayoutEffect(() => {
    if (!panelOpen || !panelHost) return
    let cancelled = false
    let userMoved = false
    let frame = 0
    let releaseFrame = 0
    const align = () => {
      if (cancelled || userMoved || skipAlign.current) return
      panelPositioning.current = true
      const anchor = panelReturn.current
      if (panelHost === panelDock.current && anchor?.el?.isConnected) {
        window.scrollBy({ top: anchor.el.getBoundingClientRect().top - anchor.top, behavior: 'instant' })
      } else {
        const panel = document.getElementById('source-panel')
        if (panel) window.scrollBy({ top: panel.getBoundingClientRect().top - 110, behavior: 'instant' })
      }
      cancelAnimationFrame(releaseFrame)
      releaseFrame = requestAnimationFrame(() => { releaseFrame = requestAnimationFrame(() => { panelPositioning.current = false }) })
    }
    const onGesture = (event) => {
      if (event.target?.closest?.('.panel-face')) return
      if (event.type === 'keydown' && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return
      userMoved = true
      panelPositioning.current = false
    }
    const onResize = () => { userMoved = false }
    window.addEventListener('resize', onResize)
    window.addEventListener('wheel', onGesture, { passive: true })
    window.addEventListener('touchmove', onGesture, { passive: true })
    window.addEventListener('keydown', onGesture)
    align()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(align)
    })
    if (stageRef.current) observer.observe(stageRef.current)
    const actions = document.querySelector('.reader-actions')
    if (actions) observer.observe(actions)
    // 从引入页首次挂载正文时，字体加载还会改变前文高度。
    // 字体就绪后再对齐一次，避免查证标题被导航栏挡住。
    document.fonts.ready.then(() => { if (!cancelled) frame = requestAnimationFrame(align) })
    return () => {
      cancelled = true; cancelAnimationFrame(frame); cancelAnimationFrame(releaseFrame)
      panelPositioning.current = false; observer.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('wheel', onGesture)
      window.removeEventListener('touchmove', onGesture)
      window.removeEventListener('keydown', onGesture)
    }
  }, [panelOpen, panelHost, widePanel])

  const beats = story.beats

  /* **本地阅读进度。** 刷新、往返查证、关掉再打开，都能接着读。
     只用 localStorage；存坏了读不了就照常从头读（见 lib/progress.js）。 */
  const { progress, ready: progressReady } = useProgress()
  const [readReady, setReadReady] = useState(false)
  /* 内容改版之后接着读的位置被挪过：入口要说一声，不能静默跳。 */
  const [resumeAdjusted, setResumeAdjusted] = useState(false)
  const savedRead = progress.read[storyKey(person.id, story.id)]
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!progressReady || restoredRef.current) return
    restoredRef.current = true
    const saved = progress.read[storyKey(person.id, story.id)]
    if (saved) {
      const { beat: n, adjusted } = resolveResume(person.id, story.id, saved, beats.length, beats)
      setRevealed(n)
      setResumeAdjusted(adjusted)
      if (saved.phase === 'live') setPhase('live')
    }
    setReadReady(true)
  }, [progressReady, progress, person.id, story.id, beats.length])
  /* 每推进一步就记一次（只在正文里记，入场页不算「读到第几段」） */
  useEffect(() => {
    if (!readReady || phase !== 'live' || citingFromOpening) return
    const finished = revealed >= beats.length
    markRead(person.id, story.id, {
      beat: revealed,
      beats: beats.length,
      /* 锚点 = 读到那一段的开头。内容改版后靠它找回同一段，不再靠硬编码的段数表。 */
      anchor: beatAnchor(beats[revealed - 1]),
      phase: 'live',
      done: finished,
      ...(finished && !savedRead?.done ? { doneAt: Date.now() } : {}),
    })
  }, [readReady, phase, revealed, person.id, story.id, beats.length, citingFromOpening])
  const isLast = afterVisible || revealed >= beats.length
  /* 正文里也能从头读（进度存在本机时才有意义） */
  const restart = () => {
    resetStory(person.id, story.id)
    setResumeAdjusted(false)
    setRevealed(1); setAfterVisible(false); setFollowing(1); setPanelOpen(false); setCameFrom(null)
    setPersonVisit(null); setPersonTarget(null); setPersonCitationReturn(null)
    restoring.current = true
    setPhase('opening'); window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const shownBeat = beats[following - 1] || beats[0]

  /* 读完一篇直接进下一篇。顺序取人物页的篇目顺序，只数已实现的——
     未实现的排进去会点进一个空页。 */
  const readyList = person.storyList.filter((s) => s.ready)
  const at = readyList.findIndex((s) => s.id === story.id)
  const prevStory = at > 0 ? readyList[at - 1] : null
  const nextStory = at >= 0 && at < readyList.length - 1 ? readyList[at + 1] : null

  const showPanel = (trigger) => {
    panelTrigger.current = trigger || document.activeElement
    const el = panelTrigger.current
    panelReturn.current = el ? { el, top: el.getBoundingClientRect().top } : null
    setPanelBeat(Number(el?.closest('.beat')?.dataset.n) || following)
    panelScrolled.current = false
    setPanelOpen(true)
  }
  const closePanel = () => {
    if (personCitationReturn) { returnFromPersonCitation(); return }
    if (personVisit) { returnFromPerson(); return }
    if (cameFrom?.entrance) { backFromSource(); return }
    // 看过后续正文再关闭，留在当前阅读处，不把人拉回最初打开查证的地方。
    if (widePanel && panelScrolled.current && !cameFrom) {
      const anchor = [...document.querySelectorAll('.reader .narration p, .reader .emerge, .reader-after .card')]
        .find(el => { const r = el.getBoundingClientRect(); return r.bottom > 100 && r.top < innerHeight })
      if (anchor) panelReturn.current = { el: anchor, top: anchor.getBoundingClientRect().top }
      panelTrigger.current = document.querySelector(`#beat-${following} .ground`)
    }
    const focus = cameFrom?.focus?.isConnected ? cameFrom.focus : panelTrigger.current
    restoring.current = true
    setPanelOpen(false)
    setCameFrom(null)
    requestAnimationFrame(() => {
      const anchor = panelReturn.current
      if (anchor?.el?.isConnected) window.scrollBy({ top: anchor.el.getBoundingClientRect().top - anchor.top, behavior: 'instant' })
      requestAnimationFrame(() => { restoring.current = false })
      if (focus?.isConnected) focus.focus({ preventScroll: true })
    })
  }
  const openPerson = (event, mark) => {
    const trigger = event.currentTarget
    if (!personVisit) {
      setPersonVisit({ tab, panelOpen, panelBeat, trigger: panelTrigger.current, anchor: panelReturn.current,
        scroll: document.querySelector('.panel-face')?.scrollTop || 0, focus: trigger,
        focusTop: trigger.getBoundingClientRect().top })
    }
    setPersonTarget({ id: mark.personId, beat: mark.beat, paragraph: mark.paragraph })
    panelTrigger.current = trigger
    panelReturn.current = { el: trigger, top: trigger.getBoundingClientRect().top }
    panelScrolled.current = false
    setPanelBeat(mark.beat)
    setPanelOpen(true)
    setTab('present')
    requestAnimationFrame(() => {
      const el = document.getElementById(`story-person-${mark.personId}`)
      const box = el?.closest('.panel-face')
      if (box && el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12
    })
  }
  function returnFromPerson() {
    if (!personVisit) return
    const saved = personVisit
    restoring.current = true
    setPersonVisit(null); setPersonTarget(null); setPersonCitationReturn(null); setTab(saved.tab); setPanelBeat(saved.panelBeat)
    panelTrigger.current = saved.trigger
    panelReturn.current = saved.anchor
    setPanelOpen(saved.panelOpen)
    requestAnimationFrame(() => {
      const box = document.querySelector('.panel-face')
      if (saved.panelOpen && box) box.scrollTop = saved.scroll
      if (saved.focus?.isConnected) {
        window.scrollBy({ top: saved.focus.getBoundingClientRect().top - saved.focusTop, behavior: 'instant' })
        saved.focus.focus({ preventScroll: true })
      }
      requestAnimationFrame(() => { restoring.current = false })
    })
  }
  function returnFromPersonCitation() {
    if (!personCitationReturn) return
    const saved = personCitationReturn
    setPersonCitationReturn(null)
    setTab('present')
    requestAnimationFrame(() => {
      const entry = document.getElementById(`story-person-${saved.personId}`)
      const details = entry?.querySelector('details')
      if (details) details.open = true
      const box = entry?.closest('.panel-face')
      if (box) box.scrollTop = saved.scroll
      const focus = [...(entry?.querySelectorAll('.person-note-text button.cite') || [])]
        .find(button => button.textContent.trim() === saved.id)
      focus?.focus({ preventScroll: true })
    })
  }
  closePanelRef.current = closePanel
  useEffect(() => {
    if (!panelOpen) return
    /* 正在写批注时**不要**把焦点抢到「收起」：输入框一挂载就被 blur，
       空内容会被当成「保存」直接把编辑器关掉。 */
    if (!editing) document.querySelector('.panel-close')?.focus({ preventScroll: true })
    const escape = (event) => { if (event.key === 'Escape') closePanelRef.current?.() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [panelOpen, panelHost, cameFrom?.entrance, editing])

  // 查证在自己的面板内滚动；正文的位置与尚未读到的进度都不受影响。
  const jumpToSource = useCallback((id) => {
    sourceReturnCleanup.current?.()
    const active = document.activeElement
    const cites = [...document.querySelectorAll('.opening-notes button.cite')]
    if (personVisit && tab === 'present') {
      setPersonCitationReturn({ id, personId: active?.closest('[id^="story-person-"]')?.id.slice('story-person-'.length),
        scroll: document.querySelector('.panel-face')?.scrollTop || 0 })
    } else setCameFrom((prev) => prev ?? {
      tab, beat: following, entrance: phase !== 'live', scrollY: window.scrollY,
      panelWasOpen: panelOpen,
      panelScrollTop: document.querySelector('.panel-face')?.scrollTop || 0,
      panelCiteAt: [...document.querySelectorAll('.panel-body button.cite')].indexOf(active),
      citeAt: cites.indexOf(active), focus: active,
    })
    if (!panelOpen) {
      panelTrigger.current = active
      setPanelBeat(following)
      panelScrolled.current = false
      panelPositioning.current = true
      panelReturn.current = active ? { el: active, top: active.getBoundingClientRect().top } : null
    }
    if (phase !== 'live') setPhase('live')
    setPanelOpen(true)
    setTab('source')
    requestAnimationFrame(() => {
      const el = document.getElementById(`src-${id}`)
      const box = el?.closest('.panel-face')
      if (!el) return
      if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12
      el.classList.add('flash')
      el.focus({ preventScroll: true })
      setTimeout(() => el.classList.remove('flash'), 1600)
    })
  }, [tab, following, phase, panelOpen, personVisit])

  const scrollToBeat = useCallback((n) => {
    const el = document.getElementById(`beat-${n}`)
    if (el) window.scrollTo({ top: Math.max(0, window.scrollY + el.getBoundingClientRect().top - 105), behavior: 'instant' })
  }, [])

  // 连续阅读按实际可见位置记进度，不把“已渲染全文”记成“已读完”。
  useEffect(() => {
    if (phase !== 'live' || !progressReady || cameFrom?.entrance) return
    // 新开篇直接就位，不延后滚动去覆盖读者已开始的操作。
    if (revealed <= 1) {
      window.scrollTo({ top: 0, behavior: 'instant' })
      restoring.current = false
      entryScrollY.current = window.scrollY
      /* 短篇（两段、整页不用滚）在页面末尾不会自己发滚动事件，
         `locate()` 就永远不跑：末段明明在视口里，「读完之后」和复习卡却不出现。
         这里主动广播一次，让阅读线算一遍。 */
      window.dispatchEvent(new Event('scroll'))
      return
    }
    restoring.current = true
    let frame = 0
    let cancelled = false
    let previous = null
    let stable = 0
    let attempts = 0
    // 刷新后正文先挂载，样式应用和字体排版可能还在改变上方高度。
    // 等位置连续稳定再恢复，避免刚滚到段落就被后续布局挤走。
    const settle = () => {
      if (cancelled) return
      const el = document.getElementById(`beat-${revealed}`)
      const position = el ? window.scrollY + el.getBoundingClientRect().top : 0
      stable = previous !== null && Math.abs(position - previous) < .5 ? stable + 1 : 0
      previous = position
      if (stable < 3 && ++attempts < 60) { frame = requestAnimationFrame(settle); return }
      if (revealed > 1) scrollToBeat(revealed)
      else window.scrollTo({ top: 0, behavior: 'instant' })
      frame = requestAnimationFrame(() => {
        restoring.current = false
        entryScrollY.current = window.scrollY
        window.dispatchEvent(new Event('scroll'))
      })
    }
    const stop = () => {
      cancelled = true
      cancelAnimationFrame(frame)
      restoring.current = false
      window.dispatchEvent(new Event('scroll'))
    }
    const onKey = (event) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) stop() }
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('touchstart', stop, { passive: true })
    window.addEventListener('keydown', onKey)
    document.fonts.ready.then(() => { if (!cancelled) frame = requestAnimationFrame(settle) })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchstart', stop)
      window.removeEventListener('keydown', onKey)
    }
  }, [phase, progressReady, scrollToBeat])

  const backFromSource = useCallback(() => {
    if (!cameFrom) return
    sourceReturnCleanup.current?.()
    const origin = cameFrom
    if (origin.entrance) { setPhase('opening'); setPanelOpen(false) }
    else { setTab(origin.tab); setFollowing(origin.beat); setPanelOpen(origin.panelWasOpen) }
    setCameFrom(null)
    const restore = () => {
      window.scrollTo({ top: origin.scrollY, behavior: 'instant' })
      const pane = document.querySelector('.panel-face')
      if (pane && origin.panelWasOpen) pane.scrollTop = origin.panelScrollTop
      const focus = origin.entrance
        ? document.querySelectorAll('.opening-notes button.cite')[origin.citeAt]
        : origin.focus?.isConnected ? origin.focus : document.querySelectorAll('.panel-body button.cite')[origin.panelCiteAt]
      if (focus?.isConnected) focus.focus({ preventScroll: true })
    }
    if (!origin.entrance) {
      requestAnimationFrame(restore)
      return
    }
    // 引入页与展开的依据重新挂载时，高度可能晚一帧才稳定。
    // 过早恢复会被浏览器按临时页面高度截断，随后也不会自动补回。
    let frame = 0, cancelled = false, stable = 0, attempts = 0, previous = null
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    const cancel = () => {
      cancelled = true
      cancelAnimationFrame(frame)
      for (const event of events) window.removeEventListener(event, cancel)
      if (sourceReturnCleanup.current === cancel) sourceReturnCleanup.current = null
    }
    sourceReturnCleanup.current = cancel
    for (const event of events) window.addEventListener(event, cancel, { passive: true })
    const settle = () => {
      if (cancelled) return
      const focus = document.querySelectorAll('.opening-notes button.cite')[origin.citeAt]
      if (!focus?.isConnected) { cancel(); return }
      const layout = { top: scrollY + focus.getBoundingClientRect().top, height: document.documentElement.scrollHeight }
      stable = previous && Math.abs(layout.top - previous.top) < .5 && layout.height === previous.height ? stable + 1 : 0
      previous = layout
      if (stable < 3 && ++attempts < 60) { frame = requestAnimationFrame(settle); return }
      cancel()
      restore()
    }
    frame = requestAnimationFrame(() => {
      if (cancelled) return
      const focus = document.querySelectorAll('.opening-notes button.cite')[origin.citeAt]
      if (focus?.isConnected) focus.focus({ preventScroll: true })
      document.fonts.ready.then(() => { if (!cancelled) frame = requestAnimationFrame(settle) })
    })
  }, [cameFrom])

  useEffect(() => {
    if (phase !== 'live' || cameFrom || personVisit || (panelOpen && !widePanel)) return
    const els = [...document.querySelectorAll('.beat[data-n]')]
    if (!els.length) return
    let frame = 0
    const locate = () => {
      frame = 0
      if (restoring.current || panelPositioning.current) return
      const line = 140
      let current = els[0]
      for (const el of els) if (el.getBoundingClientRect().top <= line) current = el
      /* **自己滚到页底就是读到末段。** 只认「段落顶部越过阅读线」的话，
         矮篇 + 高屏时读者把页面滚到底也到不了 140，会永远停在倒数第二段。
         但要排除「恢复位置本来就在页底」——那不是读完了，是这篇短。 */
      const movedDown = entryScrollY.current != null && window.scrollY > entryScrollY.current + 40
      const atBottom = movedDown && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      const n = Number(current.dataset.n)
      const reachedEnd = atBottom || els.at(-1).getBoundingClientRect().bottom <= window.innerHeight - 30
      /* 页底只改变「读到哪」，**不改变「当前是哪段」**：
         面板跟着阅读线走，把当前段也推到末段会让旁批跳过整整一段。 */
      setFollowing(n)
      // 末段可见时先展示读后内容；持久进度只跟阅读线走，不因文末露出而完读。
      if (reachedEnd) setAfterVisible(true)
      setRevealed((previous) => Math.max(previous, atBottom ? els.length : n))
    }
    const schedule = (event) => {
      if (event?.type === 'resize' && panelOpen) return
      if (event?.type === 'scroll' && panelOpen && !panelPositioning.current && !restoring.current) {
        panelScrolled.current = true
        const anchor = [...document.querySelectorAll('.reader .narration p, .reader .emerge')]
          .find(el => { const r = el.getBoundingClientRect(); return r.bottom > 100 && r.top < innerHeight })
        if (anchor) panelReturn.current = { el: anchor, top: anchor.getBoundingClientRect().top }
      }
      if (!frame) frame = requestAnimationFrame(locate)
    }
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    if (!panelOpen) schedule()
    /* 首帧量到的段高还没算上字体：短篇可能因此判成「末段不在视口里」，
       而页面又滚不动、不会再发 scroll，读后区块就永远不出现。
       字体就绪后再算一次阅读线。 */
    document.fonts.ready.then(() => { if (!panelOpen) schedule() })
    /* 版式还在长（字体、图片、读后区块）时也重算阅读线：
       短篇整页不用滚，没有 scroll 事件可用，只能靠高度变化触发。 */
    let ro = null
    if (typeof ResizeObserver !== 'undefined' && stageRef.current) {
      ro = new ResizeObserver(() => { if (!panelOpen) schedule() })
      ro.observe(stageRef.current)
    }
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
    }
  }, [phase, panelOpen, cameFrom, personVisit, widePanel])

  /* 时间地点戳：铺陈代码块的第一行就是它 */
  const stamp = story.intro.lines[0]?.text || story.time || ''

  /* ── 入口：情境铺陈 ───────────────────────── */
  if (phase === 'opening') {
    const lines = story.intro.lines.filter((l) => l.text !== stamp)
    return (
      <>
      <main className="wrap">
        <div style={{ paddingTop: 28 }}>
          <Crumbs person={person} story={story} />
        </div>
        <div className={`opening${story.img ? ' has-img' : ''}`}>
          {story.img && (
            <>
              <img className="opening-bg" src={story.img} alt="" aria-hidden="true" />
              <div className="opening-veil" />
            </>
          )}
          <div className="when">{stamp}</div>
          <h1 className="opening-title">{story.name.replace(/\s*★/g, '')}</h1>
          <div className="lines">
            {lines.map((l, i) => (
              <p key={i}>
                {l.marker ? (
                  <>
                    {l.text.slice(0, -3)}
                    <span className="line-tail">
                      {l.text.slice(-3)}
                      <span className="line-mark"><Marker ch={l.marker.trim()[0]} size={11} /></span>
                    </span>
                  </>
                ) : l.text}
              </p>
            ))}
          </div>
          <button className="cta" onClick={() => setPhase('live')}>
            {savedRead && !savedRead.done
              ? `继续阅读 · 第 ${resolveResume(person.id, story.id, savedRead, beats.length, beats).beat} 段`
              : '进入故事'}
          </button>
          {resumeAdjusted && (
            <p style={{ marginTop: 13, fontSize: 12.5, letterSpacing: '.04em', color: 'var(--su-mute)' }}>
              这一篇的内容更新过，接着读的位置按原段附近对齐。
            </p>
          )}
          {/* 开篇这一屏也要能收藏：读者第一次看到篇名就在这里。 */}
          <StarButton personId={person.id} storyId={story.id} storyName={story.name} />
          {/* **从头读**：有进度的时候才出现。清进度、回第一段。 */}
          {savedRead && (
            <button
              className="cta-ghost"
              onClick={() => { resetStory(person.id, story.id); setRevealed(1); setAfterVisible(false); setPhase('live') }}
            >
              从 头 读
            </button>
          )}
        </div>

        <div className="wrap-narrow" style={{ paddingBottom: 90 }}>
          <details
            className="opening-notes"
            open={openingNotesOpen}
            onToggle={(event) => setOpeningNotesOpen(event.currentTarget.open)}
          >
            <summary>查阅铺陈依据与标记</summary>
            <div className="note-box">
              {/* 依据按铺陈顺序编号，点击编号可查原文并返回这里。 */}
              {(story.intro.basis || []).map((r, i) => (
                <div key={i} className="mark-block">
                  <div className="hd">
                    <span className="label">{i + 1}</span>
                    <span
                      className="src mk"
                      style={{
                        color: r.marker.includes('◆') ? 'var(--zhu)'
                          : r.marker.includes('◇') ? 'var(--zi)' : 'var(--accent)',
                      }}
                    >
                      {r.marker}
                    </span>
                  </div>
                  <div className="body"><CiteText text={r.basis} ids={sourceIds} onJump={jumpToSource} /></div>
                </div>
              ))}
              <div style={{ marginTop: 14 }}><Legend foreign={foreignBooks(person)} /></div>
            </div>
          </details>
        </div>
      </main>

      </>
    )
  }

  /* ── 主体：双面 ───────────────────────────── */
  const shownMark = shownBeat?.marker || '—'
  /* 在场人物来自故事文件（`## 在场人物` 一节），不在组件里写死——
     写死的话换个故事就全错了。 */
  const presentHere = story.present.filter((p) => p.here)
  const presentNames = new Set(story.present.map(p => p.name))
  const supplementalPeople = (story.personNotes?.people || []).filter(p => !presentNames.has(p.name) &&
    personVersion(p, personTarget?.beat ?? following, personTarget?.paragraph ?? null))
    .map(p => ({ name: p.name, state: '相关人物' }))
  const presentAway = [...story.present.filter((p) => !p.here), ...supplementalPeople]
  const personEntry = (p, away = false) => {
    const item = story.personNotes?.people?.find(x => x.name === p.name)
    const version = personVersion(item, personTarget?.beat ?? following, personTarget?.paragraph ?? null)
    return (
      <div key={p.name} id={item ? `story-person-${item.id}` : undefined} data-person-current={item?.id === personTarget?.id}>
        <div className={`person${away ? ' away' : ''}`}>
          <span className="dot" /><span className="n">{p.name}</span>
          <span className="r">{away ? p.state.replace(/^不在场[（(]?/, '').replace(/[）)]$/, '') : p.role}</span>
        </div>
        {version && <div className="person-note-text">
          <p>{version.text}</p>
          <details><summary>出处</summary>{version.sources.map((ref, i) => ref.kind === 'local'
            ? <p key={i}><CiteText text={ref.id} ids={sourceIds} onJump={jumpToSource} /></p>
            : <p key={i}><a href={ref.url} target="_blank" rel="noreferrer">{ref.book}·{ref.section}</a></p>)}</details>
        </div>}
      </div>
    )
  }

  const sourcePanel = (
          <aside className="panel reader-panel" id="source-panel" hidden={!panelOpen} aria-label="史料查阅">
            <div className="panel-heading">
              <span>随文查证</span>
              <div className="panel-heading-actions">
                {savedRead && <button type="button" className="panel-restart" onClick={restart}>从头读</button>}
                <button type="button" className="panel-close" onClick={closePanel}>收起</button>
              </div>
            </div>
            <div className="panel-tabs">
              {TABS.map((t) => (
                <button
                  key={t.k}
                  aria-current={tab === t.k}
                  onClick={() => { setTab(t.k); if (t.k !== 'notes') { setEditing(null); setNoteBeat(null) } }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="panel-body">
              {tab === 'evidence' && shownBeat && (
                <div className="panel-face paper anim-fade" key={shownBeat.n} data-beat={shownBeat.n}>
                  <h3>这 一 处 的 依 据</h3>

                  {/* 每个来源都保留。已逐字匹配的当前摘句先显示，完整上下文按需展开。 */}
                  {(shownBeat.sources || []).map((id) => {
                    const full = source[id]?.text || ''
                    const excerpt = evidenceExcerpt(shownBeat, id, full)
                    return (
                      <div key={id} className="lead">
                        {source[id]?.parts
                          ? <SourceText source={source[id]} excerpt={excerpt || undefined} />
                          : <>「{excerpt || full}」</>}
                        <div style={{ fontSize: 11, color: 'var(--mo-mute)', marginTop: 6, letterSpacing: '.06em' }}>
                          {sourceExcerptOrigin(source[id], excerpt || undefined) || person.sourceBook} {id}
                        </div>
                        {excerpt && (
                          <details className="source-context">
                            <summary>展开完整底本 · {id}</summary>
                            <div className="source-context-text"><SourceText source={source[id]} /></div>
                          </details>
                        )}
                      </div>
                    )
                  })}

                  <div className={`mark-block ${
                    shownMark === '◆' ? 'source' : shownMark === '○' ? 'infer' : shownMark === '△' ? 'doubt' : 'silent'
                  }`}>
                    <div className="hd">
                      <span className="glyph mk"><Marker ch={shownMark} size={13} /></span>
                      <span className="label">{titleOf(shownMark, person, shownBeat, source)}</span>
                    </div>
                    {/* 依据正文只有在本段底本里找不到时才显示。
                        没有可显示的就不显示——不再补一句「引文即证据，见上」。
                        标记本身已经说完了。 */}
                    {evidenceAdds(shownBeat, source) && (
                      <div className="body"><CiteText text={shownBeat.ground} ids={sourceIds} onJump={jumpToSource} /></div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'source' && (() => {
                /* 「本篇原文」按**底本**分节。
                   一个人可能同时在读好几本书：曹操这篇的 001–003 是陈寿正文、
                   101 是裴松之注引孙盛《异同杂语》、201 是十四世纪的《三国演义》。
                   并排摊成一张单子、同样挂 ◆，读者会以为「闻司徒有七星宝刀一口」
                   是陈寿写的。分节 + 各自的书名 + 小说用空心标记，位置本身就是区分。 */
                const groups = (person.books || [])
                  .map((b) => ({ ...b, rows: b.ids.map((id) => source[id]).filter(Boolean) }))
                  .filter((b) => b.rows.length)
                /* 分节标题的写法：`档次 · 书名 · 这一档要提醒什么`。
                   四档都要**写出书名**——读者看的是「这一句出自哪本书」，
                   不是「这一句出自哪一档」。原来非正史三档只写档次
                   （「小说 · 不是史书，出自小说」），书名一个字没有：
                   正史那节写着《三国志·魏书·武帝纪》，小说那节却只有「小说」，
                   同一个人物、同一个面板，两套交代方式。
                   `b.book` 来自 source.md 的底本小节，界面不自己编。 */
                const SUB_HEAD = {
                  正史: '',
                  注: '不是正文',
                  小说: '不是史书',
                  野史: '不是正史',
                }
                const row = (s) => (
                  <div key={s.id} id={`src-${s.id}`} tabIndex={-1}
                    className={`mark-block ${s.tier === '正史' ? 'source' : FOREIGN_TIERS.has(s.tier) ? 'fiction' : 'noted'}`}>
                    <div className="hd">
                      <span className="glyph mk"><Marker ch={FOREIGN_TIERS.has(s.tier) ? '◇' : '◆'} size={11} /></span>
                      {/* 书名在标题里（正史）或者在牌上（注、小说），行尾只留编号，
                          不然会出现「《三国演义》第四回　《三国演义》第四回 201」 */}
                      {(s.tier !== '正史' || hasMixedSourceLayers(s)) && <span className="tag" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{s.origin}</span>}
                      <span className="src">{s.id}</span>
                      {person.supplementalSourceIds?.includes(s.id) && <span className="tag">补充参照</span>}
                      {/* **返回**：从依据点编号跳过来的人，要能一步回到刚才读的地方 */}
                      {(personCitationReturn || cameFrom) && (
                        <button type="button" className="cite back" onClick={personCitationReturn ? returnFromPersonCitation : backFromSource}>← 返回</button>
                      )}
                    </div>
                    <div className="quote"><SourceText source={s} /></div>
                  </div>
                )
                return (
                  <div className="panel-face paper anim-fade">
                    <h3>本 篇 原 文 · {story.sourceRange}</h3>
                    {groups.map((b, i) => (
                      <section className="src-group" key={`${b.tier}-${b.book}`}>
                        <h4 className={i === 0 ? 'sub-head first' : 'sub-head'}>
                          {[b.rows.some(hasMixedSourceLayers) ? '正文及附注' : b.tier, b.book, SUB_HEAD[b.tier]].filter(Boolean).join(' · ')}
                        </h4>
                        {b.rows.map(row)}
                      </section>
                    ))}
                  </div>
                )
              })()}

              {tab === 'backgrounds' && (
                <div className="panel-face paper anim-fade">
                  <h3>背 景 卡 · {story.backgrounds.length} 张</h3>
                  {story.backgrounds.map((bg, i) => (
                    <div key={i} className="mark-block">
                      <div className="hd">
                        <span className="label" style={{ color: 'var(--mo)' }}>{bg.name}</span>
                        {bg.marker && <span className="glyph mk"><Marker ch={bg.marker} size={11} /></span>}
                      </div>
                      {/* **按块渲染，不按段落数组渲染。**
                          背景卡里原来只有段落；出处对照表那种表格在编译期就被丢掉了
                          （见 R02）。现在编译器给出 `blocks`，表格原样渲染成表格。
                          老数据没有 `blocks` 时退回 `body`，不让既有背景卡变空。 */}
                      {(bg.blocks?.length ? bg.blocks : bg.body.map((text) => ({ type: 'p', text }))).map((blk, j) => (
                        blk.type === 'table' ? (
                          <table key={j} className="bg-table">
                            <thead><tr>{blk.head.map((c, k) => <th key={k}><RichText text={c} /></th>)}</tr></thead>
                            <tbody>
                              {blk.rows.map((r, k) => (
                                <tr key={k}>{r.map((c, m) => <td key={m}><RichText text={c} /></td>)}</tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div key={j} className="body" style={{ marginBottom: 8 }}><RichText text={blk.text} /></div>
                        )
                      ))}
                      {bg.basis && (
                        <div className="body" style={{ fontSize: 11.5, color: 'var(--mo-mute)', marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--zhi-3)' }}>
                          <CiteText text={bg.basis} ids={sourceIds} onJump={jumpToSource} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {tab === 'ground' && (
                <div className="panel-face paper anim-fade">
                  <h3>依 据 映 射 表 · {story.groundTable.length} 条</h3>
                  {story.groundTable.map((row, i) => (
                    <div key={i} className="mark-block">
                      <div className="hd">
                        <span className="label" style={{ color: 'var(--mo)', fontWeight: 400, fontSize: 13 }}>{row.claim}</span>
                        <span className="src"><RichText text={row.marker} /></span>
                      </div>
                      <div className="body" style={{ fontSize: 12 }}><CiteText text={row.basis} ids={sourceIds} onJump={jumpToSource} /></div>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'present' && (
                <div className="panel-face anim-fade">
                  {personVisit && <button type="button" className="person-note-return" onClick={returnFromPerson}>← {personVisit.panelOpen ? `回到刚才的${TABS.find(t => t.k === personVisit.tab)?.label || '查证'}` : '返回正文'}</button>}
                  <h3>此 刻 在 场</h3>
                  {presentHere.map((p) => personEntry(p))}

                  {presentAway.length > 0 && (
                    <>
                      <h4 style={{ marginTop: 24, fontSize: 11, letterSpacing: '.24em', color: 'var(--su-dim)', fontWeight: 400, marginBottom: 12 }}>
                        其 他 相 关 人 物
                      </h4>
                      {presentAway.map((p) => personEntry(p, true))}
                    </>
                  )}
                </div>
              )}
              {tab === 'notes' && (() => {
                const list = noteList
                const beatNo = editing?.beat ?? noteBeat ?? shownBeat?.n ?? following
                const current = list.find((note) => note.beat === beatNo) || null
                const start = () => setEditing({
                  key: current?.key || null, beat: beatNo, draft: current?.text || '',
                  quote: current?.quote || null, para: current?.para ?? null,
                })
                return (
                  <div className="panel-face paper anim-fade" key={`notes-${beatNo}`}>
                    <h3>第 {beatNo} 段 的 批 注</h3>
                    {editing && editing.beat === beatNo ? (
                      <div className="note-editor">
                        {editing.quote && <blockquote className="note-quote">「{editing.quote}」</blockquote>}
                        <textarea
                          className="note-input"
                          value={editing.draft}
                          rows={2}
                          maxLength={NOTE_LIMIT}
                          placeholder="写一句"
                          autoFocus
                          onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
                          onCompositionStart={() => { composing.current = true }}
                          onCompositionEnd={() => { composing.current = false }}
                          onBlur={() => { if (!composing.current) saveNote() }}
                          onKeyDown={(event) => {
                            /* Esc 只退出编辑，不关面板；面板自己的 Esc 在别处。 */
                            if (event.key === 'Escape') { event.stopPropagation(); cancelNote() }
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveNote() }
                          }}
                        />
                        <div className="note-actions">
                          <button type="button" onClick={saveNote}>存</button>
                          <button type="button" onClick={cancelNote}>取消</button>
                          {current && (
                            <button type="button" className="danger" onClick={() => { removeNote(current.key); cancelNote() }}>删</button>
                          )}
                          <span className="note-count">{editing.draft.length} / {NOTE_LIMIT}</span>
                        </div>
                      </div>
                    ) : current ? (
                      <div className="note-view">
                        <p className="note-text">{current.text}</p>
                        <div className="note-actions">
                          <button type="button" onClick={start}>改</button>
                          <button type="button" className="danger" onClick={() => removeNote(current.key)}>删</button>
                        </div>
                      </div>
                    ) : (
                      <div className="note-view">
                        <p className="note-empty">这一段还没有批注</p>
                        <div className="note-actions"><button type="button" onClick={start}>写一句</button></div>
                      </div>
                    )}
                    {list.length > 0 && (
                      <>
                        <h4 className="note-list-title">本 篇 · {list.length} 条</h4>
                        {list.map((note) => (
                          <button
                            type="button"
                            key={note.beat}
                            className={`note-item${note.beat === beatNo ? ' current' : ''}`}
                            onClick={() => {
                              setEditing(null); setNoteBeat(note.beat); setFollowing(note.beat)
                              /* 手机上面板是插在这一段之后的：先让面板落位，
                                 再把这一段滚到阅读线上——否则读者跳过去只看到面板，
                                 正文那一段被顶到屏幕外。 */
                              skipAlign.current = true
                              requestAnimationFrame(() => requestAnimationFrame(() => {
                                scrollToBeat(note.beat)
                                requestAnimationFrame(() => { skipAlign.current = false })
                              }))
                            }}
                          >
                            <span className="no">第 {note.beat} 段</span>
                            <span className="tx">{note.quote ? `「${note.quote}」 ` : ''}{note.text}</span>
                            {note.moved && <span className="mv">位置可能已变</span>}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )
              })()}
            </div>
          </aside>
  )

  return (
    <>
      <main className="wrap" style={{ paddingBottom: 80 }}>
        {pendingQuote && typeof document !== 'undefined' && createPortal((
          <button
            type="button"
            className="zhupi-pick"
            style={{
              left: pendingQuote.x,
              top: pendingQuote.y,
              transform: pendingQuote.below ? 'translate(-50%, 0)' : 'translate(-50%, -140%)',
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const picked = pendingQuoteRef.current || pendingQuote
              if (!picked) return
              pendingQuoteRef.current = null
              setPendingQuote(null)
              window.getSelection()?.removeAllRanges()
              setEditing({ key: null, beat: picked.beat, draft: '', quote: picked.text, para: picked.para })
              setNoteBeat(picked.beat)
              setFollowing(picked.beat)
              setTab('notes')
              showPanel(event.currentTarget)
            }}
          >
            评
          </button>
        ), document.body)}
        <div style={{ paddingTop: 24 }}>
          <Crumbs person={person} story={story} />
        </div>
        <div className="reader-actions">
          <StarButton personId={person.id} storyId={story.id} storyName={story.name} />
          <button type="button" onClick={() => { setPanelOpen(false); setPhase('opening'); window.scrollTo({ top: 0, behavior: 'instant' }) }}>回看引入</button>
          <button type="button" aria-expanded={panelOpen} aria-controls="source-panel" onClick={(event) => panelOpen ? closePanel() : showPanel(event.currentTarget)}>查证与背景</button>
        </div>
        <div className={`face reader${panelOpen && panelHost === panelDock.current ? ' with-panel' : ''}`}>
          {/* 暗场 */}
          <section className="stage" ref={stageRef}>
            <div className="scene-meta">{stamp}</div>
            <h1 className="reading-title">{story.name.replace(/\s*★/g, '')}</h1>

            <div className="beats">
              {beats.map((b) => {
                /* b.quotes 由编译器给：只有**逐字对得上底本**的那些行才算原文。
                   本地不要再用「有没有引号」去猜——白话对白也带引号。
                   就地渲染，不抽到段末：抽走的话，紧跟其后的白话回译会跑到引文前面。
                   回译跟着引文一起走，就是 06 段 5「——始终没有回头。」那个形状。 */
                const quotes = b.quotes || []
                const glossAt = new Set(quotes.map((q) => q.glossAt).filter((x) => x !== null))
                return (
                  <article key={b.n} data-n={b.n} id={`beat-${b.n}`} className="beat active" data-current={following === b.n}>
                    <div className="narration anim-emerge">
                      {b.prose.map((p, i) => {
                        const q = quotes.find((x) => x.at === i)
                        if (q) {
                          /* 引文也能划线批注：选中的是原文那一句。 */
                          const quoteMarks = quoteNotes
                            .filter((note) => note.beat === b.n && note.para === i && q.text.includes(note.quote))
                            .sort((a, z) => q.text.indexOf(a.quote) - q.text.indexOf(z.quote))
                          let cursor = 0
                          const citeParts = []
                          for (const note of quoteMarks) {
                            const start = q.text.indexOf(note.quote)
                            if (start < cursor) continue
                            citeParts.push(q.text.slice(cursor, start))
                            citeParts.push(<mark key={note.key} className="zhupi" data-note={note.key}>{note.quote}</mark>)
                            cursor = start + note.quote.length
                          }
                          citeParts.push(q.text.slice(cursor))
                          return (
                            <div key={i} className="emerge anim-emerge d2" data-para={i}>
                              <cite>{citeParts}</cite>
                              {/* **回译和白话重复时不渲染。** 同一句话在页面上出现三遍
                                  （白话 → 原文 → 回译 → 白话），读者读到的是复述。
                                   白话已经把这句原文译过了，回译就没有存在的理由。 */}
                              {q.gloss && !q.glossRedundant && <span className="gloss">{q.gloss}</span>}
                            </div>
                          )
                        }
                        if (glossAt.has(i)) return null
                        const marks = (story.personNotes?.occurrences || []).filter(m => m.beat === b.n && m.paragraph === i).sort((a, z) => a.offset - z.offset)
                        /* 划线批注：把选中的那一句也切出来，包一层朱线。 */
                        const noted = quoteNotes
                          .filter((note) => note.beat === b.n && note.para === i)
                          .map((note) => ({ note, start: p.indexOf(note.quote), end: p.indexOf(note.quote) + note.quote.length }))
                          .filter((span) => span.start >= 0)
                        if (!marks.length && !noted.length) return <p key={i} data-para={i}>{p}</p>
                        const spans = [
                          ...marks.map((mark) => ({ kind: 'person', start: mark.offset, end: mark.offset + mark.text.length, mark })),
                          ...noted.map((span) => ({ kind: 'note', ...span })),
                        ].sort((a, z) => a.start - z.start)
                        const parts = []; let cursor = 0
                        for (const span of spans) {
                          if (span.start < cursor) continue        // 重叠就不画第二遍
                          parts.push(p.slice(cursor, span.start))
                          if (span.kind === 'person') {
                            parts.push(<button type="button" key={`${span.mark.personId}-${span.start}`} className="person-name-trigger" aria-controls="source-panel" aria-expanded={Boolean(personVisit && tab === 'present' && personTarget?.id === span.mark.personId)} onClick={event => openPerson(event, span.mark)}>{span.mark.text}</button>)
                          } else {
                            parts.push(<mark key={span.note.key} className="zhupi" data-note={span.note.key}>{p.slice(span.start, span.end)}</mark>)
                          }
                          cursor = span.end
                        }
                        parts.push(p.slice(cursor))
                        return <p key={i} data-para={i}>{parts}</p>
                      })}
                    </div>

                    {/* 插图位：内容里填了「图」才渲染，没填就什么都不占 */}
                    {b.img && (
                      <figure className="beat-figure">
                        <img src={b.img} alt={b.imgCaption || ''} loading="lazy" />
                        {b.imgCaption && <figcaption>{b.imgCaption}</figcaption>}
                      </figure>
                    )}

                    <div className="beat-actions">
                      <button
                        className="ground anim-fade d3"
                        onClick={(event) => { setTab('evidence'); setFollowing(b.n); showPanel(event.currentTarget) }}
                        aria-controls="source-panel"
                        title={titleOf(b.marker, person, b, source)}
                      >
                        <b className={MARK_CLASS[b.marker] || 'g-silent'}>{b.marker || '—'}</b>
                        <span className="sep">·</span>
                        依据
                        {b.source && <span className="src-id">{b.source}</span>}
                      </button>
                      <button
                        type="button"
                        className={`ground-note anim-fade d3${noteHas(b.n) ? ' on' : ''}`}
                        onClick={(event) => { setEditing(null); setNoteBeat(b.n); setTab('notes'); setFollowing(b.n); showPanel(event.currentTarget) }}
                        aria-controls="source-panel"
                        title={noteHas(b.n) ? '看这一段的批注' : '给这一段写一句'}
                      >
                        批注
                      </button>
                    </div>
                    <div className="inline-panel-host" data-panel-host />
                  </article>
                )
              })}
            </div>

            <div className="ask">
              {(prevStory || nextStory) ? (
                /* 读完之后，场景底部的这条常驻位换成出口。
                   和「继续」用同一套语言：贴着场景底的一条细线、暗场的字；
                   不是贴一张纸进来（纸是「查账」那边的语言，属于场景外）。 */
                <nav className="next-bar">
                  {prevStory
                    ? <Link href={`/p/${person.id}/${prevStory.id}`} className="prev">
                        <span className="k">上一篇</span><span className="t">{prevStory.name}</span>
                      </Link>
                    : <span />}
                  {nextStory
                    ? <Link href={`/p/${person.id}/${nextStory.id}`} className="next">
                        <span className="k">下一篇</span><span className="t">{nextStory.name}</span>
                      </Link>
                    : <span />}
                </nav>
              ) : (
                /* 这个人物只有这一篇时，上一篇/下一篇都不存在——
                   不留下一条空栏。退回到人物页，别让读者走到死路。 */
                <nav className="next-bar">
                  <span />
                  <Link href={`/p/${person.id}`} className="next">
                    <span className="k">回到</span><span className="t">{person.name}</span>
                  </Link>
                </nav>
              )}
            </div>
          </section>

          {/* 纸面 */}
          <div className="reader-panel-dock" ref={panelDock} hidden={!panelOpen || panelHost !== panelDock.current} />
          {panelHost && createPortal(sourcePanel, panelHost)}
        </div>

        {/* 读完之后 */}
        {isLast && (
          <section className="reader-after" style={{ marginTop: 56 }}>
            {story.cards.length > 0 ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
                  <h2 style={{ fontFamily: 'var(--f-song)', fontSize: 17, letterSpacing: '.14em', fontWeight: 600 }}>
                    读完之后 · {story.cards.length} 张复习卡
                  </h2>
                </div>
                <ReviewCards cards={story.cards} personId={person.id} storyId={story.id} sourceIds={sourceIds} onJump={jumpToSource} />
              </>
            ) : (
              <div className="card-hint" style={{ textAlign: 'left' }}>
                本篇暂无复习卡
              </div>
            )}

            {/* 提问入口。原来贴在场景底部，现在挪到复习卡之后——
                读完之后先看这一篇的账（复习卡），再开口问。
                仍然是和「继续」同一种形态：一条细线、左侧光标、右侧提示。 */}
            {story.seeds.length > 0 ? (
              <button className="ask-btn ask-after" onClick={() => setSheet(true)}>
                <span className="caret" />
                <span>读后追问</span>
                <span className="hint">{story.seeds.length} 个问题可选</span>
              </button>
            ) : (
              /* 还没有对话种子时，不显示一个点了没反应的入口 */
              <div className="ask-empty ask-after">本篇暂无可问的问题</div>
            )}

            <div className="note-box" style={{ marginTop: 34 }}>
              <Link href={`/p/${person.id}`} style={{ color: 'var(--accent)' }}>← {person.name}</Link>
              {' · '}
              <Link href="/settings" style={{ color: 'var(--accent)' }}>设置</Link>
              {' · '}
              <Link href="/" style={{ color: 'var(--accent)' }}>返回总览</Link>
            </div>
          </section>
        )}
      </main>

      {sheet && <SeedSheet seeds={story.seeds} source={source} onClose={() => setSheet(false)} />}
    </>
  )
}
