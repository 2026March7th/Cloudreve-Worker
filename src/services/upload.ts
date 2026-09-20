/**
 * 上传服务。对应 Cloudreve v4 的 `service/explorer/upload.go` +
 * `pkg/filemanager/manager/upload.go`。
 *
 * 会话状态存在 KV（`upload_session:<id>`），与原版把 UploadSession 放进
 * KV 缓存的做法一致（原版用 gob 编码，这里用 JSON，只在本实现内部消费）。
 *
 * 上传流程：
 *   PUT    /api/v4/file/upload            创建会话 → 返回 chunk_size / upload_urls
 *   POST   /api/v4/file/upload/:sid/:idx  上传第 idx 片
 *   DELETE /api/v4/file/upload            取消会话
 * 最后一片到齐时**自动**完成上传（原版没有独立的 complete 端点）。
 */
import { AppContext } from './context';
import { logAudit } from './audit';
import { FileSystemService } from './fs';
import { generateSavePath } from './savepath';
import { FileSystemType, URI, validateName } from './uri';
import type { EntityRow, FileRow, StoragePolicyRow, UserWithGroup } from '../db/types';
import { EntityType, FileType, PolicyType } from '../lib/boolset';
import {
  AppError,
  CodeCredentialInvalid,
  CodeFileNotFound,
  CodeFileTooLarge,
  CodeFileTypeNotAllowed,
  CodeIllegalObjectName,
  CodeInvalidChunkIndex,
  CodeInvalidContentLength,
  CodeMetaMismatch,
  CodeObjectExist,
  CodeOwnerOnly,
  CodePolicyNotAllowed,
  CodeRootProtected,
  CodeUploadSessionExpired,
  Err,
} from '../lib/errors';
import { randomString, timingSafeEqual, uuidv4 } from '../lib/crypto';
import { extOf } from './savepath';
import { isRelayEnabled, type UploadedPart, type UploadSession } from '../storage/types';
import { publish } from './events';

const SESSION_PREFIX = 'upload_session:';
/** 原版 uploadSentinelCheckMargin = 5 分钟 */
const SENTINEL_MARGIN_MS = 5 * 60 * 1000;

export interface CreateUploadSessionParams {  uri: string;
  size: number;
  lastModified?: number;
  mimeType?: string;
  policyId?: string;
  metadata?: Record<string, string>;
  entityType?: string;
}

export interface UploadSessionResponse {
  session_id: string;
  upload_id?: string;
  chunk_size: number;
  expires: number;
  upload_urls?: string[];
  credential?: string;
  ak?: string;
  keyTime?: string;
  completeURL?: string;
  storage_policy?: ReturnType<FileSystemService['buildPolicyInfo']>;
  uri: string;
  callback_secret: string;
  /** 直传型驱动的收尾回调地址（原版 `fs.UploadCredential.Callback`） */
  callback?: string;
  mime_type?: string;
  upload_policy?: string;
  encrypt_metadata?: unknown;
}

export class UploadService {
  /**
   * 上传彻底收尾后的钩子。路由层用它把「建全文索引」这类
   * 不该阻塞响应、又必须做的工作挂到 `waitUntil` 上。
   * 收尾失败（钩子抛错）不影响上传本身 —— 索引可以重建，文件不能丢。
   */
  onUploadFinished?: (file: FileRow) => void;

  constructor(
    private readonly ctx: AppContext,
    private readonly fs: FileSystemService,
  ) {}

  // -------------------------------------------------------------------------
  // 创建会话
  // -------------------------------------------------------------------------

  async createSession(params: CreateUploadSessionParams): Promise<UploadSessionResponse> {
    const user = this.ctx.requireUser();

    if (!params.uri) throw Err.param('uri is required');
    if (params.size < 0) throw Err.param('Invalid file size');

    const uri = URI.parse(params.uri);
    if (uri.fsType !== FileSystemType.My) {
      throw new AppError(CodePolicyNotAllowed, 'Upload is only supported in personal file system');
    }

    const name = uri.elements.at(-1);
    if (!name) throw new AppError(CodeRootProtected, 'Cannot upload to root as a file');

    const nameError = validateName(name);
    if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

    // 策略：请求指定（必须属于用户组策略集，防越权用任意策略落盘）
    //       > 用户选中/组绑定的默认策略。
    if (params.policyId) {
      const policyId = this.ctx.codec.decodePolicyID(params.policyId);
      if (policyId === null) throw new AppError(40035, 'Storage policy not found');
      const policy = await this.ctx.assertPolicyAllowed(policyId);
      return this.startSession(policy, uri, name, params, user);
    }
    const policy = await this.ctx.preferredPolicy();
    return this.startSession(policy, uri, name, params, user);
  }

