/**
 * 用户与认证服务。对应 Cloudreve v4 的 `service/user/` 目录。
 *
 * 认证契约（回源码核对）：
 *   - 登录响应 `{ user, token }`，token 是 `auth.Token`：
 *     `access_token` / `refresh_token` / `access_expires` / `refresh_expires`
 *     （注意**没有** expires_in，过期时间是 RFC3339 字符串）；
 *   - JWT 为 HS256，claims 里 `sub` 是 hashid 用户 ID；
 *   - 注销把 refresh token 的 `root_token_id` 写进 KV 吊销名单（前缀 `jwt_revoke_`）。
 */
import { AppContext } from './context';
import type { UserRow, UserWithGroup } from '../db/types';
import { BooleanSet, GroupPermission } from '../lib/boolset';
import {
  AppError,
  CodeEmailExisted,
  CodeFeatureNotEnabled,
  CodeIncorrectPassword,
  CodeInvalidPassword,
  CodeNotFullySuccess,
  CodeUserBaned,
  CodeUserNotActivated,
  Err,
} from '../lib/errors';
import { checkPassword, digestPassword } from '../lib/crypto';
import { hashUserState, RevokeTokenPrefix, type Claims } from '../lib/jwt';
import { randomString } from '../lib/crypto';

export interface UserResponse {
  id: string;
  email?: string;
  nickname: string;
  status?: string;
  avatar?: string;
  created_at: string;
  preferred_theme?: string;
  anonymous?: boolean;
  group?: {
    id: string;
    name: string;
    permission?: string;
    direct_link_batch_size?: number;
    trash_retention?: number;
  };
  pined?: { uri: string; name?: string }[];
  language?: string;
  disable_view_sync?: boolean;
  share_links_in_profile?: string;
}

export interface LoginResult {
  user: UserResponse;
  token: {
    access_token: string;
    refresh_token: string;
    access_expires: string;
    refresh_expires: string;
  };
}

export interface RegisterResult {
  /** 需要邮件激活时 data 为空，code 为 203 */
  needActivation: boolean;
  user?: UserResponse;
}

export class UserService {
  constructor(private readonly ctx: AppContext) {}

  // -------------------------------------------------------------------------
  // 响应构造
  // -------------------------------------------------------------------------

  /**
   * 构造用户响应。
   * @param self 是否本人视角（本人可见 email 与私有设置）
   */
  async buildUserResponse(user: UserRow, self: boolean): Promise<UserResponse> {
    const group = await this.ctx.groups.byId(user.group_users);
    const settings = user.settings ?? {};

    const res: UserResponse = {
      id: this.ctx.codec.encodeUserID(user.id),
      nickname: user.nick,
      created_at: user.created_at.toISOString(),
    };

    if (self) {
      res.email = user.email;
      res.status = user.status;
      res.preferred_theme = settings.preferred_theme;
      res.pined = settings.pined;
      res.language = settings.email_language;
      res.disable_view_sync = settings.disable_view_sync;
      res.share_links_in_profile = settings.share_links_in_profile;
    }

    if (user.avatar) {
      res.avatar = user.avatar;
    }

    if (group) {
      const perms = group.permissions instanceof Uint8Array
        ? new BooleanSet(group.permissions)
        : BooleanSet.fromBase64(group.permissions as unknown as string);
      res.group = {
        id: this.ctx.codec.encodeGroupID(group.id),
        name: group.name,
        permission: perms.toBase64(),
        // 对应原版 BuildGroup：DirectLinkBatchSize 取 group.Settings.SourceBatchSize，
        // TrashRetention 取 group.Settings.TrashRetention（都是组级配置，不是站点设置）
        direct_link_batch_size: group.settings?.source_batch,
        trash_retention: group.settings?.trash_retention,
      };
    }

    return res;
  }

  /** 匿名用户（未登录访问站点配置时用）。 */
  anonymousUserResponse(): UserResponse {
    return {
      id: '',
      nickname: '',
      created_at: new Date().toISOString(),
      anonymous: true,
    };
  }

  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.ctx.users.byEmailWithGroup(email);
    if (!user) {
      throw new AppError(CodeInvalidPassword, 'Incorrect password or email address');
    }
    const ok = await checkPassword(user.password, password);
    if (!ok) {
      throw new AppError(CodeInvalidPassword, 'Incorrect password or email address');
    }
    if (user.status === 'manual_banned' || user.status === 'sys_banned') {
      throw new AppError(CodeUserBaned, 'This account has been blocked');
    }
    if (user.status === 'inactive') {
      throw new AppError(CodeUserNotActivated, 'This account is not activated');
    }

