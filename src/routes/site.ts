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
import { backupDatabaseUrls, databaseUrls, failoverEnabled } from '../db';
import { archiveCount, archiveEnabled } from '../services/archive';
import { walUnfinished } from '../services/wal';
import { purgeAllCaches, warmAllCaches } from '../services/cacheWarmer';
import { CACHE_ENTRIES, purgeableEntries } from '../lib/cacheRegistry';

const CAPTCHA_PREFIX = 'captcha:';
const CAPTCHA_TTL = 1800; // 与原版 CaptchaTTL 一致（30 分钟）

/**
 * 内置「文件查看器」默认定义。与上游 `inventory/setting.go` 的
 * `defaultFileViewers` 逐字段对齐（JSON snake_case；type 取值
 * builtin / custom；archive 的 required_group_permission=[5] 即
 * GroupPermissionArchiveTask，与边缘版 boolset 位表一致）。
 *
 * 前端预览器注册表完全由 explorer 配置的 `file_viewers` 构建——
 * 上游安装时会播种这组默认值；边缘版不落库（省一次 BOOTSTRAP_FLAG
 * 迁移），settings 键缺失时用这里的默认值，管理员在后台
 * 「文件系统 → 文件查看器」保存过的自定义配置会自然覆盖它。
 */
const DEFAULT_FILE_VIEWERS = JSON.stringify([
  {
    viewers: [
      {
        id: 'music',
        type: 'builtin',
        display_name: 'fileManager.musicPlayer',
        exts: ['mp3', 'ogg', 'wav', 'flac', 'm4a'],
      },
      {
        id: 'epub',
        type: 'builtin',
        display_name: 'fileManager.epubViewer',
        exts: ['epub'],
      },
      {
        id: 'googledocs',
        type: 'custom',
        display_name: 'fileManager.googledocs',
        icon: '/static/img/viewers/gdrive.png',
        url: 'https://docs.google.com/gview?url={$src}&embedded=true',
        exts: [
          'jpeg', 'png', 'gif', 'tiff', 'bmp', 'webm', 'mpeg4', '3gpp', 'mov', 'avi',
          'mpegps', 'wmv', 'flv', 'txt', 'css', 'html', 'php', 'c', 'cpp', 'h', 'hpp',
          'js', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'pages', 'ai',
          'psd', 'tiff', 'dxf', 'svg', 'eps', 'ps', 'ttf', 'xps',
        ],
        max_size: 26214400,
      },
      {
        id: 'm365online',
        type: 'custom',
        display_name: 'fileManager.m365viewer',
        icon: '/static/img/viewers/m365.svg',
        url: 'https://view.officeapps.live.com/op/view.aspx?src={$src}',
        exts: [
          'doc', 'docx', 'docm', 'dotm', 'dotx', 'xlsx', 'xlsb', 'xls', 'xlsm',
          'pptx', 'ppsx', 'ppt', 'pps', 'pptm', 'potm', 'ppam', 'potx', 'ppsm',
        ],
        max_size: 10485760,
      },
      {
        id: 'pdf',
        type: 'builtin',
        display_name: 'fileManager.pdfViewer',
        exts: ['pdf'],
      },
      {
        id: 'video',
        type: 'builtin',
        icon: '/static/img/viewers/artplayer.png',
        display_name: 'Artplayer',
        exts: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'm3u8', 'flv'],
      },
      {
        id: 'markdown',
        type: 'builtin',
        display_name: 'fileManager.markdownEditor',
        exts: ['md'],
        templates: [{ ext: 'md', display_name: 'Markdown' }],
      },
      {
        id: 'drawio',
        type: 'builtin',
        icon: '/static/img/viewers/drawio.svg',
        display_name: 'draw.io',
        exts: ['drawio', 'dwb'],
        props: { host: 'https://embed.diagrams.net' },
        templates: [
          { ext: 'drawio', display_name: 'fileManager.diagram' },
          { ext: 'dwb', display_name: 'fileManager.whiteboard' },
        ],
      },
      {
        id: 'image',
        type: 'builtin',
        display_name: 'fileManager.imageViewer',
        exts: ['bmp', 'png', 'gif', 'jpg', 'jpeg', 'svg', 'webp', 'heic', 'heif'],
      },
      {
        id: 'monaco',
        type: 'builtin',
        icon: '/static/img/viewers/monaco.svg',
        display_name: 'fileManager.monacoEditor',
        exts: [
          'md', 'txt', 'json', 'php', 'py', 'bat', 'c', 'h', 'cpp', 'hpp', 'cs',
          'css', 'dockerfile', 'go', 'html', 'htm', 'ini', 'java', 'js', 'jsx',
          'less', 'lua', 'sh', 'sql', 'xml', 'yaml',
        ],
        templates: [{ ext: 'txt', display_name: 'fileManager.text' }],
      },
      {
        id: 'photopea',
        type: 'builtin',
        icon: '/static/img/viewers/photopea.png',
        display_name: 'Photopea',
        exts: [
          'psd', 'ai', 'indd', 'xcf', 'xd', 'fig', 'kri', 'clip', 'pxd', 'pxz',
          'cdr', 'ufo', 'afphoyo', 'svg', 'esp', 'pdf', 'pdn', 'wmf', 'emf', 'png',
          'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp', 'avif', 'heic', 'jxl',
          'ppm', 'pgm', 'pbm', 'tiff', 'dds', 'iff', 'anim', 'tga', 'dng', 'nef',
          'cr2', 'cr3', 'arw', 'rw2', 'raf', 'orf', 'gpr', '3fr', 'fff',
        ],
      },
      {
        id: 'excalidraw',
        type: 'builtin',
        icon: '/static/img/viewers/excalidraw.svg',
        display_name: 'Excalidraw',
        exts: ['excalidraw'],
        templates: [{ ext: 'excalidraw', display_name: 'Excalidraw' }],
      },
      {
        id: 'archive',
        type: 'builtin',
        display_name: 'fileManager.archivePreview',
        exts: ['zip', '7z'],
        required_group_permission: [5],
      },
    ],
  },
]);

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

