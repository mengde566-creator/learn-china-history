/**
 * 存储键的唯一拼法。
 *
 * 一律 `人物/篇`，不允许只用篇 id：`01-jingkou` 同时属于 liuyu 与 tandaoji，
 * 只按篇 id 存会把两篇合成一条。进度与收藏共用这一个实现，
 * 免得两份代码各写一次、某天其中一份忘了带人物。
 */
export const storyKey = (personId, storyId) => `${personId}/${storyId}`

/** 合法的篇键：恰好一个斜杠，两边都不空。 */
export const isStoryKey = (key) => /^[^/]+\/[^/]+$/.test(String(key || ''))
