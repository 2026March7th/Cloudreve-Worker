/**
 * 分享服务。对应 Cloudreve v4 的 `service/share/manage.go` 与 `visit.go`。
 *
 * 关键契约（回源码核对过）：
 *   - 创建分享的响应 `data` 是**字符串**（分享 URL），不是对象；
 *   - `is_private=true` 且未给密码时，服务端随机生成 8 位小写密码；
 *   - `expire <= 0` 表示永久；
 *   - **没有独立的解锁端点**，密码通过 `GET /share/info/:id?password=` 传入；
 *   - 短链 `GET /s/:id[/:password]` 302 到前端 `/home?path=cloudreve://<id>[:<pwd>]@share`。
 *
 * 付费分享（原版 Pro 的 `CodePurchaseRequired`）在边缘版完全没有实现。
 */
import { AppContext } from './context';
import { logAudit } from './audit';
import { FileSystemService, MetadataRestoreUri } from './fs';
import { FileSystemType, URI } from './uri';
import { isShareExpired, isShareInvalid } from './share-rules';
import type { FileRow, ShareRow, UserRow } from '../db/types';
import { FileType, GroupPermission } from '../lib/boolset';
import {
  AppError,
  CodeIncorrectPassword,
  CodeNoPermissionErr,
  CodeNotFound,
  CodeSaveOwnShare,
  CodeGroupNotAllowed,
  Err,
} from '../lib/errors';
import { randomString } from '../lib/crypto';

export interface ShareCreateParams {
  uri: string;
  is_private?: boolean;
  password?: string;
  downloads?: number;
  expire?: number;
  share_view?: boolean;
  show_readme?: boolean;
}

export interface ShareResponse {
  id: string;
  name?: string;
  remain_downloads?: number;
  visited: number;
  downloaded?: number;
  expires?: string;
  unlocked: boolean;
  password_protected?: boolean;
  source_type?: number;
  owner: {
    id: string;
    email?: string;
    nickname: string;
    created_at: string;
    anonymous?: boolean;
  };
  created_at?: string;
  expired: boolean;
  url: string;
  show_readme?: boolean;
  size: number;
  is_private?: boolean;
  password?: string;
  share_view?: boolean;
  source_uri?: string;
}

export interface ShareInfoOptions {
  password?: string;
  countViews?: boolean;
  ownerExtended?: boolean;
}

export class ShareService {
  constructor(
    private readonly ctx: AppContext,
    private readonly fs: FileSystemService,
  ) {}

  /** 分享 URL：`/s/<shareHashid>[/<password>]`。 */
  private shareUrl(shareId: number, password?: string | null): string {
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const hash = this.ctx.codec.encodeShareID(shareId);
    return password ? `${base}/s/${hash}/${encodeURIComponent(password)}` : `${base}/s/${hash}`;
  }

  // -------------------------------------------------------------------------
  // 创建 / 编辑
  // -------------------------------------------------------------------------

  /** 创建分享，返回分享 URL（与原版一致，data 是字符串）。 */
  async create(params: ShareCreateParams): Promise<string> {
    const user = this.ctx.requireUser();
    this.ctx.requireGroupPermission(GroupPermission.Share, 'Group permission denied');

    if (!params.uri) throw Err.param('uri is required');
    const uri = URI.parse(params.uri);
    // 对齐原版 `manager.CreateOrUpdateShare`（`manager/operation.go:288-296`）：
    // 取不到源文件（含根目录，原版带 `WithNotRoot()`）或缺少 Share 能力位，
    // 一律报 `CodeNotFound` + "src file not found"；属主不符报 403 "permission denied"。
    const file = await this.fs.resolve(uri);
    if (!file || this.fs.isRootFolder(file)) {
      throw new AppError(CodeNotFound, 'src file not found');
    }
    if (file.owner_id !== user.id) {
      throw new AppError(CodeNoPermissionErr, 'permission denied');
    }
    // 符号目录（「保存到我的网盘」生成的快捷方式）不能分享，见 operation.go:298-300
    if (file.is_symbolic) {
      throw new AppError(CodeNoPermissionErr, 'cannot share symbolic file');
    }

    let password = params.password?.trim() || null;
    if (password && !/^[a-zA-Z0-9]{1,32}$/.test(password)) {
      throw Err.param('Password must be alphanumeric and at most 32 characters');
    }
    // 私密分享未给密码时随机生成（原版行为）
    if (params.is_private && !password) {
      password = randomString(8).toLowerCase();
    }

    const expire = Number(params.expire ?? 0);
    const expires = expire > 0 ? new Date(Date.now() + expire * 1000) : null;

    const remainDownloads =
      params.downloads && params.downloads > 0 ? Number(params.downloads) : null;

    const share = await this.ctx.shares.create({
      fileId: file.id,
      userId: user.id,
      password,
      expires,
      remainDownloads,
      props: {
        share_view: params.share_view === true,
        show_read_me: params.show_readme === true,
      },
    });

    logAudit(this.ctx, 'share', user.id, { name: file.name, is_private: params.is_private === true });
    return this.shareUrl(share.id, password);
  }

