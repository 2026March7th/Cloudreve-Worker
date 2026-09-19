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
} from '../db/repo';
import type { GroupRow, StoragePolicyRow, UserWithGroup } from '../db/types';
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
  /** URL / 请求签名器，密钥与 JWT 共用站点 secret */
  readonly signer: Signer;

  constructor(
    readonly env: Env,
    readonly settings: SettingsProvider,
    readonly codec: HashIDCodec,
    readonly jwt: JWTService,
    readonly user?: UserWithGroup,
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
    this.signer = new Signer(settings.secretKey);
  }

  /** 当前用户必须存在，否则抛 401。 */
  requireUser(): UserWithGroup {
    if (!this.user) {
      throw new AppError(401, 'Unauthorized action');
    }
    return this.user;
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

  driverFor(policy: StoragePolicyRow): StorageDriver {
    return getStorageDriver(this.env, policy);
  }

  /** 用户容量上限；返回 null 表示不限量。 */
  get maxStorage(): number | null {
    const user = this.requireUser();
    return user.group.max_storage === null || user.group.max_storage === undefined
      ? null
      : Number(user.group.max_storage);
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
      throw new AppError(40051, 'Insufficient capacity');
    }
  }
}
