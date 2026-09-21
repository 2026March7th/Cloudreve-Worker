/**
 * 请求级应用上下文：把 env、设置、仓储、当前用户打包在一起，
 * 服务层通过它访问一切依赖（相当于原版的 dependency.Dep）。
 */
import type { Env } from '../env';
import type { SettingsProvider } from '../settings/provider';
import type { HashIDCodec } from '../lib/hashid';
import type { JWTService } from '../lib/jwt';
import { Signer } from '../lib/sign';
import {
  DirectLinkRepo,
  EntityRepo,
  FileRepo,
  GroupRepo,
  MetadataRepo,
  PolicyRepo,
  ShareRepo,
  TaskRepo,
  UserRepo,
  DavAccountRepo,
  PasskeyRepo,
} from '../db/repo';
import type { GroupRow, StoragePolicyRow, UserRow, UserWithGroup } from '../db/types';
import { AppError, CodeGroupNotAllowed, CodeNoPermissionErr } from '../lib/errors';
import { BooleanSet, GroupPermission } from '../lib/boolset';
import { getStorageDriver, isPolicyTypeSupported } from '../storage';
import type { StorageDriver } from '../storage/types';

/**
 * 匿名用户组 ID。取自原版 `inventory/group.go:19`（`AnonymousGroupID = 3`）。
 * 未登录访问分享时，权限判定用的是这个组的位集。
 */
export const AnonymousGroupID = 3;

/** 把用户组的 `permissions` 列（bytea，驱动可能给 Uint8Array 或 base64 串）转成位集。 */
export function permissionsOf(group: GroupRow): BooleanSet {
  const raw = group.permissions;
  if (raw instanceof Uint8Array) return new BooleanSet(raw);
  return BooleanSet.fromBase64(raw as unknown as string);
}

export class AppContext {
  readonly users: UserRepo;
  readonly groups: GroupRepo;
  readonly policies: PolicyRepo;
  readonly files: FileRepo;
  readonly entities: EntityRepo;
  readonly shares: ShareRepo;
  readonly metadata: MetadataRepo;
  readonly directLinks: DirectLinkRepo;
  readonly tasks: TaskRepo;
  readonly davAccounts: DavAccountRepo;
  readonly passkeys: PasskeyRepo;
  /** URL / 请求签名器，密钥与 JWT 共用站点 secret */
  readonly signer: Signer;

  constructor(
    readonly env: Env,
    readonly settings: SettingsProvider,
    readonly codec: HashIDCodec,
    readonly jwt: JWTService,
    readonly user?: UserWithGroup,
    /**
     * OAuth 客户端 token 的 scopes（内置登录 token 没有，视为不限）。
     * 对应上游 `auth.GetScopesFromContext`。
     */
    readonly scopes?: string[],
  ) {
    this.users = new UserRepo(env);
    this.groups = new GroupRepo(env);
    this.policies = new PolicyRepo(env);
    this.files = new FileRepo(env);
    this.entities = new EntityRepo(env);
    this.shares = new ShareRepo(env);
    this.metadata = new MetadataRepo(env);
    this.directLinks = new DirectLinkRepo(env);
    this.tasks = new TaskRepo(env);
    this.davAccounts = new DavAccountRepo(env);
    this.passkeys = new PasskeyRepo(env);
    this.signer = new Signer(settings.secretKey);
  }

  /** 当前用户必须存在，否则抛 401。 */
  requireUser(): UserWithGroup {
    if (!this.user) {
      throw new AppError(401, 'Unauthorized action');
    }
    return this.user;
  }

  /**
   * 以指定用户身份派生一个上下文（共享全部 repo/绑定，仅替换 user）。
   * 用于「签名 URL 匿名访问但要按原请求者权限执行」的场景，
   * 例如打包下载：会话里存了 requester_id，取包时恢复其身份。
   * 对应上游 `GetLoginUserByID`（service/explorer/file.go:66）。
   */
  withUser(user: UserWithGroup): AppContext {
    const clone = Object.create(AppContext.prototype) as AppContext;
    Object.assign(clone, this, { user });
    return clone;
  }

  /** 当前用户所属组的权限位集。 */
  get groupPermissions(): BooleanSet {
    return permissionsOf(this.requireUser().group);
  }

