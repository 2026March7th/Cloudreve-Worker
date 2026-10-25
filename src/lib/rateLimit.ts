/**
 * 简易速率限制（KV 固定窗口计数）。
 *
 * 用途：登录、2FA、注册、找回密码、分享密码这些「猜口令」入口。之前**一个都
 * 没有** —— 密码最短 4 位 + 无锁定 + 无 IP 限速，等于把在线爆破的门敞开。
 *
 * 设计取舍：
 *   - 用 **窗口序号进键**（`rl:<bucket>:<window>:<id>`）而不是「读-改-写同一个键」，
 *     这样跨窗口不会互相污染计数，也不需要本地状态。
 *   - Workers KV 是最终一致的，读-改-写**不是原子**的：极短时间内的高并发
 *     可能少记几次。对「把爆破成本抬到不现实」这个目标足够；要严格原子得换
 *     Durable Object 或库里建表，那是另一种量级的延迟。
 *   - KV 没绑定时**放行**（fail-open）：宁可少一层防护，也不能因为配置缺失把
 *     所有人锁在门外。部署里 KV 一定在，这条只是兜底。
 */
import type { Env } from '../env';
import { kvFor } from './kvRouter';

export interface RateLimitOptions {
  /** 限速维度名，例如 `login:email`、`share:pwd` */
  bucket: string;
  /** 具体对象：IP、邮箱、分享 id…… */
  id: string;
  /** 窗口内允许的次数 */
  limit: number;
  /** 窗口长度（秒） */
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** 还要等多久（秒），ok=true 时为 0 */
  retryAfter: number;
}

function windowIndexOf(windowSec: number): number {
  return Math.floor(Date.now() / (windowSec * 1000));
}

function keyOf(opts: RateLimitOptions, window: number): string {
  // id 里可能是邮箱/带冒号的东西，统一转义，避免拼出歧义的键
  return `rl:${opts.bucket}:${window}:${encodeURIComponent(opts.id)}`;
}

/**
 * 记一次访问。返回 `ok=false` 表示已超限（**本次也要算进去**，
 * 否则超限期间请求不计费，窗口一过又能打满一轮）。
 */
export async function hitRateLimit(env: Env, opts: RateLimitOptions): Promise<RateLimitResult> {
  const kv = kvFor(env, 'session');
  if (!kv) return { ok: true, retryAfter: 0 };

  const window = windowIndexOf(opts.windowSec);
  const key = keyOf(opts, window);
  try {
    const raw = await kv.get(key);
    const count = Number(raw ?? 0);
    if (count >= opts.limit) {
      const elapsed = Math.floor((Date.now() / 1000) % opts.windowSec);
      return { ok: false, retryAfter: Math.max(1, opts.windowSec - elapsed) };
    }
    // 多留 10 秒余量：KV 的 expirationTtl 最小值是 60，短窗口靠窗口序号自然作废
    await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, opts.windowSec + 10) });
    return { ok: true, retryAfter: 0 };
  } catch {
    return { ok: true, retryAfter: 0 };
  }
}

/** 成功之后清掉计数（例如登录成功就别再拦这个人了）。 */
export async function clearRateLimit(env: Env, opts: RateLimitOptions): Promise<void> {
  const kv = kvFor(env, 'session');
  if (!kv) return;
  try {
    await kv.delete(keyOf(opts, windowIndexOf(opts.windowSec)));
  } catch {
    /* 尽力而为 */
  }
}

/** 取客户端 IP。Workers 上 `CF-Connecting-IP` 一定有；本地/测试回落到 XFF。 */
export function clientIp(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const cf = c.req.header('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = c.req.header('X-Forwarded-For');
  if (xff) return (xff.split(',')[0] ?? '').trim();
  return 'unknown';
}

/**
 * 常用策略集中放这里，避免各处凭感觉写数字。
 * 单位都是「每个窗口」。
 */
export const RATE_LIMITS = {
  /** 同一邮箱登录：10 次 / 分钟（正常用户不会打这么快） */
  loginByEmail: { bucket: 'login:email', limit: 10, windowSec: 60 },
  /** 同一 IP 登录：40 次 / 分钟（网吧/公司出口共用 IP 也要留余量） */
  loginByIp: { bucket: 'login:ip', limit: 40, windowSec: 60 },
  /** 同一 2FA 会话：6 次 / 分钟（6 位 TOTP 打满要 100 万年） */
  twoFactor: { bucket: 'login:2fa', limit: 6, windowSec: 60 },
  /** 同一 IP 注册：5 次 / 分钟 */
  registerByIp: { bucket: 'register:ip', limit: 5, windowSec: 60 },
  /** 同一 IP 发找回密码邮件：3 次 / 5 分钟（防被当成邮件轰炸机） */
  resetByIp: { bucket: 'reset:ip', limit: 3, windowSec: 300 },
  /** 同一分享 + IP 猜密码：10 次 / 分钟 */
  sharePassword: { bucket: 'share:pwd', limit: 10, windowSec: 60 },
} as const;
