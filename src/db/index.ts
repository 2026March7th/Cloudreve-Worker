/**
 * Neon (PostgreSQL) 访问层。
 *
 * 用 `@neondatabase/serverless` 的 HTTP 驱动，在 Workers 里无需 TCP 连接池，
 * 每次查询就是一次 fetch。注意两点与本地 Postgres 驱动的差异：
 *
 *   1. BIGINT 通过 HTTP 以 **字符串** 返回（避免 JSON 精度丢失），
 *      所有读取路径都要过 `toNum()`。
 *   2. BYTEA 返回 **十六进制字符串**（`\x0102` 形式）。
 *      所有读取路径都要过 `toBytes()`。
 */
import { neon, neonConfig, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../env';

export type Sql = NeonQueryFunction<false, false>;

const clients = new WeakMap<object, Sql>();

/**
 * 取（并缓存）当前 env 对应的 SQL 客户端。
 *
 * 免费档 Neon 在并发突发时会回 5xx（实测并发 6 路 x 24 请求有 14 个失败，
 * 状态码 520 / 522 / 525 混杂，最长一次耗了 122 秒），用户侧表现为
 * 「数据库操作失败 (Server error (HTTP status 520))」。原先只有
 * `provision.ts` / `settings/provider.ts` 手动调 withRetry，**所有业务查询
 * （repo.ts 的 11 个类）完全没有重试**，一次抖动就直接报错。
 *
 * 重试只装一次（`neonConfig.fetchFunction`），在 **fetch 层**做：
 *   - 驱动 `execute()` 里读的是**模块级单例** `pg.defaults.fetchFunction`，
 *     传 `neon(url, {fetchFunction})` 是无效的（实测该选项根本到不了 fetch 调用点），
 *     必须走 `neonConfig` 这个全局入口；
 *   - 装在这一层对驱动完全透明：单条查询、`sql('...', params)`、
 *     `sql.transaction([...])` 全部自动覆盖，不需要逐个改调用点；
 *   - 早于驱动 `throw`，所以不会出现「驱动已把响应 body 读完、重试却要重放查询」
 *     的错位，也不依赖 `NeonQueryPromise` 的惰性求值语义。
 */
export function getSql(env: Env): Sql {
  const cached = clients.get(env);
  if (cached) return cached;
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  installRetryingFetch();
  const sql = neon(env.DATABASE_URL);
  clients.set(env, sql);
  return sql;
}

// ---------------------------------------------------------------------------
// fetch 层重试
// ---------------------------------------------------------------------------

/** 免费档 Neon 的网关在突发时会回这些状态；`429` 是显式限流。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fetchInstalled = false;

/**
 * 把 fetch 层重试装到 Neon 驱动上（幂等，全局只需一次）。
 *
 * 语义要点：**只在拿到可重试状态码时重试，用尽尝试次数后把原始响应交回驱动**，
 * 让驱动照旧抛 `Server error (HTTP status ...)`。这样：
 *   - 不吞错：最终失败的错误信息与不装重试时完全一致；
 *   - 不改契约：400（SQL 语法/约束）与 401（鉴权）立即透传，不浪费重试；
 *   - 请求体可重放：驱动传进来的 `init.body` 是已序列化的字符串，重试时原样复用。
 *
 * ⚠️ Workers 免费版单请求只有 50 个 subrequest，重试会成倍放大这个计数。
 * 之所以取 `ATTEMPTS = 4`（而不是更多）：本部署一个请求内的 DB 往返最多两三位数，
 * 正常路径一次就成（`passthrough`），只有当上游真在抖时才吃重试；4 次是
 * 「足够扛过一秒级的网关抖动」和「不把 subrequest 预算打光」之间的折中。
 * 需要更多次机会时，靠上层的 `withRetry` 再补（它重试的是整条查询）。
 */
function installRetryingFetch(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;

  const realFetch: typeof fetch = neonConfig.fetchFunction ?? globalThis.fetch.bind(globalThis);
  const ATTEMPTS = 4;

  neonConfig.fetchFunction = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let lastRes: Response | undefined;
    let lastErr: unknown;
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        lastRes = await realFetch(input as RequestInfo, init);
      } catch (err) {
        // fetch 层自己抛（连接被重置 / TLS 失败 / 上游断开）：也属瞬态
        lastErr = err;
        if (i === ATTEMPTS - 1) throw err;
        await sleep(300 * 2 ** i + Math.floor(Math.random() * 200));
        continue;
      }
      if (!isRetryableStatus(lastRes.status)) return lastRes;
      if (i === ATTEMPTS - 1) return lastRes; // 交回驱动，由它抛原始错误
      // 必须把失败响应体读掉，否则连接不会被释放
      try {
        await lastRes.text();
      } catch {
        /* 读不动就算了，不影响重试 */
      }
      await sleep(300 * 2 ** i + Math.floor(Math.random() * 200));
    }
    if (lastErr) throw lastErr;
    return lastRes!;
  };
}

