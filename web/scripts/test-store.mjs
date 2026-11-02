/**
 * 本机存储基座的单测。**每一项都必须能失败**——写不出失败用例的检查等于没写。
 *
 * 跑法：npm run test:store
 *
 * 这里大半用例是「审查抓出来的真 bug」的钉子：reset 回落旧键、
 * 坏数据被下一次写入销毁、顶层 at 短路合并、导入的 v 覆盖版本、形状校验。
 * 冒烟测过的东西不算数——这五条每一条都会静默丢读者数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersistentStore, mergeByAt } from '../lib/store.js'

/** 内存版 localStorage。故意不依赖浏览器，这样单测不用起服务。 */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
    _keys: () => [...map.keys()],
  }
}

const defaults = { read: {}, review: {} }
const migrate = (raw) => ({ read: raw.read || {}, review: raw.review || {} })
const make = (storage, extra = {}) => createPersistentStore({
  key: 'guanshi.progress.v2',
  version: 2,
  defaults,
  migrate,
  legacyKeys: ['guanshi.progress.v1'],
  storage,
  ...extra,
})

test('没有数据时给默认值，且**不是同一个对象**（默认值不能被改动污染）', () => {
  const s = fakeStorage()
  const store = make(s)
  assert.deepEqual(store.get(), defaults)
  assert.notEqual(store.get(), store.defaults, '空存储直接把 defaults 交出去了')
  store.get().read['x/y'] = { beat: 1 }
  assert.deepEqual(store.defaults.read, {}, '上层的读写改到了 defaults')
  assert.equal(s._map.size, 0, '只是读，不该写盘')
})

test('坏 JSON：读成空、状态 corrupt，原值不被悄悄覆盖', () => {
  const s = fakeStorage({ 'guanshi.progress.v2': '{ 坏掉的一半' })
  const store = make(s)
  assert.deepEqual(store.get(), defaults)
  assert.equal(store.getStatus(), 'corrupt')
  assert.equal(s.getItem('guanshi.progress.v2'), '{ 坏掉的一半', '读的时候就把原值改了')
})

test('坏 JSON 之后第一次写入：先把原文备份，再覆盖', () => {
  const s = fakeStorage({ 'guanshi.progress.v2': '{ 坏掉的一半' })
  const store = make(s)
  store.get()
  store.set((state) => ({ ...state, read: { 'a/b': { beat: 1, at: 1 } } }))
  const backups = s._keys().filter((k) => k.startsWith('guanshi.progress.v2.corrupt.'))
  assert.equal(backups.length, 1, '覆盖之前没有留备份')
  assert.equal(s.getItem(backups[0]), '{ 坏掉的一半')
  assert.equal(store.getStatus(), 'recovered')
})

test('迁移抛错：不能变成「空状态 + 等下一次写入清空」', () => {
  const s = fakeStorage({ 'guanshi.progress.v1': JSON.stringify({ read: { 'a/b': { beat: 3, at: 5 } } }) })
  const store = make(s, { migrate: () => { throw new Error('迁移写坏了') } })
  assert.deepEqual(store.get(), defaults)
  assert.equal(store.getStatus(), 'corrupt')
  store.set((state) => ({ ...state, read: { 'c/d': { beat: 1, at: 1 } } }))
  const backups = s._keys().filter((k) => k.startsWith('guanshi.progress.v1.corrupt.'))
  assert.equal(backups.length, 1, '迁移失败后的第一次写入销毁了旧数据')
  assert.match(s.getItem(backups[0]), /a\/b/)
})

test('顶层不是对象也当没有', () => {
  for (const raw of ['null', '[]', '"x"', '42']) {
    const s = fakeStorage({ 'guanshi.progress.v2': raw })
    const store = make(s)
    assert.deepEqual(store.get(), defaults, `raw=${raw}`)
  }
})

test('形状校验：read:null 进来也是 {}，上层不会 TypeError', () => {
  const s = fakeStorage({ 'guanshi.progress.v2': JSON.stringify({ v: 2, read: null, review: [] }) })
  const store = make(s)
  assert.deepEqual(store.get(), { read: {}, review: {} })
})