/**
 * 诊断端点：回显当前 Worker 运行时**实际拿到**的数据库连接串。
 *
 * 与 `/kv-status` 同一个存在理由 —— 多库配置配错了不会报错：
 * `db/shard.ts` 在只配了主库时照常工作（备库为空数组 → 恒用主库），
 * 于是「配了 5 个库、实际只有 1 个可见」从外部完全看不出来。
 *
 * ⚠️ **只回显 host 与是否存在，绝不回显用户名/密码**（连接串含密码）。
 *
 * 这里同时读取 `env` 上的**绑定**。关键区别（很多人在这里踩坑）：
 *   - Cloudflare 面板「变量和机密」= **运行时**，Worker 这里能读到；
 *   - GitHub Secrets / Workers Builds 构建环境变量 = **构建期**，
 *     只有构建脚本（db:sync / deploy）能读，Worker 运行时读不到。
 *   要让运行时看到 N 个库，必须在**面板**里配齐 DATABASE_URL_2..5
 *   （或走 deploy.mjs 的 `wrangler secret put`，它写的也是运行时机密）。
 */
siteRoutes.get('/db-status', (c) => {
  c.header('Cache-Control', 'no-cache');
  const env = c.env as unknown as Record<string, string | undefined>;
  const names = ['DATABASE_URL', 'DATABASE_URL_2', 'DATABASE_URL_3', 'DATABASE_URL_4', 'DATABASE_URL_5'] as const;

  const configured = names
    .map((name) => {
      const raw = env[name]?.trim();
      if (!raw) return { name, present: false as const };
      return {
        name,
        present: true as const,
        // 只给 host，用于区分「是不是不同的库」。用户名/密码一律不出。
        host: safeHost(raw),
        duplicated: names.some((other) => other !== name && env[other]?.trim() === raw),
      };
    })
    .filter((x) => x.present);

  const urls = databaseUrls(c.env as never);
  const backups = backupDatabaseUrls(c.env as never);
  const failover = failoverEnabled(c.env as never);

  return ok(c, {
    present: configured,
    database_count: urls.length,
    backup_count: backups.length,
    failover_enabled: failover,
    // 主库是不是唯一可写：这里是恒定 true（设计如此），写出来是为了让人
    // 一眼看懂「备库不接流量」不是配置错误。
    single_writer: true,
    hint:
      urls.length <= 1
        ? 'Worker 运行时只看到 1 个数据库。面板「变量和机密」里需要同时配 DATABASE_URL_2..5（构建期变量运行时读不到）。'
        : failover
          ? `运行时看到 ${urls.length} 个库（1 主 + ${backups.length} 备），已开启故障切换。备库平时不接流量，每次构建由 CI 全量同步。`
          : `运行时看到 ${urls.length} 个库（1 主 + ${backups.length} 备）。备库平时不接流量，每次构建由 CI 全量同步；主库挂了要临时接管需设 DB_FAILOVER=1。`,
  });
});

/** 从连接串里取 host（去掉账号密码）。解析失败返回 '(无法解析)'。 */
function safeHost(url: string): string {
  try {
    return new URL(url).host || '(空)';
  } catch {
    return '(无法解析)';
  }
}

/**
 * 诊断端点：归档区（ARCHIVE_KV）与写前日志（WAL）是否可用。
 *
 * 归档与 WAL 都是**可选增强**，没绑 `ARCHIVE_KV` 时整体降级为 no-op
 * —— 站点照常工作，但你不会得到「历史版本」与「未完成操作」这两项能力。
 * 因为这个降级是静默的（设计如此，避免把可选项变成必需项），所以需要
 * 一个端点明确告诉你「到底有没有在生效」。
 */
