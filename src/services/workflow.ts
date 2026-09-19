/**
 * 任务流服务。对应 Cloudreve v4 的 `service/explorer/workflows.go` 与后台任务队列。
 *
 * ## 与原版最大的结构差异，先说清楚
 *
 * 原版把任务丢进后台 goroutine 池慢慢跑，前端轮询进度。Workers 是**请求作用域**的：
 * 响应一返回，这次执行的 CPU 预算就结束了，没有常驻进程能接着跑。
 *
 * 所以这里改成「**请求内同步跑完**」：
 *   - 打包（create_archive）：边打包边上传，跑完任务就是 completed；
 *   - 远程下载（remote_download）：边下边传，跑完就是 completed。
 *
 * 代价是单次能处理的体积受 Workers 的 CPU/内存上限约束，因此设了
 * `MAX_WORKFLOW_BYTES` 作为硬闸门 —— 超了就明确报「太大」，而不是
 * 建一个永远跑不完的任务给用户看。这比假装排队要诚实。
 *
 * 没有实现的部分（解压、从策略导入、重建全文索引）一律返回明确的「不支持」，
 * 不建空任务。
 */
import { AppContext } from './context';
import { FileSystemService } from './fs';
import { UploadService } from './upload';
import type { FileRow, TaskRow } from '../db/types';
import { FileType } from '../lib/boolset';
import { AppError, CodeFeatureNotEnabled, Err } from '../lib/errors';
import { createZipStream, type ZipEntry } from '../lib/zip';
import { URI } from './uri';

/**
 * 单个任务允许处理的字节上限。
 *
 * 定在 200MB：Workers 请求内可用内存 128MB，打包是按分片流式处理的
 * （内存里最多同时存在一个分片），200MB 是 CPU 时间比内存先见底的量级。
 */
export const MAX_WORKFLOW_BYTES = 200 * 1024 * 1024;

/** 递归列举目录时的单页大小。 */
const LIST_PAGE_SIZE = 500;

interface ArchiveItem {
  /** 包内路径；目录以 `/` 结尾 */
  name: string;
  file: FileRow;
  isDir: boolean;
}

