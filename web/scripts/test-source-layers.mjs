import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { attachSourceLayers, sourceLayersForText, sourceExcerptOrigin, hasMixedSourceLayers } from '../lib/source-layers.mjs'

const root = new URL('../../content/people/caocao/', import.meta.url)
const entries = JSON.parse(fs.readFileSync(new URL('source-layers.json', root)))
const readRows = file => new Map(fs.readFileSync(new URL(file, root), 'utf8').split('\n')
  .filter(l => /^\| \d{3} \|/.test(l)).map(l => l.split('|').slice(1, -1).map(v => v.trim())).map(c => [c[0], c]))
const raw = readRows('source.md'), glossRows = readRows('gloss.md')
const fixture = () => ({
  source: Object.fromEntries(Object.keys(entries).map(id => [id, {
    id, text: raw.get(id)[1], tier: Number(id) < 200 ? '正史' : '注', book: '《三国志·魏书·武帝纪》', origin: raw.get(id)[2],
  }])),
  gloss: Object.fromEntries(Object.keys(entries).map(id => [id, glossRows.get(id)[2]])),
})

test('十条真实材料分层不丢原文白话，分段稿与总稿同步', () => {
  const { source, gloss } = fixture()
  attachSourceLayers(source, gloss, entries)
  for (const [id, row] of Object.entries(source)) {
    assert.equal(row.parts.map(p => p.text).join(''), raw.get(id)[1])
    assert.equal(row.parts.map(p => p.gloss).join(''), gloss[id])
    const drafts = fs.readdirSync(new URL('gloss-parts/', root)).filter(f => f.endsWith('.md'))
      .flatMap(f => [...readRows(`gloss-parts/${f}`)]).filter(([n]) => n === id)
    assert.equal(drafts.length, 1, `${id} 分段稿应有一条`)
    assert.equal(drafts[0][1][2], gloss[id], `${id} 分段稿白话未同步`)
  }
})

test('袁遗小传、刘岱鲍信互见及两条音释是注，正文在原处续接', () => {
  const { source, gloss } = fixture(); attachSourceLayers(source, gloss, entries)
  for (const id of ['017', '019', '020', '023', '047', '053', '061', '063']) {
    assert(hasMixedSourceLayers(source[id])); assert.match(source[id].origin, /正文与裴注合录/)
    assert.equal(source[id].parts.filter(p => p.tier === '注').length, id === '061' ? 2 : 1)
  }
  assert.equal(source['019'].parts[0].text, '山阳太守袁遗、')
  assert.match(source['019'].parts[1].text, /^遗字伯业/)
  assert.match(source['017'].parts[2].text, /^河内太守王匡/)
  assert.match(source['063'].parts[2].text, /^汉罢三公官/)
})

test('309并列四层引书与孙盛评论，310分清两书', () => {
  assert.deepEqual(entries['309'].map(p => p.origin), [
    '裴松之注引《魏略》', '裴松之注引《魏氏春秋》', '裴松之注合引《曹瞒传》《世语》', '裴松之注所录孙盛评论',
  ])
  assert.deepEqual(entries['310'].map(p => p.origin), ['裴松之注引《世语》', '裴松之注引《曹瞒传》'])
  assert(entries['309'].every(p => p.tier === '注'))
})

test('正文摘句不沾注，注内摘句和跨界摘句保留实际归属', () => {
  const { source, gloss } = fixture(); attachSourceLayers(source, gloss, entries)
  const row = source['063']
  assert.match(sourceExcerptOrigin(row, '作玄武池以肄舟师。'), /正文$/)
  assert.match(sourceExcerptOrigin(row, '三苍曰：「肄，习也。」'), /裴松之注/)
  const excerpt = '肄， 习也。」汉罢三公官'
  assert.deepEqual(sourceLayersForText(row, excerpt).map(p => p.tier), ['注', '正史'])
  assert.equal(sourceLayersForText(row, excerpt).map(p => p.text).join(''), excerpt.replace(/\s/g, ''))
  assert.match(sourceExcerptOrigin(row, excerpt), /合录/)
  assert.equal(sourceLayersForText({ text: '无分层的原文' }), null)
})

test('陈旧分层、白话漂移、错误档次和空出处阻止编译', () => {
  for (const mutate of [
    parts => { parts['019'][1].text += '多出来的字' },
    parts => { parts['063'][1].gloss = '没有音释' },
    parts => { parts['309'][0].tier = '正史' },
    parts => { parts['019'][0].origin = '' },
    parts => { parts['999'] = parts['019'] },
  ]) {
    const { source, gloss } = fixture(), parts = structuredClone(entries); mutate(parts)
    assert.throws(() => attachSourceLayers(source, gloss, parts))
  }
})
