/**
 * 文件系统服务。对应 Cloudreve v4 的 `pkg/filemanager/fs/dbfs/` 一族 navigator，
 * 但把 `my` / `trash` / `share` / `shared_with_me` 四种文件系统合并到一个实现里。
 *
 * 数据模型要点（回源码确认过）：
 *   - 根目录：`name = ''` 且 `file_children IS NULL`
 *   - 回收站项：`file_children IS NULL` 且 `name <> ''`
 *     （删除 = 把父指针置空但保留名字；恢复 = 把父指针指回去）
 *   - 目录内容：`file_children = 父 id`
 */
import { AppContext } from './context';
import { SearchService } from './search';
import { FileSystemType, URI, validateName } from './uri';
import type { ExplorerView, FileRow, MetadataRow, StoragePolicyRow } from '../db/types';
import { BooleanSet, EntityType, FileType, GroupPermission } from '../lib/boolset';
import {
  AppError,
  CodeAnonymouseAccessDenied,
  CodeEntityNotExist,
  CodeFileCountLimitedReached,
  CodeFileNotFound,
  CodeGroupNotAllowed,
  CodeIllegalObjectName,
  CodeIncorrectPassword,
  CodeNoPermissionErr,
  CodeObjectExist,
  CodeOwnerOnly,
  CodeParentNotExist,
  CodePolicyNotAllowed,
  CodeRootProtected,
  CodeSaveOwnShare,
  Err,
} from '../lib/errors';
import { whitelist } from '../db/repo';
import {
  MetadataExpectedCollectTime,
  MetadataRestoreUri,
  MetadataSharedRedirect,
  MetadataUploadSessionID,
} from '../lib/sysmeta';
import { isShareInvalid } from './share-rules';

// ---------------------------------------------------------------------------
// 响应结构。字段与 json tag 取自 `service/explorer/response.go`。
// ---------------------------------------------------------------------------

export interface FileResponse {
  type: number;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  size: number;
  metadata: Record<string, string>;
  path?: string;
  shared?: boolean;
  capability?: string;
  owned?: boolean;
  primary_entity?: string;
  folder_summary?: FolderSummary;
  extended_info?: ExtendedInfo;
}

export interface FolderSummary {
  size: number;
  files: number;
  folders: number;
  completed: boolean;
  calculated_at: string;
}

export interface DirectLinkInfo {
  id: string;
  url: string;
  downloaded: number;
  created_at: string;
}

export interface StoragePolicyInfo {
  id: string;
  name: string;
  type: string;
  max_size: number;
  relay?: boolean;
  chunk_concurrency?: number;
  encryption?: boolean;
}

export interface EntityInfo {
  id: string;
  size: number;
  type: number;
  created_at: string;
  /** 该实体所在的存储策略（原版 `BuildEntity` 恒带此字段）。 */
  storage_policy?: StoragePolicyInfo;
}

export interface ExtendedInfo {
  storage_policy?: StoragePolicyInfo;
  storage_used: number;
  entities?: EntityInfo[];
  view?: ExplorerView;
  direct_links?: DirectLinkInfo[];
}

export interface PaginationResults {
  page: number;
  page_size: number;
  total_items?: number;
  next_token?: string;
  is_cursor?: boolean;
}

export interface NavigatorProps {
  capability: string;
  max_page_size: number;
  order_by_options: string[];
  order_direction_options: string[];
}

export interface ListResponse {
  files: FileResponse[];
  parent?: FileResponse;
  pagination: PaginationResults;
  props: NavigatorProps;
  mixed_type: boolean;
  recursion_limit_reached?: boolean;
}

export interface BuildFileOptions {
  /** 附带扩展信息（存储策略、实体、直链等），仅单个文件详情时用 */
  extended?: boolean;
  /** 附带文件夹摘要（会做一次递归统计，列表接口不要开） */
  folderSummary?: boolean;
  /** 是否已被分享 */
  shared?: boolean;
  /** 当前访问者是否拥有该文件 */
  owned?: boolean;
  /**
   * 该文件在**调用方视角**下的 URI，用于填充响应里的 `path`。
   * 分享 / 指定所有者的 my 空间必须传，否则会退化成 `cloudreve://my/...`，
   * 前端后续请求就会打到自己的空间里去。
   */
  uri?: URI;
  /**
   * 覆盖响应里的 `name`。只有回收站场景会用到：那里的 `files.name` 是随机串，
   * 显示名要取 `sys:restore_uri` 的最后一段（原版 `File.DisplayName()`）。
   */
  displayName?: string;
}

const ORDER_BY_OPTIONS = ['name', 'size', 'updated_at', 'created_at'];
const ORDER_DIRECTION_OPTIONS = ['asc', 'desc'];

// ---------------------------------------------------------------------------
// 系统元数据键（回收站的 restore_uri 等）统一放在 lib/sysmeta.ts，
// 这里既本地引用、也重新导出，方便调用方就近取。
// ---------------------------------------------------------------------------

