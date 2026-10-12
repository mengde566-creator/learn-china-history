'use client'

import Link from 'next/link'
import { useSettings } from '@/lib/settings'

export default function SettingsClient({ stats }) {
  const { settings, update, ready } = useSettings()

  return (
    <main className="wrap-narrow">
      <header className="page-head">
        <h1>设 置</h1>
        <p className="sub">
          设置保存在这台设备的浏览器里，不会上传，也不影响别人。
        </p>
      </header>

      <section>
        {/* ── AI 对话 ───────────────────────────── */}
        <div className="set-row">
          <div className="info">
            <h3>
              AI 自由对话
              <span className={`badge ${settings.aiEnabled ? 'on' : 'off'}`} style={{ marginLeft: 10 }}>
                {settings.aiEnabled ? '已开启' : '未开启'}
              </span>
            </h3>
            <p>
              开启后，除了预置的 60 个问题，你还可以<b>自己输入问题</b>，由 AI 以人物身份回答。
              <br />
              关闭时，产品用预置问答运行——<b>完整循环一样走得通</b>，只是不能自由提问。
            </p>
            <p style={{ marginTop: 10, color: 'var(--zhe)' }}>
              ⚠️ 当前版本（M2a）尚未接入 AI，<b>这个开关现在改了不会有任何效果</b>。
              它先把你的选择存下来，M2b 上线时直接生效。
            </p>
          </div>
          <div className="ctrl">
            <button
              className="switch"
              role="switch"
              aria-checked={ready && settings.aiEnabled}
              aria-label="AI 自由对话"
              onClick={() => update({ aiEnabled: !settings.aiEnabled })}
            />
          </div>
        </div>

        {/* ── 明暗 ──────────────────────────────── */}
        <div className="set-row">
          <div className="info">
            <h3>场景区浅色</h3>
            <p>
              场景区默认用暗场（「入戏」），依据面板用纸面（「查账」）——用明暗区分两种状态。
              <br />
              如果你长时间阅读觉得暗色累，可以打开这一项，把场景区也改成浅色。
            </p>
          </div>
          <div className="ctrl">
            <button
              className="switch"
              role="switch"
              aria-checked={ready && settings.lightStage}
              aria-label="场景区浅色"
              onClick={() => update({ lightStage: !settings.lightStage })}
            />
          </div>
        </div>
      </section>

      {/* ── 版本状态 ────────────────────────────── */}
      <section style={{ marginTop: 52 }}>
        <h2 style={{ fontFamily: 'var(--f-song)', fontSize: 16, letterSpacing: '.14em', fontWeight: 600, marginBottom: 6 }}>
          版 本 状 态
        </h2>

        <div className="note-box">
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 20px', alignItems: 'baseline' }}>
            <span style={{ color: 'var(--su-mute)' }}>当前版本</span>
            <span>M2a · <b>无 AI 的完整循环</b></span>

            <span style={{ color: 'var(--su-mute)' }}>已实现</span>
            <span>{stats.implemented}</span>

            <span style={{ color: 'var(--su-mute)' }}>下一步</span>
            <span>M2b · 接入 AI 自由对话（读上面那个开关）</span>

            <span style={{ color: 'var(--su-mute)' }}>再往后</span>
            <span>{stats.next}</span>
          </div>
        </div>

        <div className="note-box">
          <b>关于原文的诚实说明</b>
          <br />
          底本共 91 段，<b>全部尚未与实体书核对</b>。已标出 6 段高优先级核对项，另有 15 处待核疑点。
          <br />
          这个产品的目标不是假装没有不确定性，而是<b>把不确定性标出来</b>——四种标记存在的意义就在这里。
        </div>

        <div className="note-box">
          <b>关于「无 AI 模式」</b>
          <br />
          这不是一个缩水版。预置问答里的每一条都经过人工审校，并且带完整的依据标注；
          而 AI 现场生成的回答，反而<b>更容易编出动人但错误的内容</b>。
          <br />
          换句话说：<b>无 AI 模式是这个产品的下限，也是它最可靠的部分。</b>
        </div>

        <p style={{ marginTop: 30, fontSize: 13 }}>
          <Link href="/" style={{ color: 'var(--accent)' }}>← 返回总览</Link>
          {'　·　'}
          {stats.links.map((l, i) => (
            <span key={l.href}>
              {i > 0 && '　·　'}
              <Link href={l.href} style={{ color: 'var(--accent)' }}>{l.label}</Link>
            </span>
          ))}
        </p>
      </section>

      <div style={{ height: 90 }} />
    </main>
  )
}
