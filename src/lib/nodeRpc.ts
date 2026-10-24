/**
 * 从节点 RPC 客户端（主站 Worker → 从机）。
 *
 * 协议与官方 Cloudreve 完全一致（`pkg/auth` + `pkg/cluster/routes`），
 * 所以一台以从机模式运行的官方 Cloudreve 可以当存储节点用，不用改一行代码。
 * 也可以跑仓库里的 `agent/cloudreve-node-agent.mjs`（同一套协议的最小实现）。
 *
 * 签名规则（务必逐字对齐 `pkg/auth/auth.go` + `pkg/auth/hmac.go`）：
 *
 *   待签串 = JSON{"Path": <解码后的 URL 路径>, "Header": <X-Cr-* 头按名排序后
 *           用 & 连接>, "Body": <正文，分片上传时不签>}
 *   签名   = base64url(HMAC-SHA256(slave_key, 待签串 + ":" + expires)) + ":" + expires
 *   请求头 = Authorization: Bearer Cr <签名>
 *
 * 两个坑：
 *   1. Go 的 `json.Marshal` 默认开启 HTML 转义，`<` `>` `&` 会变成 `\u003c`
 *      `\u003e` `\u0026`。头串里必然有 `&`，所以必须自己转 —— 否则签名
 *      永远对不上，且从机只会回一个笼统的「invalid sign」。
 *   2. 路径要**解码后**参与签名（Go 的 `url.URL.Path` 是解码结果），而 JS 的
 *      `URL.pathname` 是编码的。
 */
import type { NodeRow } from '../db/types';

/** 从机 RPC 的路径前缀（`constants.APIPrefixSlave`）。 */
export const SLAVE_PREFIX = '/api/v4/slave';

/** 主站自身信息，随每个请求带给从机（从机用它回调主站 / 拼链接）。 */
export interface NodeSiteMeta {
  siteId: string;
  siteUrl: string;
  version: string;
}

export interface NodeRpcOptions {
  method: string;
  /** 相对 `SLAVE_PREFIX` 的路径（可带 query），如 `file/list?path=x` */
  path: string;
  /** 实际发送的正文 */
  body?: BodyInit | null;
  /**
   * 参与签名的正文字符串。不传时按 `body` 是字符串处理；
   * 分片上传（`POST slave/upload/:id`）必须传 `null` 并把 `signBody` 置 false。
   */
  bodyText?: string | null;
  /** 是否把正文纳入签名，默认 true */
  signBody?: boolean;
  extraHeaders?: Record<string, string>;
  /** 毫秒；0 表示不设超时（大分片上传） */
  timeoutMs?: number;
  /** 签名有效期（秒） */
  ttl?: number;
}

/** 从节点 RPC 返回的业务错误。 */
export class NodeRpcError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number,
  ) {
    super(message);
    this.name = 'NodeRpcError';
  }
}

// ---------------------------------------------------------------------------
// 签名基础件
// ---------------------------------------------------------------------------

/**
 * 与 Go `json.Marshal` 等价的序列化（含默认开启的 HTML 转义）。
 * 只用于待签串，不用于请求体。
 */
export function goJsonStringify(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

/** 把 URL 的编码路径还原成 Go 里 `url.URL.Path` 的形态。 */
export function decodePathForSign(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  // Go 用 base64.URLEncoding（**保留**结尾的 =），这里不做去填充
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_');
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    // isolate 内复用；密钥数量等于节点数量，不会无限增长
    if (hmacKeys.size > 64) hmacKeys.clear();
    hmacKeys.set(secret, key);
  }
  return key;
}

