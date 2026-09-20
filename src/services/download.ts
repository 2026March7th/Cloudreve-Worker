/**
 * 实体下载与外链服务。对应 Cloudreve v4 的
 * `pkg/filemanager/manager/entitysource/entitysource.go` + `service/explorer/entity.go`。
 *
 * URL 有两种形态：
 *   1. 驱动能给出直链（OneDrive 的 @microsoft.graph.downloadUrl、配了公共域名的 R2）
 *      → 直接返回远端地址，浏览器/客户端拿走即可；
 *   2. 驱动需要代理（未配公共域名的 R2）
 *      → 返回本站签名地址 `/api/v4/file/content/:entityId/:speed/:name?sign=...`，
 *        由 Worker 把对象流式转发出去。
 *
 * 「限速」在 Workers 上无法实现，`speed` 段仅作为协议占位原样透传（见 README）。
 */
import { AppContext } from './context';
import { FileSystemService, type DirectLinkInfo } from './fs';
import { FileSystemType, URI } from './uri';
import type { EntityRow, FileRow } from '../db/types';
import { FileType } from '../lib/boolset';
import {
  AppError,
  CodeFileNotFound,
  CodeEntityNotExist,
  CodeGroupNotAllowed,
  CodeInvalidSign,
  CodeOwnerOnly,
  CodeSignExpired,
  Err,
} from '../lib/errors';
import { GroupPermission } from '../lib/boolset';
import type { ObjectContent } from '../storage/types';

export interface EntityUrl {
  url: string;
  stream_saver_display_name?: string;
}

export interface FileUrlResponse {
  urls: EntityUrl[];
  expires: Date | string | null;
}

export interface GetUrlOptions {
  download?: boolean;
  entity?: string;
  noCache?: boolean;
  /** 直链有效期（秒），默认取站点设置 entity_url_default_ttl */
  ttlSeconds?: number;
}

export interface ServeEntityResult {
  content: ObjectContent;
  /** 直接 302 到远端时的地址 */
  redirectTo?: string;
}

/** 直链 URL 的路径前缀（原版是 /f/:id/:name，签名后可见）。 */
export const DIRECT_LINK_PREFIX = '/f';

export class DownloadService {
  constructor(
    private readonly ctx: AppContext,
    private readonly fs: FileSystemService,
  ) {}

  /**
   * 为一批文件生成下载/预览地址。
   * 与原版一致：`redirect` 只对单个 uri 生效，由路由层处理。
   */
  async getUrls(uris: URI[], options: GetUrlOptions = {}): Promise<FileUrlResponse> {
    const urls: EntityUrl[] = [];
    const now = Math.floor(Date.now() / 1000);
    const ttl = options.ttlSeconds ?? this.ctx.settings.getInt('entity_url_default_ttl', 3600);
    const expiresAt = ttl > 0 ? now + ttl : 0;

    for (const uri of uris) {
      const file = await this.fs.mustResolve(uri);
      if (file.type !== FileType.File) {
        throw new AppError(CodeFileNotFound, 'Cannot generate download URL for a folder');
      }

      // 分享下载计数。原版由 navigator 的 `HookTypeBeforeDownload` 钩子完成
      // （share_navigator.go:302-308 → shareClient.Downloaded：downloads +1，
      //  remain_downloads 有值时再 -1），钩子在 `GetEntityUrls` 里触发，
      // 也就是**生成下载地址时**计数，而不是真正取字节时。
      if (uri.fsType === FileSystemType.Share && uri.id) {
        const shareId = this.ctx.codec.decodeShareID(uri.id);
        if (shareId !== null) await this.ctx.shares.incrementDownloads(shareId);
      }

      const entity = await this.primaryEntityOf(file, options.entity);
      const name = file.name;

      const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
      if (!policy) throw Err.policyNotAllowed();
      const driver = this.ctx.driverFor(policy);
      const caps = driver.capabilities();

      let url: string;
      if (!caps.proxyRequired) {
        // 驱动可直链
        url = await driver.source(entity.source, {
          expire: expiresAt > 0 ? expiresAt * 1000 : undefined,
          isDownload: options.download === true,
          displayName: name,
          speed: 0,
        });
      } else {
        url = await this.buildProxyUrl(
          entity.id,
          name,
          expiresAt,
          options.download === true,
          await this.speedLimitFor(file),
        );
      }

      const item: EntityUrl = { url };
      if (driver.settings?.stream_saver) {
        item.stream_saver_display_name = name;
      }
      urls.push(item);
    }

    return { urls, expires: expiresAt > 0 ? new Date(expiresAt * 1000).toISOString() : null };
  }

