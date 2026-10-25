/**
 * Colo 级进程外缓存（Cache API）。
 *
 * 解决的问题：Workers 的 isolate 会被平台随时回收，模块级内存缓存跟着没了；
 * 而冷 isolate 的第一次请求要依次走 `KV 读 → 回源数据库`，实测站点设置这条
 * 路径能吃掉 **900ms 左右**（KV 远端读 + Neon 新加坡往返）。这个成本对
 * 「新 isolate 的第一个访客」是全额支付的，而低流量站点上**每次访问大概率
 * 都是某个 isolate 的第一个请求** —— 也就是首屏那 1 秒。
 *
 * Cache API 是 **colo 内、跨 isolate 共享** 的：同一个边缘节点上只要有一个
 * isolate 写进去过，后续任何新 isolate 读它都是内存级（1~3ms）。
 *
 * 三条纪律：
 *  1. 键用**合成域名**（`https://colo-cache.internal/...`），客户端永远请求
 *     不到，因此不会与真实响应互相污染，也不存在被外部投毒的可能。
 *  2. 非 Workers 运行时（本地 Node 测试）没有 `caches` 全局 → 全部降级为空操作。
 *  3. 只做「加速层」：读失败/写失败一律静默，正确性由 KV 与数据库保证。
 */

/** 合成源：只用于拼缓存键，不会发起任何真实请求。 */
const CACHE_ORIGIN = 'https://colo-cache.internal';

interface CacheLike {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

function defaultCache(): CacheLike | null {
  const c = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches;
  return c?.default ?? null;
}

function keyRequest(key: string): Request | null {
  try {
    // 键里可能有 `/`，逐段 encode 保证是合法 URL 且不产生歧义
    const safe = key.split('/').map(encodeURIComponent).join('/');
    return new Request(`${CACHE_ORIGIN}/__l1/${safe}`, { method: 'GET' });
  } catch {
    return null;
  }
}

/** 读 JSON。未命中 / 过期 / 解析失败 / 运行时不可用都返回 null。 */
export async function coloCacheGetJson<T>(key: string, maxAgeS: number): Promise<T | null> {
  const cache = defaultCache();
  if (!cache) return null;
  const req = keyRequest(key);
  if (!req) return null;
  try {
    const hit = await cache.match(req);
    if (!hit) return null;
    // 逻辑年龄：写入时记的时间戳。物理 TTL 由 Cache-Control 管，这里按
    // 调用方给的 maxAgeS 判定新鲜度 —— 同一个键在不同路径可以有不同容忍度。
    const at = Number(hit.headers.get('X-Cola-At') ?? '0');
    if (!at || Date.now() - at > maxAgeS * 1000) return null;
    const text = await hit.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 写 JSON。`ttlS` 是 CF 侧的物理 TTL。 */
export async function coloCachePutJson(key: string, value: unknown, ttlS: number): Promise<boolean> {
  const cache = defaultCache();
  if (!cache) return false;
  const req = keyRequest(key);
  if (!req) return false;
  try {
    const body = JSON.stringify(value);
    const res = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttlS}`,
        'X-Cola-At': String(Date.now()),
        // Vary 必须为空：CF 的 cache.match 会按已存响应的 Vary 逐个头比对，
        // 而查找用的是裸 Request —— 带 Vary 就永远命中不了（静默失效）。
        Vary: '',
      },
    });
    await cache.put(req, res);
    return true;
  } catch {
    return false;
  }
}

/** 删键。只影响**当前 colo**，其它节点靠 TTL 自然过期。 */
export async function coloCacheDelete(key: string): Promise<void> {
  const cache = defaultCache();
  if (!cache) return;
  const req = keyRequest(key);
  if (!req) return;
  try {
    await cache.delete(req);
  } catch {
    /* 尽力而为 */
  }
}
