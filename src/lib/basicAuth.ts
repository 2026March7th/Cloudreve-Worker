/**
 * HTTP Basic 凭据解析。
 *
 * 单独抽出来是因为它有两个很容易踩错的点，而且都在「用户名/密码不是纯 ASCII」
 * 时才暴露 —— 自测用 `davuser:davpass` 永远看不出来：
 *
 * 1. **`atob` 解出来是 latin1 字符串，不是 UTF-8。**
 *    `Authorization: Basic` 的载荷是 base64(UTF-8 字节)。`atob` 把每个字节当成
 *    一个码点返回，于是「测试账号」会变成 `æµ‹è¯•è´¦å·`。拿这个去查库必然
 *    查不到，客户端只看到 401（Cloudreve 上游是 Go，`string(bytes)` 天然是
 *    UTF-8，所以原版没这个问题 —— 属于移植时丢掉的语义）。
 *
 * 2. **scheme 大小写不敏感。** RFC 7617 明确写了 `basic` / `BASIC` 都算，
 *    个别 Android 客户端就发小写。原来用 `startsWith('Basic ')` 直接判死刑。
 */
export function parseBasicAuth(header: string | undefined): { name: string; password: string } | null {
  if (!header) return null;
  // token68 允许的字符集：ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" / "="
  const m = /^\s*basic\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
  if (!m?.[1]) return null;

  let decoded: string;
  try {
    decoded = decodeUtf8(atob(m[1]));
  } catch {
    return null;
  }

  const sep = decoded.indexOf(':');
  if (sep <= 0) return null; // 没冒号，或用户名为空
  return { name: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** latin1 → UTF-8。非法字节按 U+FFFD 处理（与「查不到这个账号」等价，不会误放行）。 */
function decodeUtf8(latin1: string): string {
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i += 1) bytes[i] = latin1.charCodeAt(i) & 0xff;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
