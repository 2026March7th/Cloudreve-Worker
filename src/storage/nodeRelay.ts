/**
 * 节点中转驱动：策略绑定到从节点，文件落在**节点自己的磁盘**上。
 *
 * 对应上游 `pkg/filemanager/driver/remote`（`remote` 策略类型）以及
 * 「`local` 策略 + 从节点」这两种用法。Worker 没有本地磁盘，所以两者在这里
 * 是同一件事：读写都打成签名 RPC 给节点，由节点的 `/api/v4/slave/*` 落盘。
 *
 * 协议要点（与官方从机逐字节兼容）：
 *   - 建会话：`PUT  /api/v4/slave/upload`，body `{session, overwrite}`，正文参与签名
 *   - 传分片：`POST /api/v4/slave/upload/:id?chunk=N`，正文**不**参与签名
 *             （`pkg/auth.isUploadDataRequest`），但要带 `X-Cr-Overwrite`
 *   - 删文件：`DELETE /api/v4/slave/file`，body `{"files":[...]}`
 *   - 下载：`GET  /api/v4/slave/file/content/:nodeId/:src/:speed/:name?sign=…`
 *           直连节点（Worker 不中转），文件名由节点按 `:name` 下发
 *
 * 发给节点的策略类型固定写成 `remote`：从机收到 `X-Cr-Node-Id` 与
 * `policy.NodeID` 相等时会把 `remote` 转成 `local` 用本地磁盘（上游
 * `manager.CastStoragePolicyOnSlave`）。反过来发 `local` 会被从机转成
 * `remote` 再打回主站，形成回环。
 */
import type { NodeRow, StoragePolicyRow } from '../db/types';
import {
  NodeRpcError,
  nodeFetch,
  nodeRpc,
  nodeUrl,
  signNodeUrl,
  type NodeSiteMeta,
} from '../lib/nodeRpc';
import type {
  DriverCapabilities,
  GetSourceArgs,
  ObjectContent,
  StorageDriver,
  UploadCredential,
  UploadRequest,
  UploadSession,
  UploadedPart,
} from './types';
import { resolveChunkSize } from './types';

const DEFAULT_CHUNK_SIZE = 25 * 1024 * 1024;
/** 分片上传不设超时：大文件在慢线路上可能要几分钟 */
const NO_TIMEOUT = 0;
const CONTROL_TIMEOUT = 30_000;

/** 一次节点操作需要的东西：节点行 + 主站自身信息。 */
export interface NodeContext {
  node: NodeRow;
  meta: NodeSiteMeta;
}

/**
 * 由调用方注入的上下文解析器（查节点 + 读站点设置）。
 *
 * 做成注入而不是在这里直接读库，一是避免驱动反向依赖 db/settings（会绕出
 * 循环），二是让这个驱动能在纯 Node 下跑端到端测试（见
 * `scripts/test-node-relay.mjs`）。
 */
export type NodeContextResolver = (policy: StoragePolicyRow) => Promise<NodeContext>;

/** base64url（**保留** `=` 填充，与 Go 的 `base64.URLEncoding` 一致）。 */
function b64urlPath(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_');
}

export class NodeRelayDriver implements StorageDriver {
  readonly settings;
  readonly type: string;
  readonly chunkSize: number;

  constructor(
    readonly policy: StoragePolicyRow,
    private readonly resolveContext: NodeContextResolver,
  ) {
    this.settings = policy.settings ?? {};
    this.type = policy.type;
    this.chunkSize = resolveChunkSize(this.settings, DEFAULT_CHUNK_SIZE);
  }

  // -------------------------------------------------------------------------
  // 上下文
  // -------------------------------------------------------------------------

  private async resolve(): Promise<NodeContext> {
    return this.resolveContext(this.policy);
  }

  /**
   * 发给从机的策略对象（`ent.StoragePolicy` 的 JSON 形态）。
   *
   * 从机用它决定落盘位置与分片大小：`Settings.ChunkSize` 必须与我们给客户端
   * 的分片大小一致，否则从机会按自己的分片长度校验，返回「内容长度不符」。
   */
  private wirePolicy(nodeId: number, chunkSize: number): Record<string, unknown> {
    return {
      ID: this.policy.id,
      Name: this.policy.name,
      Type: 'remote',
      Server: '',
      BucketName: '',
      IsPrivate: this.policy.is_private === true,
      AccessKey: '',
      SecretKey: '',
      MaxSize: Number(this.policy.max_size ?? 0),
      DirNameRule: this.policy.dir_name_rule ?? '',
      FileNameRule: this.policy.file_name_rule ?? '',
      Settings: { ...this.settings, chunk_size: chunkSize },
      NodeID: nodeId,
    };
  }

