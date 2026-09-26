/**
 * 登录态 GET 接口的边缘缓存（CF Cache API，跨 isolate 共享）。
 *
 * ## 动机
 * 首屏登录后每个请求都要走 `appContext`：`loadSettings` 的 KV 读 →
 * `resolveUser` → 业务查询。`GET /api/v4/file`（列目录）是首屏必调热点，一次
 * 要打 ~5 次数据库往返；`/api/v4/user/me` 也每次必调。这些响应用户相关但
 * 「读多写少」，用边缘缓存后：命中即短路返回、跳过整个 `appContext`
 * （省 KV + DB），同数据中心内 isolate 轮换也共享同一份。
 *
 * ## 与 `cachePublicAnon`（匿名 ping / site/config）的关系
 *  - `cachePublicAnon` 只管**公开、与用户无关**的数据（ping + site/config），
 *    且不接受带 `Authorization` 的请求。本模块管**用户相关**的只读端点。
 *  - 键里带「登录态指纹」=`Authorization` 头的 SHA-256：只有拿到同一份
 *    token 的人才能算出同一把键；攻击者没有别人的 token 就算不出别人的键，
 *    **不会越权读到别人的缓存**。伪造 token（改 `sub`）算出的哈希不同 →
 *    必然 miss → 落到 `appContext` 被验签拒掉，不会命中别人的缓存。
 *
 * ## 正确性：写即失效
 *  每次成功的非 GET 登录态请求都会 bump 该用户的 `epoch`（存在 KV，跨
 *  isolate 可见）。缓存键带 epoch，所以一次写之后，旧缓存下一读就 miss、
 *  重新回源，做到同数据中心近实时失效。最坏情况（KV 跨区传播延迟）由 TTL
 *  兜底。epoch 设了 1h TTL，避免失效 token 的键无限堆积。
 *
 * ## 安全：客户端缓存
 *  响应回给浏览器时改写为 `private` + `stale-while-revalidate`，禁止共享
 *  代理缓存用户数据；`private` 只让浏览器在本人机器上做 SWR 加速。
 */
import type { Context } from 'hono';
import type { Env } from '../env';
import { edgeCacheMatch, edgeCachePut } from './edgeCache';
import { kvFor } from './kvRouter';

/** 缓存命名空间版本：响应结构破坏性变更时手动 +1，使所有旧键失效。 */
const EDGE_AUTH_CACHE_VER = 'v1';

/** 登录态指纹：Authorization 头的 SHA-256（永不存储原始 token）。 */
export async function authHash(header: string): Promise<string> {
  const data = new TextEncoder().encode(header);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

const EPOCH_MEMO = new Map<string, { v: string; t: number }>();
const EPOCH_MEMO_TTL_MS = 2000;

function deployKey(env: Env): string {
  // 用 JWT 密钥前缀区分不同部署，避免跨部署串缓存。
  return (env.JWT_SECRET ?? '').slice(0, 8) || 'dev';
}

export async function getAuthEpoch(env: Env, hash: string): Promise<string> {
  const memoKey = `${deployKey(env)}:${hash}`;
  const now = Date.now();
  const cached = EPOCH_MEMO.get(memoKey);
  if (cached && now - cached.t < EPOCH_MEMO_TTL_MS) return cached.v;
  let v = '0';
  try {
    const kv = kvFor(env, 'session');
    if (kv) {
      const got = await kv.get(`edge:ep:${hash}`);
      if (got) v = got;
    }
  } catch {
    /* KV 不可用时退化为不失效（靠 TTL 兜底） */
  }
  EPOCH_MEMO.set(memoKey, { v, t: now });
  return v;
}

/** 写操作后调用：bump 该用户的 epoch，使旧缓存下一读即失效（尽力而为）。 */
export async function bumpAuthEpoch(env: Env, hash: string): Promise<void> {
  try {
    const kv = kvFor(env, 'session');
    if (!kv) return;
    await kv.put(`edge:ep:${hash}`, String(Date.now()), { expirationTtl: 3600 });
    EPOCH_MEMO.delete(`${deployKey(env)}:${hash}`);
  } catch {
    /* 失效是尽力而为，失败不影响正确性（TTL 兜底） */
  }
}

function originOf(c: Context): string {
  return new URL(c.req.url).origin.replace(/\/+$/, '');
}

/** 归一化 query：按 key 排序，避免参数顺序不同产生不同键。 */
function normalizedQuery(c: Context): string {
  const url = new URL(c.req.url);
  const keys = [...url.searchParams.keys()].sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${url.searchParams.get(k)}`).join('&');
}

/**
 * 计算边缘缓存键路径。合成 URL（以 `/__edge_auth__/` 前缀），不含真实的
 * `?`，避免被 Cache API 当成查询串而错位匹配。
 */
function cacheKeyPath(c: Context, hash: string, epoch: string): string {
  const seg = [
    EDGE_AUTH_CACHE_VER,
    hash,
    epoch,
    encodeURIComponent(c.req.path),
    encodeURIComponent(normalizedQuery(c)),
  ].join('/');
  return `/__edge_auth__/${seg}`;
}

/** 查登录态边缘缓存（命中返回响应，未命中/不可用返回 null）。 */
export async function edgeAuthCacheMatch(
  c: Context,
  hash: string,
  epoch: string,
): Promise<Response | null> {
  const origin = originOf(c);
  const key = cacheKeyPath(c, hash, epoch);
  return edgeCacheMatch(origin, key);
}

/** 把登录态 GET 的 200 响应写回边缘缓存（尽力而为）。 */
export function edgeAuthCachePut(
  c: Context,
  hash: string,
  epoch: string,
  ttlS: number,
): void {
  const origin = originOf(c);
  const key = cacheKeyPath(c, hash, epoch);
  edgeCachePut(c.executionCtx.waitUntil, origin, key, c.res, ttlS);
}
