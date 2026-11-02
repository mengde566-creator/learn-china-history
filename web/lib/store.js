/**
 * 本机存储的**唯一基座**。
 *
 * 为什么要有这一层：`lib/progress.js` 和 `lib/settings.js` 各自抄了一遍
 * load / persist / emit / subscribe，而且两份的读盘容错已经分叉——
 * settings 用 `{...DEFAULTS, ...parsed}`，progress 逐字段校验。
 * 再加收藏与朱批就是第三份，三份各错一次的成本比这一层高得多。
 *
 * 这一层负责五件事，每件都有对应单测（`npm run test:store`）：
 *
 * 1. **版本迁移**：载荷里的 `v` 对不上就走 `migrate`；`legacyKeys` 只读接入旧键。
 * 2. **读—合并—写**：`localStorage` 整键覆盖，两个标签页各写一次会互相抹掉。
 *    写之前先读盘、按记录的时间戳合并。
 * 3. **坏数据不销毁**：解析或迁移失败时记下原文，下次覆盖之前先备份一份，
 *    状态置 `corrupt`。绝不「悄悄把读者攒的东西写成空」。
 * 4. **失败不静默**：写不进去（隐私模式、配额满）时状态变 `degraded`，
 *    调用方能据此把按钮置灰、提示读者。
 * 5. **形状校验**：读盘与导入都过一遍 `clean`，`read: null` 这种值
 *    不会一路走到 `progress.read[key]` 变成 TypeError。
 *
 * **不引 React**：node 单测能直接跑（React 的部分在 `lib/use-store.js`）。
 *
 * **契约**：同一份数据在应用里只应有一个 store 实例（模块级常量），
 * 否则两个实例各持一份 state、各自监听，互不同步。
 */

const PLAIN = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))

/** 已绑定 storage 监听的键。HMR 会重复执行模块，这层去重防止监听越挂越多。 */
const bound = new Set()

/**
 * 合并两份状态。规则只有两条：
 *
 * 1. **`depth > 0` 且两边都有 `at` 的记录**：取时间较新的；比不出来时本机为准
 *    （盘上那份是「上一次写下的」，本机这份是「读者刚刚动的」）。
 * 2. **其余情况**：当作集合逐键递归合并，缺的补上；叶子以本机为准。
 *
 * 两个坑，都是单测钉住的：
 * - **顶层不比较 `at`**。progress 的载荷顶层就有 `at`（最后一次推进时间），
 *   如果顶层走「整体取较新」，per-record 合并会整个失效（盘上别的篇全丢）。
 * - **必须递归**。`review[篇][卡号]` 是两层，只合一层会让第二张卡被吃掉。
 */
function mergeValue(local, disk, depth) {
  if (local === undefined || local === null) return disk
  if (disk === undefined || disk === null) return local
  if (!PLAIN(local) || !PLAIN(disk)) return local
  const bothAt = depth > 0 && typeof local.at === 'number' && typeof disk.at === 'number'
  if (bothAt) return disk.at > local.at ? disk : local
  const out = { ...local }
  for (const key of Object.keys(disk)) out[key] = mergeValue(local[key], disk[key], depth + 1)
  return out
}

export function mergeByAt(local, disk) { return mergeValue(local, disk, 0) }