// ---------------------------------------------------------------------------
// 业务层重试（withRetry）
//
// 注意：**fetch 层已经有一层重试**（见上方 `installRetryingFetch`），它会拦掉
// 绝大部分 5xx / 429 / 网络抖动。这里的 withRetry 是第二道防线，用途有二：
//   1. 覆盖 fetch 层用尽尝试后仍失败、但错误恰好属于瞬态的情况（多给几次机会）；
//   2. 给 `provision.ts` / `settings/provider.ts` 这类「整批操作」提供事务级重试
//      （一次 transaction = 一个 HTTP 请求，失败就整批重放，代价可控）。
// 驱动抛出的错误消息形如 `Server error (HTTP status 520): ...`，靠状态码识别。
// ---------------------------------------------------------------------------

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|too many/i.test(msg);
}

/**
 * Neon HTTP 端点回 5xx 时的错误。驱动源码（`@neondatabase/serverless`
 * `execute`）在非 400 错误分支里抛
 * `new Error(\`Server error (HTTP status ${status}): ${body}\`)`，
 * 所以这里靠消息里的 `HTTP status <code>` 识别。
 *
 * 这些是**上游网关层的瞬态失败**（520 unknown / 522 connection timed out /
 * 503 / 504），不是 SQL 本身的错误 —— 对**只读查询**和**幂等写**重试是安全的。
 * Cloudreve 的写操作绝大多数是 `UPDATE ... WHERE id = ?` 这类幂等形态。
 */
export function isUpstream5xxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /HTTP status (\d{3})/.exec(msg);
  if (m) {
    const status = Number(m[1]);
    return status >= 500 && status <= 599;
  }
  return false;
}

/** fetch 层自己抛出的网络异常（连不上、TLS、连接被重置），也值得重试。 */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'TypeError' ||
    /network|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|connection/i.test(err.message)
  );
}

/**
 * 值得重试的瞬态错误：
 *   1. 限流（429）
 *   2. **上游网关 5xx**（520/522/503/504）—— 免费档 Neon 在并发突发时的
 *      典型表现，用户侧表现为「数据库操作失败 (HTTP status 520)」
 *   3. fetch 层网络异常
 *   4. **没有任何 message** 的错误（跨序列化边界丢内容）
 *
 * 正常的数据库错误（缺表、语法、约束冲突）都带明确 message 且非 5xx，
 * 不会被误重试。
 */
function isTransientError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (isUpstream5xxError(err)) return true;
  if (isNetworkError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim().length === 0;
}

/** 带退避的重试：只对瞬态错误生效，其他错误原样抛出。 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i === attempts - 1) throw err;
      // 指数退避 + 抖动：并发突发时让重试错开，避免同一波请求同时回打
      await sleep(400 * 2 ** i + Math.floor(Math.random() * 250));
    }
  }
  throw lastErr;
}

/**
 * 把可能以字符串形式返回的 BIGINT / NUMERIC 归一化成 number。
 * 数据库里 size / storage 这类值不可能超过 Number.MAX_SAFE_INTEGER
 * （2^53 字节 ≈ 9 PB），因此直接转换是安全的。
 */
export function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 同上，但保留 null 语义。 */
export function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return toNum(v);
}

/** 把 bytea 列归一化成 Uint8Array。 */
export function toBytes(v: unknown): Uint8Array {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    let hex = v;
    if (hex.startsWith('\\x')) hex = hex.slice(2);
    else if (hex.startsWith('0x')) hex = hex.slice(2);
    if (hex.length === 0) return new Uint8Array(0);
    // 容错：奇数长度时左侧补 0
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array(0);
}

/** 把 Uint8Array 编码成 Postgres 的 bytea 十六进制字面量。 */
export function toByteaLiteral(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

/** JSON 列：驱动可能返回对象，也可能是字符串，统一解成对象。 */
export function toJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof v === 'object') return v as T;
  return fallback;
}

/** 时间列：驱动可能返回 Date 对象，也可能是 ISO 字符串。 */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}