export {
  MetadataSysPrefix,
  MetadataRestoreUri,
  MetadataExpectedCollectTime,
} from '../lib/sysmeta';

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class FileSystemService {
  constructor(private readonly ctx: AppContext) {}

  // -------------------------------------------------------------------------
  // 定位
  // -------------------------------------------------------------------------

  /**
   * 把 URI 解析成文件行。
   * 根目录返回根目录行；路径不存在返回 null。
   */
  async resolve(uri: URI): Promise<FileRow | null> {
    switch (uri.fsType) {
      case FileSystemType.My:
        return this.resolveMy(uri);
      case FileSystemType.Trash:
        return this.resolveTrash(uri);
      case FileSystemType.Share:
        return this.resolveShare(uri);
      case FileSystemType.SharedWithMe:
        return this.resolveSharedWithMe(uri);
      default:
        throw new AppError(CodeFileNotFound, `Unsupported file system: ${uri.fsType}`);
    }
  }

  /** 解析失败即抛 40044。 */
  async mustResolve(uri: URI): Promise<FileRow> {
    const file = await this.resolve(uri);
    if (!file) throw Err.fileNotFound();
    return file;
  }

  private async resolveMy(uri: URI): Promise<FileRow | null> {
    const user = this.ctx.requireUser();
    // 支持 `cloudreve://<userHashid>@my/...` 指定所有者，但**只允许自己**。
    // 原版 my_navigator.go:85 —— `if fsUid != n.user.ID { return ErrPermissionDenied }`，
    // 管理员也没有后门，这里保持一致。
    let ownerId = user.id;
    if (uri.id) {
      const decoded = this.ctx.codec.decodeUserID(uri.id);
      if (decoded === null) throw Err.fileNotFound();
      if (decoded !== user.id) {
        throw new AppError(CodeNoPermissionErr, 'Permission denied');
      }
      ownerId = decoded;
    }
    const root = await this.ctx.files.ensureRoot(ownerId);
    return this.walk(root, uri.elements);
  }

  private async resolveTrash(uri: URI): Promise<FileRow | null> {
    const user = this.ctx.requireUser();
    const elements = uri.elements;
    if (elements.length === 0) return null; // 回收站没有根节点
    if (elements.length > 1) {
      throw new AppError(CodeFileNotFound, `Invalid path ${uri.path}`);
    }
    const name = elements[0]!;
    const rows = await this.ctx.files.list({
      parentId: null,
      ownerId: user.id,
      trash: true,
      page: 0,
      pageSize: 1000,
      orderBy: 'name',
      orderDirection: 'asc',
      nameKeyword: name,
    });
    return rows.files.find((f) => f.name === name) ?? null;
  }

  /**
   * 分享空间的定位。校验顺序严格照抄原版 `share_navigator.go` 的 `Root()`：
   *   1. 解 hashid 取分享，取不到 → shareNotFound；
   *   2. `IsValidShare`：过期 / 分享者非 active / 源文件已删（回收站或根）→ shareNotFound；
   *   3. 密码：`share.password != "" && share.password != uri.password` 且非本人 → 40069；
   *   4. 非本人访问需要 `GroupPermissionShareDownload`，匿名则报 40088。
   */
  private async resolveShare(uri: URI): Promise<FileRow | null> {
    if (!uri.id) throw Err.shareNotFound();
    const shareId = this.ctx.codec.decodeShareID(uri.id);
    if (shareId === null) throw Err.shareNotFound();
    const share = await this.ctx.shares.byId(shareId);
    if (!share) throw Err.shareNotFound();

    const owner = share.user_shares ? await this.ctx.users.byId(share.user_shares) : null;
    const root = share.file_shares ? await this.ctx.files.byId(share.file_shares) : null;
    // 上游 PR #3524：属主当前所属组失去 Share 权限位时分享失效
    const ownerGroup = owner?.group_users ? await this.ctx.groups.byId(owner.group_users) : null;
    if (isShareInvalid(share, root, owner, ownerGroup)) throw Err.shareNotFound();

    const viewer = this.ctx.user;
    const isOwner = viewer !== undefined && viewer.id === share.user_shares;

    // 密码校验：所有者不受限（原版 share_navigator.go:130-132）
    if (share.password && !isOwner && (uri.password || '') !== share.password) {
      throw new AppError(CodeIncorrectPassword, 'Incorrect share password');
    }

    // 非本人访问需要「分享下载」权限（原版 share_navigator.go:159-173）
    if (!isOwner) {
      const perms = await this.ctx.viewerPermissions();
      if (!perms.enabled(GroupPermission.ShareDownload)) {
        if (this.ctx.isAnonymous) {
          throw new AppError(
            CodeAnonymouseAccessDenied,
            "You don't have permission to access share links",
          );
        }
        throw new AppError(
          CodeNoPermissionErr,
          "You don't have permission to access share links",
        );
      }
    }

    return this.walk(root!, uri.elements);
  }

  /**
   * 「分享给我」。原版 `sharewithme_navigator.go:58-86`：
   *   - 匿名 → 401；
   *   - **只允许访问根**（`cloudreve://shared_with_me`），任何子路径都报路径不存在 ——
   *     它是一棵扁平树，子项的 URI 只是给前端展示用的（`newSharedWithMeUri(fileHashid)`）。
   */
  private async resolveSharedWithMe(uri: URI): Promise<FileRow | null> {
    const user = this.ctx.requireUser();
    if (uri.elements.length > 0) {
      throw new AppError(CodeFileNotFound, `Invalid path ${uri.path}`);
    }
    return this.ctx.files.ensureRoot(user.id);
  }

  /**
   * 沿路径分段逐级向下。
   *
   * 进入下一级之前先看当前节点是不是符号目录 —— 是就直接 403
   * （原版 `baseNavigator.walkNext` 的 `root.IsSymbolic()` 检查，navigator.go:179-183）。
   * 注意检查点在**取子节点之前**：`cloudreve://my/sym` 这种「目标自身就是符号目录」
   * 的解析是允许的，只有继续往下钻才被拒。
   */
  private async walk(start: FileRow, elements: string[]): Promise<FileRow | null> {
    let current = start;
    for (const el of elements) {
      if (current.is_symbolic) throw Err.symbolicFolder();
      const next = await this.ctx.files.childByName(current.id, el);
      if (!next) return null;
      current = next;
    }
    return current;
  }

  /** 取文件在「用户视角」下的完整路径。 */
  async pathOf(file: FileRow): Promise<string> {
    const segments: string[] = [];
    let current: FileRow | null = file;
    let guard = 0;
    while (current && guard++ < 256) {
      if (current.file_children === null) break; // 根目录或回收站项
      segments.unshift(current.name);
      current = await this.ctx.files.byId(current.file_children);
    }
    return segments.length === 0 ? '/' : `/${segments.join('/')}`;
  }

  /** 判断是否根目录。 */
  isRootFolder(file: FileRow): boolean {
    return file.file_children === null && file.name === '';
  }

  /** 判断是否在回收站里。 */
  isInTrash(file: FileRow): boolean {
    return file.file_children === null && file.name !== '';
  }

  /**
   * 显示名。对应原版 `dbfs.File.DisplayName()`：回收站项的 `files.name` 已被改成
   * 随机串，真实名字取自 `sys:restore_uri` 元数据的最后一段；缺这条元数据时退回
   * `files.name`（原版同样如此）。
   */
  displayNameOf(file: FileRow, meta?: MetadataRow[]): string {
    const mark = meta?.find((m) => m.name === MetadataRestoreUri);
    if (!mark) return file.name;
    const uri = URI.tryParse(mark.value);
    return uri?.name || file.name;
  }

  /** 文件的父目录行。根目录返回 null。 */
  async parentOf(file: FileRow): Promise<FileRow | null> {
    if (file.file_children === null) return null;
    return this.ctx.files.byId(file.file_children);
  }

  // -------------------------------------------------------------------------
  // 响应构造
  // -------------------------------------------------------------------------

  async buildFileResponse(file: FileRow, options: BuildFileOptions = {}): Promise<FileResponse> {
    const user = this.ctx.user;
    const path = await this.pathOf(file);
    // 用户视角的 URI：
    //   - 回收站项固定是 `cloudreve://trash/<随机名>`（原版 trash_navigator.go:94-95）；
    //   - 其余情况以调用方给的 `options.uri` 为准 —— 分享空间下它是
    //     `cloudreve://<shareHashid>[:<pwd>]@share/<path>`（原版 share_navigator.go:148
    //     把 root 的 pathIndexUser 设成请求 URI 的 Root()，子节点在此基础上 Join）；
    //   - 没给 uri 时回落到 `cloudreve://my/<path>`。
    const userViewUri = this.isInTrash(file)
      ? URI.trash(file.name)
      : options.uri ?? URI.my(path);

    const res: FileResponse = {
      type: file.type,
      id: this.ctx.codec.encodeFileID(file.id),
      name: options.displayName ?? file.name,
      created_at: file.created_at.toISOString(),
      updated_at: file.updated_at.toISOString(),
      size: Number(file.size),
      metadata: {},
    };

    if (!this.isRootFolder(file)) {
      res.path = userViewUri.toString();
    }

    if (options.owned !== undefined) {
      res.owned = options.owned;
    } else {
      res.owned = user !== undefined && file.owner_id === user.id;
    }

    if (options.shared) {
      res.shared = true;
    }

    if (file.primary_entity && file.type === FileType.File) {
      res.primary_entity = this.ctx.codec.encodeEntityID(file.primary_entity);
    }

    // 目录自定义视图（`props.view`）只在 `extended_info` 里下发，与列表响应一致；
    // 列表接口不额外带，避免每条记录都塞一份。

    if (options.folderSummary && file.type === FileType.Folder) {
      const summary = await this.ctx.files.folderSummary(file.id);
      res.folder_summary = {
        size: summary.size,
        files: summary.files,
        folders: summary.folders,
        completed: true,
        calculated_at: new Date().toISOString(),
      };
    }

    if (options.extended) {
      res.extended_info = await this.buildExtendedInfo(file);
    }

    return res;
  }

  /**
   * 构造 `extended_info`。字段与可见性对齐原版 `dbfs/dbfs.go:413-437` 的
   * `LoadFileExtendedInfo` 分支：
   *   - `storage_used` = 该文件**所有实体**的大小之和（`File.SizeUsed()`）；
   *   - `direct_links` **仅属主**可见（原版 `if f.user.ID == target.OwnerID()`）；
   *   - `view` 属主或管理员可见，取自 `files.props.view`；
   *   - 每个实体附带它所在的存储策略。
   */
  private async buildExtendedInfo(file: FileRow): Promise<ExtendedInfo> {
    const requester = this.ctx.user;
    const isOwner = requester !== undefined && file.owner_id === requester.id;
    const canSeeOwnerOnly = isOwner || this.ctx.isAdmin;

    const info: ExtendedInfo = { storage_used: 0 };

    const policyId = file.storage_policy_files;
    if (policyId) {
      const policy = await this.ctx.policies.byId(policyId);
      if (policy) {
        info.storage_policy = this.buildPolicyInfo(policy);
      }
    }

    if (file.type === FileType.File) {
      const entities = await this.ctx.entities.listByFile(file.id);
      info.storage_used = entities.reduce((sum, e) => sum + Number(e.size), 0);

      const entityInfos: EntityInfo[] = [];
      for (const e of entities) {
        const entityInfo: EntityInfo = {
          id: this.ctx.codec.encodeEntityID(e.id),
          size: Number(e.size),
          type: e.type,
          created_at: e.created_at.toISOString(),
        };
        const entityPolicy = await this.ctx.policies.byId(e.storage_policy_entities);
        if (entityPolicy) entityInfo.storage_policy = this.buildPolicyInfo(entityPolicy);
        entityInfos.push(entityInfo);
      }
      info.entities = entityInfos;
    }

    if (canSeeOwnerOnly && file.props?.view) {
      info.view = file.props.view;
    }

    if (isOwner) {
      const links = await this.ctx.directLinks.listByFile(file.id);
      if (links.length > 0) {
        const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
        info.direct_links = links.map((l) => ({
          id: this.ctx.codec.encodeSourceLinkID(l.id),
          url: `${base}/f/${this.ctx.codec.encodeSourceLinkID(l.id)}/${encodeURIComponent(l.name)}`,
          downloaded: l.downloads,
          created_at: l.created_at.toISOString(),
        }));
      }
    }

    return info;
  }

  buildPolicyInfo(policy: StoragePolicyRow): StoragePolicyInfo {
    return {
      id: this.ctx.codec.encodePolicyID(policy.id),
      name: policy.name,
      type: policy.type,
      max_size: Number(policy.max_size ?? 0),
      relay: policy.settings?.relay,
      chunk_concurrency: policy.settings?.chunk_concurrency,
      encryption: policy.settings?.encryption,
    };
  }

  /** 批量读取元数据，避免逐个文件查询。 */
  private async loadMetadata(files: FileRow[], includePrivate: boolean): Promise<Map<number, MetadataRow[]>> {
    const ids = files.map((f) => f.id);
    const rows = await this.ctx.metadata.listByFiles(ids, includePrivate);
    const map = new Map<number, MetadataRow[]>();
    for (const r of rows) {
      const list = map.get(r.file_id) ?? [];
      list.push(r);
      map.set(r.file_id, list);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  async list(
    uri: URI,
    params: {
      page: number;
      pageSize: number;
      orderBy: string;
      orderDirection: string;
      typeFilter?: number | null;
    },
  ): Promise<ListResponse> {
    // 这里**不能**直接用 requireUser()：匿名访问分享是合法路径（原版靠匿名用户组放行）。
    // my / trash 的登录要求由 resolveMy / resolveTrash 内部保证。
    const viewer = this.ctx.user;
    const dir = await this.resolve(uri);

    const isTrashRoot = uri.fsType === FileSystemType.Trash && uri.elements.length === 0;
    // 目录不存在时，如果目标是根目录就按空目录处理（首次登录还没建根）
    if (!dir && !(uri.fsType === FileSystemType.My && uri.isRoot) && !isTrashRoot) {
      throw Err.fileNotFound();
    }

    // 符号目录的内容在另一个文件系统里，不允许直接列（原版 navigator.go:241-243）
    if (dir?.is_symbolic) throw Err.symbolicFolder();

    const pageSize = Math.min(
      params.pageSize > 0 ? params.pageSize : 100,
      this.ctx.settings.maxPageSize,
    );

    const ownerId =
      uri.fsType === FileSystemType.My || uri.fsType === FileSystemType.Trash
        ? this.ctx.requireUser().id
        : dir
          ? dir.owner_id
          : null;

    const { files, total } = await this.ctx.files.list({
      parentId: dir ? dir.id : null,
      ownerId,
      trash: isTrashRoot,
      // 「分享给我」是一棵扁平树，不走 parentId 过滤
      sharedWithMe: uri.fsType === FileSystemType.SharedWithMe,
      page: params.page,
      pageSize,
      orderBy: whitelist(params.orderBy, ORDER_BY_OPTIONS, 'name'),
      orderDirection: whitelist(params.orderDirection, ORDER_DIRECTION_OPTIONS, 'asc'),
      typeFilter: params.typeFilter ?? null,
    });

    const metadataMap = await this.loadMetadata(files, uri.fsType === FileSystemType.My);
    const sharedIds = await this.ctx.shares.sharedFileIds(files.map((f) => f.id));

    const fileResponses: FileResponse[] = [];
    for (const f of files) {
      const meta = metadataMap.get(f.id);
      const res = await this.buildFileResponse(f, {
        shared: sharedIds.has(f.id),
        owned: viewer !== undefined && f.owner_id === viewer.id,
        // 子节点在调用方视角下的 URI —— 分享空间下要带上 share hashid 与密码
        uri: this.childUri(uri, f),
        // 回收站里的 name 是随机串，显示名要回落到 sys:restore_uri 的最后一段
        displayName: isTrashRoot ? this.displayNameOf(f, meta) : undefined,
      });
      if (meta) {
        for (const m of meta) res.metadata[m.name] = m.value;
      }
      fileResponses.push(res);
    }

    const response: ListResponse = {
      files: fileResponses,
      pagination: {
        page: params.page,
        page_size: pageSize,
        total_items: total,
      },
      props: {
        capability: this.navigatorCapability(uri).toBase64(),
        max_page_size: this.ctx.settings.maxPageSize,
        order_by_options: ORDER_BY_OPTIONS,
        order_direction_options: ORDER_DIRECTION_OPTIONS,
      },
      mixed_type: params.typeFilter === null || params.typeFilter === undefined,
    };

    if (dir) {
      response.parent = await this.buildFileResponse(dir, {
        owned: viewer !== undefined && dir.owner_id === viewer.id,
        uri,
      });
    }

    return response;
  }

  /**
   * 子节点在**调用方视角**下的 URI。各文件系统的规则不一样（对照原版各家 navigator）：
   *   - my / share：父 URI 直接 Join 文件名（`share_navigator.go:148` 把 root 的
   *     user-view 设为请求 URI 的 Root()，子项在其上 Join）；
   *   - trash：`cloudreve://trash/<随机名>`（`trash_navigator.go:112`）；
   *   - shared_with_me：`cloudreve://shared_with_me/<fileHashid>`
   *     （`sharewithme_navigator.go:97`）—— 注意这只是展示用，该路径本身不可访问。
   */
  private childUri(uri: URI, file: FileRow): URI | undefined {
    switch (uri.fsType) {
      case FileSystemType.My:
      case FileSystemType.Share:
        return uri.child(file.name);
      case FileSystemType.Trash:
        return undefined; // buildFileResponse 内部走 URI.trash(file.name)
      case FileSystemType.SharedWithMe:
        return URI.sharedWithMeFile(this.ctx.codec.encodeFileID(file.id));
      default:
        return uri.child(file.name);
    }
  }

  /** 各文件系统暴露的能力位集（回收站与分享空间一律为空）。 */
  private navigatorCapability(uri: URI): BooleanSet {
    if (uri.fsType !== FileSystemType.My) return new BooleanSet();
    const perms = this.ctx.groupPermissions;
    const out = new BooleanSet();
    // 与原版 my navigator 上报的能力保持一致：分享 / 打包下载 / 高级删除
    for (const bit of [
      GroupPermission.Share,
      GroupPermission.ArchiveDownload,
      GroupPermission.AdvanceDelete,
    ]) {
      if (perms.enabled(bit)) out.set(bit, true);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 创建
  // -------------------------------------------------------------------------

  async create(
    uri: URI,
    type: 'file' | 'folder',
    options: { metadata?: Record<string, string>; errOnConflict?: boolean } = {},
  ): Promise<FileResponse> {
    const user = this.ctx.requireUser();
    if (uri.fsType !== FileSystemType.My) {
      throw new AppError(CodePolicyNotAllowed, 'Only personal file system supports creation');
    }

    const name = uri.elements.at(-1);
    if (!name) throw new AppError(CodeRootProtected, 'Cannot create at root');

    const nameError = validateName(name);
    if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

    const existing = await this.ctx.files.resolvePath(user.id, uri.elements);
    if (existing) {
      if (options.errOnConflict) throw Err.objectExist();
      return this.buildFileResponse(existing, { owned: true });
    }

    const parentUri = uri.parent();
    const parent = await this.ctx.files.resolvePath(user.id, parentUri.elements);
    if (!parent) throw new AppError(40016, 'Parent folder does not exist');
    if (parent.type !== FileType.Folder) {
      throw new AppError(40016, 'Parent is not a folder');
    }

    const policy = await this.ctx.resolvePolicy(null);

    // 「保存到我的网盘」的落点：前端用 `POST /file/create` 建一个目录，并在 metadata 里
    // 带 `sys:shared_redirect` 指向分享 URI；服务端据此把它标成**符号目录**
    // （原版 `manager.Create` 的 operation.go:116-135 → `dbfs.WithSymbolicLink()`）。
    // 符号目录本身不可遍历，前端读 metadata 里的那个键自己跳转到分享。
    const isSymbolic = Boolean(
      options.metadata && Object.prototype.hasOwnProperty.call(options.metadata, MetadataSharedRedirect),
    );

    const file = await this.ctx.files.create({
      type: type === 'folder' ? FileType.Folder : FileType.File,
      name,
      ownerId: user.id,
      parentId: parent.id,
      size: 0,
      policyId: policy.id,
      isSymbolic,
    });

    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        // 元数据键有长度上限（原版 MaxMetadataLen = 65535）
        if (k.length > 1024) continue;
        await this.ctx.metadata.upsert(file.id, k, v, false);
      }
    }

    return this.buildFileResponse(file, { owned: true });
  }

  // -------------------------------------------------------------------------
  // 重命名
  // -------------------------------------------------------------------------

  async rename(uri: URI, newName: string): Promise<FileResponse> {
    const user = this.ctx.requireUser();
    const file = await this.mustResolve(uri);
    if (this.isRootFolder(file)) throw new AppError(CodeRootProtected, 'Cannot rename root folder');
    this.assertOwner(file, user.id);

    const nameError = validateName(newName);
    if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

    // 目标目录下不能已有同名节点
    const sibling = await this.ctx.files.childByName(file.file_children, newName);
    if (sibling && sibling.id !== file.id) throw Err.objectExist();

    await this.ctx.files.rename(file.id, newName);
    const updated = await this.ctx.files.byId(file.id);

    // 同步全文索引里的文件名（失败不影响改名本身）
    if (updated && updated.primary_entity) {
      await new SearchService(this.ctx).rename(
        updated.id,
        updated.primary_entity,
        updated.name,
      );
    }
    return this.buildFileResponse(updated!, { owned: true });
  }

  // -------------------------------------------------------------------------
  // 移动 / 复制
  // -------------------------------------------------------------------------

  async moveOrCopy(uris: URI[], dstUri: URI, copy: boolean): Promise<void> {
    const user = this.ctx.requireUser();

    // 原版的约束（dbfs.canMoveOrCopyTo）：
    //   copy=true  仅允许 my → my
    //   copy=false 允许 my → my / my → trash / trash → my
    const dstFs = dstUri.fsType;
    if (copy) {
      if (dstFs !== FileSystemType.My) {
        throw new AppError(CodeGroupNotAllowed, 'Copy is only allowed within personal file system');
      }
    } else {
      const allowed =
        (dstFs === FileSystemType.My || dstFs === FileSystemType.Trash);
      if (!allowed) {
        throw new AppError(CodeGroupNotAllowed, 'Move is not allowed to this location');
      }
    }

    const dstFolder = dstFs === FileSystemType.Trash ? null : await this.mustResolve(dstUri);
    if (dstFolder && dstFolder.type !== FileType.Folder) {
      throw new AppError(CodeObjectExist, 'Destination is not a folder');
    }

    for (const uri of uris) {
      const src = await this.mustResolve(uri);
      if (this.isRootFolder(src)) throw new AppError(CodeRootProtected, 'Cannot move root folder');
      this.assertOwner(src, user.id);

      const nameError = validateName(src.name);
      if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

      if (copy) {
        // files 表有 (file_children, name) 唯一索引，不预检同名会把原始
        // DB 冲突裸抛成 500（move 分支同样道理，见下方 conflict 检查）
        const conflict = await this.ctx.files.childByName(dstFolder!.id, src.name);
        if (conflict) throw Err.objectExist();
        await this.copyRecursive(src, dstFolder!.id, user.id);
      } else if (dstFs === FileSystemType.Trash) {
        await this.softDeleteFile(src);
      } else {
        // 防止把目录移动到自己内部
        if (dstFolder && (await this.isDescendant(dstFolder.id, src.id))) {
          throw new AppError(CodeGroupNotAllowed, 'Cannot move a folder into itself');
        }
        const conflict = await this.ctx.files.childByName(dstFolder!.id, src.name);
        if (conflict) throw Err.objectExist();
        await this.ctx.files.updateParent(src.id, dstFolder!.id);
      }
    }
  }

  /** 目标是否是源的后代。 */
  private async isDescendant(candidateId: number, ancestorId: number): Promise<boolean> {
    let current: FileRow | null = await this.ctx.files.byId(candidateId);
    let guard = 0;
    while (current && current.file_children !== null && guard++ < 256) {
      if (current.file_children === ancestorId) return true;
      current = await this.ctx.files.byId(current.file_children);
    }
    return false;
  }

  /**
   * 递归复制。文件共享实体（引用计数 +1），目录递归下去。
   * 这与原版的行为一致：复制不产生新的物理对象，只增加实体引用。
   */
  private async copyRecursive(src: FileRow, dstParentId: number, ownerId: number): Promise<FileRow> {
    const policy = await this.ctx.resolvePolicy(src.storage_policy_files);
    const created = await this.ctx.files.create({
      type: src.type,
      name: src.name,
      ownerId,
      parentId: dstParentId,
      size: src.size,
      policyId: policy.id,
      primaryEntity: null,
      props: src.props ?? {},
    });

    if (src.type === FileType.File && src.primary_entity) {
      const entities = await this.ctx.entities.listByFile(src.id);
      for (const e of entities) {
        await this.ctx.entities.retain([e.id]);
        await this.ctx.entities.linkFile(created.id, e.id);
      }
      await this.ctx.files.updatePrimaryEntity(created.id, src.primary_entity);
    }

    if (src.type === FileType.Folder) {
      const children = await this.ctx.files.list({
        parentId: src.id,
        ownerId: null,
        page: 0,
        pageSize: 10000,
        orderBy: 'name',
        orderDirection: 'asc',
      });
      for (const child of children.files) {
        await this.copyRecursive(child, created.id, ownerId);
      }
    }

    return created;
  }

  // -------------------------------------------------------------------------
  // 删除 / 恢复 / 清空
  // -------------------------------------------------------------------------

  async delete(uris: URI[], options: { unlinkOnly?: boolean; skipSoftDelete?: boolean } = {}): Promise<void> {
    const user = this.ctx.requireUser();

    if (options.unlinkOnly) {
      this.ctx.requireGroupPermission(GroupPermission.AdvanceDelete, 'Advanced delete is not allowed');
    }

    const errors: string[] = [];

    for (const uri of uris) {
      try {
        const file = await this.mustResolve(uri);
        if (this.isRootFolder(file)) throw new AppError(CodeRootProtected, 'Cannot delete root folder');
        this.assertOwner(file, user.id);

        if (this.isInTrash(file)) {
          // 已在回收站中的再删一次 = 彻底删除
          await this.purge(file);
          continue;
        }

        if (options.skipSoftDelete) {
          await this.purge(file);
        } else {
          await this.softDeleteFile(file);
        }
      } catch (e) {
        errors.push(uri.toString());
        if (uris.length === 1) throw e;
      }
    }

    if (errors.length > 0 && errors.length === uris.length) {
      throw new AppError(40081, 'One or more operation failed');
    }
  }

  /**
   * 软删除到回收站。对应原版 `dbfs.SoftDelete`：
   *   1. 先把**当前完整路径**（含文件名）算出来，写进 `sys:restore_uri` 元数据；
   *      回收站列表里的显示名取自它的最后一段（`File.DisplayName()`），
   *      恢复时也靠它定位原目录。
   *   2. 按属主用户组的 `trash_retention`（秒）写 `sys:expected_collect_time`，
   *      供定时任务自动清理；未配置（0）则不写。
   *   3. 最后才改名并清空父指针 —— 顺序反了路径就算不出来了。
   *
   * 两个键都是**公开**元数据：原版 `UpsertMetadata` 的 privateMask 传 nil，
   * 于是 `is_public = true`，列表接口（只带公开元数据）才能读到。
   */
  private async softDeleteFile(file: FileRow): Promise<void> {
    const path = await this.pathOf(file);
    const restoreUri = URI.my(path).toString();

    await this.ctx.files.moveToTrash([file.id]);

    // 进回收站的文件不该再被搜到：从全文索引剔除，恢复时重建
    await new SearchService(this.ctx).deleteByFileIds([file.id]);

    await this.ctx.metadata.upsert(file.id, MetadataRestoreUri, restoreUri, true);

    const retention = this.ctx.user?.group.settings?.trash_retention ?? 0;
    if (retention > 0) {
      const collectAt = Math.floor(Date.now() / 1000) + retention;
      await this.ctx.metadata.upsert(
        file.id,
        MetadataExpectedCollectTime,
        String(collectAt),
        true,
      );
    }
  }

  /** 彻底删除：解除实体引用，引用归零的实体连同物理对象一起删掉。 */
  private async purge(file: FileRow): Promise<void> {
    const ids = await this.ctx.files.collectDescendants([file.id]);
    const entitiesToRelease: number[] = [];

    for (const id of ids) {
      const entities = await this.ctx.entities.listByFile(id);
      for (const e of entities) entitiesToRelease.push(e.id);
      await this.ctx.metadata.removeAllForFile(id);
    }

    const garbage = await this.ctx.entities.release(entitiesToRelease);

    // 删除物理对象，并按大小回冲用户容量
    for (const entity of garbage) {
      try {
        const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
        if (policy) {
          const driver = this.ctx.driverFor(policy);
          await driver.delete([entity.source]);
        }
      } catch {
        // 物理删除失败不回滚数据库，留待人工清理（原版同样容忍）
      }
      if (entity.created_by) {
        await this.ctx.users.addStorage(entity.created_by, -Number(entity.size));
      }
    }
    await this.ctx.entities.hardDelete(garbage.map((e) => e.id));
    await this.ctx.files.deleteMany(ids);

    // 彻底删除的文件从全文索引剔除
    await new SearchService(this.ctx).deleteByFileIds(ids);
  }

  // -------------------------------------------------------------------------
  // 版本管理。对应原版 `DBFS.VersionControl`（`dbfs/manage.go:415-478`），
  // 两个服务分别以 `delete=false` / `delete=true` 调用同一段逻辑。
  // -------------------------------------------------------------------------

  /**
   * 把文件的当前版本切换成指定的历史版本。
   * 对齐 `dbfs/manage.go:785-821` 的 `setCurrentVersion`。
   */
  async setCurrentVersion(uri: URI, versionId: number): Promise<void> {
    const file = await this.resolveVersionTarget(uri);
    if (file.primary_entity === versionId) return;

    // 原版要求：实体存在、类型为 version、且不是未完成上传的占位实体
    // （`upload_session_id == nil`），否则报 `fs.ErrEntityNotExist`。
    const entities = await this.ctx.entities.listByFile(file.id);
    const target = entities.find(
      (e) => e.id === versionId && e.type === EntityType.Version && e.upload_session_id === null,
    );
    if (!target) throw new AppError(CodeEntityNotExist, 'Entity not exist');

    await this.ctx.files.updatePrimaryEntity(file.id, versionId);
  }

  /**
   * 删除文件的某个历史版本。
   * 对齐 `dbfs/manage.go:757-783` 的 `deleteEntity`。原版这里只按 ID 找实体、
   * **不校验类型**，所以缩略图实体也能从这条路径删掉 —— 保持一致。
   */
  async deleteVersion(uri: URI, versionId: number): Promise<void> {
    const file = await this.resolveVersionTarget(uri);

    // 原版不允许删当前版本，报 `fs.ErrNotSupportedAction`（403 Not supported action）
    if (file.primary_entity === versionId) {
      throw new AppError(CodeNoPermissionErr, 'Not supported action');
    }

    const entities = await this.ctx.entities.listByFile(file.id);
    const target = entities.find((e) => e.id === versionId);
    if (!target) throw new AppError(CodeEntityNotExist, 'Entity not exist');

    await this.ctx.entities.unlinkFile(file.id, target.id);
    // 原版在实体仍是「未完成上传」状态时，会顺带清掉文件上的上传会话标记
    if (target.upload_session_id !== null) {
      await this.ctx.metadata.remove(file.id, MetadataUploadSessionID);
    }

    const garbage = await this.ctx.entities.release([target.id]);
    for (const entity of garbage) {
      try {
        const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
        if (policy) await this.ctx.driverFor(policy).delete([entity.source]);
      } catch {
        // 物理删除失败不回滚数据库（与原版一致，留待人工清理）
      }
      if (entity.created_by) {
        await this.ctx.users.addStorage(entity.created_by, -Number(entity.size));
      }
    }
    await this.ctx.entities.hardDelete(garbage.map((e) => e.id));
  }

  /**
   * 版本管理的目标解析与前置校验，对齐 `dbfs/manage.go:415-439`。
   *
   * 顺序与原版一致：**先查属主、再查类型**。属主判定放在这里（而不是复用
   * `assertOwner`）是因为原版此处没有管理员后门 —— `ByPassOwnerCheckCtxKey`
   * 只在内部调用链里注入，HTTP 路径永远拿不到它。
   */
  private async resolveVersionTarget(uri: URI): Promise<FileRow> {
    const user = this.ctx.requireUser();
    const file = await this.mustResolve(uri);

    if (file.owner_id !== user.id) {
      throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
    }
    if (file.type !== FileType.File) {
      throw new AppError(CodeNoPermissionErr, 'Not supported action');
    }
    return file;
  }

  async restore(uris: URI[]): Promise<void> {
    const user = this.ctx.requireUser();
    for (const uri of uris) {
      const file = await this.mustResolve(uri);
      if (!this.isInTrash(file)) {
        throw new AppError(CodeFileNotFound, 'File is not in trash bin');
      }
      this.assertOwner(file, user.id);

      // 原版要求必须带 sys:restore_uri 标记，否则拒绝恢复 —— 没有它就不知道该还原到哪
      const marks = await this.ctx.metadata.listByFile(file.id, false);
      const mark = marks.find((m) => m.name === MetadataRestoreUri);
      const original = mark ? URI.tryParse(mark.value) : null;
      if (!original) {
        throw new AppError(CodeNoPermissionErr, 'Not supported action');
      }

      // 目标目录 = 原路径的父目录。原目录也已被删的话，这里会解析不到。
      const dstDir = await this.resolve(original.parent());
      if (!dstDir) {
        throw new AppError(CodeParentNotExist, 'Path not exist');
      }

      // 回收站里 name 是随机串，恢复时还原成原始文件名
      const originalName = original.name;
      const conflict = await this.ctx.files.childByName(dstDir.id, originalName);
      if (conflict && conflict.id !== file.id) throw Err.objectExist();

      await this.ctx.files.rename(file.id, originalName);
      await this.ctx.files.updateParent(file.id, dstDir.id);
      await this.ctx.metadata.remove(file.id, MetadataRestoreUri);
      await this.ctx.metadata.remove(file.id, MetadataExpectedCollectTime);

      // 恢复后重建全文索引（软删时剔除过）
      const restored = await this.ctx.files.byId(file.id);
      if (restored) {
        await new SearchService(this.ctx).indexFile(restored).catch(() => undefined);
      }
    }
  }

  /** 清空回收站。 */
  async emptyTrash(): Promise<void> {
    const user = this.ctx.requireUser();
    const { files } = await this.ctx.files.list({
      parentId: null,
      ownerId: user.id,
      trash: true,
      page: 0,
      pageSize: 100000,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    for (const file of files) {
      await this.purge(file);
    }
  }

  /**
   * 回收站到期清理。原版由队列任务 `trash_collector` 定期跑；边缘版挂在
   * Worker 的 `scheduled()` 上。只处理 `sys:expected_collect_time` 已到的项，
   * 每轮上限 200 条，返回实际清理的数量。
   */
  async purgeExpiredTrash(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const expired = await this.ctx.files.listExpiredTrash(now);
    for (const file of expired) {
      await this.purge(file);
    }
    return expired.length;
  }

  /** 文件数上限校验（原版对单目录文件数有限制，这里按用户总量限制）。 */
  async assertFileCount(additional: number): Promise<void> {
    const limit = this.ctx.settings.getInt('max_file_count', 0);
    if (limit <= 0) return;
    const user = this.ctx.requireUser();
    const { total } = await this.ctx.files.list({
      parentId: null,
      ownerId: user.id,
      page: 0,
      pageSize: 1,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    if (total + additional > limit) {
      throw new AppError(CodeFileCountLimitedReached, 'File count limit reached');
    }
  }

  /** 容量校验。 */
  assertCapacity(size: number): void {
    this.ctx.assertCapacity(size);
  }

  /** 所有权校验：非本人所有则需要管理员/忽略归属权限。 */
  private assertOwner(file: FileRow, userId: number): void {
    if (file.owner_id === userId) return;
    if (this.ctx.isAdmin) return;
    if (this.ctx.groupPermissions.enabled(GroupPermission.IgnoreFileOwnership)) return;
    throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
  }

  /** 复制到自己的空间时禁止转存自己的分享（原版 CodeSaveOwnShare）。 */
  assertNotOwnShare(sourceOwnerId: number, userId: number): void {
    if (sourceOwnerId === userId) {
      throw new AppError(CodeSaveOwnShare, 'Cannot save your own share');
    }
  }
}

export { FileType, EntityType };
