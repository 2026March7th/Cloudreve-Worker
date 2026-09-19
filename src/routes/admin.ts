/**
 * 管理后台路由。对应 Cloudreve v4 `routers/router.go` 的 admin 分组。
 *
 * 已实现：
 *   GET    /api/v4/admin/summary              概览统计
 *   POST   /api/v4/admin/settings             读取设置
 *   PATCH  /api/v4/admin/settings             修改设置
 *   POST   /api/v4/admin/group                用户组列表
 *   GET    /api/v4/admin/group/:id            单个用户组
 *   PUT    /api/v4/admin/group                新建用户组
 *   PUT    /api/v4/admin/group/:id            更新用户组
 *   DELETE /api/v4/admin/group/:id            删除用户组
 *   POST   /api/v4/admin/user                 用户列表
 *   PATCH  /api/v4/admin/user/:id             修改用户
 *   DELETE /api/v4/admin/user/:id             封禁用户
 *   POST   /api/v4/admin/policy               存储策略列表
 *   PUT    /api/v4/admin/policy               新建策略
 *   PUT    /api/v4/admin/policy/:id           更新策略
 *   DELETE /api/v4/admin/policy/:id           删除策略
 *   POST   /api/v4/admin/queue                任务列表
 *
 * 未实现（返回「未启用」）：邮件测试、WOPI 探测、缩略图生成器测试、
 * 实体 URL 缓存清理、任务清理与批量删除、文件导入。
 *
 * 付费/订单/兑换码相关的一切在原版社区版里就不存在，边缘版同样没有。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { UserService } from '../services/user';
import { BooleanSet, GroupPermission } from '../lib/boolset';
import { AppError, CodeFeatureNotEnabled, Err } from '../lib/errors';
import { invalidateSettings } from '../settings/provider';
import { SUPPORTED_POLICY_TYPES, isPolicyTypeSupported } from '../storage';
import { BACKEND_VERSION } from './site';
import { toByteaLiteral } from '../db';
import type { HashIDCodec } from '../lib/hashid';
import type { GroupRow, StoragePolicyRow } from '../db/types';

export const adminRoutes = new Hono<AppBindings>();

/** 所有管理端点统一先做管理员校验。 */
adminRoutes.use('*', async (c, next) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  if (!ctx.isAdmin) return c.json(fail(c, Err.adminRequired()) as never);
  await next();
});

/** 概览 */
adminRoutes.get('/summary', async (c) => {
  const ctx = ctxOf(c);
  const userCount = await ctx.users.countAll();
  const policies = await ctx.policies.list();
  const tasksByStatus = await ctx.tasks.countByStatus();
  const pendingTasks = (tasksByStatus.queued ?? 0) + (tasksByStatus.processing ?? 0);

  // 站点容量：累加所有策略下实体的总大小
  const sql = (await import('../db')).getSql(ctx.env);
  const sizeRows = (await sql`
    SELECT COALESCE(SUM(size), 0) AS total FROM entities
    WHERE deleted_at IS NULL AND reference_count > 0 AND type = 0
  `) as Record<string, unknown>[];

  return c.json(
    ok(c, {
      site_url: ctx.settings.siteUrl,
      version: BACKEND_VERSION,
      user_count: userCount,
      // 原版 Pro 标志恒为 false
      pro: false,
      capacity: Number((sizeRows[0]?.total as string) ?? 0),
      pending_tasks: pendingTasks,
      policy_count: policies.length,
      supported_policies: SUPPORTED_POLICY_TYPES,
    }) as never,
  );
});

/** 读取设置 */
adminRoutes.post('/settings', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { keys?: string[] };
  const sql = (await import('../db')).getSql(ctx.env);
  const rows = (await sql`
    SELECT name, value FROM settings WHERE deleted_at IS NULL ORDER BY name ASC
  `) as { name: string; value: string | null }[];

  const out: Record<string, string> = {};
  for (const r of rows) {
    if (body.keys?.length && !body.keys.includes(r.name)) continue;
    out[r.name] = r.value ?? '';
  }
  return c.json(ok(c, out) as never);
});

