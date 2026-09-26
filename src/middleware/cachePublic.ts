/**
 * 公共匿名 GET 接口的边缘缓存（CF Cache API，跨 isolate 共享）。
 *
 * 首屏要打几个 site/config/* 与 ping，它们用户无关、几乎不变，但每个请求
 * 都会落入 appContext → loadSettings 付一次 KV 读。低流量站点 isolate 频繁
 * 轮换，isolate 级内存缓存不生效，等于每个请求都打 KV（~0.5s）。这些接口用
 * CF 边缘缓存后：首次请求回源写缓存，之后同一边缘数据中心的所有 isolate
 * （轮换也没关系，Cache API 是数据中心级、跨 isolate 共享）直接命中，跳过
 * KV 与冷启动。
 *
 * - 前置 cachePublicAnon()：命中即短路返回、跳过 appContext。
 * - 后置 cachePublicAnonStore()：miss 时把 200 响应写回缓存（60s）。
 *
 * 仅限匿名 GET 的 ping 与 site/config/* —— 这些是全局公开数据，不涉及任何
 * 用户态，缓存安全。TTL 60s 与 settings 的 KV 缓存窗口一致。
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { edgeCacheMatch, edgeCachePut } from '../lib/edgeCache';

type Bindings = { Bindings: Env };

/** 仅这些匿名 GET 走缓存：ping 与 site/config/*。 */
const CACHEABLE = [/^\/api\/v4\/site\/ping$/, /^\/api\/v4\/site\/config\//];

function isCacheable(c: Context<Bindings>): boolean {
  if (c.req.method !== 'GET') return false;
  if (c.req.header('Authorization')) return false; // 仅匿名
  const p = c.req.path;
  return CACHEABLE.some((re) => re.test(p));
}

/** 前置：命中边缘缓存则直接返回，跳过 appContext（省 KV / 冷启动）。 */
export function cachePublicAnon(): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    if (!isCacheable(c)) return next();
    const origin = new URL(c.req.url).origin;
    const hit = await edgeCacheMatch(origin, c.req.path);
    if (hit) {
      const correlationId = c.req.header('X-Correlation-ID') ?? crypto.randomUUID();
      hit.headers.set('X-Correlation-ID', correlationId);
      return hit;
    }
    return next();
  };
}

/** 后置：miss 时把 200 响应写回边缘缓存（60s，尽力而为）。 */
export function cachePublicAnonStore(): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status !== 200 || !isCacheable(c)) return;
    const origin = new URL(c.req.url).origin;
    edgeCachePut(c.executionCtx.waitUntil, origin, c.req.path, res, 60);
  };
}
