/**
 * Cloudflare R2 驱动。
 *
 * 走 Worker 的 R2 绑定，**不需要** S3 的 AK/SK。上传采用中转模式：
 * 客户端把分片打到 `/api/v4/file/upload/:sessionId/:index`，Worker 用绑定的
 * multipart API 写入 R2。这样避免了在 KV 里存二进制，也不需要把 R2 的
 * 长期密钥下发到客户端。
 *
 * 已知取舍（见 README「已知差异」）：
 *   - 没有实现直传到 R2 的预签名 URL。中转模式下单次请求体上限取决于
 *     Workers 套餐（免费 100MB / 付费 500MB），因此**超大文件需要配置
 *     R2_PUBLIC_BASE 之外的直传方案**，或改用 OneDrive 策略。
 *   - 未配置 R2_PUBLIC_BASE 时，下载经 Worker 代理（`proxyRequired = true`）。
 */
import type { Env } from '../env';
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

/** R2 的 public 域名不需要编码整段路径，逐段编码即可。 */
function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** 解析 `bytes=start-end` 形式的 Range 头。 */
function parseRange(
  range: string | null | undefined,
  size: number,
): { offset: number; length: number } | null {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    // 后缀范围：bytes=-500 → 最后 500 字节
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const offset = Math.max(0, size - suffix);
    return { offset, length: size - offset };
  }
  const offset = Number(startRaw);
  const end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isFinite(offset) || !Number.isFinite(end) || end < offset) return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

export class R2Driver implements StorageDriver {
  // R2 兼容 S3 API；策略类型按上游词表呈现为 's3'（前端枚举无 'r2'）。
  readonly type = 's3';
  readonly chunkSize: number;
  readonly settings;

  constructor(
    private readonly env: Env,
    readonly policy: StoragePolicyRow,
  ) {
    this.settings = policy.settings ?? {};
    // R2 multipart 要求除最后一片外每片不小于 5MB，默认取 25MB（与原版 S3 驱动一致）。
    this.chunkSize = Math.max(5 * 1024 * 1024, resolveChunkSize(policy.settings, 25 << 20));
  }

  private get bucket(): R2Bucket {
    if (!this.env.R2) {
      throw new Error('R2 binding is not configured');
    }
    return this.env.R2;
  }

  capabilities(): DriverCapabilities {
    return {
      // 没有公共域名时只能经 Worker 代理下载
      proxyRequired: !this.env.R2_PUBLIC_BASE,
      uploadSentinelRequired: true,
      maxSourceExpire: 0,
      thumbSupportedExts: [],
      thumbSupportAllExts: false,
      thumbMaxSize: 0,
    };
  }

  async token(session: UploadSession, file: UploadRequest): Promise<UploadCredential> {
    const expires = Math.floor(session.expireAt / 1000);

    // 小文件单次写入，不必开 multipart。
    if (file.size <= this.chunkSize) {
      return {
        session_id: session.id,
        chunk_size: 0, // 0 表示客户端只发一个分片（index=0，长度等于文件大小）
        expires,
      };
    }

    const mpu = await this.bucket.createMultipartUpload(file.savePath, {
      httpMetadata: file.mimeType ? { contentType: file.mimeType } : undefined,
    });
    session.uploadId = mpu.uploadId;

    return {
      session_id: session.id,
      chunk_size: this.chunkSize,
      expires,
      uploadID: mpu.uploadId,
    };
  }

  async writeChunk(
    session: UploadSession,
    index: number,
    body: ReadableStream,
    _length: number,
  ): Promise<UploadedPart | null> {
    if (!session.uploadId) {
      // 单次写入路径
      await this.bucket.put(session.savePath, body, {
        httpMetadata: session.mimeType ? { contentType: session.mimeType } : undefined,
      });
      return null;
    }

    const mpu = this.bucket.resumeMultipartUpload(session.savePath, session.uploadId);
    const part = await mpu.uploadPart(index + 1, body);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  async completeUpload(session: UploadSession): Promise<void> {
    if (!session.uploadId) return; // 单次写入已在 writeChunk 内完成
    const parts = [...(session.parts ?? [])].sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length === 0) return;
    const mpu = this.bucket.resumeMultipartUpload(session.savePath, session.uploadId);
    await mpu.complete(parts);
  }

  async cancelToken(session: UploadSession): Promise<void> {
    if (session.uploadId) {
      try {
        const mpu = this.bucket.resumeMultipartUpload(session.savePath, session.uploadId);
        await mpu.abort();
      } catch {
        // 会话可能已过期，忽略
      }
    }
    if (session.newFileCreated === false) return;
    // 清理可能已写入的占位对象
    try {
      await this.bucket.delete(session.savePath);
    } catch {
      // ignore
    }
  }

  async delete(sources: string[]): Promise<string[]> {
    if (sources.length === 0) return [];
    // R2 绑定单次 delete 支持数组，超过 1000 个时分批
    const failed: string[] = [];
    for (let i = 0; i < sources.length; i += 1000) {
      const batch = sources.slice(i, i + 1000);
      try {
        await this.bucket.delete(batch);
      } catch {
        failed.push(...batch);
      }
    }
    return failed;
  }

  async put(file: UploadRequest, body: ReadableStream, _contentLength: number): Promise<void> {
    if (!file.overwrite) {
      const head = await this.bucket.head(file.savePath);
      if (head) throw new Error('Object existed');
    }
    await this.bucket.put(file.savePath, body, {
      httpMetadata: file.mimeType ? { contentType: file.mimeType } : undefined,
    });
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const head = await this.bucket.head(source);
    if (!head) return null;
    const parsed = parseRange(range, head.size);
    const obj = await this.bucket.get(source, parsed ? { range: parsed } : undefined);
    if (!obj) return null;
    return {
      body: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType,
      contentRange: parsed ? `bytes ${parsed.offset}-${parsed.offset + parsed.length - 1}/${head.size}` : null,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const head = await this.bucket.head(source);
    return head ? { size: head.size } : null;
  }

  async source(source: string, _args: GetSourceArgs): Promise<string> {
    const base = this.env.R2_PUBLIC_BASE;
    if (!base) {
      // 没有公共域名，调用方应改用站点代理（capabilities().proxyRequired 为 true）
      throw new Error('R2 public base is not configured, use proxy instead');
    }
    return `${base.replace(/\/+$/, '')}/${encodeKeyPath(source)}`;
  }

  async thumb(): Promise<string | null> {
    return null;
  }
}
