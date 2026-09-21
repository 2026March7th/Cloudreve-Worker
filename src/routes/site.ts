/**
 * 站点相关路由。对应 Cloudreve v4 的 `service/basic/site.go`。
 *
 *   GET /api/v4/site/ping                → 版本号字符串
 *   GET /api/v4/site/config/:section     → 站点配置（按 section 返回子集）
 *   GET /api/v4/site/captcha             → 验证码 { image, ticket }
 *
 * 各 section 的字段集合与 json tag 严格对齐原版 SiteConfig
 * （`service/basic/site.go`）。设置键名取自 `inventory/setting.go` 的
 * DefaultSettings，不要凭空造键 —— 造出来的键读到的永远是空值。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { ok } from '../lib/response';
import { randomString } from '../lib/crypto';
import { UserService } from '../services/user';
import { publicOidcInfo } from '../services/oidc';
import type { AppContext } from '../services/context';
import { kvFor } from '../lib/kvRouter';

const CAPTCHA_PREFIX = 'captcha:';
const CAPTCHA_TTL = 1800; // 与原版 CaptchaTTL 一致（30 分钟）

/**
 * 设置表里部分字段存的是 JSON 字符串，但原版 SiteConfig 在 Go 侧已
 * unmarshal 成结构化值再返回（如 `[]setting.CustomNavItem`、
 * `types.DefaultViewerMapping`），前端 redux slice 也按数组/对象消费。
 * 这里必须在服务端解析成真实类型；解析失败回退到空值而不是把原始
 * 字符串透传出去（字符串.length 会骗过前端判空，然后 .map 直接崩）。
 */
function parseJson<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}
/** 与原版 constants.BackendVersion 保持一致 */
export const BACKEND_VERSION = '4.14.0';

export const siteRoutes = new Hono<AppBindings>();

siteRoutes.get('/ping', (c) => {
  c.header('Cache-Control', 'no-cache');
  return ok(c, BACKEND_VERSION);
});

/**
 * 诊断端点：回显当前 Worker 实际拿到的 KV 绑定。
 *
 * 存在的意义：多 KV 的绑定是**编译期**决定的（`wrangler.toml` 的
 * `[[kv_namespaces]]`），配错了不会报错 —— `lib/kvRouter.ts` 会把缺失的
 * 角色静默回退到兜底 `KV`，于是「配了 5 个实际只生效 1 个」从外部看不出来。
 * 这个端点让「线上到底绑了几个」变成一条可以直接访问的 URL。
 *
 * 只暴露绑定**名字**，不含 ID、不含任何业务数据，无鉴权风险。
 */
siteRoutes.get('/kv-status', (c) => {
  c.header('Cache-Control', 'no-cache');
  const env = c.env as unknown as Record<string, unknown>;
  const present = listKvBindings(c.env);
  const roles = ['site', 'session', 'upload', 'cred', 'flag'] as const;

  // 每个角色实际落到哪个绑定 —— 直接反映回退结果。
  const resolved: Record<string, string> = {};
  for (const role of roles) {
    try {
      const ns = kvFor(c.env, role);
      resolved[role] = String((ns as unknown as { __kvBinding?: string }).__kvBinding ?? '?');
    } catch {
      resolved[role] = '(未绑定)';
    }
  }

  const distinct = new Set(Object.values(resolved));
  return ok(c, {
    bindings: present,
    kv_count: present.filter((b) => b !== 'KV').length,
    roles: resolved,
    // 角色实际落在几个不同的 namespace 上。=1 说明多 KV 没生效。
    distinct_namespaces: distinct.size,
    // 只有 KV_1 时 KV_COUNT_FILE / KV_COUNT 没被构建读到。
    hint: distinct.size === 1
      ? '所有角色都落在同一个 namespace：多 KV 未生效。检查构建时是否读到了 KV_COUNT（看图构建日志里的 "KV_COUNT = N（来源：…）"）。'
      : '多 KV 已生效。',
  });
});

/** 供诊断用：列出当前 env 上实际存在的 KV 绑定名。 */
function listKvBindings(env: unknown): string[] {
  const bindings = env as Record<string, unknown>;
  return Object.keys(bindings)
    .filter((k) => /^KV(_\d+)?$/.test(k))
    .sort();
}

