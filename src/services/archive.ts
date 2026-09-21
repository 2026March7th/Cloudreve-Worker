/**
 * 归档区（archive KV）+ 写前日志（WAL）。
 *
 * ## 设计意图
 *
 * `KV_COUNT=5` 时五个角色已各占一个 namespace。这里**再保留一个独立的
 * KV 作为归档区**（`ARCHIVE_KV`），它有两个用途，都是「别的 KV 干不了」的：
 *
 *   1. **历史归档**（本文件）：把「最新的 = 最好的」这类会覆盖的历史版本
 *      留一份 —— 例如设置被改动前的旧值、用户被改前的旧行。主 KV 里只留
 *      最新（因为它是缓存，必须最新），历史归 archive。
 *
 *   2. **写前日志 WAL**（同目录 `wal.ts`）：Worker 没有传统事务，多步写
 *      中途失败会留下半成品。WAL 把「打算做什么」先记在**与业务库不同的
 *      存储**上，事后可回放/核对。
 *
 * ## 为什么归档要独立 namespace 而不是「主 KV 里换个键」
 *
 * 归档是**只增不减**的历史数据，而主 KV 是**可被整体清理**的缓存区
 * （运维清缓存、`delete` 键、TTL 过期）。两者放一起的话，清一次缓存就
 * 把历史一起清了 —— 那归档就失去意义。独立 namespace 后：
 *
 *   - 清业务缓存完全不影响归档（前缀 + 独立 namespace，双保险）；
 *   - 归档可以配更长的 TTL / 干脆不过期；
 *   - 归档写失败绝不影响业务（下面所有函数都吞异常）。
 *
 * ## 优雅降级
 *
 * 归档是**增强能力**，不是业务必需。所以：
 *   - 没绑 `ARCHIVE_KV` → 所有归档操作变成 no-op（不报错、不抛异常）；
 *   - 归档读写失败 → 静默忽略，业务照常。
 * 这样「1 个 KV 的部署」和「6 个 KV 的部署」跑的是同一份代码。
 */
import type { Env } from '../env';

/** 归档区绑定名。独立于 KV_1..KV_5，需要单独在面板/wrangler 里声明。 */
const ARCHIVE_BINDING = 'ARCHIVE_KV';

/** 归档键前缀。即使误配到同一个 namespace，也不会与业务键相撞。 */
const ARCHIVE_PREFIX = 'archive:';

/**
 * 归档条目。
 *
 * `at` 是归档时间（写入方给出，取服务端时间），`kind` 标明归档的是什么
 * （如 `settings` / `user`），`id` 是被归档对象的标识。三者一起构成
 * 「这条历史属于谁、什么时候的」。
 */
export interface ArchiveEntry<T = unknown> {
  kind: string;
  id: string | number;
  at: string;
  /** 被归档的**旧值**（写入方通常在被新值覆盖之前调用 archivePut）。 */
  value: T;
  /** 可选：这次改动是谁触发的（用户 id / 'system'）。 */
  actor?: string | number;
  /** 可选：补充说明，如改了什么字段。 */
  note?: string;
}

/**
 * 取归档 namespace。未绑定时返回 `null`（调用方据此走 no-op）。
 *
 * **不抛异常**：归档是可选能力，缺绑定是合法状态。
 */
export function archiveKv(env: Env): KVNamespace | null {
  const ns = (env as unknown as Record<string, KVNamespace | undefined>)[ARCHIVE_BINDING];
  return ns ?? null;
}

/** 归档是否可用（诊断端点用）。 */
export function archiveEnabled(env: Env): boolean {
  return archiveKv(env) !== null;
}

/**
 * 归档键名。
 *
 * 形如 `archive:settings:global:1737...-abc123`。
 * 用**时间戳前置**（不是后置）是为了让 `list({prefix})` 天然按时间有序
 * —— KV 的 list 返回顺序就是键的字典序，时间戳在前的键翻页即时间线。
 * 尾部追加随机串避免同一毫秒内两次归档互相覆盖。
 */
function archiveKey(kind: string, id: string | number, at: Date, nonce: string): string {
  const stamp = at.toISOString();
  return `${ARCHIVE_PREFIX}${kind}:${id}:${stamp}:${nonce}`;
}

/** 列出某对象的归档，最新的在前。 */
export function archivePrefix(kind: string, id?: string | number): string {
  return id === undefined ? `${ARCHIVE_PREFIX}${kind}:` : `${ARCHIVE_PREFIX}${kind}:${id}:`;
}

/**
 * 归档一个**旧值**（覆盖前调用）。
 *
 * 典型用法：改设置前把旧值归档，再写新值。
 *
 * @param ttlSeconds 归档保留时间。不传则永不过期（归档的本意就是长期留存）。
 * @returns 归档成功与否。**失败不抛** —— 归档失败绝不能让业务写失败。
 */
export async function archivePut<T>(
  env: Env,
  kind: string,
  id: string | number,
  value: T,
  opts: { actor?: string | number; note?: string; ttlSeconds?: number } = {},
): Promise<boolean> {
  const ns = archiveKv(env);
  if (!ns) return false;
  try {
    const at = new Date();
    const nonce = crypto.randomUUID().slice(0, 8);
    const entry: ArchiveEntry<T> = {
      kind,
      id,
      at: at.toISOString(),
      value,
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    };
    const putOpts = opts.ttlSeconds ? { expirationTtl: opts.ttlSeconds } : {};
    await ns.put(archiveKey(kind, id, at, nonce), JSON.stringify(entry), putOpts);
    return true;
  } catch {
    // 归档是增强能力：失败静默。业务数据已经在主库/KV 里了。
    return false;
  }
}

/**
 * 读回某对象的归档历史（最新的在前，最多 `limit` 条）。
 *
 * 用 `list` + 逐条 `get` —— KV 没有「批量取 value」的 API。因此
 * **必须限制条数**（默认 20），否则一次翻几百页会打爆子请求预算。
 */
export async function archiveList<T = unknown>(
  env: Env,
  kind: string,
  id?: string | number,
  limit = 20,
): Promise<ArchiveEntry<T>[]> {
  const ns = archiveKv(env);
  if (!ns) return [];
  try {
    const listed = await ns.list({ prefix: archivePrefix(kind, id), limit });
    const out: ArchiveEntry<T>[] = [];
    for (const k of listed.keys) {
      const raw = await ns.get(k.name, 'json');
      if (raw && typeof raw === 'object') out.push(raw as ArchiveEntry<T>);
    }
    // list 是字典序升序 → 反转成「最新在前」，符合「看历史」的直觉。
    return out.reverse();
  } catch {
    return [];
  }
}

/**
 * 归档键数量（诊断用）。只翻一页，用于判断「归档区到底有没有在用」。
 */
export async function archiveCount(env: Env, kind?: string): Promise<number> {
  const ns = archiveKv(env);
  if (!ns) return 0;
  try {
    const listed = await ns.list({ prefix: kind ? `${ARCHIVE_PREFIX}${kind}:` : ARCHIVE_PREFIX, limit: 1000 });
    return listed.keys.length;
  } catch {
    return 0;
  }
}
