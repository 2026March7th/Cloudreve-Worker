/**
 * 又拍云（Upyun）驱动。
 *
 * 又拍云 **不提供 S3 兼容 API**，走自有 REST 协议（上游 upyun.go 用
 * upyun/go-sdk 对接，协议要点据又拍云 REST API 官方文档）：
 *   - 端点 `https://v0.api.upyun.com`（自动线路；settings.server 可覆盖，
 *     如电信 v1 / 联通 v2 / 移动 v3），路径风格恒为 `/<服务名>/<路径>`
 *     （无 virtual-host 概念）；
 *   - 签名 `Authorization: UPYUN <操作员>:<签名>`，签名 =
 *     base64(HMAC-SHA1(密钥, `METHOD&URI&DATE`))，其中**密钥是操作员
 *     密码的 MD5 十六进制串**，DATE 为 RFC1123 GMT（Date 头，必须参与
 *     签名与请求一致）。Workers 的 Web Crypto 不支持 MD5，这里自带一份
 *     纯 TS MD5（仅用于密码派生，输入是短密码串，性能无虞）；
 *   - 上传 PUT 到不存在的目录会**自动创建父目录**，无需 mkdir；
 *   - 下载 GET 支持 RFC7233 Range；无原生分片上传、无服务端签名直链。
 *
 * 因此本驱动走**全中转**模式（与 R2Driver 的 relay 模式同一形态）：
 *   - 上传：浏览器 → Worker → 又拍云。Upyun 无 multipart，token() 恒
 *     返回单分片（chunk_size: 0，整个文件一个请求经 Worker PUT）——
 *     单请求体上限取决于 Workers 套餐（免费 100MB），管理员应把策略的
 *     单文件上限配在套餐之内；
 *   - 下载：`proxyRequired = true`，直链由 Worker 签名下发并流式转发
 *     （Range 透传），不经任何预签名。
 */
import type { StoragePolicyRow } from '../db/types';
import {
  resolveChunkSize,
  type DriverCapabilities,
  type GetSourceArgs,
  type ObjectContent,
  type StorageDriver,
  type UploadCredential,
  type UploadRequest,
  type UploadSession,
  type UploadedPart,
} from './types';

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// MD5（又拍云签名要求先对操作员密码做一次 MD5；Web Crypto 无 MD5，自带实现）
// ---------------------------------------------------------------------------

/** RFC 1321 MD5，输入 UTF-8 字符串，输出小写 hex。 */
function md5(input: string): string {
  const bytes = encoder.encode(input);
  const bitLen = bytes.length * 8;
  // padding: 0x80 + 0x00… + 64-bit little-endian length
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const K = new Uint32Array(64);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(chunk + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i]! + M[g]!) >>> 0;
      B = (B + ((sum << S[i]!) | (sum >>> (32 - S[i]!)))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  // base64
  return btoa(bin);
}

function rfc1123(date = new Date()): string {
  return date.toUTCString();
}

export class UpyunDriver implements StorageDriver {
  readonly type = 'upyun';
  // 无分片能力：chunkSize 只用于把前端单分片上传的组织方式对齐（恒单分片）。
  readonly chunkSize: number;
  readonly settings;

  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly operator: string;
  private readonly signKey: string; // = md5(操作员密码)

  constructor(readonly policy: StoragePolicyRow) {
    this.settings = policy.settings ?? {};
    this.chunkSize = resolveChunkSize(this.settings, 0) || 0;
    const endpointRaw = (this.settings.server_side_endpoint || policy.server || 'v0.api.upyun.com').trim();
    this.endpoint = new URL(endpointRaw.includes('://') ? endpointRaw : `https://${endpointRaw}`);
    this.bucket = (policy.bucket_name ?? '').trim();
    if (!this.bucket) throw new Error('Upyun policy is missing the bucket (service) name');
    this.operator = (policy.access_key ?? '').trim();
    if (!this.operator) throw new Error('Upyun policy is missing the operator name');
    const password = (policy.secret_key ?? '').trim();
    if (!password) throw new Error('Upyun policy is missing the operator password');
    this.signKey = md5(password);
  }

  capabilities(): DriverCapabilities {
    return {
      // 无签名直链能力，下载一律经 Worker 中转
      proxyRequired: true,
      uploadSentinelRequired: true,
      maxSourceExpire: 0,
      thumbSupportedExts: this.settings.thumb_exts ?? [],
      thumbSupportAllExts: false,
      thumbMaxSize: 0,
    };
  }

  // -------------------------------------------------------------------------
  // 签名与请求
  // -------------------------------------------------------------------------

  private objectUrl(key: string): URL {
    const u = new URL(this.endpoint.toString());
    const encoded = key
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');
    u.pathname = `/${this.bucket}${encoded.startsWith('/') ? encoded : `/${encoded}`}`;
    return u;
  }