siteRoutes.get('/config/:section', async (c) => {
  const ctx = ctxOf(c);
  const section = c.req.param('section');
  const s = ctx.settings;

  // 未登录时按匿名用户返回（原版 SiteConfig.User 由 BuildUser 构造，匿名时 id 为空）
  const userPayload = ctx.user
    ? await new UserService(ctx).buildUserResponse(ctx.user, true)
    : {
        id: '',
        nickname: '',
        created_at: new Date().toISOString(),
        anonymous: true,
        group: { id: '', name: '', permission: '' },
      };

  switch (section) {
    case 'login': {
      const oidc = publicOidcInfo(ctx);
      return ok(c, {
        login_captcha: s.loginCaptcha,
        reg_captcha: s.regCaptcha,
        forget_captcha: s.forgetCaptcha,
        authn: s.authnEnabled,
        register_enabled: s.registerEnabled,
        tos_url: s.get('tos_url', ''),
        privacy_policy_url: s.get('privacy_policy_url', ''),
        // 第三方登录（OIDC）：登录页据此显示「使用 XX 登录」按钮
        oidc_enabled: oidc.enabled,
        oidc_name: oidc.name,
      }) as never;
    }

    case 'explorer':
      // JSON 型字段（file_viewers / default_viewer_mapping / custom_props）
      // 原版返回结构化值，必须 parse 后再给前端；icons 上游就是字符串原样。
      return ok(c, {
        max_batch_size: s.maxBatchedFile,
        file_viewers: parseJson(s.get('file_viewers', '[]'), [] as unknown[]),
        default_viewer_mapping: parseJson(s.get('viewer_default_apps', '{}'), {}),
        icons: s.get('explorer_icons', '[]'),
        map_provider: s.get('map_provider', 'openstreetmap'),
        google_map_tile_type: s.get('map_google_tile_type', 'roadmap'),
        mapbox_ak: s.get('map_mapbox_ak', ''),
        thumbnail_width: parseInt(s.get('thumb_width', '400'), 10) || 400,
        thumbnail_height: parseInt(s.get('thumb_height', '300'), 10) || 300,
        custom_props: parseJson(s.get('custom_props', '[]'), [] as unknown[]),
        show_encryption_status: s.getBool('show_encryption_status', true),
        full_text_search: s.getBool('fts_enabled', false),
      }) as never;

    case 'emojis':
      return ok(c, { emoji_preset: s.get('emojis', '{}') }) as never;

    case 'app':
      return ok(c, {
        app_promotion: s.getBool('show_app_promotion', false),
        desktop_app_promotion: s.getBool('show_desktop_app_promotion', false),
      }) as never;

    case 'thumb':
      // 原版汇总各服务端缩略图生成器（builtin / ffmpeg / vips / libreoffice…）
      // 支持的后缀。边缘版不做服务端生成，只能上报「存储驱动自己声明支持的」后缀，
      // 也就是各策略 settings 里的 thumb_exts（与驱动 ThumbSupportedExts 一致）。
      return ok(c, { thumb_exts: await collectThumbExts(ctx) }) as never;

    default:
      return ok(c, {
        instance_id: s.siteId,
        title: s.siteName,
        themes: s.get('theme_options', '{}'),
        default_theme: s.get('defaultTheme', ''),
        user: userPayload,
        logo: s.get('site_logo', '/static/img/logo.svg'),
        logo_light: s.get('site_logo_light', '/static/img/logo_light.svg'),
        custom_nav_items: parseJson(s.get('custom_nav_items', '[]'), [] as unknown[]),
        custom_html: {
          headless_footer: s.get('headless_footer_html', ''),
          headless_bottom: s.get('headless_bottom_html', ''),
          sidebar_bottom: s.get('sidebar_bottom_html', ''),
        },
        captcha_type: s.get('captcha_type', ''),
        turnstile_site_id: s.get('captcha_turnstile_site_key', ''),
        captcha_ReCaptchaKey: s.get('captcha_ReCaptchaKey', ''),
        captcha_cap_instance_url: s.get('captcha_cap_instance_url', ''),
        captcha_cap_site_key: s.get('captcha_cap_site_key', ''),
        captcha_cap_asset_server: s.get('captcha_cap_asset_server', ''),
        app_promotion: s.getBool('show_app_promotion', false),
        // 增值服务（edge 自建 Pro 功能）：商店导航显隐与货币展示
        shop_nav_enabled: s.getBool('shop_nav_enabled', false),
        credit_enabled: s.getBool('credit_enabled', false),
        currency_code: s.get('currency_code', 'CNY'),
        currency_symbol: s.get('currency_symbol', '¥'),
        currency_unit: s.getInt('currency_unit', 100),
      }) as never;
  }
});

/** 汇总所有策略里声明的缩略图后缀（去重、排序）。 */
async function collectThumbExts(ctx: ReturnType<typeof ctxOf>): Promise<string[]> {
  const policies = await ctx.policies.list();
  const exts = new Set<string>();
  for (const policy of policies) {
    const declared = policy.settings?.thumb_exts;
    if (Array.isArray(declared)) {
      for (const e of declared) {
        if (typeof e === 'string' && e) exts.add(e.toLowerCase());
      }
    }
  }
  return [...exts].sort();
}

/**
 * 简单验证码：生成一个 SVG 图片，答案存在 KV 里，ticket 是取回答案的凭据。
 * 原版依赖 gocaptcha 生成位图并支持 reCAPTCHA / Turnstile 等；边缘版只保留
 * 内置的 SVG 验证码，足够自用（见 README「已知差异」）。
 */