  /** 策略确定后的公共流程：约束校验 → 建会话。 */
  private async startSession(
    policy: StoragePolicyRow,
    uri: URI,
    name: string,
    params: CreateUploadSessionParams,
    user: UserWithGroup,
  ): Promise<UploadSessionResponse> {

    this.assertPolicyConstraints(policy, name, params.size);
    this.ctx.assertCapacity(params.size);

    const parentUri = uri.parent();
    const parent = await this.ctx.files.resolvePath(user.id, parentUri.elements);
    if (!parent) throw new AppError(40016, 'Parent folder does not exist');
    if (parent.type !== FileType.Folder) throw new AppError(40016, 'Parent is not a folder');

    const existing = await this.ctx.files.childByName(parent.id, name);

    // 原版语义：目标已存在且（未指定 entity_type 或已存在的不是文件）→ 报「已存在」
    if (existing) {
      const wantsNewVersion = params.entityType === 'version';
      if (!wantsNewVersion || existing.type !== FileType.File) {
        throw Err.objectExist();
      }
    }

    // 注意：sessionId 会写进 entities.upload_session_id（Postgres UUID 列），
    // 必须是合法 UUID，不能用 randomString —— 与上游 uuid.NewV4() 语义一致
    const sessionId = uuidv4();
    const callbackSecret = randomString(32);

    const savePath = generateSavePath(policy, {
      uid: user.id,
      originName: name,
      originPath: this.dirPathOf(parentUri),
    });

    // 目标文件行：已存在则复用（新增版本），否则先建占位
    let fileRow: FileRow;
    let newFileCreated: boolean;
    if (existing) {
      fileRow = existing;
      newFileCreated = false;
    } else {
      fileRow = await this.ctx.files.create({
        type: FileType.File,
        name,
        ownerId: user.id,
        parentId: parent.id,
        size: params.size,
        policyId: policy.id,
      });
      newFileCreated = true;
    }

    // 实体：占位，等上传完成后写入真实大小并清掉 upload_session_id
    const entity = await this.ctx.entities.create({
      type: EntityType.Version,
      source: savePath,
      size: params.size,
      policyId: policy.id,
      createdBy: user.id,
      uploadSessionId: sessionId,
    });

    const expireAt = Date.now() + this.ctx.settings.uploadSessionTTL * 1000;

    const session: UploadSession = {
      id: sessionId,
      policy,
      uid: user.id,
      fileId: fileRow.id,
      entityId: entity.id,
      savePath,
      size: params.size,
      chunkSize: 0,
      parts: [],
      chunksReceived: [],
      callbackSecret,
      expireAt,
      newFileCreated,
      mimeType: params.mimeType ?? '',
    };

    const driver = this.ctx.driverFor(policy);
    const credential = await driver.token(session, {
      savePath,
      fileName: name,
      size: params.size,
      mimeType: params.mimeType ?? '',
      overwrite: !newFileCreated,
      metadata: params.metadata,
    });

    // driver 可能在 token 阶段决定分片大小与 uploadId，回写到会话
    session.chunkSize = credential.chunk_size;

    await this.saveSession(session);

    const response: UploadSessionResponse = {
      session_id: sessionId,
      chunk_size: credential.chunk_size,
      expires: credential.expires,
      uri: uri.toString(),
      callback_secret: callbackSecret,
      storage_policy: this.fs.buildPolicyInfo(policy),
    };
    if (credential.uploadID) response.upload_id = credential.uploadID;
    if (credential.upload_urls) response.upload_urls = credential.upload_urls;
    if (credential.completeURL) response.completeURL = credential.completeURL;
    if (credential.ak) response.ak = credential.ak;
    if (credential.keyTime) response.keyTime = credential.keyTime;
    if (credential.credential) response.credential = credential.credential;
    if (params.mimeType) response.mime_type = params.mimeType;

    // OneDrive 直传的收尾回调地址。原版由驱动自己拼（`onedrive.go:167` 调
    // `routes.MasterSlaveCallbackUrl(siteURL, PolicyTypeOd, sessionID, CallbackSecret)`），
    // 路径形状是 `<site>/api/v4/callback/<driver>/<sessionID>/<secret>`。
    // 只有 OneDrive 需此字段，其余驱动不返回 —— 与原版一致。
    if (policy.type === PolicyType.OneDrive) {
      const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
      response.callback = `${base}/api/v4/callback/onedrive/${sessionId}/${callbackSecret}`;
    }

    return response;
  }