  /** 是否匿名（未登录）请求。 */
  get isAnonymous(): boolean {
    return !this.user;
  }

  /**
   * 匿名组的权限位集。同一请求内只查一次库。
   * 对应原版 `userClient.AnonymousUser()` 拿到的那个组的权限。
   */
  anonymousPermissions(): Promise<BooleanSet> {
    if (!this.anonymousPermissionsPromise) {
      this.anonymousPermissionsPromise = this.groups
        .byId(AnonymousGroupID)
        .then((group) => (group ? permissionsOf(group) : new BooleanSet()));
    }
    return this.anonymousPermissionsPromise;
  }

  /**
   * 当前访问者的权限位集：登录用户取所属组，未登录取匿名组。
   * share navigator 的 `GroupPermissionShareDownload` 判定用它。
   */
  viewerPermissions(): Promise<BooleanSet> {
    return this.user ? Promise.resolve(permissionsOf(this.user.group)) : this.anonymousPermissions();
  }

  private anonymousPermissionsPromise?: Promise<BooleanSet>;

  requireGroupPermission(flag: number, msg = 'Group not allowed to perform this action'): void {
    if (!this.groupPermissions.enabled(flag)) {
      throw new AppError(CodeGroupNotAllowed, msg);
    }
  }

  requireAdmin(): void {
    if (!this.groupPermissions.enabled(GroupPermission.IsAdmin)) {
      throw new AppError(CodeNoPermissionErr, 'Admin required');
    }
  }

  get isAdmin(): boolean {
    if (!this.user) return false;
    return permissionsOf(this.user.group).enabled(GroupPermission.IsAdmin);
  }

  /** 当前用户可用的存储策略：优先取用户组绑定的，否则取默认策略。 */
  async resolvePolicy(policyId?: number | null): Promise<StoragePolicyRow> {
    if (policyId) {
      const policy = await this.policies.byId(policyId);
      if (!policy) {
        throw new AppError(40035, 'Storage policy not found');
      }
      if (!isPolicyTypeSupported(policy.type)) {
        throw new AppError(40006, `Storage policy type "${policy.type}" is not supported`);
      }
      return policy;
    }

    const user = this.requireUser();
    const groupPolicyId = user.group.storage_policy_id;
    if (groupPolicyId) {
      const policy = await this.policies.byId(groupPolicyId);
      if (policy && isPolicyTypeSupported(policy.type)) return policy;
    }

    const fallback = await this.policies.defaultPolicy();
    if (!fallback) {
      throw new AppError(40035, 'No storage policy is configured');
    }
    if (!isPolicyTypeSupported(fallback.type)) {
      throw new AppError(40006, `Storage policy type "${fallback.type}" is not supported`);
    }
    return fallback;
  }

  /**
   * 用户组的全部可用策略（edge 自建 Pro 功能：组多策略）。
   * 按组关联表取全量并过滤掉类型不支持的驱动；组没绑任何策略时
   * 回落到 resolvePolicy 的默认链。user 缺省时取当前请求用户
   * （列表下发策略跟随**目录属主**，所以要显式传属主）。
   *
   * 策略行按 id 批量取（1 次查询），不再逐个 `byId` —— 列表接口对每个
   * 请求都要走这条路，组绑 N 个策略时原来要 N+1 次往返（每次 ~300ms）。
   */
  async groupPolicies(user?: UserRow): Promise<StoragePolicyRow[]> {
    const u = user ?? this.requireUser();
    const ids = await this.groups.listPolicyIds(u.group_users);
    const policies = (await this.policies.byIds(ids)).filter((p) =>
      isPolicyTypeSupported(p.type),
    );
    if (policies.length > 0) return policies;
    if (!user) return [await this.resolvePolicy(null)];
    return policies;
  }

  /** 校验 policyId 属于当前用户组的策略集；不属于抛 40035。 */
  async assertPolicyAllowed(policyId: number): Promise<StoragePolicyRow> {
    const allowed = await this.groupPolicies();
    const hit = allowed.find((p) => p.id === policyId);
    if (!hit) throw new AppError(40035, 'Storage policy not allowed for this group');
    return hit;
  }