siteRoutes.get('/captcha', async (c) => {
  const code = randomString(5).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4).padEnd(4, 'A');
  const ticket = randomString(32);
  await kvFor(c.env, 'session').put(`${CAPTCHA_PREFIX}${ticket}`, code, { expirationTtl: CAPTCHA_TTL });

  const noise = Array.from({ length: 6 }, () => {
    const x1 = Math.floor(Math.random() * 140);
    const y1 = Math.floor(Math.random() * 50);
    const x2 = Math.floor(Math.random() * 140);
    const y2 = Math.floor(Math.random() * 50);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#999" stroke-width="1"/>`;
  }).join('');

  const chars = code
    .split('')
    .map((ch, i) => {
      const x = 18 + i * 32;
      const y = 36 + (Math.random() * 6 - 3);
      const rot = Math.floor(Math.random() * 40) - 20;
      return `<text x="${x}" y="${y}" font-size="28" font-family="monospace" fill="#222" transform="rotate(${rot} ${x} ${y})">${ch}</text>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="50" viewBox="0 0 140 50"><rect width="140" height="50" fill="#f2f2f2"/>${noise}${chars}</svg>`;
  const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;

  return ok(c, { image: dataUrl, ticket }) as never;
});

/**
 * 校验验证码（供登录/注册/找回密码流程调用）。
 *
 * 对齐上游 `middleware.CaptchaRequired`（middleware/captcha.go）：
 * 按 `captcha_type` 分派——
 *   - turnstile → Cloudflare Turnstile siteverify（token 在 ticket 字段）；
 *   - recaptcha → reCAPTCHA v2 siteverify（token 在 captcha 字段）；
 *   - cap       → Cap 2.0 `/{siteKey}/siteverify`（token 在 ticket 字段）；
 *   - normal / tcaptcha / 空 → 内置 SVG 验证码（ticket ↔ KV 答案）。
 */
export async function verifyCaptcha(
  ctx: AppContext,
  ticket: string | undefined | null,
  value: string | undefined | null,
): Promise<boolean> {
  try {
    return await verifyCaptchaInner(ctx, ticket, value);
  } catch (e) {
    // 验证码校验绝不能让请求挂掉：调用方（登录/注册/找回密码）都在 try 之外
    // 调它，抛出去就是未捕获 rejection → Cloudflare 回 520。
    // 外部站点（recaptcha / turnstile / cap）不可达或返回体异常时统一判失败，
    // 由调用方回 40026，前端能看到明确报错而不是 520。
    console.error('captcha verification failed:', e);
    return false;
  }
}

/** 真正的校验逻辑，见 `verifyCaptcha` 的说明。任何异常都由外层兜住。 */
async function verifyCaptchaInner(
  ctx: AppContext,
  ticket: string | undefined | null,
  value: string | undefined | null,
): Promise<boolean> {
  const type = ctx.settings.get('captcha_type', '') || 'normal';

  const formPost = async (endpoint: string, body: string): Promise<unknown> => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        // 外部校验站点挂掉/被墙时不能拖着整个请求：超时按校验失败处理。
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      return (await res.json().catch(() => null)) as unknown;
    } catch {
      return null;
    }
  };

  if (type === 'turnstile') {
    const secret = ctx.settings.get('captcha_turnstile_site_secret', '');
    if (!secret || !ticket) return false;
    const json = (await formPost(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({ secret, response: ticket }).toString(),
    )) as { success?: boolean } | null;
    return json?.success === true;
  }

  if (type === 'recaptcha') {
    const secret = ctx.settings.get('captcha_ReCaptchaSecret', '');
    if (!secret || !value) return false;
    const json = (await formPost(
      'https://www.recaptcha.net/recaptcha/api/siteverify',
      new URLSearchParams({ secret, response: value }).toString(),
    )) as { success?: boolean } | null;
    return json?.success === true;
  }

  if (type === 'cap') {
    // Cap 2.0 API：POST {instance}/{siteKey}/siteverify，JSON 体
    const instance = ctx.settings.get('captcha_cap_instance_url', '').replace(/\/+$/, '');
    const siteKey = ctx.settings.get('captcha_cap_site_key', '');
    const secret = ctx.settings.get('captcha_cap_secret_key', '');
    if (!instance || !siteKey || !secret || !ticket) return false;
    try {
      const res = await fetch(`${instance}/${siteKey}/siteverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: ticket }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return false;
      const json = (await res.json().catch(() => null)) as { success?: boolean } | null;
      return json?.success === true;
    } catch {
      return false;
    }
  }

  // normal / tcaptcha：内置 SVG 验证码
  if (!ticket || !value) return false;
  const expected = await kvFor(ctx.env, 'session').get(`${CAPTCHA_PREFIX}${ticket}`);
  if (!expected) return false;
  await kvFor(ctx.env, 'session').delete(`${CAPTCHA_PREFIX}${ticket}`); // 一次性
  return expected.toUpperCase() === value.toUpperCase();
}
