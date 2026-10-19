import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseStoryContent } from './build-content.mjs'

test('背景中的稿件分隔线不成为正文，普通段落、列表、破折号与表格完整保留', () => {
  const story = parseStoryContent('fixture.md', {}, [
    '# 背景示例', '## 二、情节点', '### 情节点 1 · 开始', '> 故事正文。',
    '| 标记 | ◆ |', '## 四、背景卡', '### 甲 ◆',
    '先读这一段。', '', '---', '***', '___', '  ----  ',
    '—', '——后面的解释仍须保留。', '- 百姓惊恐，士卒没有斗志。',
    '| 来源 | 经过 |', '|---|---|', '| 正文 | 追击受降 |',
    '> **依据**：`027`', '---', '### 乙 ○', '第二张卡没有被吞。', '## 五、依据映射表',
  ])
  assert.equal(story.backgrounds.length, 2)
  assert.deepEqual(story.backgrounds[0].blocks, [
    { type: 'p', text: '先读这一段。' }, { type: 'p', text: '—' },
    { type: 'p', text: '——后面的解释仍须保留。' },
    { type: 'p', text: '- 百姓惊恐，士卒没有斗志。' },
    { type: 'table', head: ['来源', '经过'], rows: [['正文', '追击受降']] },
  ])
  assert.deepEqual(story.backgrounds[0].body, ['先读这一段。', '—', '——后面的解释仍须保留。', '- 百姓惊恐，士卒没有斗志。', '来源 ｜ 经过', '正文 ｜ 追击受降'])
  assert.equal(story.backgrounds[0].basis, '027')
  assert.equal(story.backgrounds[1].blocks[0].text, '第二张卡没有被吞。')
})

test('真实赤壁背景保留全部来源对读表、行与依据', () => {
  const story = parseStoryContent('people/caocao/stories/09-chibi.md', {})
  const card = story.backgrounds.find(bg => bg.name === '谁烧的船')
  const table = card.blocks.find(block => block.type === 'table')
  assert.equal(table.head.length, 4)
  assert.equal(table.rows.length, 6)
  assert.ok(card.basis.includes('313'))
  for (const bg of story.backgrounds) assert.ok(!bg.blocks.some(block => block.type === 'p' && block.text === '---'))
})