test('v1 → v2 迁移：读得到旧数据，last 被丢掉，旧键保留', () => {
  const s = fakeStorage({
    'guanshi.progress.v1': JSON.stringify({
      read: { 'caocao/09-chibi': { beat: 6, beatCount: 9, at: 100 } },
      review: { 'caocao/09-chibi': { 3: 'known' } },
      last: { person: 'caocao', story: '09-chibi', at: 100 },
    }),
  })
  const store = make(s)
  const state = store.get()
  assert.equal(state.read['caocao/09-chibi'].beat, 6)
  assert.equal(state.review['caocao/09-chibi']['3'], 'known')
  assert.equal('last' in state, false, '迁移后不应再有 last')
  assert.ok(s._map.has('guanshi.progress.v1'))
})

test('新键优先于旧键', () => {
  const s = fakeStorage({
    'guanshi.progress.v1': JSON.stringify({ read: { 'a/b': { beat: 1, at: 1 } } }),
    'guanshi.progress.v2': JSON.stringify({ v: 2, read: { 'c/d': { beat: 2, at: 2 } } }),
  })
  const store = make(s)
  assert.deepEqual(Object.keys(store.get().read), ['c/d'])
})

test('reset 连旧键一起清，刷新后数据不会回来', () => {
  const s = fakeStorage({
    'guanshi.progress.v1': JSON.stringify({ read: { 'a/b': { beat: 6, at: 5 } }, review: {} }),
  })
  const store = make(s)
  assert.equal(store.get().read['a/b'].beat, 6)
  store.reset()
  assert.deepEqual(store.get().read, {})
  assert.equal(s.getItem('guanshi.progress.v1'), null, '旧键还在，下次读盘会把数据搬回来')
  // 刷新 = 新实例读同一份存储
  assert.deepEqual(make(s).get().read, {})
})

test('写之前先读盘合并：别的标签页刚写进来的记录不能被抹掉', () => {
  const s = fakeStorage()
  const store = make(s)
  store.get()
  s.setItem('guanshi.progress.v2', JSON.stringify({
    v: 2, read: { 'a/b': { beat: 4, at: 10 } }, review: {},
  }))
  store.set((state) => ({ ...state, read: { ...state.read, 'c/d': { beat: 2, at: 20 } } }))
  const disk = JSON.parse(s.getItem('guanshi.progress.v2'))
  assert.ok(disk.read['a/b'], '另一个标签页的 a/b 被覆盖掉了')
  assert.equal(disk.read['a/b'].beat, 4)
  assert.ok(disk.read['c/d'])
})

test('同一条记录取较新的一方', () => {
  const s = fakeStorage({
    'guanshi.progress.v2': JSON.stringify({ v: 2, read: { 'a/b': { beat: 9, at: 50 } }, review: {} }),
  })
  const store = make(s)
  store.get()
  store.set((state) => ({ ...state, read: { ...state.read, 'a/b': { beat: 2, at: 10 } } }))
  assert.equal(JSON.parse(s.getItem('guanshi.progress.v2')).read['a/b'].beat, 9)
})

test('updater 返回同一个引用时不写盘、不广播', () => {
  const s = fakeStorage()
  const store = make(s)
  let calls = 0
  store.subscribe(() => { calls++ })
  store.set((state) => state)
  assert.equal(calls, 0)
  assert.equal(s._map.has('guanshi.progress.v2'), false)
})

test('写不进去时状态变 degraded，不抛', () => {
  const broken = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError') },
    removeItem: () => {},
  }
  const store = make(broken)
  store.get()
  assert.equal(store.getStatus(), 'ok')
  store.set((state) => ({ ...state, read: { 'a/b': { beat: 1, at: 1 } } }))
  assert.equal(store.getStatus(), 'degraded')
})

