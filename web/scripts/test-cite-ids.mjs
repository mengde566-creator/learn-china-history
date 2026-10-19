import assert from 'node:assert/strict'
import test from 'node:test'
import { sourceReferences } from '../lib/cite-ids.mjs'
import { supplementaryIds } from '../lib/story-sources.mjs'

test('同一依据中的纪年和来源编号分别识别，保留编号的位置', () => {
  const text = '189 年；194年；2018年；正文026–027，补充226及091。'
  const refs = [...sourceReferences(text)]
  assert.deepEqual(refs.map(m => m[1]), ['026', '027', '226', '091'])
  for (const ref of refs) assert.equal(text.slice(ref.index, ref.index + 3), ref[1])
})

test('纪年恰好等于可用编号也不增加跨篇资料；重复引用只补入一次', () => {
  const story = { backgrounds: [{ basis: '208 年；226、226、091及999' }] }
  const available = { '208': {}, '226': {}, '091': {} }
  assert.deepEqual(supplementaryIds(story, available, new Set(['226'])), ['091'])
})