  private async authHeaders(method: string, url: URL, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const date = rfc1123();
    // 签名串：METHOD&URI&DATE；URI 为 /bucket/path（含编码）
    const signString = `${method}&${url.pathname}&${date}`;
    const sig = await hmacSha1(this.signKey, signString);
    return {
      Date: date,
      Authorization: `UPYUN ${this.operator}:${sig}`,
      ...extra,
    };
  }

  private async fetchUpyun(
    method: string,
    url: URL,
    opts: { body?: Uint8Array; headers?: Record<string, string>; raw?: boolean } = {},
  ): Promise<Response> {
    const res = await fetch(url.toString(), {
      method,
      headers: { ...(await this.authHeaders(method, url, opts.headers)), ...(opts.headers ?? {}) },
      // Workers 类型里 BodyInit 未收窄 ArrayBufferView，这里显式断言
      body: opts.body as unknown as BodyInit,
    });
    if (!res.ok && !opts.raw) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Upyun request failed (${res.status} ${method} ${url.pathname}): ${text.slice(0, 300)}`,
      );
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // 上传（全中转；无 multipart，token() 恒单分片）
  // -------------------------------------------------------------------------

  async token(session: UploadSession, _file: UploadRequest): Promise<UploadCredential> {
    // chunk_size: 0 = 客户端把整个文件作为一个分片（index=0）经 Worker 中转 PUT
    return {
      session_id: session.id,
      chunk_size: 0,
      expires: Math.floor(session.expireAt / 1000),
    };
  }

  async writeChunk(
    session: UploadSession,
    _index: number,
    body: ReadableStream,
    _length: number,
  ): Promise<UploadedPart | null> {
    // 单次写入路径：整个文件一次 PUT（又拍云自动创建父目录）
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    await this.fetchUpyun('PUT', this.objectUrl(session.savePath), {
      body: buf,
      headers: session.mimeType ? { 'content-type': session.mimeType } : {},
    });
    return null;
  }

  async completeUpload(_session: UploadSession): Promise<void> {
    // 单请求写入已在 writeChunk 完成
  }

  async cancelToken(session: UploadSession): Promise<void> {
    if (session.newFileCreated === false) return;
    try {
      await this.fetchUpyun('DELETE', this.objectUrl(session.savePath), { raw: true });
    } catch {
      // ignore
    }
  }

  async put(file: UploadRequest, body: ReadableStream, _contentLength: number): Promise<void> {
    if (!file.overwrite) {
      const existing = await this.meta(file.savePath);
      if (existing) throw new Error('Object existed');
    }
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    await this.fetchUpyun('PUT', this.objectUrl(file.savePath), {
      body: buf,
      headers: file.mimeType ? { 'content-type': file.mimeType } : {},
    });
  }

  // -------------------------------------------------------------------------
  // 读取 / 元信息 / 删除
  // -------------------------------------------------------------------------

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const headers: Record<string, string> = {};
    if (range) headers.range = range;
    const res = await this.fetchUpyun('GET', this.objectUrl(source), { headers, raw: true });
    if (res.status === 404) return null;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Upyun GET failed (${res.status}) for ${source}`);
    }
    if (res.status === 416) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    let size = Number(res.headers.get('content-length') ?? 0);
    let contentRange: string | null = res.headers.get('content-range');
    const cr = contentRange;
    if (cr) {
      const total = Number(cr.split('/')[1]);
      if (Number.isFinite(total)) size = total;
    }
    return {
      body: res.body!,
      size,
      contentType: res.headers.get('content-type') ?? undefined,
      contentRange,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const res = await this.fetchUpyun('HEAD', this.objectUrl(source), { raw: true });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Upyun HEAD failed (${res.status}) for ${source}`);
    await res.body?.cancel().catch(() => {});
    return { size: Number(res.headers.get('content-length') ?? 0) };
  }

  async delete(sources: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const s of sources) {
      try {
        // 目录形态的路径补尾斜杠（又拍云目录以 / 结尾）
        const target = s.endsWith('/') ? s : s;
        await this.fetchUpyun('DELETE', this.objectUrl(target), { raw: true });
      } catch {
        failed.push(s);
      }
    }
    return failed;
  }

  async list(
    _prefix: string,
    _options: { continuation?: string; afterKey?: string; limit?: number },
  ): Promise<{ keys: { key: string; size: number; lastModified: Date }[]; continuation: string | null }> {
    throw new Error('Upyun driver does not support import listing');
  }

  /** proxyRequired=true 时下载走 Worker 中转，source 不会被调用。 */
  async source(_source: string, _args: GetSourceArgs): Promise<string> {
    throw new Error('Upyun has no presigned direct link, use proxy instead');
  }

  async setCors(): Promise<void> {
    // 又拍云无跨域配置需求（上传/下载全部经 Worker 中转）
  }

  async thumb(): Promise<string | null> {
    return null;
  }
}