  /** 建会话请求体（`fs.UploadSession` 无 json tag，所以字段名是 Go 字段名）。 */
  private sessionPayload(
    session: UploadSession,
    overwrite: boolean,
    chunkSize: number,
    nodeId: number,
  ): string {
    return JSON.stringify({
      session: {
        UID: session.uid,
        Policy: this.wirePolicy(nodeId, chunkSize),
        FileID: 0,
        EntityID: 0,
        Callback: '',
        CallbackSecret: '',
        UploadID: '',
        UploadURL: '',
        Credential: '',
        ChunkSize: chunkSize,
        SentinelTaskID: 0,
        NewFileCreated: session.newFileCreated,
        Importing: false,
        LockToken: '',
        Props: {
          Uri: null,
          Size: session.size,
          UploadSessionID: session.id,
          PreferredStoragePolicy: 0,
          SavePath: session.savePath,
          LastModified: null,
          MimeType: session.mimeType || '',
          Metadata: {},
          PreviousVersion: '',
          EntityType: null,
          ExpireAt: new Date(session.expireAt).toISOString(),
          ClientSideEncrypted: false,
        },
      },
      overwrite,
    });
  }

  private async createRemoteSession(
    r: NodeContext,
    session: UploadSession,
    overwrite: boolean,
    chunkSize: number,
  ): Promise<void> {
    const body = this.sessionPayload(session, overwrite, chunkSize, r.node.id);
    await nodeRpc(r.node, r.meta, {
      method: 'PUT',
      path: 'upload',
      body,
      bodyText: body,
      timeoutMs: CONTROL_TIMEOUT,
      extraHeaders: { 'Content-Type': 'application/json' },
    });
  }

  // -------------------------------------------------------------------------
  // 驱动接口
  // -------------------------------------------------------------------------

  capabilities(): DriverCapabilities {
    return {
      // 下载直连节点（签名 URL），不经过 Worker
      proxyRequired: false,
      uploadSentinelRequired: false,
      maxSourceExpire: 604800,
      // 缩略图交给节点的原生能力会需要扩展名，而这里拿不到 —— 返回 null 让
      // 上层走 Cloudflare Image Resizing（对签名 URL 同样有效）。
      thumbSupportedExts: [],
      thumbSupportAllExts: false,
      thumbMaxSize: 0,
      // content URL 里带 `:name`，download=true 时节点会下发 attachment 头
      directUrlFilename: true,
    };
  }

  async token(session: UploadSession, file: UploadRequest): Promise<UploadCredential> {
    const r = await this.resolve();
    // 不返回 upload_urls ⇒ 客户端把分片打给 Worker，由这里转发给节点。
    // 不给客户端直传地址的原因：节点多半在内网/只有反代可达，而且直传要
    // 把 slave_key 的签名交给浏览器，等于把密钥泄露给任何能打开 F12 的人。
    await this.createRemoteSession(r, session, file.overwrite, this.chunkSize);
    return {
      session_id: session.id,
      chunk_size: this.chunkSize,
      expires: Math.floor(session.expireAt / 1000),
      mime_type: session.mimeType || undefined,
    };
  }

  async put(file: UploadRequest, body: ReadableStream, contentLength: number): Promise<void> {
    const r = await this.resolve();
    // 整文件一次写入：把从机侧分片长度设成文件大小，就只有 1 个分片
    const chunkSize = Math.max(contentLength, 1);
    const session: UploadSession = {
      id: crypto.randomUUID(),
      policy: this.policy,
      uid: 0,
      fileId: 0,
      entityId: 0,
      savePath: file.savePath,
      size: contentLength,
      chunkSize,
      parts: [],
      chunksReceived: [],
      callbackSecret: '',
      expireAt: Date.now() + 3600_000,
      newFileCreated: !file.overwrite,
      mimeType: file.mimeType,
    };
    await this.createRemoteSession(r, session, file.overwrite, chunkSize);

    await nodeRpc(r.node, r.meta, {
      method: 'POST',
      path: `upload/${session.id}?chunk=0`,
      body,
      bodyText: null,
      signBody: false,
      timeoutMs: NO_TIMEOUT,
      extraHeaders: {
        'X-Cr-Overwrite': String(file.overwrite),
        ...(file.mimeType ? { 'Content-Type': file.mimeType } : {}),
      },
    });
  }

  async writeChunk(
    session: UploadSession,
    index: number,
    body: ReadableStream,
    _length: number,
  ): Promise<UploadedPart | null> {
    const r = await this.resolve();
    await nodeRpc(r.node, r.meta, {
      method: 'POST',
      path: `upload/${session.id}?chunk=${index}`,
      body,
      // 分片正文不参与签名（`pkg/auth.isUploadDataRequest`）：否则要在签名前
      // 把整个分片读进内存，几十 MB 的缓冲在 Worker 里不可接受。
      bodyText: null,
      signBody: false,
      timeoutMs: NO_TIMEOUT,
      extraHeaders: {
        'X-Cr-Overwrite': String(!session.newFileCreated),
        ...(session.mimeType ? { 'Content-Type': session.mimeType } : {}),
      },
    });
    return null;
  }

