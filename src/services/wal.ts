/**
 * 写前日志（WAL, Write-Ahead Log）。
 *
 * ## 为什么需要
 *
 * Workers 里没有跨请求事务，`@neondatabase/serverless` 也没有交互式事务
 * （每次查询一个 HTTP 请求，「开事务 → 查 → 提交」不可行）。于是多步写
 * 天然存在**半成品状态**：例如「建订单 → 调支付 → 履行」中，第二步失败
 * 会留下一个永不履行的订单。
 *
 * WAL 的做法：**在业务写之前**，把「打算做什么」记在**与业务库不同的
 * 存储**上（KV）。这样：
 *   - 业务写成功了 → 标记 WAL 条目 `done`（或让它靠 TTL 过期）；
 *   - 业务写失败了 → WAL 里留下一条 `pending` 记录，事后可核对/回放；
 *   - 进程直接死了 → 同样留下 `pending`，这是 WAL 最重要的场景。
 *
 * ## 为什么放在 KV 而不是同一张表里
 *
 * 如果 WAL 也写进业务库，那「业务库挂了」时 WAL 一起没 —— 而业务库挂掉
 * 恰恰是最需要 WAL 的时刻。放在 KV 上是**独立的故障域**：库写失败时
 * 日志还在，事后能看到「当时打算做什么」。
 *
 * ## 与归档（archive.ts）的区别
 *
 *   - 归档：**事后**留存旧值，只增不改，长期。
 *   - WAL  ：**事前**记录意图，有生命周期（pending → done/过期），短期。
 *
 * 两者共用一个 KV（`ARCHIVE_KV`）—— 都是「独立于业务库的记录」，且都用
 * 前缀隔离（`wal:` vs `archive:`）。未绑定该 KV 时整体降级为 no-op。
 */
import type { Env } from '../env';
import { archiveKv } from './archive';

/** WAL 键前缀。与 archive 的 `archive:` 前缀区分开。 */
const WAL_PREFIX = 'wal:';

/**
 * 单调递增序号，用于打破「同一毫秒」的平局。
 *
 * 为什么需要：`new Date().toISOString()` 只到毫秒，同一毫秒内连续 start
 * 多次（快节奏操作完全可能）会得到完全相同的 `startedAt`，仅靠时间是
 * **无法还原创建先后**的。用这个自增序号保证同一 isolate 内严格有序。
 */
let walSeq = 0;

/** WAL 条目状态。 */
export type WalStatus = 'pending' | 'done' | 'failed';

/** 一条 WAL 记录。 */
export interface WalEntry {
  /** 操作名，如 `payment.fulfill` / `share.purchase`。 */
  op: string;
  /** 关联的业务对象标识。 */
  ref: string;
  status: WalStatus;
  /** 第一步记录时间。 */
  startedAt: string;
  /** 最后更新时间。 */
  updatedAt: string;
  /** 恢复现场所需的参数（尽量小）。 */
  payload?: unknown;
  /** 失败原因（status=failed 时）。 */
  error?: string;
  /**
   * 该记录在 KV 里的完整键名。仅 `walUnfinished()` 返回的对象带此字段
   * （读的时候才知道键名），用于同一毫秒内多条记录排序时打破平局。
   */
  key?: string;
}

/** 默认保留 7 天：够人工排查，又不会无限堆积。 */
const DEFAULT_TTL_S = 7 * 24 * 3600;

/** WAL 键名。`<op>:<ref>:<开始时间>:<随机串>` —— 时间在第三段，便于按 op/ref 列历史。 */
function walKey(op: string, ref: string, startedAt: string, nonce: string): string {
  return `${WAL_PREFIX}${op}:${ref}:${startedAt}:${nonce}`;
}

/** WAL 是否可用（诊断用）。 */
export function walEnabled(env: Env): boolean {
  return archiveKv(env) !== null;
}

/**
 * 开始一次多步操作：写入一条 `pending` 记录。
 *
 * @returns 可用于后续 `walDone` / `walFail` 的句柄；WAL 不可用时返回
 *          `null`（调用方据此跳过后续标记，业务逻辑不受影响）。
 */