  /**
   * 从**已取到的**策略集里挑出用户当前选中的上传策略（未选/失效时取第一个）。
   *
   * 纯函数版本 —— 调用方已经拿到 `groupPolicies()` 结果时用它，避免
   * `preferredPolicy()` 内部再查一次组策略（列表接口原来就重复查了）。
   * `ListResponse.storage_policy` 的取法必须与 `preferredPolicy()` 完全一致，
   * 否则前端展示的策略与实际落盘策略会对不上。
   */
  pickPreferredPolicy(
    allowed: StoragePolicyRow[],
    settings?: UserRow['settings'],
  ): StoragePolicyRow {
    const want = settings?.upload_policy_id;
    if (want != null) {
      const hit = allowed.find((p) => p.id === Number(want));
      if (hit) return hit;
    }
    // 组没绑任何存储策略（或绑定的全被删了）：必须抛明确业务错误，
    // 否则调用方拿到 undefined 再读 policy.max_size 会 50001 内部错误。
    if (!allowed.length) {
      throw new AppError(40035, 'No available storage policy for your group');
    }
    return allowed[0]!;
  }

  /** 用户在组策略集里当前选中的上传策略（未选/失效时取第一个）。 */
  async preferredPolicy(user?: UserRow): Promise<StoragePolicyRow> {
    const u = user ?? this.requireUser();
    const allowed = await this.groupPolicies(u);
    return this.pickPreferredPolicy(allowed, u.settings);
  }

  driverFor(policy: StoragePolicyRow): StorageDriver {
    return getStorageDriver(this.env, policy);
  }

  /** 用户容量上限；返回 null 表示不限量。含购买容量包（未过期部分）。 */
  get maxStorage(): number | null {
    const user = this.requireUser();
    const base =
      user.group.max_storage === null || user.group.max_storage === undefined
        ? null
        : Number(user.group.max_storage);
    // 购买的容量包（edge 自建 Pro 功能）：叠加在组上限之上；
    // 过期包在读时直接过滤，不需要后台清理任务。
    const packs = Array.isArray(user.settings?.quota_packs) ? user.settings!.quota_packs! : [];
    const now = Date.now();
    const bonus = packs
      .filter((p) => p && (!p.expire_at || new Date(p.expire_at).getTime() > now))
      .reduce((sum, p) => sum + Math.max(0, Number(p.size ?? 0)), 0);
    if (base === null) return null; // 组不限量时叠加无意义
    return base + bonus;
  }

  /** 已用容量。 */
  get usedStorage(): number {
    return Number(this.requireUser().storage ?? 0);
  }

  /** 容量校验：超出上限抛 40051。 */
  assertCapacity(additional: number): void {
    const max = this.maxStorage;
    if (max === null || max <= 0) return; // 不限量
    if (this.usedStorage + additional > max) {
      // 对应原版 Pro 的「存储配额超出」通知（mail_exceed_quota_template）：
      // 由中间件注入 notifier，fire-and-forget 发信（限频在 notifier 内做），
      // 绝不能阻塞或影响这次必然失败的请求。
      try {
        this.onQuotaExceeded?.(this.requireUser());
      } catch {
        /* 通知失败不影响业务错误抛出 */
      }
      throw new AppError(40051, 'Insufficient capacity');
    }
  }

  // -------------------------------------------------------------------------
  // 后台任务挂钩（由中间件注入，见 src/middleware/app.ts）
  // -------------------------------------------------------------------------

  private backgroundHooks?: {
    waitUntil: (p: Promise<unknown>) => void;
    onQuotaExceeded: (user: UserWithGroup) => void;
  };

  /** 注入 `waitUntil` 与配额超限通知。仅路由装配层调用一次。 */
  setBackgroundHooks(hooks: {
    waitUntil: (p: Promise<unknown>) => void;
    onQuotaExceeded: (user: UserWithGroup) => void;
  }): void {
    this.backgroundHooks = hooks;
  }

  /** 把不该阻塞响应、又必须跑完的工作挂到 Workers 的生命周期上。 */
  get waitUntil(): ((p: Promise<unknown>) => void) | undefined {
    return this.backgroundHooks?.waitUntil;
  }

  /** 存储配额超出时的通知回调（发「配额超出」邮件，限频由实现方负责）。 */
  get onQuotaExceeded(): ((user: UserWithGroup) => void) | undefined {
    return this.backgroundHooks?.onQuotaExceeded;
  }
}
