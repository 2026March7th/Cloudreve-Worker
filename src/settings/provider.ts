/**
 * 站点设置读取器。
 *
 * 原版把设置放在数据库里，由 `setting.Provider` 加缓存读取。这里做同样的事：
 * 一次性把 settings 表全部加载到请求级内存缓存（表很小），并提供带类型的取值方法。
 * 跨请求的缓存交给 KV（`settings:all`，60 秒），避免每个请求都打一次数据库。
 */
import type { Env } from '../env';
import { getSql, toJson, withRetry } from '../db';
import type { SettingRow } from '../db/types';
import { DEFAULT_SETTINGS, GENERATED_SETTINGS } from './defaults';
import { randomString } from '../lib/crypto';

const KV_CACHE_KEY = 'settings:all:v1';
const KV_CACHE_TTL = 60;

/** 全文检索配置。字段名与官方前端面板提交的键名一致。 */
export interface FtsConfig {
  enabled: boolean;
  indexType: string;
  extractorType: string;
  meiliEndpoint: string;
  meiliApiKey: string;
  meiliPageSize: number;
  meiliEmbedEnabled: boolean;
  meiliEmbedConfig: string;
  tikaEndpoint: string;
  tikaExts: string[];
  tikaMaxFileSize: number;
  chunkSize: number;
}

export class SettingsProvider {
  private cache: Map<string, string> | null = null;

  constructor(
    private readonly env: Env,
    private readonly loaded: Map<string, string>,
  ) {
    this.cache = loaded;
  }

  /** 读取原始字符串值，缺失时回落到默认值。 */
  get(key: string, fallback = ''): string {
    const v = this.cache?.get(key);
    if (v !== undefined && v !== null && v !== '') return v;
    return DEFAULT_SETTINGS[key] ?? fallback;
  }

  getInt(key: string, fallback = 0): number {
    const raw = this.get(key, '');
    if (raw === '') return DEFAULT_SETTINGS[key] !== undefined ? Number(DEFAULT_SETTINGS[key]) : fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  getBool(key: string, fallback = false): boolean {
    const raw = this.get(key, '');
    if (raw === '') return fallback;
    return raw === '1' || raw.toLowerCase() === 'true';
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key, '');
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /** 站点 ID，参与 refresh token 的 state hash 计算。 */
  get siteId(): string {
    return this.get('siteID');
  }
  get siteName(): string {
    return this.get('siteName', 'Cloudreve');
  }
  get siteTitle(): string {
    return this.get('siteTitle', 'Cloud storage for everyone');
  }
  get siteUrl(): string {
    const configured = this.get('siteURL', '');
    return configured || this.env.SITE_URL || '';
  }
  get siteScript(): string {
    return this.get('siteScript', '');
  }
  /** JWT 签名密钥：优先用 Worker 机密，其次用库里的 secret_key。 */
  get secretKey(): string {
    return this.env.JWT_SECRET || this.get('secret_key');
  }
  get hashIdSalt(): string {
    return this.get('hash_id_salt');
  }
  get registerEnabled(): boolean {
    return this.getBool('register_enabled', true);
  }
  get emailActive(): boolean {
    return this.getBool('email_active', false);
  }
  /**
   * SMTP 连接参数。字段名与官方前端管理面板**提交的键名逐字一致**
   * （`frontend/src/component/Admin/Settings/Email/Email.tsx`），
   * 所以管理员在面板里填完保存就能直接生效，不需要任何环境变量。
   */
  get smtp(): {
    host: string;
    port: number;
    user: string;
    pass: string;
    forceEncryption: boolean;
    keepalive: number;
  } {
    return {
      host: this.get('smtpHost', ''),
      port: this.getInt('smtpPort', 25),
      user: this.get('smtpUser', ''),
      pass: this.get('smtpPass', ''),
      forceEncryption: this.getBool('smtpEncryption', false),
      keepalive: this.getInt('mail_keepalive', 30),
    };
  }
  /** 发件人与回复地址。`fromAdress` 的拼写错误来自上游，不能顺手改。 */
  get mailSender(): { name: string; address: string; replyTo: string } {
    return {
      name: this.get('fromName', ''),
      address: this.get('fromAdress', ''),
      replyTo: this.get('replyTo', ''),
    };
  }
  /**
   * 全文检索配置。字段名与官方前端面板提交的键名一致
   * （`frontend/src/component/Admin/FileSystem/FullTextSearch/FullTextSearchSetting.tsx`）。
   */
  get fts(): FtsConfig {
    return {
      enabled: this.getBool('fts_enabled', false),
      indexType: this.get('fts_index_type', 'meilisearch'),
      extractorType: this.get('fts_extractor_type', 'tika'),
      meiliEndpoint: this.get('fts_meilisearch_endpoint', '').replace(/\/+$/, ''),
      meiliApiKey: this.get('fts_meilisearch_api_key', ''),
      meiliPageSize: this.getInt('fts_meilisearch_page_size', 5),
      meiliEmbedEnabled: this.getBool('fts_meilisearch_embed_enabled', false),
      meiliEmbedConfig: this.get('fts_meilisearch_embed_config', '{}'),
      tikaEndpoint: this.get('fts_tika_endpoint', '').replace(/\/+$/, ''),
      tikaExts: this
        .get('fts_tika_exts', '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      tikaMaxFileSize: this.getInt('fts_tika_max_file_size', 26214400),
      chunkSize: this.getInt('fts_chunk_size', 2000),
    };
  }
  get loginCaptcha(): boolean {
    return this.getBool('login_captcha', false);
  }
  get regCaptcha(): boolean {
    return this.getBool('reg_captcha', false);
  }
  get forgetCaptcha(): boolean {
    return this.getBool('forget_captcha', false);
  }
  get authnEnabled(): boolean {
    return this.getBool('authn_enabled', false);
  }
  get defaultGroupId(): number {
    return this.getInt('default_group', 2);
  }
  get accessTokenTTL(): number {
    return this.getInt('access_token_ttl', 3600);
  }
  get refreshTokenTTL(): number {
    return this.getInt('refresh_token_ttl', 1209600);
  }
  get uploadSessionTTL(): number {
    return this.getInt('upload_session_timeout', 86400);
  }
  get maxPageSize(): number {
    return this.getInt('max_page_size', 2000);
  }
  get maxBatchedFile(): number {
    return this.getInt('max_batched_file', 3000);
  }
}

/**
 * 加载设置。优先读 KV 缓存，未命中则回源数据库。
 * `ensureSettings()` 保证表里每个默认键都有行。
 */
export async function loadSettings(env: Env): Promise<SettingsProvider> {
  const cached = await env.KV.get(KV_CACHE_KEY, 'json');
  if (cached && typeof cached === 'object') {
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(cached as Record<string, unknown>)) {
      if (typeof v === 'string') map.set(k, v);
    }
    if (map.size > 0) return new SettingsProvider(env, map);
  }

  const sql = getSql(env);
  // 空闲后（Neon 免费版会自动休眠计算节点）第一条查询偶尔会撞上瞬态错误，
  // 定时任务一小时才来一次，正好踩在这个场景上 —— 限流/网络抖动统一退避重试。
  const rows = (await withRetry(
    () => sql`SELECT name, value FROM settings WHERE deleted_at IS NULL`,
  )) as SettingRow[];
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.name, r.value ?? '');
  }
  // 补齐默认值（表里缺失的键不写库，只在本请求内生效）
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!map.has(k)) map.set(k, v);
  }

  const obj: Record<string, string> = {};
  for (const [k, v] of map) obj[k] = v;
  await env.KV.put(KV_CACHE_KEY, JSON.stringify(obj), { expirationTtl: KV_CACHE_TTL });

  return new SettingsProvider(env, map);
}

