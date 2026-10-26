/**
 * SSE 订阅的客户端标识。
 *
 * 为什么要单独抽：官方桌面端（cloudreve-api）发的是 **`X-Cr-Client-Id`**
 * （`format!("{}Client-Id", CR_HEADER_PREFIX)`，前缀 `X-Cr-`），而本仓库早期只认
 * `X-Client-Id` —— 于是 `/file/events` 直接回 400 信封，桌面端判「SSE 没升级」，
 * 界面上挂一行「实时事件推送丢失」。这种「头名对不上」的错自测很难发现，
 * 所以这里把三种写法都收进来，并留单测（`npm run test:sse`）钉住。
 *
 * 缺省不报错：生成一个临时 ID 继续推流。上游要求必须有 Client ID（同客户端
 * 重连时复用订阅），但对我们「每个连接独立推流」的实现来说，少一路复用
 * 远不如「推送直接不可用」严重。
 */
const HEADER_NAMES = ['x-cr-client-id', 'x-client-id'];

export function sseClientId(
  header: (name: string) => string | undefined | null,
  queryId?: string | null,
): string {
  for (const name of HEADER_NAMES) {
    const v = header(name)?.trim();
    if (v) return v;
  }
  const q = queryId?.trim();
  if (q) return q;
  return crypto.randomUUID();
}