test('没有可用的存储时状态是 unavailable，读给默认值，内存里照常工作', () => {
  const store = createPersistentStore({
    key: 'guanshi.progress.v2', version: 2, defaults, migrate, storage: null,
  })
  assert.deepEqual(store.get(), defaults)
  assert.equal(store.getStatus(), 'unavailable')
  assert.equal(
    store.set((state) => ({ ...state, read: { 'a/b': { beat: 1, at: 1 } } })).read['a/b'].beat,
    1,
  )
})

test('导出是副本；导入是合并而不是替换', () => {
  const s = fakeStorage({ 'guanshi.progress.v2': JSON.stringify({ v: 2, read: { 'a/b': { beat: 1, at: 10 } }, review: {} }) })
  const store = make(s)
  const payload = store.exportJSON()
  assert.equal(payload.app, 'guanshi')
  assert.equal(payload.schema, 2)
  payload.data.read['a/b'].beat = 999
  assert.equal(store.get().read['a/b'].beat, 1, '导出的对象是活引用，被调用方改到了 store')

  const other = make(fakeStorage())
  other.importJSON({ ...payload, data: { read: { 'a/b': { beat: 7, at: 99 }, 'x/y': { beat: 3, at: 5 } }, review: {} } })
  assert.equal(other.get().read['a/b'].beat, 7)
  assert.equal(other.get().read['x/y'].beat, 3)
})

test('导入旧版数据：先迁移，且数据里的 v 不能覆盖版本号', () => {
  const s = fakeStorage()
  const store = make(s)
  store.importJSON({
    app: 'guanshi', schema: 1,
    data: { v: 1, read: { 'a/b': { beat: 4, at: 9 } }, review: {}, last: { person: 'a', story: 'b' } },
  })
  const disk = JSON.parse(s.getItem('guanshi.progress.v2'))
  assert.equal(disk.v, 2, '导入数据里的 v 把版本号盖掉了')
  assert.equal(disk.read['a/b'].beat, 4)
  assert.equal('last' in disk, false, '导入没有跑迁移')
})

test('导入拒绝别的应用、更高版本、坏结构、过大', () => {
  const store = make(fakeStorage())
  assert.throws(() => store.importJSON({ app: 'other', schema: 2, data: {} }), /不是观史/)
  assert.throws(() => store.importJSON({ app: 'guanshi', schema: 99, data: {} }), /更新的一版/)
  assert.throws(() => store.importJSON(null), /不是观史/)
  assert.throws(() => store.importJSON({
    app: 'guanshi', schema: 2, data: { read: { 'a/b': { beat: 1, note: 'x'.repeat(1_600_000) } } },
  }), /太大了/)
})

test('导入写不进去时抛错，不假装成功', () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
  const store = make(broken)
  assert.throws(() => store.importJSON({ app: 'guanshi', schema: 2, data: { read: {}, review: {} } }), /写不进/)
})

test('mergeByAt：两层结构都要合并，没有 at 时本机为准', () => {
  const merged = mergeByAt(
    { review: { 'a/b': { 1: 'known' } } },
    { review: { 'a/b': { 1: 'todo', 2: 'known' } } },
  )
  assert.equal(merged.review['a/b']['1'], 'known')
  assert.equal(merged.review['a/b']['2'], 'known', '盘上多出来的卡被吃掉了')
})

test('mergeByAt：顶层有 at 也不能短路整份合并', () => {
  const merged = mergeByAt(
    { at: 5, read: { a: { beat: 1, at: 5 } } },
    { at: 1, read: { b: { beat: 2, at: 1 } } },
  )
  assert.deepEqual(Object.keys(merged.read).sort(), ['a', 'b'], '顶层 at 让整份记录退化成「取较新」')
})

test('mergeByAt：一边不是对象时不炸', () => {
  assert.deepEqual(mergeByAt(null, { a: 1 }), { a: 1 })
  assert.deepEqual(mergeByAt({ a: 1 }, null), { a: 1 })
  assert.deepEqual(mergeByAt({ a: { at: 2 } }, { a: 'x' }), { a: { at: 2 } })
})
