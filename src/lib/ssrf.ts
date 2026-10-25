/**
 * 远程 URL 的安全校验（SSRF 防护）。
 *
 * 对应上游 `pkg/request/ssrf.go` 的 `ValidateExternalURL` / `checkIP`，并且
 * **包含 CVE-2026-79913 的修复**：上游 4.18.0 之前只做 `IsPrivate` /
 * `IsLoopback` 这类判断，而 IPv4-in-IPv6 的几种过渡封装（NAT64 `64:ff9b::/96`、
 * IPv4-compatible `::a.b.c.d`、6to4 `2002::/16`、Teredo `2001::/32`）会被
 * 判成「普通公网 IPv6」，实际路由时又被解包到内网 IPv4 —— 于是 `http://[64:ff9b::7f00:1]/`
 * 能打到 127.0.0.1。
 *
 * 这里的做法和上游修复一致：先 `effectiveIp()` 把封装里的 IPv4 拆出来，再分类。
 *
 * 补充说明（Workers 环境下的实际风险）：Cloudflare 自己在出口侧就禁止访问
 * 回环与私网，所以这条链路本身很难被真打通。但这层校验仍然要做 ——
 * ① 任务可能被分派到**从节点**执行，从节点在真实网络里，没有平台的这层保护；
 * ② 报错信息要能说清「为什么不允许」，而不是让用户看着一个莫名其妙的 fetch 失败。
 */

/** 被 SSRF 校验拒绝时抛这个（调用方转成参数错误文案）。 */
export class UnsafeRemoteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRemoteUrlError';
  }
}