/** 修改设置 */
adminRoutes.patch('/settings', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    return c.json(fail(c, Err.param('No settings provided')) as never);
  }

  const sql = (await import('../db')).getSql(ctx.env);
  const updated: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    // 密钥类字段禁止通过接口读回，但仍然允许写入
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    await sql`
      INSERT INTO settings (name, value) VALUES (${key}, ${strValue})
      ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    updated.push(key);
  }
  await invalidateSettings(ctx.env);
  return c.json(ok(c, { updated }) as never);
});

// ---------------------------------------------------------------------------
// 用户组
// ---------------------------------------------------------------------------

function groupToResponse(codec: HashIDCodec, group: GroupRow) {
  const perms = group.permissions instanceof Uint8Array
    ? new BooleanSet(group.permissions)
    : BooleanSet.fromBase64(group.permissions as unknown as string);

  return {
    id: codec.encodeGroupID(group.id),
    name: group.name,
    max_storage: group.max_storage === null || group.max_storage === undefined
      ? 0
      : Number(group.max_storage),
    speed_limit: group.speed_limit ?? 0,
    permission: perms.toBase64(),
    settings: group.settings ?? {},
    storage_policy_id: group.storage_policy_id
      ? codec.encodePolicyID(group.storage_policy_id)
      : '',
  };
}

adminRoutes.post('/group', async (c) => {
  const ctx = ctxOf(c);
  const groups = await ctx.groups.list();
  const out = [];
  for (const g of groups) {
    const item = groupToResponse(ctx.codec, g);
    out.push({ ...item, user_count: await ctx.groups.countUsers(g.id) });
  }
  return c.json(ok(c, { groups: out }) as never);
});

adminRoutes.get('/group/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodeGroupID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(40039, 'Group not found')) as never);
  const group = await ctx.groups.byId(id);
  if (!group) return c.json(fail(c, new AppError(40039, 'Group not found')) as never);
  return c.json(ok(c, groupToResponse(ctx.codec, group)) as never);
});

/** 从请求体解析权限位集：接受 base64 字符串或权限位号数组。 */
function parsePermission(input: unknown, fallback: BooleanSet): BooleanSet {
  if (Array.isArray(input)) {
    const bs = new BooleanSet();
    for (const bit of input) {
      if (typeof bit === 'number' && bit >= 0 && bit <= 64) bs.set(bit, true);
    }
    return bs;
  }
  if (typeof input === 'string') return BooleanSet.fromBase64(input);
  return fallback;
}

adminRoutes.put('/group', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!body.name) return c.json(fail(c, Err.param('name is required')) as never);

  const perms = parsePermission(body.permission, new BooleanSet());
  let policyId: number | null = null;
  if (typeof body.storage_policy_id === 'string' && body.storage_policy_id) {
    policyId = ctx.codec.decodePolicyID(body.storage_policy_id);
  }

  try {
    const group = await ctx.groups.create({
      name: String(body.name),
      maxStorage: body.max_storage !== undefined ? Number(body.max_storage) : null,
      speedLimit: body.speed_limit !== undefined ? Number(body.speed_limit) : null,
      permissions: perms.toBytes(),
      settings: (body.settings as Record<string, unknown>) ?? {},
      storagePolicyId: policyId,
    });
    return c.json(ok(c, groupToResponse(ctx.codec, group)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

adminRoutes.put('/group/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodeGroupID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(40039, 'Group not found')) as never);
  const group = await ctx.groups.byId(id);
  if (!group) return c.json(fail(c, new AppError(40039, 'Group not found')) as never);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof ctx.groups.patch>[1] = {};

  if (body.name !== undefined) patch.name = String(body.name);

  // max_storage = -1 在原版表示「不限量」，这里映射为 NULL
  if (body.max_storage !== undefined) {
    const v = Number(body.max_storage);
    patch.maxStorage = v < 0 ? null : v;
  }
  if (body.speed_limit !== undefined) patch.speedLimit = Number(body.speed_limit);
  if (body.permission !== undefined) {
    patch.permissions = parsePermission(body.permission, new BooleanSet()).toBytes();
  }
  if (body.settings !== undefined) patch.settings = body.settings as Record<string, unknown>;
  if (body.storage_policy_id !== undefined) {
    const raw = body.storage_policy_id;
    patch.storagePolicyId =
      typeof raw === 'string' && raw ? ctx.codec.decodePolicyID(raw) : null;
  }

  try {
    await ctx.groups.patch(id, patch);
    const updated = await ctx.groups.byId(id);
    return c.json(ok(c, groupToResponse(ctx.codec, updated!)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

adminRoutes.delete('/group/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodeGroupID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(40039, 'Group not found')) as never);

  // 系统内置组（1=管理员 2=默认用户 3=匿名）禁止删除，与原版一致
  if ([1, 2, 3].includes(id)) {
    return c.json(fail(c, new AppError(40040, 'Cannot perform this action on system group')) as never);
  }
  const used = await ctx.groups.countUsers(id);
  if (used > 0) {
    return c.json(fail(c, new AppError(40041, 'This group is being used by users')) as never);
  }
  await ctx.groups.softDelete(id);
  return c.json(ok(c) as never);
});

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

adminRoutes.post('/user', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const pageSize = Math.min(Number(body.page_size ?? 20) || 20, 100);

  try {
    const res = await new UserService(ctx).listUsers({
      page: Number(body.page ?? 0) || 0,
      pageSize,
      orderBy: body.order_by as string | undefined,
      orderDirection: body.order_direction as string | undefined,
      keyword: body.keyword as string | undefined,
      groupId: body.group_id as string | undefined,
      status: body.status as string | undefined,
    });
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

adminRoutes.patch('/user/:id', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const service = new UserService(ctx);
    await service.adminUpdateUser(c.req.param('id'), {
      groupId: body.group_id as string | undefined,
      status: body.status as string | undefined,
      nick: body.nick as string | undefined,
      email: body.email as string | undefined,
    });
    if (body.new_password) {
      await service.resetUserPassword(c.req.param('id'), String(body.new_password));
    }
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

adminRoutes.delete('/user/:id', async (c) => {
  const ctx = ctxOf(c);
  try {
    await new UserService(ctx).deleteUser(c.req.param('id'));
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 存储策略
// ---------------------------------------------------------------------------

function policyToResponse(codec: HashIDCodec, policy: StoragePolicyRow, includeSecrets = false) {
  const out: Record<string, unknown> = {
    id: codec.encodePolicyID(policy.id),
    name: policy.name,
    type: policy.type,
    server: policy.server ?? '',
    bucket_name: policy.bucket_name ?? '',
    is_private: policy.is_private === true,
    max_size: Number(policy.max_size ?? 0),
    dir_name_rule: policy.dir_name_rule ?? '',
    file_name_rule: policy.file_name_rule ?? '',
    settings: policy.settings ?? {},
    supported: isPolicyTypeSupported(policy.type),
  };
  if (includeSecrets) {
    // 与原版一致：密钥字段只在创建/更新时写入，读取时留空
    out.access_key = '';
    out.secret_key = '';
  }
  return out;
}

adminRoutes.post('/policy', async (c) => {
  const ctx = ctxOf(c);
  const policies = await ctx.policies.list();
  return c.json(
    ok(c, {
      policies: policies.map((p) => policyToResponse(ctx.codec, p)),
      supported_types: SUPPORTED_POLICY_TYPES,
    }) as never,
  );
});

adminRoutes.put('/policy', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!body.name || !body.type) {
    return c.json(fail(c, Err.param('name and type are required')) as never);
  }
  const type = String(body.type);
  if (!isPolicyTypeSupported(type)) {
    return c.json(
      fail(c, new AppError(40006, `Policy type "${type}" is not supported by the edge build`)) as never,
    );
  }
  try {
    const policy = await ctx.policies.create({
      name: String(body.name),
      type,
      server: (body.server as string) || null,
      bucketName: (body.bucket_name as string) || null,
      isPrivate: body.is_private as boolean | undefined,
      accessKey: (body.access_key as string) || null,
      secretKey: (body.secret_key as string) || null,
      maxSize: body.max_size !== undefined ? Number(body.max_size) : null,
      dirNameRule: (body.dir_name_rule as string) || null,
      fileNameRule: (body.file_name_rule as string) || null,
      settings: (body.settings as Record<string, unknown>) ?? {},
    });
    return c.json(ok(c, policyToResponse(ctx.codec, policy, true)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

adminRoutes.put('/policy/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodePolicyID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(40035, 'Policy not found')) as never);
  const policy = await ctx.policies.byId(id);
  if (!policy) return c.json(fail(c, new AppError(40035, 'Policy not found')) as never);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.type !== undefined && !isPolicyTypeSupported(String(body.type))) {
    return c.json(
      fail(c, new AppError(40006, `Policy type "${body.type}" is not supported`)) as never,
    );
  }

  try {
    await ctx.policies.update(
      id,
      {
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.type !== undefined ? { type: String(body.type) } : {}),
        ...(body.server !== undefined ? { server: (body.server as string) || null } : {}),
        ...(body.bucket_name !== undefined ? { bucket_name: (body.bucket_name as string) || null } : {}),
        ...(body.is_private !== undefined ? { is_private: body.is_private as boolean } : {}),
        ...(body.max_size !== undefined ? { max_size: Number(body.max_size) } : {}),
        ...(body.dir_name_rule !== undefined ? { dir_name_rule: body.dir_name_rule as string } : {}),
        ...(body.file_name_rule !== undefined ? { file_name_rule: body.file_name_rule as string } : {}),
        ...(body.settings !== undefined ? { settings: body.settings } : {}),
      },
      {
        // 空字符串表示「不改动」——避免前端回填空值把密钥清掉
        ...(body.access_key ? { accessKey: String(body.access_key) } : {}),
        ...(body.secret_key ? { secretKey: String(body.secret_key) } : {}),
      },
    );
    // 策略改动后，指向该策略的 OneDrive 凭证缓存需要失效
    await ctx.env.KV.delete(`cred_od_${id}`);
    const updated = await ctx.policies.byId(id);
    return c.json(ok(c, policyToResponse(ctx.codec, updated!, true)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

adminRoutes.delete('/policy/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodePolicyID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(40035, 'Policy not found')) as never);

  const fileCount = await ctx.policies.countFiles(id);
  if (fileCount > 0) {
    return c.json(fail(c, new AppError(40037, 'This policy still has files')) as never);
  }
  const groupCount = await ctx.policies.countGroups(id);
  if (groupCount > 0) {
    return c.json(fail(c, new AppError(40038, 'This policy is bound to user groups')) as never);
  }
  await ctx.policies.softDelete(id);
  return c.json(ok(c) as never);
});

/** 生成 OneDrive 授权链接（后台配置策略时用）。 */
adminRoutes.get('/policy/:id/oauth', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodePolicyID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(40035, 'Policy not found')) as never);
  const policy = await ctx.policies.byId(id);
  if (!policy) return c.json(fail(c, new AppError(40035, 'Policy not found')) as never);
  if (policy.type !== 'onedrive') {
    return c.json(fail(c, Err.param('Policy is not an OneDrive policy')) as never);
  }

  const { OneDriveDriver } = await import('../storage/onedrive');
  const driver = new OneDriveDriver(ctx.env, policy);
  // scope 与原版 service/admin/policy.go 一致
  return c.json(ok(c, { url: driver.authorizeUrl(['offline_access', 'files.readwrite.all']) }) as never);
});

/** 任务列表 */
adminRoutes.post('/queue', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { page_size?: number };
  const byStatus = await ctx.tasks.countByStatus();
  return c.json(
    ok(c, {
      tasks: [],
      pagination: { page: 0, page_size: Number(body.page_size ?? 20) || 20, total_items: 0 },
      metrics: { by_status: byStatus },
    }) as never,
  );
});

// ---------------------------------------------------------------------------
// 未实现的工具端点
// ---------------------------------------------------------------------------

const NOT_IMPLEMENTED_ADMIN: Record<string, string> = {
  '/tool/mail': 'SMTP delivery is not implemented in the edge build',
  '/tool/wopi': 'WOPI discovery is not implemented in the edge build',
  '/tool/thumbExecutable': 'Thumbnail generation is not implemented in the edge build',
  '/tool/entityUrlCache': 'Entity URL cache clearing is not implemented in the edge build',
  '/queue/:id': 'Task inspection is not implemented in the edge build',
  '/queue/batch/delete': 'Task management is not implemented in the edge build',
  '/queue/cleanup': 'Task cleanup is not implemented in the edge build',
};

for (const [path, message] of Object.entries(NOT_IMPLEMENTED_ADMIN)) {
  adminRoutes.all(path, (c) =>
    c.json(fail(c, new AppError(CodeFeatureNotEnabled, message)) as never),
  );
}

export { toByteaLiteral, GroupPermission };