/** `base64url(HMAC(secret, content + ":" + expires)) + ":" + expires` */
export async function hmacSign(secret: string, content: string, expires: number): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${content}:${expires}`),
  );
  return `${base64UrlEncode(new Uint8Array(mac))}:${expires}`;
}

/** 从节点地址：不带结尾斜杠。 */
export function nodeBaseUrl(node: NodeRow): URL {
  const raw = (node.server ?? '').trim();
  if (!raw) throw new NodeRpcError(`Node ${node.id} has no server address`, 0, 0);
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withProto.replace(/\/+$/, ''));
}

/** 从节点的 RPC 密钥；缺失时明确报错，别拿空串去签名。 */
export function nodeSecret(node: NodeRow): string {
  const key = (node.slave_key ?? '').trim();
  if (!key) throw new NodeRpcError(`Node ${node.id} has no slave key`, 0, 0);
  return key;
}

/** 参与签名的头：所有 `X-Cr-*`（`X-Cr-Filename` 除外），按名字排序后用 `&` 连接。 */
function signedHeaderString(headers: Record<string, string>): string {
  return Object.keys(headers)
    .filter((k) => k.startsWith('X-Cr-') && k !== 'X-Cr-Filename')
    .sort()
    .map((k) => `${k}=${headers[k]}`)
    .join('&');
}

/** 请求头里固定带的主站/节点信息。 */
function baseHeaders(node: NodeRow, meta: NodeSiteMeta): Record<string, string> {
  return {
    'X-Cr-Site-Id': meta.siteId,
    'X-Cr-Site-Url': meta.siteUrl.replace(/\/+$/, ''),
    'X-Cr-Version': meta.version,
    'X-Cr-Node-Id': String(node.id),
    'X-Cr-Correlation-Id': crypto.randomUUID(),
    // 与上游 request.Client 一致的 UA（不参与签名，纯标识）
    'User-Agent': `Cloudreve/${meta.version}`,
  };
}

/**
 * 给一次 RPC 请求签名，返回完整请求头（含 `Authorization`）。
 */
export async function signNodeRequest(
  node: NodeRow,
  meta: NodeSiteMeta,
  args: {
    /** 完整路径（含 `SLAVE_PREFIX`），**已解码** */
    path: string;
    bodyText?: string | null;
    signBody?: boolean;
    extraHeaders?: Record<string, string>;
    ttl?: number;
  },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...baseHeaders(node, meta), ...args.extraHeaders };
  const body = args.signBody === false ? '' : (args.bodyText ?? '');
  const expires = Math.floor(Date.now() / 1000) + (args.ttl ?? 60);
  const content = goJsonStringify({
    Path: args.path,
    Header: signedHeaderString(headers),
    Body: body,
  });
  const sign = await hmacSign(nodeSecret(node), content, expires);
  return { ...headers, Authorization: `Bearer Cr ${sign}` };
}

/**
 * 给下载/缩略图这类「URL 直连」的地址签名（`pkg/auth.SignURI`）。
 * 待签内容是**解码后的路径**，query 不参与。
 */
export async function signNodeUrl(
  node: NodeRow,
  url: string,
  ttl = 3600,
): Promise<string> {
  const u = new URL(url);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const sign = await hmacSign(nodeSecret(node), decodePathForSign(u.pathname), expires);
  u.searchParams.set('sign', sign);
  return u.toString();
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** 拼一个从机 RPC 地址。`path` 里的 `?` 之后是 query。 */
export function nodeUrl(node: NodeRow, path: string): URL {
  const base = nodeBaseUrl(node);
  const target = new URL(`${SLAVE_PREFIX}/${path.replace(/^\/+/, '')}`, base);
  return target;
}

/**
 * 发起一次签名 RPC。返回原始 `Response`（调用方自己决定怎么读）。
 * 非 2xx 抛 `NodeRpcError`；业务 `code !== 0` 由调用方处理（部分接口要靠它区分）。
 *
 * 签名方式跟上游 `request.options.sign` 一致 —— **看方法**：
 *   PUT / POST / PATCH → 签请求（`Authorization` 头，正文参与）
 *   GET / HEAD / DELETE → 签 URL（`?sign=`，只签解码后的路径）
 * 从机的 `SignRequired` 正是按同样规则校验的，搞反了会被判 `invalid sign`。
 */
export async function nodeFetch(
  node: NodeRow,
  meta: NodeSiteMeta,
  opts: NodeRpcOptions,
): Promise<Response> {
  const method = opts.method.toUpperCase();
  let target = nodeUrl(node, opts.path);
  const init: RequestInit = { method };
  const base = baseHeaders(node, meta);

  if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
    const bodyText =
      opts.bodyText !== undefined
        ? opts.bodyText
        : typeof opts.body === 'string'
          ? opts.body
          : null;
    init.headers = await signNodeRequest(node, meta, {
      path: decodePathForSign(target.pathname),
      bodyText,
      signBody: opts.signBody,
      extraHeaders: opts.extraHeaders,
      ttl: opts.ttl,
    });
  } else {
    target = new URL(await signNodeUrl(node, target.toString(), opts.ttl ?? 60));
    init.headers = { ...base, ...opts.extraHeaders };
  }

  if (opts.body !== undefined && opts.body !== null) {
    init.body = opts.body;
    // Node 的 fetch 要求流式正文显式声明 duplex；Workers 忽略这个字段。
    // 不加的话本地端到端测试会直接报 "duplex option is required"。
    if (typeof opts.body === 'object' && 'getReader' in (opts.body as object)) {
      (init as unknown as { duplex: string }).duplex = 'half';
    }
  }
  if (opts.timeoutMs && opts.timeoutMs > 0) init.signal = AbortSignal.timeout(opts.timeoutMs);

  let res: Response;
  try {
    res = await fetch(target.toString(), init);
  } catch (err) {
    throw new NodeRpcError(
      `Failed to reach node "${node.name}": ${(err as Error).message}`,
      0,
      0,
    );
  }
  if (!res.ok) {
    // 从机的错误响应体是 JSON 信封，尽量把 msg 带出来
    let msg = `node returned HTTP ${res.status}`;
    try {
      const json = (await res.clone().json()) as { msg?: string };
      if (json?.msg) msg = json.msg;
    } catch {
      /* 非 JSON（例如网关页），保持状态码信息 */
    }
    throw new NodeRpcError(msg, res.status, 0);
  }
  return res;
}

/** 发起 RPC 并解析 Cloudreve 的 JSON 信封，返回 `data`。 */
export async function nodeRpc<T = unknown>(
  node: NodeRow,
  meta: NodeSiteMeta,
  opts: NodeRpcOptions,
): Promise<T> {
  const res = await nodeFetch(node, meta, opts);
  const json = (await res.json().catch(() => null)) as
    | { code?: number; msg?: string; data?: T }
    | null;
  if (!json) throw new NodeRpcError('node returned a non-JSON response', res.status, 0);
  if ((json.code ?? 0) !== 0) {
    throw new NodeRpcError(json.msg ?? `node returns code ${json.code}`, res.status, json.code ?? 0);
  }
  return json.data as T;
}