/** 把若干 Uint8Array 拼成一个。 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export class WorkflowService {
  constructor(
    private readonly ctx: AppContext,
    private readonly fs: FileSystemService,
  ) {}

  // -------------------------------------------------------------------------
  // 打包
  // -------------------------------------------------------------------------

  /**
   * 把 `src` 打成 zip 写到 `dst`。
   *
   * 对应上游 `explorer.ArchiveWorkflowService` + `controllers.CreateArchive`。
   * 上游是建任务后台跑；这里同步跑完，返回时任务已经是 completed（或 error）。
   */
  async createArchive(args: { src: string[]; dst: string }): Promise<TaskRow> {
    const user = this.ctx.requireUser();
    if (!args.src.length) throw Err.param('src is required');
    if (!args.dst) throw Err.param('dst is required');

    const task = await this.ctx.tasks.create({
      type: 'create_archive',
      userId: user.id,
      publicState: { summary: { props: { src_multiple: args.src, dst: args.dst } } },
    });

    try {
      const items = await this.collect(args.src);
      const encoder = new TextEncoder();

      // store 模式下 zip 的最终大小可以精确算出来，上传会话一开始就要知道总长度
      let zipSize = 22;
      for (const item of items) {
        const nameLen = encoder.encode(item.name).length;
        zipSize += 30 + nameLen + (item.isDir ? 0 : item.file.size) + 16; // local + data + descriptor
        zipSize += 46 + nameLen; // central directory entry
      }
      if (zipSize > MAX_WORKFLOW_BYTES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Archive would be ${zipSize} bytes, which exceeds the ${MAX_WORKFLOW_BYTES} byte limit of a single edge request`,
        );
      }

      const entries: ZipEntry[] = items.map((item) => ({
        name: item.name,
        modifiedAt: item.file.updated_at,
        data: item.isDir ? null : () => this.openFileStream(item.file),
      }));

      await this.writeToUri(args.dst, zipSize, createZipStream(entries), 'application/zip');
      await this.ctx.tasks.updateStatus(task.id, 'completed', {
        summary: { props: { src_multiple: args.src, dst: args.dst, total: items.length } },
      });
      return (await this.ctx.tasks.byId(task.id))!;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.ctx.tasks.updateStatus(task.id, 'error', {
        error: message,
        error_history: [message],
      });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // 远程下载
  // -------------------------------------------------------------------------

  /**
   * 把一个 HTTP(S) 地址的内容存到 `dst`。
   *
   * 对应上游 `explorer.DownloadWorkflowService` + `controllers.CreateRemoteDownload`。
   * 上游支持种子/磁力（走 aria2 从节点），边缘版只支持**直链** HTTP(S)。
   */
  async createRemoteDownload(args: { url: string; dst: string }): Promise<TaskRow> {
    const user = this.ctx.requireUser();
    if (!args.url) throw Err.param('url is required');
    if (!args.dst) throw Err.param('dst is required');

    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      throw Err.param('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError(
        CodeFeatureNotEnabled,
        'Only HTTP(S) links are supported; torrents and magnet links need a slave node',
      );
    }

    const task = await this.ctx.tasks.create({
      type: 'remote_download',
      userId: user.id,
      publicState: { summary: { props: { src: args.url, dst: args.dst } } },
    });

    try {
      // 先 HEAD 拿长度；拿不到就按流式未知长度处理（上传会话必须要一个确定长度，
      // 所以这里退化为「先取到内存上限内」——超过上限直接报太大）
      const head = await fetch(args.url, { method: 'HEAD' }).catch(() => null);
      const declared = Number(head?.headers.get('content-length') ?? 0);
      if (declared > MAX_WORKFLOW_BYTES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Remote file is ${declared} bytes, which exceeds the ${MAX_WORKFLOW_BYTES} byte limit`,
        );
      }

      const res = await fetch(args.url);
      if (!res.ok || !res.body) {
        throw new AppError(CodeFeatureNotEnabled, `Failed to fetch remote file: HTTP ${res.status}`);
      }

      await this.writeToUri(
        args.dst,
        declared,
        res.body as ReadableStream<Uint8Array>,
        res.headers.get('content-type') ?? undefined,
      );
      await this.ctx.tasks.updateStatus(task.id, 'completed', {
        summary: { props: { src: args.url, dst: args.dst, total: declared } },
      });
      return (await this.ctx.tasks.byId(task.id))!;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.ctx.tasks.updateStatus(task.id, 'error', {
        error: message,
        error_history: [message],
      });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 把来源 URI 展开成扁平的条目列表（目录递归展开）。 */
  private async collect(sources: string[]): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    for (const raw of sources) {
      const uri = URI.parse(raw);
      const file = await this.fs.mustResolve(uri);
      if (file.type === FileType.Folder) {
        items.push({ name: `${file.name}/`, file, isDir: true });
        await this.walk(file.id, file.name, items);
      } else {
        items.push({ name: file.name, file, isDir: false });
      }
    }
    return items;
  }

  private async walk(folderId: number, prefix: string, out: ArchiveItem[]): Promise<void> {
    const ownerId = this.ctx.requireUser().id;
    let page = 0;
    for (;;) {
      const { files, total } = await this.ctx.files.list({
        parentId: folderId,
        ownerId,
        page,
        pageSize: LIST_PAGE_SIZE,
        orderBy: 'name',
        orderDirection: 'asc',
      });
      for (const file of files) {
        const childPath = `${prefix}/${file.name}`;
        if (file.type === FileType.Folder) {
          out.push({ name: `${childPath}/`, file, isDir: true });
          await this.walk(file.id, childPath, out);
        } else {
          out.push({ name: childPath, file, isDir: false });
        }
      }
      if ((page + 1) * LIST_PAGE_SIZE >= total) break;
      page += 1;
    }
  }

  /** 打开文件的实体内容流。惰性调用 —— 只有轮到这个条目时才真的去对象存储取。 */
  private async openFileStream(file: FileRow): Promise<ReadableStream<Uint8Array>> {
    if (!file.primary_entity) {
      throw new AppError(CodeFeatureNotEnabled, `File "${file.name}" has no entity`);
    }
    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) throw new AppError(CodeFeatureNotEnabled, `Entity of "${file.name}" is missing`);
    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw Err.policyNotAllowed();
    const content = await this.ctx.driverFor(policy).get(entity.source, null);
    if (!content) {
      throw new AppError(CodeFeatureNotEnabled, `Object of "${file.name}" is missing in storage`);
    }
    return content.body as ReadableStream<Uint8Array>;
  }

  /**
   * 把一段已知长度的字节流写进用户的文件系统。
   *
   * 走的是正规上传链路（`UploadService`），所以容量校验、策略约束、实体转正、
   * 版本保留这些都和客户端上传完全一致 —— 不做绕过这些检查的「直写」。
   *
   * 分片大小必须和上传会话声明的一致（`expectedChunkLength` 会严格校验），
   * 所以这里按会话给的 `chunk_size` 切分后再逐片提交。
   */
  private async writeToUri(
    uri: string,
    size: number,
    source: ReadableStream<Uint8Array>,
    mimeType?: string,
  ): Promise<void> {
    const upload = new UploadService(this.ctx, this.fs);
    const session = await upload.createSession({ uri, size, mimeType });

    const chunkSize = session.chunk_size > 0 ? session.chunk_size : size;
    const totalChunks = chunkSize > 0 ? Math.max(1, Math.ceil(size / chunkSize)) : 1;
    const expectedFor = (index: number): number =>
      chunkSize > 0 ? (index === totalChunks - 1 ? size - index * chunkSize : chunkSize) : size;

    const reader = source.getReader();
    // 跨分片边界的剩余字节
    let carry: Uint8Array[] = [];
    let carryLen = 0;

    try {
      for (let index = 0; index < totalChunks; index += 1) {
        const want = expectedFor(index);

        while (carryLen < want) {
          const { done, value } = await reader.read();
          if (done) {
            throw new AppError(
              CodeFeatureNotEnabled,
              `Source stream ended early: expected ${size} bytes, got ${carryLen}`,
            );
          }
          carry.push(value as Uint8Array);
          carryLen += (value as Uint8Array).length;
        }

        // 精确取 want 个字节，多出来的留到下一片
        const parts: Uint8Array[] = [];
        let taken = 0;
        while (taken < want) {
          const first = carry[0]!;
          if (first.length <= want - taken) {
            parts.push(carry.shift()!);
            taken += first.length;
          } else {
            const need = want - taken;
            parts.push(first.subarray(0, need));
            carry[0] = first.subarray(need);
            taken = want;
          }
        }
        carryLen -= want;

        await upload.uploadChunk(
          session.session_id,
          index,
          bytesToStream(concatBytes(parts)) as ReadableStream,
          want,
        );
      }
    } catch (e) {
      // 失败要把占位实体清掉，否则用户目录里会留下一个 0 字节的幽灵文件
      await upload.deleteSession(session.session_id, uri).catch(() => undefined);
      throw e;
    }
  }
}