siteRoutes.get('/archive-status', async (c) => {
  c.header('Cache-Control', 'no-cache');
  const env = c.env;
  const enabled = archiveEnabled(env);
  if (!enabled) {
    return ok(c, {
      archive_enabled: false,
      wal_enabled: false,
      hint:
        '未绑定 ARCHIVE_KV —— 归档与写前日志整体降级为 no-op（站点照常运行，但没有历史版本与未完成操作记录）。' +
        '要启用：在 Cloudflare 面板为该 Worker 添加一个 KV namespace 绑定，名字填 ARCHIVE_KV。',
    });
  }

  // 只读探测：列几页，确认读写真的通（绑定存在但权限/状态异常时也能发现）。
  let archiveCountNum = 0;
  let unfinished: unknown[] = [];
  try {
    archiveCountNum = await archiveCount(env);
    unfinished = (await walUnfinished(env, 20)).map((e) => ({
      op: e.op,
      ref: e.ref,
      status: e.status,
      started_at: e.startedAt,
      error: e.error,
    }));
  } catch {
    return ok(c, {
      archive_enabled: true,
      wal_enabled: true,
      readable: false,
      hint: 'ARCHIVE_KV 已绑定但读取失败，请检查该 namespace 的状态。',
    });
  }

  return ok(c, {
    archive_enabled: true,
    wal_enabled: true,
    readable: true,
    archive_entries: archiveCountNum,
    unfinished_operations: unfinished,
    hint:
      unfinished.length === 0
        ? '归档区正常，当前没有未完成的多步操作。'
        : `有 ${unfinished.length} 个多步操作标为未完成（pending/failed）。这些是「起了头但没走完」的操作，需人工核对。`,
  });
});


/**
 * 诊断端点：缓存清单、每类键的数量、以及手动触发一次刷新/清理。
 *
 * 存在的理由与 `/kv-status`、`/db-status` 相同 —— 「清空 + 重填 + 每小时
 * 刷新」这套机制如果没在生效，从外部完全看不出来（缓存本身就是透明的）。
 * 这个端点让「到底缓存了些什么、每类有多少、上次刷新成不成功」变成一条
 * 可以直接访问的 URL。
 *
 * 查询参数：
 *   - `?refresh=1` 手动触发一次**刷新**（覆盖写，安全、开销恒定）；
 *   - `?purge=1`   尝试**清理**（受 subrequest 预算限制，可能清不干净；
 *                  完整的清理请用构建期脚本 `npm run kv:refill`）。
 *
 * 无鉴权：只暴露**条数**与**清单**，不含任何业务数据值。
 */
siteRoutes.get('/cache-status', async (c) => {
  c.header('Cache-Control', 'no-cache');
  const env = c.env;
  const q = new URL(c.req.url).searchParams;

  // 每类缓存当前的键数（只列首页，够判断「有没有在缓存」）。
  const counts: { id: string; label: string; role: string; keys: number; purged: boolean }[] = [];
  for (const entry of CACHE_ENTRIES) {
    let n = 0;
    try {
      const listed = await kvFor(env, entry.role).list({ prefix: entry.prefix, limit: 1000 });
      n = listed.keys.length;
    } catch {
      n = -1; // 角色未绑定
    }
    counts.push({
      id: entry.id,
      label: entry.label,
      role: entry.role,
      keys: n,
      purged: entry.purge,
    });
  }

  const result: Record<string, unknown> = {
    entries: counts,
    purge_roles: purgeableEntries().map((e) => e.role),
    // 关键说明：`flag` 永不参与清理，避免触发重新自举。
    note: '清理只覆盖 purge=true 的条目；自举标记（flag 角色）永不清理，否则会触发站点重新自举。',
  };

  if (q.get('refresh') === '1') {
    const warmed = await warmAllCaches(env);
    result.refresh = warmed;
  }
  if (q.get('purge') === '1') {
    const purged = await purgeAllCaches(env);
    result.purge = purged;
    result.purge_note =
      'Worker 内清理受 subrequest 预算限制（免费档 50），可能只清了一部分。完整清空请用构建期脚本。';
  }

  return ok(c, result) as never;
});


siteRoutes.get('/config/:section', async (c) => {
  const ctx = ctxOf(c);
  const section = c.req.param('section');
  const s = ctx.settings;

  // 未登录时按匿名用户返回（原版 SiteConfig.User 由 BuildUser 构造，匿名时 id 为空）
  const userPayload = ctx.user
    // 组行已在 ctx.user 里，直接传入省一次查询（config/:section 每次进站都会调）
    ? await new UserService(ctx).buildUserResponse(ctx.user, true, ctx.user.group)
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
      // file_viewers 缺省时给内置查看器默认集（上游安装时播种的同一套），
      // 否则前端「打开方式」菜单整个为空，所有文件都只能下载。
      return ok(c, {
        max_batch_size: s.maxBatchedFile,
        file_viewers: parseJson(s.get('file_viewers', DEFAULT_FILE_VIEWERS), []),
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
