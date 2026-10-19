import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceExcerpt, validateEvidenceExcerpts } from '../lib/evidence.mjs'

const source = { '001': { text: '甲。乙。丙。' }, '002': { text: '丁。戊。己。' } }
test('多来源逐一摘引，编号与全文保留，旧单来源摘句兼容', () => {
  const beat = { sources: ['001', '002'], sourceExcerpts: { '001': '乙。', '002': '戊。' } }
  validateEvidenceExcerpts(beat, source)
  assert.equal(evidenceExcerpt(beat, '001', source['001'].text), '乙。')
  assert.equal(evidenceExcerpt(beat, '002', source['002'].text), '戊。')
  assert.equal(evidenceExcerpt({ sourceCell: '001 乙。' }, '001', source['001'].text), '乙。')
  assert.equal(evidenceExcerpt({ sourceCell: '001 乙。' }, '002', source['002'].text), null)
  assert.equal(source['001'].text, '甲。乙。丙。')
})
test('错配编号、拼接或虚构原句不能通过内容编译', () => {
  for (const excerpts of [{ '001': '丁。' }, { '001': '甲。丙。' }, { '001': '原书未有此句' }, { '003': '甲。' }, { '001': '' }]) {
    assert.throws(() => validateEvidenceExcerpts({ sources: ['001', '002'], sourceExcerpts: excerpts }, source))
  }
})
test('无摘句和全文同长时保持原有全文呈现，不自动删句', () => {
  assert.equal(evidenceExcerpt({ sources: ['001'] }, '001', source['001'].text), null)
  assert.equal(evidenceExcerpt({ sourceExcerpts: { '001': source['001'].text } }, '001', source['001'].text), null)
  assert.equal(evidenceExcerpt({ sourceExcerpts: { '001': '甲。丙。' } }, '001', source['001'].text), null)
})
