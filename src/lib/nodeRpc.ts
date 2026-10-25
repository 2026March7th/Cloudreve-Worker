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

/** 控制类 RPC 的超时（建会话、查任务、删文件）。 */
const CONTROL_TIMEOUT_MS = 30_000;

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

/**
 * 把头名规范化成 Go `textproto.CanonicalMIMEHeaderKey` 的形态
 * （`X-Cr-Node-Id` 这种：每段首字母大写、其余小写）。
 *
 * 必须做：JS 的 `Headers`（含 Workers 的 `request.headers`）一律返回**小写**键，
 * 而 Go 收请求时会规范化。两边如果不统一，签名里的头串永远对不上 —— 而且
 * 表现只是「invalid sign」，看不出是大小写问题。
 */
function canonicalHeaderKey(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join('-');
}

/** 参与签名的头：所有 `X-Cr-*`（`X-Cr-Filename` 除外），按名字排序后用 `&` 连接。 */
function signedHeaderString(headers: Record<string, string>): string {
  const canon = new Map<string, string>();
  for (const [raw, value] of Object.entries(headers)) {
    const key = canonicalHeaderKey(raw);
    if (!key.startsWith('X-Cr-') || key === 'X-Cr-Filename') continue;
    canon.set(key, value);
  }
  return [...canon.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
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

// ---------------------------------------------------------------------------
// 验签（主站接收从机调用时用）
// ---------------------------------------------------------------------------

export type SignatureCheck =
  | { ok: true; expires: number }
  | { ok: false; reason: string };

/**
 * 校验从机发来的请求签名。与 `signNodeRequest` / `signNodeUrl` 完全对称，
 * 对应上游 `auth.CheckRequest` + `auth.CheckURI` + `middleware.SignRequired`。
 *
 * 调用方负责：按 `X-Cr-Node-Id` 找到节点、把 slave_key 传进来。
 *
 * 签名方式同样**看方法**（与从机的 SignRequired 一致）：
 *   PUT / POST / PATCH → `Authorization: Bearer Cr …`，正文参与签名
 *   GET / HEAD / DELETE → URL 上的 `?sign=`，只签解码后的路径
 * 分片上传（`POST /slave/upload/…`）的正文不参与签名 —— 与上游
 * `isUploadDataRequest` 同一个判据，否则几十 MB 的分片要先读进内存。
 */
export async function verifyNodeSignature(args: {
  slaveKey: string;
  method: string;
  /** 请求的完整 URL（用于取解码后的路径与 query 里的 sign） */
  url: string;
  headers: Headers;
  /** 原始正文；分片上传与 GET/DELETE 传空 */
  body?: string | Uint8Array | null;
}): Promise<SignatureCheck> {
  const method = args.method.toUpperCase();
  const url = new URL(args.url);
  const headers: Record<string, string> = {};
  args.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let provided: string;
  let expected: string;

  if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
    const auth = args.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer Cr ')) {
      return { ok: false, reason: 'authorization header is missing' };
    }
    provided = auth.slice('Bearer Cr '.length);
    const isUploadData = url.pathname.includes(`${SLAVE_PREFIX}/upload/`) && method !== 'PUT';
    const bodyText =
      isUploadData || args.body == null
        ? ''
        : typeof args.body === 'string'
          ? args.body
          : new TextDecoder().decode(args.body);
    expected = goJsonStringify({
      Path: decodePathForSign(url.pathname),
      Header: signedHeaderString(headers),
      Body: bodyText,
    });
  } else {
    provided = url.searchParams.get('sign') ?? '';
    if (!provided) return { ok: false, reason: 'sign is missing in query' };
    expected = decodePathForSign(url.pathname);
  }

  const idx = provided.lastIndexOf(':');
  if (idx < 0) return { ok: false, reason: 'invalid sign format' };
  const expires = Number(provided.slice(idx + 1));
  if (!Number.isFinite(expires) || expires === 0) {
    return { ok: false, reason: 'expire timestamp is missing' };
  }
  if (expires < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'signature expired' };

  const want = await hmacSign(args.slaveKey, expected, expires);
  // 定长比较，避免时序侧信道
  let diff = want.length === provided.length ? 0 : 1;
  for (let i = 0; i < Math.min(want.length, provided.length); i += 1) {
    diff |= want.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (diff !== 0) return { ok: false, reason: 'invalid sign' };
  return { ok: true, expires };
}

// ---------------------------------------------------------------------------
// 任务（主站 → 从节点）
// ---------------------------------------------------------------------------

/** 从节点上的任务摘要（对应上游 `cluster.SlaveTaskSummary`）。 */
export interface NodeTaskSummary {
  status: string;
  error?: string;
  /** 从节点自己留的进度（不透明，原样带回前端） */
  private_state?: string;
  progress?: unknown;
}

/** 在从节点上创建任务，返回从节点侧的任务 id。 */
export async function createNodeTask(
  node: NodeRow,
  meta: NodeSiteMeta,
  args: { type: string; state: string },
): Promise<number> {
  const body = JSON.stringify(args);
  const data = await nodeRpc<{ id?: number }>(node, meta, {
    method: 'PUT',
    path: 'task',
    body,
    bodyText: body,
    timeoutMs: CONTROL_TIMEOUT_MS,
    extraHeaders: { 'Content-Type': 'application/json' },
  });
  if (!data || typeof data.id !== 'number') {
    throw new NodeRpcError('node did not return a task id', 0, 0);
  }
  return data.id;
}

/** 查从节点任务状态。 */
export async function getNodeTask(
  node: NodeRow,
  meta: NodeSiteMeta,
  taskId: number,
): Promise<NodeTaskSummary> {
  return nodeRpc<NodeTaskSummary>(node, meta, {
    method: 'GET',
    path: `task/${taskId}`,
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
}

/** 让从节点清理任务临时目录。 */
export async function cleanupNodeFolders(
  node: NodeRow,
  meta: NodeSiteMeta,
  folders: string[],
): Promise<void> {
  const body = JSON.stringify({ path: folders });
  await nodeRpc(node, meta, {
    method: 'POST',
    path: 'task/cleanup',
    body,
    bodyText: body,
    timeoutMs: CONTROL_TIMEOUT_MS,
    extraHeaders: { 'Content-Type': 'application/json' },
  });
}
