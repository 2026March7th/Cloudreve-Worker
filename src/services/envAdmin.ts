/**
 * 环境变量兜底管理员。
 *
 * 对应一个真实场景：部署者没有本机（手机上一键部署），站长把管理员
 * 账号搞丢了，或者第一个注册者占掉了管理员组。在部署环境里配
 * ADMIN_EMAIL + ADMIN_PASSWORD（建议用 Secret）后，Worker 会保证：
 *
 *   - 该邮箱存在（不存在就创建）；
 *   - 密码与 ADMIN_PASSWORD 一致；
 *   - 属于管理员组（id = 1）且处于激活状态。
 *
 * 幂等与失效：把「email + 密码摘要」的 SHA-256 记在 KV 里，只有这对
 * 环境变量的**值发生变化**时才重新落库 —— 站长事后在网页里改密码不会
 * 被下次冷启动覆盖；删掉这对环境变量则什么都不做（账号原样保留）。
 *
 * 密码摘要是带随机盐的（`lib/crypto.ts` digestPassword），两次摘要必然
 * 不同，所以不能靠「摘要是否相等」判断要不要写 —— 判断依据只有 KV 标记。
 */
import type { Env } from '../env';
import { digestPassword } from '../lib/crypto';
import { FileRepo, UserRepo } from '../db/repo';

const MARKER_KEY = 'bootstrap:env-admin:v1';

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** 检查并应用环境变量里的管理员配置。未配置时直接返回。 */
export async function ensureEnvAdmin(env: Env): Promise<void> {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const digest = await digestPassword(password);
  const marker = toHex(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${email}:${digest}`)),
  );
  if ((await env.KV.get(MARKER_KEY)) === marker) return;

  const users = new UserRepo(env);
  const existing = await users.byEmailWithGroup(email);
  if (existing) {
    await users.updatePassword(existing.id, digest);
    if (existing.group.id !== 1) await users.updateGroup(existing.id, 1);
    if (existing.status !== 'active') await users.updateStatus(existing.id, 'active');
  } else {
    const user = await users.create({
      email,
      nick: email.split('@')[0] ?? email,
      passwordDigest: digest,
      groupId: 1,
      status: 'active',
    });
    await new FileRepo(env).ensureRoot(user.id);
  }
  await env.KV.put(MARKER_KEY, marker);
}