  /** 对象键模板里的 `{path}`：文件所在的网盘目录，以 `/` 结尾。 */
  private dirPathOf(dirUri: URI): string {
    if (dirUri.isRoot) return '';
    return `${dirUri.path.replace(/\/+$/, '')}/`;
  }

  /** 策略级限制：单文件大小上限、扩展名黑白名单、名称正则。 */
  private assertPolicyConstraints(policy: StoragePolicyRow, name: string, size: number): void {
    const maxSize = Number(policy.max_size ?? 0);
    if (maxSize > 0 && size > maxSize) {
      throw new AppError(CodeFileTooLarge, `File size exceeds the policy limit of ${maxSize} bytes`);
    }

    const settings = policy.settings ?? {};
    const ext = extOf(name).replace(/^\./, '').toLowerCase();

    if (settings.file_type && settings.file_type.length > 0) {
      const listed = settings.file_type.map((e) => e.replace(/^\./, '').toLowerCase());
      const inList = listed.includes(ext);
      const isDenyList = settings.is_file_type_deny_list === true;
      if (isDenyList ? inList : !inList) {
        throw new AppError(CodeFileTypeNotAllowed, `File type "${ext}" is not allowed by this policy`);
      }
    }

    if (settings.file_regexp) {
      let re: RegExp;
      try {
        re = new RegExp(settings.file_regexp);
      } catch {
        re = /^$/;
      }
      const matches = re.test(name);
      if (settings.is_name_regexp_deny_list ? matches : !matches) {
        throw new AppError(CodeFileTypeNotAllowed, 'File name is not allowed by this policy');
      }
    }
  }

  // -------------------------------------------------------------------------
  // 分片上传
  // -------------------------------------------------------------------------

