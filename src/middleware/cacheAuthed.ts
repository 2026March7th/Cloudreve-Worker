/**
 * 登录态只读接口的边缘缓存中间件（CF Cache API，跨 isolate 共享）。
 *
 * 用法：在 `appContext()` **之前**注册。命中即短路返回，跳过整个
 * `appContext`（省 KV + DB 往返）。
 *
 * 覆盖三类请求：
 *  1. 缓存命中（读）：`GET` 且命中允许列表 → 直接返回缓存响应。
 *  2. 缓存写入（读 miss）：`GET` 允许列表且 `code === 0` 的 200 响应 → 写回。
 *  3. 失效（写）：任何**成功**（200 + `code === 0`）的非 GET 登录态请求 →
 *     bump 该用户的 epoch，使旧缓存下一读即失效。
 *
 * 允许列表与 TTL（见 `AUTH_CACHEABLE`）：
 *  - `/api/v4/user/me`      用户资料，30s（资料极少变，写即失效）。
 *  - `/api/v4/file`         列目录，8s（写操作即时失效，TTL 兜底）。
 *
 * `/site/config/*` 与 ping 仍由 `cachePublicAnon` 处理（公开、与用户无关），
 * 不在此列，避免重复缓存。
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  authHash,
  bumpAuthEpoch,
  edgeAuthCacheMatch,
  edgeAuthCachePut,
  getAuthEpoch,
} from '../lib/edgeCacheAuth';

type Bindings = { Bindings: import('../env').Env };

interface CacheRule {
  re: RegExp;
  ttl: number;
}

/** 允许缓存的登录态 GET 接口及各自 TTL（秒）。 */
const AUTH_CACHEABLE: CacheRule[] = [
  { re: /^\/api\/v4\/user\/me$/, ttl: 30 },
  { re: /^\/api\/v4\/file$/, ttl: 8 },
];

/** 命中允许列表且为 GET 则返回规则，否则 null。 */
function matchCacheable(c: Context<Bindings>): CacheRule | null {
  if (c.req.method !== 'GET') return null;
  const p = c.req.path;
  for (const r of AUTH_CACHEABLE) if (r.re.test(p)) return r;
  return null;
}

/** 读信封的 `code` 字段判断是否真正成功（本 API 错误也走 HTTP 200）。 */
async function envelopeCode(c: Context<Bindings>): Promise<number | null> {
  try {
    const clone = c.res.clone();
    const j = (await clone.json()) as { code?: number };
    return typeof j.code === 'number' ? j.code : null;
  } catch {
    return null;
  }
}

export function cacheAuthed(): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    const rule = matchCacheable(c);

    // 前置准备：命中读列表且带登录态时，算 hash/epoch 并尝试命中。
    let pendingHash: string | undefined;
    let pendingEpoch: string | undefined;
    let pendingTtl = 0;

    if (rule) {
      const header = c.req.header('Authorization') ?? null;
      if (header) {
        const hash = await authHash(header);
        const epoch = await getAuthEpoch(c.env, hash);
        const hit = await edgeAuthCacheMatch(c, hash, epoch);
        if (hit) {
          const correlationId = c.req.header('X-Correlation-ID') ?? crypto.randomUUID();
          hit.headers.set('X-Correlation-ID', correlationId);
          // 浏览器侧 private + SWR：本人机器上即时复用，不进共享代理。
          hit.headers.set(
            'Cache-Control',
            `private, max-age=0, stale-while-revalidate=${rule.ttl}`,
          );
          return hit;
        }
        // miss：记下来，post 阶段写回（复用同一 hash/epoch）。
        pendingHash = hash;
        pendingEpoch = epoch;
        pendingTtl = rule.ttl;
      }
    }

    await next();

    const res = c.res;

    // 1) 读 miss 写回（仅真正成功的 200）。
    if (pendingHash && res.status === 200) {
      const code = await envelopeCode(c);
      if (code === 0) {
        edgeAuthCachePut(c, pendingHash, pendingEpoch!, pendingTtl);
        // 同时让浏览器也能 SWR（覆盖 jsonResponse 强制的 no-store）。
        res.headers.set(
          'Cache-Control',
          `private, max-age=0, stale-while-revalidate=${pendingTtl}`,
        );
      }
      return;
    }

    // 2) 写操作失效：任何成功的非 GET 登录态请求 bump epoch。
    if (rule === null && c.req.method !== 'GET' && res.status === 200) {
      const header = c.req.header('Authorization');
      if (header) {
        const code = await envelopeCode(c);
        if (code === 0) {
          await bumpAuthEpoch(c.env, await authHash(header));
        }
      }
    }
  };
}
