import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCards } from './build-content.mjs'

// 使用真实稿件，固定独立复审指出的表头和各条材料的身份。
for (const [id, n, head, labels] of [
  ['02-cidong', 2, ['来源', '经过'], ['《武帝纪》正文', '裴注引《魏书》', '《三国演义》第四回']],
  ['02-cidong', 8, ['出处', '经过', '方向'], ['《魏书》', '《世语》', '孙盛《杂记》']],
  ['09-chibi', 1, ['出处', '说'], [
    '《周瑜传》正文（113、114）', '《周瑜传》裴注引《江表传》（312）',
    '《周瑜传》另一处裴注引《江表传》（313）', '《吴主传》正文（外证）',
    '裴注引《山阳公载记》（265）',
  ]],
]) {
  test(`${id} 卡${n}保留表头和全部材料`, () => {
    const card = parseCards(`people/caocao/cards/${id}.md`).find((c) => c.n === n)
    const tables = card.blocks.filter((b) => b.t === 'table')
    assert.equal(tables.length, 1)
    assert.deepEqual(tables[0].head, head)
    assert.deepEqual(tables[0].rows.map((r) => r[0]), labels)
    assert(tables[0].rows.every((r) => r.length === head.length))
    assert.deepEqual(card.meta.map((m) => m.k), ['依据', '标记', '考点'])
    if (n === 8) assert.deepEqual(tables[0].rows.map((r) => r[2]), ['自卫', '起疑', '负人'])
  })
}

const parse = (body) => parseCards('fixture.md', `### 卡 1 · 对读\n\n**问：怎样区分？**\n\n${body}`.split('\n'))[0]

test('答案数据行可以使用元数据字段名，不丢第三列', () => {
  const card = parse('| 项目 | 内容 | 区别 |\n|---|---|---|\n| 依据 | 原句 | 直接记载 |\n| 标记 | ○ | 推论 |\n\n| | |\n|---|---|\n| 标记 | ◆ |')
  assert.deepEqual(card.blocks[0], {
    t: 'table', head: ['项目', '内容', '区别'],
    rows: [['依据', '原句', '直接记载'], ['标记', '○', '推论']],
  })
  assert.equal(card.marker, '◆')
})

test('独立空表头块仍识别来源、出处和标记等元数据', () => {
  const card = parse('答：先分清材料。\n\n| | |\n|---|---|\n| 来源 | 第一种材料 |\n| 出处 | 第二种材料 |\n| 标记 | ○ 外证 |')
  assert.deepEqual(card.blocks, [{ t: 'p', v: '先分清材料。' }])
  assert.deepEqual(card.meta, [{ k: '来源', v: '第一种材料' }, { k: '出处', v: '第二种材料' }, { k: '标记', v: '○ 外证' }])
  assert.equal(card.marker, '○')
})

test('空行分隔的两张答案表不合并，后接元数据不吞表格', () => {
  const card = parse('| 来源 | 内容 |\n|---|---|\n| 甲书 | 甲说 |\n\n| 出处 | 经过 | 方向 |\n|---|---|---|\n| 乙书 | 乙说 | 待考 |\n\n| | |\n|---|---|\n| 标记 | △ |')
  assert.deepEqual(card.blocks.map((b) => b.head), [['来源', '内容'], ['出处', '经过', '方向']])
  assert.deepEqual(card.blocks[1].rows, [['乙书', '乙说', '待考']])
})

test('元数据块中的内部审校备注不进入读者答案', () => {
  const card = parse('答：可见答案。\n\n| | |\n|---|---|\n| 标记 | ◆ |\n| 内部 | 不应显示的审校记录 |')
  assert.deepEqual(card.meta, [{ k: '标记', v: '◆' }])
  assert(!JSON.stringify(card).includes('不应显示'))
})

test('畸形元数据块或标记报出稿件行号，不静默截掉单元格', () => {
  for (const row of ['| 依据 | 文字 | 多余列 |', '| 未知字段 | 文字 |', '| 标记 | 未定 |']) {
    assert.throws(() => parse(`答：材料说明。\n\n| | |\n|---|---|\n${row}`), /fixture\.md:9/)
  }
})