function ipv4ToInt(parts: number[]): number {
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

/** 解析点分十进制 IPv4；非法返回 null。 */
function parseIpv4(raw: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/** 解析 IPv6 为 8 个 hextet；非法返回 null。支持 `::` 压缩与末尾内嵌 IPv4。 */
function parseIpv6(raw: string): number[] | null {
  let s = raw;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;
  // 末尾的 IPv4 形式（::ffff:1.2.3.4）
  const v4Tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4Tail) {
    const quad = parseIpv4(v4Tail[2]!);
    if (!quad) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    s = `${v4Tail[1]}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

function hextetsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * 把「封装了 IPv4 的 IPv6」还原成那个 IPv4 字符串。
 *
 * 与上游 `effectiveIP` 覆盖的四种形式一致：
 *   - IPv4-mapped   `::ffff:a.b.c.d`    （RFC 4291）
 *   - NAT64 WKP     `64:ff9b::a.b.c.d`  （RFC 6052）
 *   - IPv4-compat   `::a.b.c.d`         （RFC 4291，已废弃但仍在用）
 *   - 6to4          `2002:AABB:CCDD::`  （RFC 3056）
 *   - Teredo        `2001:0:...:client` （RFC 4380，末 32 位取反存客户端 IPv4）
 * 不是这几种就原样返回。
 */
export function effectiveIp(raw: string): string {
  const v4 = parseIpv4(raw);
  if (v4) return raw;

  const h = parseIpv6(raw);
  if (!h) return raw;

  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
    number, number, number, number, number, number, number, number,
  ];

  // ::ffff:a.b.c.d
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return hextetsToIpv4(h6, h7);
  }
  // 64:ff9b::/96（NAT64 well-known prefix）
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return hextetsToIpv4(h6, h7);
  }
  // ::a.b.c.d（::/96，排除 :: 与 ::1）
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    if (h6 === 0 && h7 <= 1) return raw; // :: / ::1 本身就是特殊地址，别当 IPv4
    return hextetsToIpv4(h6, h7);
  }
  // 2002:AABB:CCDD::/48（6to4，中间 32 位是目标 IPv4）
  if (h0 === 0x2002) return hextetsToIpv4(h1, h2);
  // 2001:0000::/32（Teredo，末 32 位是客户端 IPv4 的按位取反）
  if (h0 === 0x2001 && h1 === 0x0000) {
    return hextetsToIpv4(h6 ^ 0xffff, h7 ^ 0xffff);
  }
  return raw;
}

/** IPv4 是否属于「不能从公网访问」的段。 */
function isBlockedIpv4(dotted: string): boolean {
  const parts = parseIpv4(dotted);
  if (!parts) return false;
  const n = ipv4ToInt(parts);
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(parseIpv4(base)!);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // 本网络
    inRange('10.0.0.0', 8) || // 私网
    inRange('100.64.0.0', 10) || // CGNAT（RFC 6598）
    inRange('127.0.0.0', 8) || // 回环
    inRange('169.254.0.0', 16) || // 链路本地 / 云元数据 169.254.169.254
    inRange('172.16.0.0', 12) || // 私网
    inRange('192.0.0.0', 24) || // IETF 协议分配
    inRange('192.0.2.0', 24) || // 文档
    inRange('192.88.99.0', 24) || // 6to4 中转（已废弃）
    inRange('192.168.0.0', 16) || // 私网
    inRange('198.18.0.0', 15) || // 基准测试
    inRange('198.51.100.0', 24) || // 文档
    inRange('203.0.113.0', 24) || // 文档
    inRange('224.0.0.0', 4) || // 组播
    inRange('240.0.0.0', 4) // 保留 + 广播
  );
}

/** IPv6 自身的「不能从公网访问」段。 */
function isBlockedIpv6(raw: string): boolean {
  const h = parseIpv6(raw);
  if (!h) return false;
  const [h0] = h as [number, ...number[]];
  const allZeroExceptLast = h.slice(0, 7).every((x) => x === 0);
  if (allZeroExceptLast && (h[7] === 0 || h[7] === 1)) return true; // :: / ::1
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (h0 === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 文档
  return false;
}

/** 主机名层面的拒绝名单（域名不查 DNS —— Workers 里没有解析器，平台出口会拦私网）。 */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
];

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === '') return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => (s.startsWith('.') ? h.endsWith(s) : h === s))) return true;

  // 纯数字 / 0x 十六进制 / 数字加点的「伪 IP」：`2130706433`（127.0.0.1 的十进制）、
  // `0x7f000001`、`0177.0.0.1`（八进制）。标准点分十进制解析不出来就一律拒绝 ——
  // 浏览器和 fetch 会替我们把它解释成 IP，我们不能。
  // 注意别用「只含 0-9a-f」当判据：`abc.de` 这种真实域名会被误杀。
  const looksLikeNumericHost = /^[\d.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h);
  if (looksLikeNumericHost) {
    const asV4 = parseIpv4(h);
    if (!asV4) return true;
    return isBlockedIpv4(h);
  }
  return false;
}

/**
 * 校验用户可以指定给「服务端去抓」的 URL。
 * 合法返回解析后的 `URL`；不合法抛 `UnsafeRemoteUrlError`（文案直接给用户看）。
 */
export function assertSafeRemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeRemoteUrlError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeRemoteUrlError('Only HTTP(S) links are supported');
  }
  if (url.username || url.password) {
    // `https://user:pass@host/` 容易藏东西，且没有正当用途
    throw new UnsafeRemoteUrlError('URL must not contain credentials');
  }

  const host = url.hostname;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  if (parseIpv4(bare)) {
    if (isBlockedIpv4(bare)) {
      throw new UnsafeRemoteUrlError('Refusing to fetch a private, loopback or link-local address');
    }
    return url;
  }
  if (bare.includes(':')) {
    // IPv6（含 IPv4-in-IPv6 封装）：先还原再判，否则就是 CVE-2026-79913
    const inner = effectiveIp(bare);
    if (parseIpv4(inner)) {
      if (isBlockedIpv4(inner)) {
        throw new UnsafeRemoteUrlError('Refusing to fetch a private, loopback or link-local address');
      }
      return url;
    }
    if (isBlockedIpv6(bare)) {
      throw new UnsafeRemoteUrlError('Refusing to fetch a private, loopback or link-local address');
    }
    return url;
  }
  if (isBlockedHostname(bare)) {
    throw new UnsafeRemoteUrlError('Refusing to fetch a local or internal hostname');
  }
  return url;
}

/** 便捷版：不安全时返回 null。 */
export function safeRemoteUrlOrNull(raw: string): URL | null {
  try {
    return assertSafeRemoteUrl(raw);
  } catch {
    return null;
  }
}

/** 允许跟随的最大重定向跳数（与浏览器/curl 的常用上限一致）。 */
const MAX_REDIRECTS = 5;

/**
 * 带 SSRF 校验的 fetch：**逐跳**校验重定向目标。
 *
 * 为什么必须这样：`assertSafeRemoteUrl` 只看用户填的初始 URL。而 `fetch` 默认
 * 自动跟随 302 —— 一个公网地址完全可以 302 到 `http://169.254.169.254/`
 * 或 `http://10.0.0.5/`，校验就形同虚设（云厂商元数据接口正是这么被打的）。
 * 这里改成 `redirect: 'manual'`，每拿到一个 Location 都重新过一遍校验，
 * 不合规直接抛 `UnsafeRemoteUrlError`。
 *
 * 注意：Workers 的 fetch 本身也拒绝连内网地址，那是平台层的兜底；应用层
 * 不能依赖平台行为（换运行时、加代理就没了）。
 */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let current = assertSafeRemoteUrl(input).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get('Location') : null;
    if (!isRedirect || !location) return res;

    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new UnsafeRemoteUrlError('Redirected to an invalid URL');
    }
    current = assertSafeRemoteUrl(next).toString();
    // 丢弃上一跳的响应体，避免连接泄漏
    try {
      await res.body?.cancel();
    } catch {
      /* 忽略 */
    }
  }
  throw new UnsafeRemoteUrlError('Too many redirects');
}
