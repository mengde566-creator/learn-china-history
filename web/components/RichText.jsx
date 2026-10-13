/**
 * 把内容里的轻量标记渲染成带样式的文本。
 *
 * 支持：
 *   ◆ ○ △        四类依据标记里可内联的三个
 *   —             仅在独立成词时视为「史书的沉默」标记
 *   **粗体**       → <b>
 *   `编号`         → <code>
 *
 * 注意 `—` 的处理：内容里既有标记 `—`，也有破折号 `——`。
 * 所以只在它被空白包围或位于行尾时才当标记。
 */

const MARK_CLASS = {
  '◆': 'mk-source',
  '○': 'mk-infer',
  '△': 'mk-doubt',
  '—': 'mk-silent',
}

function renderInline(text, keyPrefix) {
  const out = []
  // 一次扫描，按优先级切分：标记 → 粗体 → 代码
  const re = /([◆○△](?=\s|$))|(?<=^|\s)(—)(?=\s|$)|(\*\*[^*]+\*\*)|(`[^`]+`)/g
  let last = 0
  let m
  let i = 0

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))

    const token = m[0]
    if (m[1] || m[2]) {
      const ch = m[1] || m[2]
      out.push(
        <span key={`${keyPrefix}-m${i++}`} className={`mk ${MARK_CLASS[ch]}`}>
          {ch}
        </span>
      )
    } else if (token.startsWith('**')) {
      out.push(<b key={`${keyPrefix}-b${i++}`}>{token.slice(2, -2)}</b>)
    } else if (token.startsWith('`')) {
      out.push(<code key={`${keyPrefix}-c${i++}`}>{token.slice(1, -1)}</code>)
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function RichText({ text, className }) {
  if (!text) return null
  const lines = String(text).split('\n')
  return (
    <span className={className}>
      {lines.map((line, idx) => (
        <span key={idx}>
          {idx > 0 && <br />}
          {renderInline(line, `l${idx}`)}
        </span>
      ))}
    </span>
  )
}

/** 单独渲染一个标记字形 */
export function Marker({ ch, size = 12 }) {
  return (
    <span className={`mk ${MARK_CLASS[ch] || 'mk-silent'}`} style={{ fontSize: size }}>
      {ch}
    </span>
  )
}

/** 四个标记的图例。长说明只在这里出现一次。 */
export function Legend() {
  return (
    <div className="legend">
      <span><Marker ch="◆" /> 出自原文，可逐字核对</span>
      <span><Marker ch="○" /> 合理推演，附推演链条</span>
      <span><Marker ch="△" /> 史书未载，后世有争议</span>
      <span><Marker ch="—" /> 史书未载，且推不出来</span>
      {/* ○ 后面常跟一个小字（「外证」「训释」）。那是推演链条的**来源**，
          全库 33 处，读者每一处都看得见，而这里原来一句解释都没有——
          「外证」是训诂学的词，不是给读者看的。说一次就够。 */}
      <b className="sub">
        ○ 后面的小字是这条推演的依据来自哪里：
        <em>外证</em>＝底本之外的材料（后世系年、注家训释），
        <em>训释</em>＝对字词的解释。
      </b>
    </div>
  )
}

/** 一句话说明全局规则：人物说出口的话一律是改写。说一次就够。 */
export function GlobalNote() {
  return (
    <p className="global-note">
      人物说出口的话一律是现代汉语改写，不可逐字核对；标记表示的是**回答内容**在史料上的地位。
    </p>
  )
}