export function createPersistentStore({
  key,
  version,
  defaults,
  migrate,
  legacyKeys = [],
  storage,
  app = 'guanshi',
  sanitize,
}) {
  const backend = () => storage
    ?? (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null)

  /** 只留 `defaults` 里有的顶层键，且类型要匹配——`read: null` 到不了上层。 */
  function shape(raw) {
    const out = clone(defaults)
    if (!PLAIN(raw)) return out
    for (const k of Object.keys(defaults)) {
      const d = defaults[k]
      const v = raw[k]
      if (PLAIN(d)) { if (PLAIN(v)) out[k] = v }
      else if (typeof v === typeof d) out[k] = v
    }
    return out
  }

  const clean = (raw) => (sanitize ? sanitize(raw, clone(defaults)) : shape(raw))

  let state = clone(defaults)
  let status = 'ok'            // ok | unavailable | degraded | corrupt | recovered
  let loaded = false
  let corrupt = null           // { key, raw }
  let lastRaw = null           // 上一次读到的原始串
  let lastDisk = null          // 那一串解析出来的**盘上状态**（不是内存状态）
  const subs = new Set()
  const emit = () => { for (const fn of subs) fn() }

  /** 读盘。坏数据一律当没有——**不因为存储坏了就读不了**；但原文要留证。 */
  function read() {
    const b = backend()
    if (!b) { status = 'unavailable'; return clone(defaults) }
    for (const k of [key, ...legacyKeys]) {
      let raw = null
      try { raw = b.getItem(k) } catch { continue }
      if (!raw) continue
      /* 缓存的是**盘上那份**，不是内存状态。写之前合并要是拿内存当盘用，
         跨标签页的「较新记录」就永远赢不了（单测钉着这一条）。 */
      if (raw === lastRaw) return lastDisk
      let parsed
      try { parsed = JSON.parse(raw) } catch {
        corrupt = { key: k, raw }; status = 'corrupt'; return clone(defaults)
      }
      if (!PLAIN(parsed)) {
        corrupt = { key: k, raw }; status = 'corrupt'; return clone(defaults)
      }
      const from = typeof parsed.v === 'number' ? parsed.v : 1
      const { v, ...rest } = parsed
      if (from !== version) {
        if (!migrate) {
          corrupt = { key: k, raw }; status = 'corrupt'; return clone(defaults)
        }
        let done
        try { done = migrate(rest, from) } catch {
          corrupt = { key: k, raw }; status = 'corrupt'; return clone(defaults)
        }
        lastRaw = raw
        lastDisk = clean(done)
        return lastDisk
      }
      lastRaw = raw
      lastDisk = clean(rest)
      return lastDisk
    }
    lastRaw = null
    lastDisk = null
    return clone(defaults)
  }

  function listen() {
    if (typeof window === 'undefined' || bound.has(key)) return
    bound.add(key)
    window.addEventListener('storage', (event) => {
      // null = 另一个标签页调了 clear()；旧键写入也要跟（回滚场景）。
      if (event.key !== null && event.key !== key && !legacyKeys.includes(event.key)) return
      lastRaw = null
      state = read()
      emit()
    })
  }

  function ensure() {
    if (loaded) return
    loaded = true
    state = read()
    listen()
  }

  /**
   * 落盘。`merge: false` 用于覆写（reset）。
   * 坏数据先备份原文，再覆盖——覆盖是对的，销毁证据不是。
   */
  function persist({ merge = true } = {}) {
    const b = backend()
    if (!b) { status = 'unavailable'; return false }
    let backedUp = false
    if (corrupt) {
      try { b.setItem(`${corrupt.key}.corrupt.${Date.now()}`, corrupt.raw) } catch { /* 备份失败也不能阻止写入 */ }
      corrupt = null
      backedUp = true
    }
    try {
      // 备份过就说明盘上那份已经坏了：**不要再拿它来合并**，否则会把空状态写回去。
      if (merge && !backedUp) state = mergeByAt(state, read())
      const payload = JSON.stringify({ ...state, v: version })
      // `v` 放在最后：导入的旧数据里如果带 `v`，不能让它盖掉版本号。
      b.setItem(key, payload)
      lastRaw = payload
      lastDisk = state
      status = backedUp ? 'recovered' : 'ok'
      return true
    } catch {
      status = 'degraded'
      return false
    }
  }

  const store = {
    key,
    version,
    defaults,
    get() { ensure(); return state },
    getStatus() { ensure(); return status },
    subscribe(fn) { ensure(); subs.add(fn); return () => { subs.delete(fn) } },

    /** 改状态。`updater` 拿到当前状态，返回新状态；返回同一个引用则什么都不做。 */
    set(updater) {
      ensure()
      const next = updater(state)
      if (next === state) return state
      if (!PLAIN(next)) {
        if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
          console.warn('[store] updater 必须返回对象，这次改动被忽略')
        }
        return state
      }
      state = clean(next)
      persist()
      emit()
      return state
    },

    /** 清除：**连旧键一起清**。不然读盘回落到旧键，刷新后数据原样回来。 */
    reset() {
      ensure()
      const b = backend()
      if (b) {
        for (const k of [key, ...legacyKeys]) { try { b.removeItem(k) } catch { /* 删不掉也不该崩 */ } }
      }
      lastRaw = null
      corrupt = null
      state = clone(defaults)
      persist({ merge: false })
      emit()
    },

    /** 导出的是**副本**：调用方改了它，不能反过来改到 store。 */
    exportJSON() {
      ensure()
      return { app, schema: version, exportedAt: Date.now(), data: clone(state) }
    },

    /** 导入：**合并，不是替换**；旧版数据先跑迁移；写失败要报错，不能假装成功。 */
    importJSON(payload) {
      ensure()
      if (!PLAIN(payload) || payload.app !== app || !PLAIN(payload.data)) {
        throw new Error('这个文件不是观史导出的数据')
      }
      if (typeof payload.schema !== 'number' || payload.schema > version) {
        throw new Error('这份数据来自更新的一版，当前版本读不了')
      }
      let raw = payload.data
      if (payload.schema !== version) {
        if (!migrate) throw new Error('这份数据来自旧版，当前版本不认')
        try { raw = migrate(raw, payload.schema) } catch {
          throw new Error('这份数据读不了，可能已经损坏')
        }
      }
      if (JSON.stringify(raw || {}).length > 1_500_000) {
        throw new Error('这份数据太大了，超过 1.5 MB')
      }
      state = mergeByAt(state, clean(raw))
      if (!persist()) throw new Error('写不进这台设备的浏览器，导入没有保存')
      emit()
      return state
    },
  }

  /* 浏览器里在模块加载时就完成首次读盘：避免在 React 渲染期做同步 I/O。 */
  ensure()

  return store
}