export async function walStart(
  env: Env,
  op: string,
  ref: string | number,
  payload?: unknown,
): Promise<{ key: string; startedAt: string } | null> {
  const ns = archiveKv(env);
  if (!ns) return null;
  const startedAt = new Date().toISOString();
  // 序号 + 随机串：序号保证同一 isolate 内严格有序，随机串防跨 isolate 撞键。
  const seq = (walSeq = (walSeq + 1) % 100000);
  const nonce = `${String(seq).padStart(5, '0')}-${crypto.randomUUID().slice(0, 8)}`;
  const key = walKey(op, String(ref), startedAt, nonce);
  try {
    const entry: WalEntry = {
      op,
      ref: String(ref),
      status: 'pending',
      startedAt,
      updatedAt: startedAt,
      ...(payload !== undefined ? { payload } : {}),
    };
    await ns.put(key, JSON.stringify(entry), {
      expirationTtl: DEFAULT_TTL_S,
    });
    return { key, startedAt };
  } catch {
    return null;
  }
}

/**
 * 标记一次操作为成功。
 *
 * 成功后**直接删除**而不是改写为 `done`：WAL 里只留「没走完的」才有意义，
 * 成功的记录留着只会淹没真正需要关注的那些。顺序不变量由调用方决定
 * （先业务写成功、再删 WAL），任何一侧失败都会留下 `pending` 可查。
 */
export async function walDone(env: Env, handle: { key: string } | null): Promise<void> {
  if (!handle) return;
  const ns = archiveKv(env);
  if (!ns) return;
  try {
    await ns.delete(handle.key);
  } catch {
    // 删不掉就等 TTL 过期 —— 会被当成「可能没走完」，是安全的方向。
  }
}

/** 标记一次操作为失败（保留记录供排查）。 */
export async function walFail(
  env: Env,
  handle: { key: string; startedAt: string } | null,
  op: string,
  ref: string | number,
  error: unknown,
): Promise<void> {
  if (!handle) return;
  const ns = archiveKv(env);
  if (!ns) return;
  try {
    const entry: WalEntry = {
      op,
      ref: String(ref),
      status: 'failed',
      startedAt: handle.startedAt,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    await ns.put(handle.key, JSON.stringify(entry), { expirationTtl: DEFAULT_TTL_S });
  } catch {
    // 失败标记写不进去时，原 pending 记录仍在（TTL 内可查）。
  }
}

/** 从 WAL 键名里取最后一段（nonce，含单调序号）。用于同毫秒记录排序。 */
function nonceOf(key: string | undefined): string {
  if (!key) return '';
  const i = key.lastIndexOf(':');
  return i === -1 ? key : key.slice(i + 1);
}

/**
 * 列出**未完成**的 WAL 记录（`pending` / `failed`），供人工核对。
 *
 * 这是 WAL 的价值兑现点：能回答「有没有哪次操作起了头但没做完」。
 * 只翻一页（限 limit），避免打爆子请求预算。
 */
export async function walUnfinished(env: Env, limit = 50): Promise<WalEntry[]> {
  const ns = archiveKv(env);
  if (!ns) return [];
  try {
    const listed = await ns.list({ prefix: WAL_PREFIX, limit });
    const out: WalEntry[] = [];
    for (const k of listed.keys) {
      const raw = await ns.get(k.name, 'json');
      if (raw && typeof raw === 'object') {
        const e = raw as WalEntry;
        // 把 KV 键也带上：同一毫秒内多条记录 startedAt 会相同，
        // 排序需要键里的随机串来打破平局（保证顺序稳定可比）。
        if (e.status === 'pending' || e.status === 'failed') out.push({ ...e, key: k.name });
      }
    }
    // 最新的在前。startedAt 相同时用**键名的最后一段**（nonce，内含单调
    // 序号）倒序 —— 不能拿整个键名比：键是 `wal:<op>:<ref>:<time>:<nonce>`，
    // 整体字典序会被 op/ref 主导（`wal:op:...` < `wal:payment...`），
    // 那样同毫秒记录的顺序由操作名决定，与创建先后无关。
    return out.sort((a, b) => {
      if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
      const an = nonceOf(a.key);
      const bn = nonceOf(b.key);
      if (an === bn) return 0;
      return an < bn ? 1 : -1; // 序号大的（后创建）排前面
    });
  } catch {
    return [];
  }
}
