/**
 * Cloudflare 边缘缓存（Cache API）封装 —— 下载内容 / 缩略图的 CDN 化。
 *
 * 语义要点（改这里的代码前先读完）：
 *
 *  1. **鉴权先行**：缓存本身不做任何鉴权，命中前路由层必须已完成签名/登录
 *     校验。缓存键不含签名 query，所以签名轮换/过期不影响命中。
 *  2. **只缓存完整 200 响应**：Range（206）请求直接回源，保证视频拖动、
 *     断点续传语义与逐字节正确性不变。
 *  3. **put 走 waitUntil**：不阻塞响应；缓存写入失败静默忽略（缓存是
 *     尽力而为的加速层，不是正确性依赖）。
 *  4. **删除残留**：文件删除后，边缘缓存里的内容在 TTL 内仍可通过已签发
 *     的 URL 命中 —— 与上游「已签发下载地址在有效期内可用」的语义一致，
 *     TTL 取 6 小时折中（不过 cache.put 有 200 状态码硬性要求）。
 *  5. 非 Workers 运行时（本地 Node 测试）`caches` 全局不存在 → 全部跳过，
 *     行为退化为不缓存，不影响功能。
 */

/** 下载内容边缘缓存 TTL（秒）。缩略图另行传参。 */
export const EDGE_CACHE_TTL_S = 6 * 3600;

interface CacheLike {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

function defaultCache(): CacheLike | null {
  const c = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches;
  return c?.default ?? null;
}

/**
 * 规范化缓存键 Request。Cache API 的 match/put 以 Request 为键，
 * 用固定的规范化 URL（与浏览器实际请求的 query 无关）保证键稳定。
 */
function cacheRequest(origin: string, keyPath: string): Request | null {
  try {
    return new Request(`${origin.replace(/\/+$/, '')}${keyPath}`, { method: 'GET' });
  } catch {
    return null;
  }
}

/** 查边缘缓存。命中返回响应（含全部响应头），未命中 / 不可用返回 null。 */
export async function edgeCacheMatch(origin: string, keyPath: string): Promise<Response | null> {
  const cache = defaultCache();
  if (!cache) return null;
  const req = cacheRequest(origin, keyPath);
  if (!req) return null;
  try {
    const hit = await cache.match(req);
    return hit ?? null;
  } catch {
    return null;
  }
}

/**
 * 把响应写入边缘缓存（尽力而为）。
 *
 * @param res 必须是 200 完整响应；本函数会 clone 其 body，原响应体不受影响
 * @param ttlS 缓存存活时间（秒）
 */
export function edgeCachePut(
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  origin: string,
  keyPath: string,
  res: Response,
  ttlS: number = EDGE_CACHE_TTL_S,
): void {
  const cache = defaultCache();
  if (!cache || !waitUntil || res.status !== 200) return;
  const req = cacheRequest(origin, keyPath);
  if (!req) return;
  try {
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', `public, max-age=${ttlS}`);
    headers.delete('Content-Disposition'); // 下载语义由命中方按 query 自行附加
    const body = res.clone().body;
    if (!body) return;
    const copy = new Response(body, { status: 200, headers });
    waitUntil(
      cache.put(req, copy).catch(() => {
        /* 缓存尽力而为 */
      }),
    );
  } catch {
    /* 同上 */
  }
}

/** 从缓存的响应还原 ObjectContent 形状（只缓存过 200，无 contentRange）。 */
export function objectFromCacheResponse(
  hit: Response,
  fallbackSize: number,
): { body: ReadableStream; size: number; contentType?: string; contentRange?: string } {
  const len = Number(hit.headers.get('Content-Length') ?? '');
  return {
    body: hit.body as ReadableStream,
    size: Number.isFinite(len) && len > 0 ? len : fallbackSize,
    contentType: hit.headers.get('Content-Type') ?? undefined,
  };
}