  /** 取文件的主实体；`entityHashId` 指定时校验归属。 */
  private async primaryEntityOf(file: FileRow, entityHashId?: string): Promise<EntityRow> {
    if (entityHashId) {
      const id = this.ctx.codec.decodeEntityID(entityHashId);
      if (id === null) throw new AppError(CodeEntityNotExist, 'Entity not found');
      const entity = await this.ctx.entities.byId(id);
      if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');
      return entity;
    }
    if (!file.primary_entity) {
      throw new AppError(CodeEntityNotExist, 'File has no content entity');
    }
    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');
    return entity;
  }

  /** 构造本站代理下载地址并签名。`download` 为真时响应带 attachment 头。 */
  private async buildProxyUrl(
    entityId: number,
    name: string,
    expiresAt: number,
    download: boolean,
    speed = 0,
  ): Promise<string> {
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const entityHash = this.ctx.codec.encodeEntityID(entityId);
    const path = `/api/v4/file/content/${entityHash}/${speed}/${encodeURIComponent(name)}`;
    const sign = await this.ctx.signer.sign(path, expiresAt);
    // 上游语义（pkg/cluster/routes/routes.go:15）：query 里 `download` 非空
    // 即表示强制下载；签名只覆盖 pathname，query 参数不参与签名
    const suffix = download ? '?download=true&sign=' : '?sign=';
    return `${base}${path}${suffix}${encodeURIComponent(sign)}`;
  }

  /**
   * 文件属主的组下载限速（字节/秒，0 = 不限）。
   * 编进代理 URL 的 `:speed` 段，由内容分发端点执行 —— 代理地址是
   * 签名给匿名用的，执行时拿不到用户上下文，所以限速必须在铸造时带上。
   */
  private async speedLimitFor(file: FileRow): Promise<number> {
    const user = this.ctx.user;
    if (user && user.id === file.owner_id) return user.group?.speed_limit ?? 0;
    if (!file.owner_id) return 0;
    const owner = await this.ctx.users.byId(file.owner_id);
    if (!owner) return 0;
    const group = await this.ctx.groups.byId(owner.group_users);
    return group?.speed_limit ?? 0;
  }

  /**
   * 代理下载：把实体内容以流的形式返回。
   * 支持 Range 透传，便于视频拖动与断点续传。
   */
  async serveEntity(
    entityHashId: string,
    name: string,
    range?: string | null,
  ): Promise<ObjectContent> {
    const entityId = this.ctx.codec.decodeEntityID(entityHashId);
    if (entityId === null) throw new AppError(CodeEntityNotExist, 'Entity not found');

    const entity = await this.ctx.entities.byId(entityId);
    if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');

    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw Err.policyNotAllowed();
    const driver = this.ctx.driverFor(policy);

    const content = await driver.get(entity.source, range ?? null);
    if (!content) throw new AppError(CodeFileNotFound, 'Object not found in storage backend');
    void name;
    return content;
  }