  async uploadChunk(
    sessionId: string,
    index: number,
    body: ReadableStream,
    contentLength: number,
  ): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session) throw new AppError(CodeUploadSessionExpired, 'Upload session expired');
    if (session.uid !== this.ctx.requireUser().id) throw Err.noPermission();

    if (!Number.isInteger(index) || index < 0) {
      throw new AppError(CodeInvalidChunkIndex, 'Invalid chunk index');
    }

    const expected = this.expectedChunkLength(session, index);
    if (expected !== null && contentLength !== expected) {
      throw new AppError(
        CodeInvalidContentLength,
        `Invalid content length: expected ${expected}, got ${contentLength}`,
      );
    }

    const driver = this.ctx.driverFor(session.policy);
    const part = await driver.writeChunk(session, index, body, contentLength);

    if (part) {
      session.parts = [...(session.parts ?? []).filter((p) => p.partNumber !== part.partNumber), part];
    }
    session.chunksReceived = Array.from(new Set([...(session.chunksReceived ?? []), index]));

    if (this.isUploadComplete(session)) {
      await this.finishUpload(session);
      // 上传成功后**只清 KV 会话**，绝不能走 `discardSession` ——
      // 那会把刚转正的实体和文件行一起删掉（见该方法注释）。
      await this.deleteSessionRecord(sessionId);
      return;
    }

    await this.saveSession(session);
  }

  /**
   * OneDrive 直传完成后的回调。对应原版
   * `routers/router.go:497-505` 的 `POST /api/v4/callback/onedrive/:sessionID/:key`
   * → `middleware.UseUploadSession(types.PolicyTypeOd)` → `callback.ProcessCallback`
   * → `manager.CompleteUpload`。
   *
   * 直传模式下字节不经过 Worker，`uploadChunk` 永远收不到最后一片，所以
   * 「实体转正 + 容量记账」只能由客户端打完最后一字节后回调这个端点触发。
   * 授权凭据就是 URL 里的 `key`（等于会话的 `callbackSecret`），
   * 与原版一样做常量时间比较（`middleware/auth.go:208-213`）。
   */
  async completeByCallback(sessionId: string, key: string): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session) {
      throw new AppError(CodeUploadSessionExpired, 'Upload session does not exist or expired');
    }
    if (!key || !timingSafeEqual(session.callbackSecret, key)) {
      throw new AppError(CodeCredentialInvalid, 'Invalid callback secret');
    }
    // 原版 `middleware/auth.go:216-218`：策略类型不符报 CodePolicyNotAllowed。
    // S3 系直传（s3/oss/cos/obs/qiniu/ks3）与 OneDrive 一样需要客户端回调转正：
    // 字节不经过 Worker，CompleteMultipartUpload 由前端用预签名 completeURL 完成。
    const S3_FAMILY: string[] = [PolicyType.S3, PolicyType.Oss, PolicyType.Cos, PolicyType.Obs, PolicyType.Qiniu, PolicyType.Ks3];
    if (session.policy.type !== PolicyType.OneDrive && !S3_FAMILY.includes(session.policy.type)) {
      throw new AppError(CodePolicyNotAllowed, 'Policy type mismatch');
    }

    await this.finishUpload(session);
    await this.deleteSessionRecord(sessionId);
  }

  /**
   * 期望的分片长度。
   * chunkSize 为 0 表示整文件单次上传，此时只有 index 0 合法，长度等于文件大小。
   */
  private expectedChunkLength(session: UploadSession, index: number): number | null {
    if (session.chunkSize <= 0) {
      if (index !== 0) {
        throw new AppError(CodeInvalidChunkIndex, 'Chunk index cannot be greater than 0');
      }
      return session.size;
    }
    const totalChunks = Math.max(1, Math.ceil(session.size / session.chunkSize));
    if (index >= totalChunks) {
      throw new AppError(CodeInvalidChunkIndex, 'Invalid chunk index');
    }
    const isLast = index === totalChunks - 1;
    return isLast ? session.size - index * session.chunkSize : session.chunkSize;
  }

  private isUploadComplete(session: UploadSession): boolean {
    const totalChunks = session.chunkSize <= 0 ? 1 : Math.max(1, Math.ceil(session.size / session.chunkSize));
    const received = new Set(session.chunksReceived ?? []);
    for (let i = 0; i < totalChunks; i++) {
      if (!received.has(i)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------

  private async finishUpload(session: UploadSession): Promise<void> {
    const driver = this.ctx.driverFor(session.policy);

    // 是否覆盖已有内容（用于事件类型判定：create vs modify）
    const hadContent = session.fileId
      ? (await this.ctx.files.byId(session.fileId))?.primary_entity !== null
      : false;

    await driver.completeUpload(session);

    // 哨兵式校验：远端大小必须与声明一致（原版 CodeMetaMismatch）
    try {
      const meta = await driver.meta(session.savePath);
      if (meta && session.size > 0 && meta.size !== session.size) {
        // OneDrive 对 SharePoint 有 1MB 容忍，这里统一给 1MB
        if (Math.abs(meta.size - session.size) > 1024 * 1024) {
          throw new AppError(
            CodeMetaMismatch,
            `File size mismatch: expected ${session.size}, got ${meta.size}`,
          );
        }
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      // 校验本身失败（网络问题等）不阻断上传
    }

    // 实体转正：清掉 upload_session_id，标记为可用
    await this.ctx.entities.clearUploadSession(session.entityId);
    await this.ctx.entities.updateSize(session.entityId, session.size);
    await this.ctx.entities.linkFile(session.fileId, session.entityId);
    await this.ctx.files.updatePrimaryEntity(session.fileId, session.entityId);
    await this.ctx.files.updateSize(session.fileId, session.size);

    // 容量记账
    await this.ctx.users.addStorage(session.uid, session.size);

    // 清理同一文件下其它未完成会话遗留的占位实体
    const entities = await this.ctx.entities.listByFile(session.fileId);
    for (const e of entities) {
      if (e.id !== session.entityId && e.upload_session_id !== null) {
        await this.ctx.entities.unlinkFile(session.fileId, e.id);
      }
    }

    // 按版本保留策略裁剪历史版本（原版 `dbfs/upload.go:305-351` 的 CapEntities）
    const target = await this.ctx.files.byId(session.fileId);
    await this.capVersionEntities(session.fileId, session.uid, target?.name ?? null);

    logAudit(this.ctx, 'entity_uploaded', session.uid, {
      name: target?.name,
      size: session.size,
    });

    if (target && this.onUploadFinished) {
      // 钩子抛错不影响上传结果（收尾已经完成，这里只是附加工作）
      try {
        this.onUploadFinished(target);
      } catch (e) {
        console.error('onUploadFinished hook failed', e);
      }
    }

    // 通知同 isolate 内的 SSE 订阅者（前端文件列表实时刷新）
    if (target) {
      try {
        publish(target.file_children ?? 0, {
          type: hadContent ? 'modify' : 'create',
          file_id: this.ctx.codec.encodeFileID(target.id),
          from: '',
          to: target.name,
        });
      } catch {
        // 事件推送失败不影响上传结果
      }
    }
  }

  /**
   * 裁剪文件的历史版本实体。对应原版 `inventory/file.go:856-883` 的 `CapEntities`：
   * 只看 `type = Version` 的实体，按 ID 倒序保留前 `max` 个，其余解除引用。
   * 引用归零的实体同时删除物理对象并回冲用户容量。
   *
   * `max` 的取值照抄原版 `dbfs/upload.go:308-318`：
   *   - 默认 1；
   *   - 用户打开了 `version_retention`、且（`version_retention_ext` 为空或当前文件
   *     扩展名在名单里）时，取 `version_retention_max`，为 0 表示不限制。
   *   注意这两个开关在**用户**的 `settings` 上，不在用户组上。
   */
  private async capVersionEntities(
    fileId: number,
    ownerId: number,
    fileName: string | null,
  ): Promise<void> {
    const owner = await this.ctx.users.byId(ownerId);
    const userSetting = owner?.settings ?? null;

    let max = 1;
    if (userSetting?.version_retention) {
      const extList = userSetting.version_retention_ext ?? [];
      const ext = fileName ? extOf(fileName).slice(1).toLowerCase() : '';
      if (extList.length === 0 || (ext && extList.includes(ext))) {
        const configured = userSetting.version_retention_max ?? 0;
        max = configured === 0 ? Number.MAX_SAFE_INTEGER : configured;
      }
    }

    const versions = (await this.ctx.entities.listByFile(fileId))
      .filter((e) => e.type === EntityType.Version)
      .sort((a, b) => b.id - a.id);

    if (versions.length <= max) return;
    const toCap = versions.slice(max);
    if (toCap.length === 0) return;

    for (const e of toCap) await this.ctx.entities.unlinkFile(fileId, e.id);

    const garbage = await this.ctx.entities.release(toCap.map((e) => e.id));
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

  // -------------------------------------------------------------------------
  // 覆盖内容（PUT /api/v4/file/content）
  // -------------------------------------------------------------------------

  /**
   * 覆盖已有文件的内容。对应原版 `FileUpdateService.PutContent` → `manager.Update`。
   *
   * 原版的语义是**新增一个版本实体**，而不是就地改写：
   *   - 先按 `maxEditSize`（默认 50MB）挡掉超大请求；
   *   - 容量按**新文件全量**预留（旧实体作为历史版本继续占空间）；
   *   - 之后由 `CapEntities` 按用户的版本保留策略裁剪旧版本（见 `capVersionEntities`）。
   *   - 新实体写到**全新的对象键**（`generateSavePath`），旧对象原地不动 ——
   *     否则旧版本行会指向被覆盖后的内容，历史版本就失真了。
   */
  async overwriteContent(
    uri: URI,
    body: ReadableStream,
    length: number,
    mimeType: string,
    options: { ignoreMaxEdit?: boolean } = {},
  ): Promise<void> {
    const user = this.ctx.requireUser();
    const file = await this.fs.mustResolve(uri);
    if (file.type !== FileType.File) {
      throw new AppError(CodeFileNotFound, 'Target is not a file');
    }
    if (file.owner_id !== user.id && !this.ctx.isAdmin) {
      throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
    }

    // WebDAV 的 PUT 也是覆盖写，但它不该受「在线编辑」的体积限制（上游 WebDAV
    // 直接走 fm.Upload，同样没有 maxEditSize 一说）
    if (!options.ignoreMaxEdit) {
      const maxEdit = this.ctx.settings.getInt('maxEditSize', 52428800);
      if (maxEdit > 0 && length > maxEdit) {
        throw new AppError(
          CodeFileTooLarge,
          `File size exceeds the online edit limit of ${maxEdit} bytes`,
        );
      }
    }

    const policy = await this.ctx.resolvePolicy(file.storage_policy_files);
    const driver = this.ctx.driverFor(policy);

    // 原版 `Update` 走 `ModeOverwrite`：建**新**实体，旧实体留作历史版本。
    // 容量按新文件全量记账，历史版本的去留交给 `maxEditSize` 之后的 CapEntities。
    this.ctx.assertCapacity(length);

    const savePath = generateSavePath(policy, {
      uid: user.id,
      originName: file.name,
      originPath: this.dirPathOf(uri.parent()),
    });

    const entity = await this.ctx.entities.create({
      type: EntityType.Version,
      source: savePath,
      size: length,
      policyId: policy.id,
      createdBy: user.id,
    });

    await driver.put(
      { savePath, fileName: file.name, size: length, mimeType, overwrite: false },
      body,
      length,
    );

    await this.ctx.entities.linkFile(file.id, entity.id);
    await this.ctx.files.updatePrimaryEntity(file.id, entity.id);
    await this.ctx.files.updateSize(file.id, length);
    await this.ctx.users.addStorage(user.id, length);

    // 新旧实体同在一张 file_entities 里，按版本保留策略裁剪（与上传提交同一条路径）
    await this.capVersionEntities(file.id, file.owner_id, file.name);
  }

  // -------------------------------------------------------------------------
  // 取消
  // -------------------------------------------------------------------------

  /**
   * 用户主动取消上传（`DELETE /api/v4/file/upload`，对应原版 `DeleteUploadSession`）。
   *
   * ⚠️ 这个方法会**销毁**会话关联的实体，必要时连文件行一起删 —— 只适用于
   * 「上传没成功、要把半成品清掉」的场景。上传成功后**必须**改用
   * `deleteSessionRecord`，否则会把刚上传好的文件删掉。
   */
  async deleteSession(sessionId: string, uriHint?: string): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (session) {
      // 会话属主校验：与 uploadChunk 同款（原版 UseUploadSession 中间件
      // 对会话 UID 与请求者做一致性检查，防登录用户互删上传会话）
      if (session.uid !== this.ctx.requireUser().id) throw Err.noPermission();
      await this.discardSession(session);
      return;
    }

    // 会话已过期：如果带了 uri，尝试按 uri 找到残留的占位文件清理掉
    if (uriHint) {
      try {
        const uri = URI.parse(uriHint);
        const file = await this.ctx.files.resolvePath(this.ctx.requireUser().id, uri.elements);
        if (file && file.type === FileType.File && !file.primary_entity) {
          await this.ctx.files.deleteMany([file.id]);
        }
      } catch {
        // 尽力而为
      }
    }
    throw new AppError(CodeUploadSessionExpired, 'Upload session expired');
  }

  /** 丢弃一个上传会话：撤销远端会话、回收占位实体（必要时连文件行）。 */
  private async discardSession(session: UploadSession): Promise<void> {
    const driver = this.ctx.driverFor(session.policy);
    try {
      await driver.cancelToken(session);
    } catch {
      // 忽略远端清理失败
    }
    // 占位实体与占位文件一并回收
    await this.ctx.entities.unlinkFile(session.fileId, session.entityId);
    await this.ctx.entities.hardDelete([session.entityId]);
    if (session.newFileCreated) {
      await this.ctx.files.deleteMany([session.fileId]);
    }
    await this.deleteSessionRecord(session.id);
  }

  /** 当前用户的上传会话数量（用于后台/调试）。 */
  async listOwnSessionIds(userId: number): Promise<string[]> {
    const list = await this.ctx.env.KV.list({ prefix: SESSION_PREFIX, limit: 1000 });
    const out: string[] = [];
    for (const key of list.keys) {
      const session = (await this.ctx.env.KV.get(key.name, 'json')) as UploadSession | null;
      if (session?.uid === userId) out.push(session.id);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // KV 存取
  // -------------------------------------------------------------------------

  private async saveSession(session: UploadSession): Promise<void> {
    const ttl = Math.max(60, Math.floor((session.expireAt - Date.now()) / 1000) + SENTINEL_MARGIN_MS / 1000);
    await this.ctx.env.KV.put(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session), {
      expirationTtl: ttl,
    });
  }

  private async loadSession(sessionId: string): Promise<UploadSession | null> {
    const raw = await this.ctx.env.KV.get(`${SESSION_PREFIX}${sessionId}`, 'json');
    return (raw as UploadSession | null) ?? null;
  }

  private async deleteSessionRecord(sessionId: string): Promise<void> {
    await this.ctx.env.KV.delete(`${SESSION_PREFIX}${sessionId}`);
  }
}

export { SESSION_PREFIX as UPLOAD_SESSION_PREFIX };

/** 「中转上传」判定：策略开了 relay，或驱动不支持直传。 */
export function shouldRelayByPolicy(policy: StoragePolicyRow): boolean {
  return isRelayEnabled(policy.settings);
}

export type { EntityRow, FileRow };
export type { UploadedPart };
