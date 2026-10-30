import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStoryContent } from './build-content.mjs'
import { preparePersonNotes, personVersion } from '../lib/person-notes.mjs'
import { supplementaryIds } from '../lib/story-sources.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const source = Object.fromEntries(read('content/people/gaohuan/source.md').split('\n').map(line => line.match(/^\|\s*(\d{3})\s*\|\s*(.*?)\s*\|/)).filter(Boolean).map(m => [m[1], { text: m[2] }]))
const fixtures = ['03-jianghu', '05-hanling'].map(id => ({ id, story: parseStoryContent(`people/gaohuan/stories/${id}.md`, source), data: JSON.parse(read(`content/people/gaohuan/person-notes/${id}.json`)) }))

test('高欢十篇人物介绍均绑定本篇正文与有效来源', () => {
  const dir = path.join(root, 'content/people/gaohuan/person-notes')
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
  assert.equal(files.length, 10)
  for (const file of files) {
    const id = file.slice(0, -5)
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const story = parseStoryContent(`people/gaohuan/stories/${id}.md`, source)
    preparePersonNotes(story, data, source)
    assert.ok(data.people.every(person => data.occurrences.some(mark => mark.personId === person.id)), file)
  }
})

test('高欢两个样本严格绑定真实正文，且无未来介绍兜底', () => {
  for (const { story, data } of fixtures) {
    assert.equal(preparePersonNotes(story, data, source), data)
    assert.ok(personVersion(data.people[0], 1))
    assert.equal(personVersion(data.people[0], 6), null)
  }
  assert.notEqual(fixtures[0].data.people[0].versions[0].text, fixtures[1].data.people[0].versions[0].text)
})

test('人物介绍引用的篇外原文补入查证，已收录编号不重复', () => {
  const story = {...fixtures[1].story, personNotes: fixtures[1].data}
  const ids = supplementaryIds(story, source, new Set(['015']))
  assert.ok(ids.includes('005'))
  assert.ok(ids.includes('008'))
  assert.ok(!ids.includes('015'))
})

test('正文改变、偏移失配、原文引句、版本重叠和缺失出处不能静默通过', () => {
  const {story,data} = fixtures[0]
  for (const change of [
    d => d.occurrences[0].paragraphText += '改动',
    d => d.occurrences[0].offset++,
    d => d.people[0].versions.push({...d.people[0].versions[0]}),
    d => { d.people[0].versions[0].sources = [{kind:'local',id:'999'}] },
    d => d.occurrences.push({...d.occurrences[0]}),
  ]) {
    const d = structuredClone(data); change(d)
    assert.throws(() => preparePersonNotes(story,d,source))
  }
  const withQuote=structuredClone(story);withQuote.beats[0].quotes.push({at:0})
  assert.throws(() => preparePersonNotes(withQuote,data,source),/原文引句/)
})

test('同一段中的不同人名允许共存，重叠标记拒绝', () => {
  const story={beats:[{n:1,prose:['甲和乙会面'],quotes:[]}]}, source={'001':{text:'依据'}}
  const person=id=>({id,name:id,versions:[{from:1,to:1,text:'介绍',sources:[{kind:'local',id:'001'}]}]})
  const mark=(id,text,offset)=>({personId:id,beat:1,paragraph:0,offset,text,paragraphText:'甲和乙会面'})
  const data={people:[person('a'),person('b')],occurrences:[mark('a','甲',0),mark('b','乙',2)]}
  assert.doesNotThrow(()=>preparePersonNotes(story,data,source))
  data.occurrences.push(mark('a','甲和',0));assert.throws(()=>preparePersonNotes(story,data,source),/重叠/)
})

test('同一情节点内按段落选择介绍，位置不明时不猜测', () => {
  const story={beats:[{n:1,prose:['初见','决裂'],quotes:[]}]}, source={'001':{text:'依据'}}
  const person={id:'p',name:'某人',versions:[
    {from:1,to:1,fromParagraph:0,toParagraph:0,text:'初见',sources:[{kind:'local',id:'001'}]},
    {from:1,to:1,fromParagraph:1,toParagraph:1,text:'决裂',sources:[{kind:'local',id:'001'}]},
  ]}
  assert.doesNotThrow(()=>preparePersonNotes(story,{people:[person],occurrences:[]},source))
  assert.equal(personVersion(person,1,0).text,'初见')
  assert.equal(personVersion(person,1,1).text,'决裂')
  assert.equal(personVersion(person,1),null)
})