  /** 最后一个分片到达时从机已经自己收尾，这里无事可做。 */
  async completeUpload(_session: UploadSession): Promise<void> {
    return;
  }

  async cancelToken(session: UploadSession): Promise<void> {
    const r = await this.resolve();
    await nodeRpc(r.node, r.meta, {
      method: 'DELETE',
      path: `upload/${session.id}`,
      timeoutMs: CONTROL_TIMEOUT,
    }).catch(() => {
      /* 会话可能已过期，取消失败不影响调用方 */
    });
  }

  async delete(sources: string[]): Promise<string[]> {
    if (sources.length === 0) return [];
    const r = await this.resolve();
    const body = JSON.stringify({ files: sources });
    try {
      await nodeRpc(r.node, r.meta, {
        method: 'DELETE',
        path: 'file',
        body,
        bodyText: body,
        timeoutMs: CONTROL_TIMEOUT,
        extraHeaders: { 'Content-Type': 'application/json' },
      });
      return [];
    } catch (e) {
      // CodeNotFullySuccess：部分失败，data 是没删掉的键
      if (e instanceof NodeRpcError && e.code === 40069) {
        return sources;
      }
      throw e;
    }
  }

  /** 内容地址（未签名）。 */
  private contentUrl(
    r: NodeContext,
    source: string,
    args: { name: string; download: boolean; speed: number },
  ): string {
    const url = nodeUrl(
      r.node,
      `file/content/${r.node.id}/${encodeURIComponent(b64urlPath(source))}/${
        args.speed || 0
      }/${encodeURIComponent(args.name || 'file')}`,
    );
    if (args.download) url.searchParams.set('download', 'true');
    return url.toString();
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const r = await this.resolve();
    const name = source.split('/').pop() || 'file';
    const signed = await signNodeUrl(
      r.node,
      this.contentUrl(r, source, { name, download: false, speed: 0 }),
      3600,
    );
    const headers: Record<string, string> = {};
    if (range) headers.Range = range;
    let res: Response;
    try {
      res = await fetch(signed, { headers });
    } catch (err) {
      throw new NodeRpcError(
        `Failed to read from node "${r.node.name}": ${(err as Error).message}`,
        0,
        0,
      );
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok && res.status !== 206) {
      await res.body?.cancel().catch(() => {});
      throw new NodeRpcError(`node returned HTTP ${res.status}`, res.status, 0);
    }
    if (!res.body) return null;
    const total = Number(res.headers.get('Content-Length') ?? 0);
    const contentRange = res.headers.get('Content-Range');
    return {
      body: res.body,
      size: total,
      contentType: res.headers.get('Content-Type') ?? undefined,
      contentRange,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const r = await this.resolve();
    const name = source.split('/').pop() || 'file';
    const signed = await signNodeUrl(
      r.node,
      this.contentUrl(r, source, { name, download: false, speed: 0 }),
      600,
    );
    let res: Response;
    try {
      res = await fetch(signed, { method: 'HEAD' });
    } catch {
      return null;
    }
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) return null;
    if (!res.ok) throw new NodeRpcError(`node returned HTTP ${res.status}`, res.status, 0);
    const len = res.headers.get('Content-Length');
    if (len === null) throw new NodeRpcError('node returned no Content-Length', res.status, 0);
    return { size: Number(len) };
  }

  async source(source: string, args: GetSourceArgs): Promise<string> {
    const r = await this.resolve();
    const ttl = Math.min(3600, Math.max(60, Math.floor(((args.expire ?? 0) - Date.now()) / 1000) || 3600));
    return signNodeUrl(
      r.node,
      this.contentUrl(r, source, {
        name: args.displayName,
        download: args.isDownload,
        speed: args.speed,
      }),
      ttl,
    );
  }

  /** 见 `capabilities()` 的说明：缩略图交给上层用 CF 图片缩放生成。 */
  async thumb(_source: string, _size: string): Promise<string | null> {
    return null;
  }

  async list(
    prefix: string,
    options?: { continuation?: string; afterKey?: string; limit?: number },
  ): Promise<{
    keys: { key: string; size: number; lastModified: Date }[];
    continuation: string | null;
  }> {
    void options;
    const r = await this.resolve();
    const data = await nodeRpc<
      { name?: string; relative_path?: string; source?: string; size?: number; is_dir?: boolean }[]
    >(r.node, r.meta, {
      method: 'GET',
      path: `file/list?path=${encodeURIComponent(prefix)}&recursive=true`,
      timeoutMs: 120_000,
    });
    const items = Array.isArray(data) ? data : [];
    return {
      keys: items
        .filter((it) => it.is_dir !== true)
        .map((it) => ({
          key: String(it.source ?? it.relative_path ?? it.name ?? ''),
          size: Number(it.size ?? 0),
          lastModified: new Date(),
        }))
        .filter((it) => it.key !== ''),
      continuation: null,
    };
  }
}
