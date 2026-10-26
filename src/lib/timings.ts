/**
 * 请求内的分段计时（诊断用）。
 *
 * 用 WeakMap 挂在 AppContext 实例上：服务层（fs/upload/…）在关键 DB 段落
 * 打点，`middleware/app.ts` 收尾时把它们并进 `Server-Timing` 头。这样线上
 * 一个请求就能看出慢在哪一段，不用再靠猜。
 */
const stages = new WeakMap<object, { name: string; ms: number }[]>();

/** 记一段耗时。`startedAt` 是这一段开始时的 `performance.now()`。 */
export function stageMark(key: object, name: string, startedAt: number): void {
  const arr = stages.get(key);
  if (arr) arr.push({ name, ms: performance.now() - startedAt });
}

/** 开始记录（首次调用时初始化）。 */
export function stageInit(key: object): void {
  if (!stages.has(key)) stages.set(key, []);
}

export function stagesOf(key: object): { name: string; ms: number }[] | undefined {
  return stages.get(key);
}