    // 二次验证：原版在这里签发 2FA session，边缘版未实现 TOTP，见 README。
    if (user.two_factor_secret) {
      throw new AppError(CodeFeatureNotEnabled, 'Two-factor authentication is not supported in the edge build');
    }

    // 确保根目录存在
    await this.ctx.files.ensureRoot(user.id);

    const token = await this.issueToken(user);
    return {
      user: await this.buildUserResponse(user, true),
      token,
    };
  }

  /** 签发 token 对。 */
  async issueToken(user: UserRow, rootTokenId?: string): Promise<LoginResult['token']> {
    const subject = this.ctx.codec.encodeUserID(user.id);
    const stateHash = await hashUserState(user.email, user.password ?? '', this.ctx.settings.siteId);
    return this.ctx.jwt.issue({
      subject,
      stateHash,
      accessTTLSeconds: this.ctx.settings.accessTokenTTL,
      refreshTTLSeconds: this.ctx.settings.refreshTokenTTL,
      rootTokenId,
    });
  }

  // -------------------------------------------------------------------------
  // 刷新 / 注销
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string): Promise<LoginResult['token']> {
    const claims = await this.ctx.jwt.verify(refreshToken);
    if (!claims || claims.token_type !== 'refresh') {
      throw new AppError(40020, 'Invalid refresh token');
    }
    const uid = this.ctx.codec.decodeUserID(claims.sub);
    if (uid === null) throw Err.userNotFound();

    const user = await this.ctx.users.byId(uid);
    if (!user || user.status !== 'active') throw Err.userNotFound();

    // 密码变更后旧 refresh token 失效
    const expected = await hashUserState(user.email, user.password ?? '', this.ctx.settings.siteId);
    if (!claims.state_hash) throw new AppError(40020, 'Invalid refresh token');
    const { stateHashEquals } = await import('../lib/jwt');
    if (!stateHashEquals(claims, expected)) {
      throw new AppError(40020, 'Invalid refresh token');
    }

    // 会话被吊销
    if (!claims.root_token_id) throw new AppError(40020, 'Invalid refresh token');
    const revoked = await this.ctx.env.KV.get(`${RevokeTokenPrefix}${claims.root_token_id}`);
    if (revoked) throw new AppError(40020, 'Invalid refresh token');

    return this.issueToken(user, claims.root_token_id);
  }

  /** 注销：把 root token 加入吊销名单。 */
  async logout(refreshToken: string): Promise<void> {
    const claims: Claims | null = await this.ctx.jwt.verify(refreshToken);
    if (!claims?.root_token_id) return;

    // TTL 覆盖 refresh token 的剩余有效期即可
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, (claims.exp ?? now + 3600) - now);
    await this.ctx.env.KV.put(`${RevokeTokenPrefix}${claims.root_token_id}`, '1', {
      expirationTtl: ttl,
    });
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  async register(email: string, password: string): Promise<RegisterResult> {
    if (!this.ctx.settings.registerEnabled) {
      throw new AppError(40019, 'Registration is not enabled');
    }

    const existing = await this.ctx.users.byEmail(email);
    if (existing) throw new AppError(CodeEmailExisted, 'This email has already been used');

    const digest = await digestPassword(password);
    const needActivation = this.ctx.settings.emailActive;

    const user = await this.ctx.users.create({
      email,
      nick: email.split('@')[0] ?? email,
      passwordDigest: digest,
      groupId: this.ctx.settings.defaultGroupId,
      status: needActivation ? 'inactive' : 'active',
    });

    await this.ctx.files.ensureRoot(user.id);

    if (needActivation) {
      return { needActivation: true };
    }
    return { needActivation: false, user: await this.buildUserResponse(user, true) };
  }

  // -------------------------------------------------------------------------
  // 密码重置
  // -------------------------------------------------------------------------

  async resetPassword(userHashId: string, secret: string, newPassword: string): Promise<UserResponse> {
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw Err.userNotFound();
    const user = await this.ctx.users.byId(uid);
    if (!user) throw Err.userNotFound();

    // 校验重置令牌：存在 KV 里的一次性密钥
    const stored = await this.ctx.env.KV.get(`password_reset:${uid}`);
    if (!stored || stored !== secret) {
      throw new AppError(40029, 'Invalid or expired reset link');
    }

    const digest = await digestPassword(newPassword);
    await this.ctx.users.updatePassword(uid, digest);
    await this.ctx.env.KV.delete(`password_reset:${uid}`);

    const updated = await this.ctx.users.byId(uid);
    return this.buildUserResponse(updated!, true);
  }

  /** 生成密码重置令牌（无邮件服务时由管理员/CLI 取用，见 README）。 */
  async createResetToken(email: string): Promise<{ token: string; expiresIn: number }> {
    const user = await this.ctx.users.byEmail(email);
    if (!user) throw Err.userNotFound();
    const token = randomString(32);
    const ttl = 3600;
    await this.ctx.env.KV.put(`password_reset:${user.id}`, token, { expirationTtl: ttl });
    return { token, expiresIn: ttl };
  }

  // -------------------------------------------------------------------------
  // 个人资料
  // -------------------------------------------------------------------------

  async capacity(): Promise<{ total: number; used: number }> {
    const user = this.ctx.requireUser();
    const max = this.ctx.maxStorage;
    return {
      // 不限量时原版返回一个很大的数；这里沿用该约定
      total: max === null || max <= 0 ? Number.MAX_SAFE_INTEGER : max,
      used: Number(user.storage),
    };
  }

  async updateSettings(patch: {
    nick?: string;
    language?: string;
    preferred_theme?: string;
    version_retention?: boolean;
    version_retention_ext?: string[];
    version_retention_max?: number;
    current_password?: string;
    new_password?: string;
    disable_view_sync?: boolean;
    share_links_in_profile?: string;
  }): Promise<UserResponse> {
    const user = this.ctx.requireUser();

    if (patch.new_password) {
      const ok = await checkPassword(user.password, patch.current_password ?? '');
      if (!ok) throw new AppError(CodeIncorrectPassword, 'Incorrect password');
      const digest = await digestPassword(patch.new_password);
      await this.ctx.users.updatePassword(user.id, digest);
    }

    if (patch.nick !== undefined) {
      await this.ctx.users.updateProfile(user.id, { nick: patch.nick });
    }

    const settings = { ...(user.settings ?? {}) };
    if (patch.language !== undefined) settings.email_language = patch.language;
    if (patch.preferred_theme !== undefined) settings.preferred_theme = patch.preferred_theme;
    if (patch.version_retention !== undefined) settings.version_retention = patch.version_retention;
    if (patch.version_retention_ext !== undefined) settings.version_retention_ext = patch.version_retention_ext;
    if (patch.version_retention_max !== undefined) settings.version_retention_max = patch.version_retention_max;
    if (patch.disable_view_sync !== undefined) settings.disable_view_sync = patch.disable_view_sync;
    if (patch.share_links_in_profile !== undefined) {
      settings.share_links_in_profile = patch.share_links_in_profile;
    }
    await this.ctx.users.updateSettings(user.id, settings as Record<string, unknown>);

    const updated = await this.ctx.users.byId(user.id);
    return this.buildUserResponse(updated!, true);
  }

  /** 固定 / 取消固定侧栏文件。 */
  async pin(uri: string, name: string | undefined, pinned: boolean): Promise<void> {
    const user = this.ctx.requireUser();
    const settings = { ...(user.settings ?? {}) };
    const list = settings.pined ?? [];

    if (pinned) {
      if (list.some((p) => p.uri === uri)) return;
      list.push({ uri, name });
    } else {
      settings.pined = list.filter((p) => p.uri !== uri);
      await this.ctx.users.updateSettings(user.id, settings as Record<string, unknown>);
      return;
    }

    settings.pined = list;
    await this.ctx.users.updateSettings(user.id, settings as Record<string, unknown>);
  }

  /** 头像地址。原版支持 gravatar 与本地头像两种。 */
  buildAvatarUrl(user: UserRow): string {
    if (user.avatar) {
      const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
      return `${base}/api/v4/user/avatar/${this.ctx.codec.encodeUserID(user.id)}`;
    }
    const server = this.ctx.settings.get('gravatar_server', 'https://www.gravatar.com/');
    // 与原版一致：用邮箱的 MD5 取头像，这里退化为邮箱本身（不引 MD5 依赖）
    return `${server.replace(/\/+$/, '')}/avatar/${encodeURIComponent(user.email)}?d=mp`;
  }

  /** 上传头像到 R2。 */
  async uploadAvatar(body: ArrayBuffer, contentType: string): Promise<void> {
    const user = this.ctx.requireUser();
    const maxSize = this.ctx.settings.getInt('avatar_size', 4194304);
    if (body.byteLength > maxSize) {
      throw new AppError(40049, `Avatar size exceeds ${maxSize} bytes`);
    }
    const key = `avatar/${user.id}`;
    await this.ctx.env.R2.put(key, body, { httpMetadata: { contentType } });
    await this.ctx.users.updateProfile(user.id, { avatar: `r2://${key}` });
  }

  async getAvatar(userHashId: string): Promise<{ body: ReadableStream; contentType: string } | null> {
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) return null;
    const user = await this.ctx.users.byId(uid);
    if (!user?.avatar?.startsWith('r2://')) return null;
    const key = user.avatar.slice('r2://'.length);
    const obj = await this.ctx.env.R2.get(key);
    if (!obj) return null;
    return {
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  // -------------------------------------------------------------------------
  // 管理：用户列表
  // -------------------------------------------------------------------------

  async listUsers(params: {
    page: number;
    pageSize: number;
    orderBy?: string;
    orderDirection?: string;
    keyword?: string;
    groupId?: string;
    status?: string;
  }): Promise<{ users: UserResponse[]; pagination: { page: number; page_size: number; total_items: number } }> {
    this.ctx.requireAdmin();

    let groupId: number | undefined;
    if (params.groupId) {
      const decoded = this.ctx.codec.decodeGroupID(params.groupId);
      groupId = decoded ?? undefined;
    }

    const { users, total } = await this.ctx.users.list({
      page: params.page,
      pageSize: params.pageSize,
      orderBy: params.orderBy,
      orderDirection: params.orderDirection,
      keyword: params.keyword,
      groupId,
      status: params.status,
    });

    const out: UserResponse[] = [];
    for (const u of users) {
      out.push(await this.buildUserResponse(u, true));
    }

    return {
      users: out,
      pagination: { page: params.page, page_size: params.pageSize, total_items: total },
    };
  }

  async adminUpdateUser(
    userHashId: string,
    patch: { groupId?: string; status?: string; nick?: string; email?: string },
  ): Promise<void> {
    this.ctx.requireAdmin();
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw Err.userNotFound();
    const user = await this.ctx.users.byId(uid);
    if (!user) throw Err.userNotFound();

    if (patch.groupId) {
      const gid = this.ctx.codec.decodeGroupID(patch.groupId);
      if (gid === null) throw new AppError(40039, 'Group not found');
      const group = await this.ctx.groups.byId(gid);
      if (!group) throw new AppError(40039, 'Group not found');
      await this.ctx.users.updateGroup(uid, gid);
    }
    if (patch.status) {
      if (!['active', 'inactive', 'manual_banned', 'sys_banned'].includes(patch.status)) {
        throw Err.param('Invalid status');
      }
      await this.ctx.users.updateStatus(uid, patch.status);
    }
    if (patch.nick !== undefined) {
      await this.ctx.users.updateProfile(uid, { nick: patch.nick });
    }
  }

  async resetUserPassword(userHashId: string, newPassword: string): Promise<void> {
    this.ctx.requireAdmin();
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw Err.userNotFound();
    const digest = await digestPassword(newPassword);
    await this.ctx.users.updatePassword(uid, digest);
  }

  async deleteUser(userHashId: string): Promise<void> {
    this.ctx.requireAdmin();
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw Err.userNotFound();
    // 原版把 id=1 视为初始用户，禁止操作
    if (uid === 1) throw new AppError(40043, 'Cannot perform this action on the default user');
    await this.ctx.users.updateStatus(uid, 'sys_banned');
  }

  /** 站内用户搜索（分享页展示所有者等场景）。 */
  async search(keyword: string, limit = 20): Promise<UserResponse[]> {
    const { users } = await this.ctx.users.list({ page: 0, pageSize: limit, keyword });
    const out: UserResponse[] = [];
    for (const u of users) out.push(await this.buildUserResponse(u, false));
    return out;
  }

  /** 判断是否管理员（供路由与前端菜单使用）。 */
  isAdmin(user: UserWithGroup): boolean {
    const perms = user.group.permissions instanceof Uint8Array
      ? new BooleanSet(user.group.permissions)
      : BooleanSet.fromBase64(user.group.permissions as unknown as string);
    return perms.enabled(GroupPermission.IsAdmin);
  }
}

export { CodeNotFullySuccess };