  /** 缩略图地址；驱动不支持时返回 null（原版返回空 url）。 */
  async thumb(uri: URI): Promise<{ url: string; expires: string | null }> {
    const file = await this.fs.mustResolve(uri);
    if (file.type !== FileType.File || !file.primary_entity) {
      return { url: '', expires: null };
    }
    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) return { url: '', expires: null };

    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) return { url: '', expires: null };
    const driver = this.ctx.driverFor(policy);

    const url = await driver.thumb(entity.source, 'large').catch(() => null);
    return { url: url ?? '', expires: null };
  }

  // -------------------------------------------------------------------------
  // 外链（直链）
  // -------------------------------------------------------------------------

  async createDirectLink(uri: URI, speed = 0): Promise<DirectLinkInfo[]> {
    const user = this.ctx.requireUser();
    const file = await this.fs.mustResolve(uri);
    if (file.owner_id !== user.id && !this.ctx.isAdmin) {
      throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
    }
    const link = await this.ctx.directLinks.create(file.id, file.name, speed);
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const id = this.ctx.codec.encodeSourceLinkID(link.id);
    return [
      {
        id,
        url: `${base}${DIRECT_LINK_PREFIX}/${id}/${encodeURIComponent(file.name)}`,
        downloaded: link.downloads,
        created_at: link.created_at.toISOString(),
      },
    ];
  }

  async deleteDirectLink(linkHashId: string): Promise<void> {
    const id = this.ctx.codec.decodeSourceLinkID(linkHashId);
    if (id === null) throw new AppError(404, 'Direct link not found');
    const link = await this.ctx.directLinks.byId(id);
    if (!link) throw new AppError(404, 'Direct link not found');
    const user = this.ctx.requireUser();
    const file = await this.ctx.files.byId(link.file_id);
    if (!file || (file.owner_id !== user.id && !this.ctx.isAdmin)) {
      throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
    }
    await this.ctx.directLinks.softDelete(id);
  }

  /** 访问直链：返回远端地址（由路由层 302）。 */
  async visitDirectLink(linkHashId: string): Promise<string> {
    const id = this.ctx.codec.decodeSourceLinkID(linkHashId);
    if (id === null) throw new AppError(404, 'Direct link not found');
    const link = await this.ctx.directLinks.byId(id);
    if (!link) throw new AppError(404, 'Direct link not found');

    const file = await this.ctx.files.byId(link.file_id);
    if (!file || !file.primary_entity) throw Err.fileNotFound();

    // 上游 PR #3524（GetFileFromDirectLink）：属主被封禁/删除，或其当前
    // 所在组已无源流能力（source_batch <= 0）时，直链立即失效。
    const owner = file.owner_id ? await this.ctx.users.byId(file.owner_id) : null;
    if (!owner || owner.status !== 'active') {
      throw new AppError(404, 'Direct link not found');
    }
    const ownerGroup = owner.group_users ? await this.ctx.groups.byId(owner.group_users) : null;
    if (!ownerGroup || !ownerGroup.settings || (ownerGroup.settings.source_batch ?? 0) <= 0) {
      throw new AppError(404, 'Direct link not found');
    }

    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');

    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw Err.policyNotAllowed();
    const driver = this.ctx.driverFor(policy);
    const caps = driver.capabilities();

    await this.ctx.directLinks.incrementDownloads(id);

    if (!caps.proxyRequired) {
      return driver.source(entity.source, {
        isDownload: true,
        displayName: file.name,
        speed: link.speed,
      });
    }

    // 需要代理时返回本站签名地址（带上属主组限速）
    const expiresAt = Math.floor(Date.now() / 1000) + this.ctx.settings.getInt('entity_url_default_ttl', 3600);
    return this.buildProxyUrl(entity.id, file.name, expiresAt, true, await this.speedLimitFor(file));
  }

  /** 打包下载：边缘版不支持流式 zip，返回明确的「未启用」错误。 */
  async archiveDownload(_uris: URI[]): Promise<never> {
    this.ctx.requireGroupPermission(
      GroupPermission.ArchiveDownload,
      'Archive download is not allowed for your group',
    );
    throw new AppError(
      40056,
      'Archive download is not implemented in the edge build; download files individually',
    );
  }
}

export { CodeInvalidSign, CodeSignExpired, FileSystemType };