/** 后台改设置后调用，让 KV 缓存失效。 */
export async function invalidateSettings(env: Env): Promise<void> {
  await env.KV.delete(KV_CACHE_KEY);
}

/**
 * 首次启动的自举：把缺失的设置键写入数据库，
 * 并为 siteID / secret_key / hash_id_salt 生成一次性的随机值。
 */
export async function ensureSettings(env: Env): Promise<void> {
  const sql = getSql(env);
  const rows = (await sql`SELECT name FROM settings WHERE deleted_at IS NULL`) as { name: string }[];
  const existing = new Set(rows.map((r) => r.name));

  const toInsert: { name: string; value: string }[] = [];
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing.has(key)) continue;
    let v = value;
    if ((GENERATED_SETTINGS as readonly string[]).includes(key)) {
      if (key === 'siteID') v = crypto.randomUUID();
      else if (key === 'secret_key') v = randomString(256);
      else if (key === 'hash_id_salt') v = randomString(64);
    }
    toInsert.push({ name: key, value: v });
  }

  if (toInsert.length === 0) return;

  // 全部缺失键合并成一个事务提交（= 1 个 HTTP 请求）。逐条插在免费版
  // Workers 里会撞 50-subrequest 上限，并发冷启动还会触发 Neon 429。
  await withRetry(() =>
    sql.transaction(
      toInsert.map((item) => sql`
        INSERT INTO settings (name, value)
        VALUES (${item.name}, ${item.value})
        ON CONFLICT (name) DO NOTHING
      `),
    ),
  );
  await invalidateSettings(env);
}

/** 把一个 JSON 值转换成设置里可存的形式（原版设置值都是字符串）。 */
export function readSettingJson<T>(provider: SettingsProvider, key: string, fallback: T): T {
  return toJson<T>(provider.get(key, ''), fallback);
}