  async edit(shareHashId: string, params: ShareCreateParams): Promise<string> {
    const user = this.ctx.requireUser();
    this.ctx.requireGroupPermission(GroupPermission.Share, 'Group permission denied');

    const shareId = this.ctx.codec.decodeShareID(shareHashId);
    if (shareId === null) throw Err.shareNotFound();
    const share = await this.ctx.shares.byId(shareId);
    if (!share) throw Err.shareNotFound();

    // 原版 `EditShare` 走的是同一个 `Upsert(c, existedID)`（`share/manage.go:63-100`），
    // 也就是说编辑和创建共用全部前置校验：按 `params.uri` 重新解析源文件 → 校验属主 →
    // 再确认待编辑的分享指的就是这个文件（`operation.go:311-313`）。
    if (!params.uri) throw Err.param('uri is required');
    const file = await this.fs.resolve(URI.parse(params.uri));
    if (!file || this.fs.isRootFolder(file)) {
      throw new AppError(CodeNotFound, 'src file not found');
    }
    if (file.owner_id !== user.id) {
      throw new AppError(CodeNoPermissionErr, 'permission denied');
    }
    if (file.is_symbolic) {
      throw new AppError(CodeNoPermissionErr, 'cannot share symbolic file');
    }
    if (share.file_shares !== file.id) {
      throw new AppError(CodeNotFound, 'share link not found');
    }

    let password = params.password?.trim() || null;
    if (password && !/^[a-zA-Z0-9]{1,32}$/.test(password)) {
      throw Err.param('Password must be alphanumeric and at most 32 characters');
    }
    if (params.is_private && !password) {
      password = randomString(8).toLowerCase();
    }

    const expire = Number(params.expire ?? 0);
    const expires = expire > 0 ? new Date(Date.now() + expire * 1000) : null;
    const remainDownloads =
      params.downloads && params.downloads > 0 ? Number(params.downloads) : null;

    await this.ctx.shares.update(shareId, {
      password,
      expires,
      remainDownloads,
      props: {
        share_view: params.share_view === true,
        show_read_me: params.show_readme === true,
      },
    });

    logAudit(this.ctx, 'edit_share', user.id, { share_id: shareId });
    return this.shareUrl(shareId, password);
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  async info(shareHashId: string, options: ShareInfoOptions = {}): Promise<ShareResponse> {
    const shareId = this.ctx.codec.decodeShareID(shareHashId);
    if (shareId === null) throw Err.shareNotFound();
    const share = await this.ctx.shares.byId(shareId);
    if (!share) throw Err.shareNotFound();

    const file = share.file_shares ? await this.ctx.files.byId(share.file_shares) : null;
    if (!file) throw Err.shareNotFound();

    // 原版 `ShareInfoService.Get` 在解锁之前先跑一遍 `IsValidShare`，
    // 失败一律按 404 + "Share link expired" 返回（不区分具体原因，避免探测）。
    // 上游 PR #3524：属主当前所属组失去 Share 权限位时同样判失效。
    const owner = share.user_shares ? await this.ctx.users.byId(share.user_shares) : null;
    const ownerGroup = owner?.group_users ? await this.ctx.groups.byId(owner.group_users) : null;
    if (isShareInvalid(share, file, owner, ownerGroup)) {
      throw new AppError(CodeNotFound, 'Share link expired');
    }

    const requester = this.ctx.user;
    const isOwner = requester?.id === share.user_shares;

    // 密码校验：所有者不受限；其余人必须密码正确
    const unlocked =
      !share.password || isOwner || (options.password ?? '') === share.password;

    if (options.countViews && !isOwner) {
      await this.ctx.shares.incrementViews(shareId);
      logAudit(this.ctx, 'share_link_viewed', share.user_shares ?? null, { share_id: shareId, viewer: requester?.id ?? null });
    }

    // 原版 visit 路径直接传 `share.Edges.File.Name`（不回落 restore_uri），
    // 且 expired 传 false —— 有效期已在上面校验过。
    return this.buildShareResponse(
      share,
      file.name,
      file.size,
      file.type,
      unlocked,
      isOwner,
      false,
      true,
      share.user_shares,
    );
  }

  /**
   * 列出分享。对应原版 `share.VisitShareService.ListShares` 与
   * `ListShareService.ListInUserProfile` 两个入口 —— 它们的差别只有
   * `unlocked` / `isOwner` 两个开关：
   *   - 自己的分享（`GET /share`）：`asOwner=true` → unlocked、isOwner 均为 true；
   *   - 他人主页（`GET /user/shares/:id`）：`asOwner=false`，且按对方的
   *     `share_links_in_profile` 决定是否只列公开分享（`publicOnly`）。
   */
  async list(params: {
    ownerId: number;
    page: number;
    pageSize: number;
    orderBy: string;
    orderDirection: string;
    asOwner: boolean;
    publicOnly?: boolean;
  }): Promise<{ shares: ShareResponse[]; pagination: { page: number; page_size: number; total_items: number } }> {
    const { shares, total } = await this.ctx.shares.listByUser({
      userId: params.ownerId,
      page: params.page,
      pageSize: params.pageSize,
      orderBy: params.orderBy,
      orderDirection: params.orderDirection,
      publicOnly: params.publicOnly,
    });

    const out: ShareResponse[] = [];
    for (const share of shares) {
      const file = share.file_shares ? await this.ctx.files.byId(share.file_shares) : null;
      if (!file) continue;

      // 原版在列表里对回收站中的文件回落到 metadata 里的原始名字
      const shareName = await this.shareDisplayName(file);
      const owner = share.user_shares ? await this.ctx.users.byId(share.user_shares) : null;
      const invalid = await this.isShareInvalidListed(share, file, owner);

      out.push(
        await this.buildShareResponse(
          share,
          shareName,
          file.size,
          file.type,
          params.asOwner,
          params.asOwner,
          invalid,
          false,
          share.user_shares,
        ),
      );
    }

    return {
      shares: out,
      pagination: { page: params.page, page_size: params.pageSize, total_items: total },
    };
  }

  /**
   * 列表里的显示名：回收站中的文件 `files.name` 已被改成随机串，
   * 真实名字在 `sys:restore_uri` 元数据里（原版 `File.DisplayName()`）。
   */
  private async shareDisplayName(file: FileRow): Promise<string> {
    if (file.file_children !== null) return file.name;
    const rows = await this.ctx.metadata.listByFile(file.id, true);
    const restore = rows.find((m) => m.name === MetadataRestoreUri);
    if (!restore) return file.name;
    const uri = URI.tryParse(restore.value);
    if (!uri) return file.name;
    return uri.name || file.name;
  }

  /**
   * 构造分享响应。字段可见性完全照抄原版 `explorer.BuildShare`：
   *   - `name` / `created_at` / `source_type` / `size` 恒返回（`size` 未解锁时为 0）；
   *   - 已解锁时才给 `remain_downloads` / `downloaded` / `expires` / `password` /
   *     `show_readme`，且 `size` 只对**文件**类型赋值；
   *   - `is_private` / `share_view` 仅所有者可见，`source_uri` 仅所有者且显式要求时可见。
   */
  private async buildShareResponse(
    share: ShareRow,
    fileName: string,
    fileSize: number,
    fileType: number,
    unlocked: boolean,
    isOwner: boolean,
    expired: boolean,
    includeSource: boolean,
    ownerId: number | null,
  ): Promise<ShareResponse> {
    const owner = ownerId ? await this.ctx.users.byId(ownerId) : null;

    const res: ShareResponse = {
      id: this.ctx.codec.encodeShareID(share.id),
      name: fileName,
      visited: share.views,
      unlocked,
      expired: isShareExpired(share) || expired,
      url: this.shareUrl(share.id, isOwner ? share.password : undefined),
      owner: this.buildOwner(owner),
      created_at: share.created_at.toISOString(),
      source_type: fileType,
      size: 0,
    };

    if (ownerId) res.owner.id = this.ctx.codec.encodeUserID(ownerId);

    if (share.password) {
      res.password_protected = true;
    }

    if (unlocked) {
      res.remain_downloads = share.remain_downloads ?? undefined;
      res.downloaded = share.downloads;
      res.expires = share.expires ? share.expires.toISOString() : undefined;
      res.password = share.password ?? undefined;
      res.show_readme = share.props?.show_read_me === true;
      // 原版只在文件类型（非目录）下赋值 size
      if (fileType === FileType.File) {
        res.size = fileSize;
      }
    }

    if (isOwner) {
      res.is_private = Boolean(share.password);
      res.share_view = share.props?.share_view === true;
      if (includeSource && share.file_shares) {
        const file = await this.ctx.files.byId(share.file_shares);
        if (file) {
          // 对齐原版 `ShareInfoService.Get` 的 owner_extended 分支（service/share/visit.go:96-114）：
          // source 取自「分享导航器解析结果的 owner 视图 URI」。单文件分享时分享导航器
          // 的根是其**父目录**（share_navigator.go:143-146），前端编辑分享会用
          // `source_uri.join(share.name)` 拼回文件本身（thunks/share.ts:220-221）；
          // 目录分享则是目录自身。若这里返回文件自身路径，前端会拼出
          // `cloudreve://my/a.txt/a.txt`，编辑弹窗必报「文件不存在」。
          if (fileType === FileType.File) {
            if (!file.file_children) {
              // 回收站中的单文件：原版在分享导航器 Root 处直接报 File not found
              throw new AppError(CodeNotFound, 'File not found');
            }
            const parent = await this.ctx.files.byId(file.file_children);
            const parentPath =
              parent && !this.fs.isRootFolder(parent) ? await this.fs.pathOf(parent) : '/';
            res.source_uri = URI.my(parentPath).toString();
          } else {
            const path = await this.fs.pathOf(file);
            res.source_uri = URI.my(path).toString();
          }
        }
      }
    }

    return res;
  }

  /**
   * 列表接口用它来置 `expired` 标记（原版 `BuildListShareResponse` 里
   * `expired := inventory.IsValidShare(share) != nil`）。列表本身不过滤。
   * 判定规则见 `share-rules.ts`。
   */
  private async isShareInvalidListed(
    share: ShareRow,
    file: FileRow | null,
    owner: UserRow | null,
  ): Promise<boolean> {
    const ownerGroup = owner?.group_users ? await this.ctx.groups.byId(owner.group_users) : null;
    return isShareInvalid(share, file, owner, ownerGroup);
  }

  private buildOwner(owner: UserRow | null): ShareResponse['owner'] {
    if (!owner) {
      return { id: '', nickname: '', created_at: new Date().toISOString(), anonymous: true };
    }
    return {
      id: this.ctx.codec.encodeUserID(owner.id),
      nickname: owner.nick,
      created_at: owner.created_at.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // 删除
  // -------------------------------------------------------------------------

  async delete(shareHashId: string): Promise<void> {
    const user = this.ctx.requireUser();
    const shareId = this.ctx.codec.decodeShareID(shareHashId);
    if (shareId === null) throw Err.shareNotFound();
    const share = await this.ctx.shares.byId(shareId);
    if (!share) throw Err.shareNotFound();
    // 对齐原版 `DeleteShare`（`share/manage.go:102-126`）：管理员可删任意分享，
    // 其余人只能删自己的；不属于自己的分享走「查不到」分支 ——
    // 即 `CodeNotFound` + "share not found"，而不是 403（不泄露分享是否存在）。
    if (share.user_shares !== user.id && !this.ctx.isAdmin) {
      throw new AppError(CodeNotFound, 'share not found');
    }
    await this.ctx.shares.softDelete(shareId);
    logAudit(this.ctx, 'delete_share', user.id, { share_id: shareId });
  }

  async batchDelete(shareHashIds: string[]): Promise<void> {
    const user = this.ctx.requireUser();
    const ids: number[] = [];
    for (const h of shareHashIds) {
      const id = this.ctx.codec.decodeShareID(h);
      if (id !== null) ids.push(id);
    }
    await this.ctx.shares.softDeleteMany(ids, user.id);
  }

  // -------------------------------------------------------------------------
  // 访问与转存
  // -------------------------------------------------------------------------

  /**
   * 短链跳转目标。对应原版 `sharesvc.ShortLinkRedirectService.RedirectTo`：
   * 目标是 `/home?path=cloudreve://<hashid>[:<pwd>]@share`（`fs.NewShareUri` 的格式，
   * 注意 userinfo 段是 `<id>:<password>`，且 **share 后面不带斜杠**）。
   *
   * 短链上带的 query（V3 兼容的 `path` 等）要合并进去：`path` 是拼接到分享 URI
   * 内部的，其余原样透传。
   */
  shortLinkRedirect(shareHashId: string, password?: string, shortLinkQuery?: URLSearchParams): string {
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const hash = encodeURIComponent(shareHashId);
    let shareUri = password ? `cloudreve://${hash}:${password}@share` : `cloudreve://${hash}@share`;

    const query = new URLSearchParams(shortLinkQuery ?? undefined);
    const userPath = query.get('path');
    if (userPath) {
      shareUri += `/${userPath.replace(/^\/+/, '')}`;
      query.delete('path');
    }

    const params = new URLSearchParams();
    params.set('path', shareUri);
    for (const [k, v] of query) params.append(k, v);

    return `${base}/home?${params.toString()}`;
  }

  /**
   * 校验分享可用性，返回分享对应的源文件。规则与 `fs.resolveShare`
   * （share navigator）完全一致，见 `share-rules.ts`。
   */
  async resolveShareSource(
    shareHashId: string,
    password?: string,
  ): Promise<{ share: ShareRow; file: FileRow }> {
    const shareId = this.ctx.codec.decodeShareID(shareHashId);
    if (shareId === null) throw Err.shareNotFound();
    const share = await this.ctx.shares.byId(shareId);
    if (!share) throw Err.shareNotFound();

    const owner = share.user_shares ? await this.ctx.users.byId(share.user_shares) : null;
    const file = share.file_shares ? await this.ctx.files.byId(share.file_shares) : null;
    const ownerGroup = owner?.group_users ? await this.ctx.groups.byId(owner.group_users) : null;
    if (isShareInvalid(share, file, owner, ownerGroup)) throw Err.shareNotFound();

    const isOwner = this.ctx.user !== undefined && this.ctx.user.id === share.user_shares;
    if (share.password && !isOwner && (password ?? '') !== share.password) {
      throw new AppError(CodeIncorrectPassword, 'Incorrect share password');
    }

    return { share, file: file! };
  }

  /**
   * 转存：把分享内容复制到自己的网盘。
   *
   * 原版**没有独立的转存端点**，前端是调用 `POST /api/v4/file/create` 并在
   * metadata 里带 `sys:shared_redirect` 建符号文件。这里额外提供一个显式实现，
   * 供不喜欢符号链接语义的客户端使用（见 README「新增端点」）。
   */
  async saveToMyFiles(shareHashId: string, password: string, dstUri: string): Promise<void> {
    const user = this.ctx.requireUser();
    const { share, file } = await this.resolveShareSource(shareHashId, password);

    if (file!.owner_id === user.id) {
      throw new AppError(CodeSaveOwnShare, 'Cannot save your own share');
    }

    const dst = URI.parse(dstUri);
    if (dst.fsType !== FileSystemType.My) {
      throw new AppError(CodeGroupNotAllowed, 'Destination must be your own file system');
    }
    const dstFolder = await this.fs.mustResolve(dst);
    if (dstFolder.type !== FileType.Folder) {
      throw Err.param('Destination is not a folder');
    }

    const conflict = await this.ctx.files.childByName(dstFolder.id, file!.name);
    if (conflict) throw Err.objectExist();

    // 实体引用 +1，不产生新的物理对象（与原版复制语义一致）
    const cloned = await this.ctx.files.create({
      type: file!.type,
      name: file!.name,
      ownerId: user.id,
      parentId: dstFolder.id,
      size: file!.size,
      policyId: file!.storage_policy_files,
      props: file!.props ?? {},
    });

    if (file!.type === FileType.File && file!.primary_entity) {
      const entities = await this.ctx.entities.listByFile(file!.id);
      for (const e of entities) {
        await this.ctx.entities.retain([e.id]);
        await this.ctx.entities.linkFile(cloned.id, e.id);
      }
      await this.ctx.files.updatePrimaryEntity(cloned.id, file!.primary_entity);
    }

    // 转存计入下载量
    await this.ctx.shares.incrementDownloads(share.id, 0);
  }
}
