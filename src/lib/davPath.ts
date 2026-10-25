/**
 * WebDAV 的路径与 href 换算。纯函数（只依赖 `services/uri`，无 IO），
 * 刻意从 `routes/dav.ts` 拆出来是为了能单测 —— 这块是 WebDAV 能不能连上的
 * 关键，也是越权访问的边界（`..` 穿越）。
 *
 * 对应上游 `pkg/webdav`（`golang.org/x/net/webdav`）+ Cloudreve 的
 * `WebDAVRequest` 包装：客户端把 `<D:href>` 与请求 URL 逐字节比对，路径差一个
 * 字符就是「找不到网络路径 / 连接失败」，所以这两件事必须可测。
 */
import { URI } from '../services/uri';

/** WebDAV 挂载前缀（`app.route('/dav', davRoutes)`）。 */
export const DAV_PREFIX = '/dav';

/**
 * `decodeURIComponent` 遇到非法百分号序列（`/dav/%zz`、`/dav/a%`）会抛 URIError。
 * 扫描器随手打一个畸形路径不该变成 500 —— 统一按「无效路径」处理。
 */
export function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * 请求 URL 的 pathname + WebDAV 账号根 → 目标 URI。
 *
 * 返回 null 表示「不属于这个账号的合法路径」，调用方一律回 404/403：
 *   - 不以 `/dav` 开头；
 *   - 百分号编码畸形；
 *   - 账号 URI 不是 `my://`（WebDAV 只挂本人空间）；
 *   - 解析 `..` 之后跑出了账号根目录（越权，CVE-2026-54563 同类）。
 */
export function resolveDavTarget(accountUri: string, pathname: string): URI | null {
  const base = URI.tryParse(accountUri);
  if (!base || base.fsType !== 'my') return null;
  if (!pathname.startsWith(DAV_PREFIX)) return null;

  const rel = safeDecode(pathname.slice(DAV_PREFIX.length));
  if (rel === null) return null;

  // `withPath` 内部会做规整（折叠重复斜杠、解析 . 与 ..），所以这里先粗拼，
  // 穿越判断放在规整之后 —— 否则 `/dav/../etc` 这种会被当成合法相对路径。
  const joined = (base.path.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '')).replace(
    /\/{2,}/g,
    '/',
  );
  const target = base.withPath(joined === '' ? '/' : joined);

  // 账号根即 `my://` 时已在最顶层，无需限制。
  if (base.path !== '/' && target.path !== base.path && !target.path.startsWith(base.path + '/')) {
    return null;
  }
  return target;
}

/**
 * 路径逐段百分号编码。
 *
 * 直接把中文/空格写进 XML 会让 Windows MrxDAV 与请求 URL 对不上号；
 * `encodeURIComponent` 保留 `-_.!~*'()` 原样，与 Go 的 `url.URL.EscapedPath()`
 * 在常见文件名上一致。
 */
export function encodeDavPath(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg === '' ? '' : encodeURIComponent(seg)))
    .join('/');
}

/**
 * `<D:href>`：站内绝对路径（`/dav/...`），目录以 `/` 结尾。
 *
 * 两条硬要求都来自真客户端：Windows WebClient 拿 href 与请求 URL 逐字节比对；
 * 集合资源不带尾斜杠时 Windows 报「找不到网络路径」，Alist / MT管理器 直接
 * 判定连接失败。根目录回 `/dav/` 而不是 `/dav`。
 */
export function davHref(path: string, isDir: boolean): string {
  const encoded = encodeDavPath(path);
  const withSlash = isDir && !encoded.endsWith('/') ? `${encoded}/` : encoded;
  const full = `${DAV_PREFIX}${withSlash}`;
  return full === DAV_PREFIX ? `${DAV_PREFIX}/` : full;
}
