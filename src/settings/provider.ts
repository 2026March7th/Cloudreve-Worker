/**
 * 站点设置读取器。
 *
 * 原版把设置放在数据库里，由 `setting.Provider` 加缓存读取。这里做同样的事：
 * 一次性把 settings 表全部加载到请求级内存缓存（表很小），并提供带类型的取值方法。
 * 跨请求的缓存交给 KV（`settings:all`，60 秒），避免每个请求都打一次数据库。
 */
import type { Env } from '../env';
import { toJson, withRetry } from '../db';
import type { SettingRow } from '../db/types';
import { DEFAULT_SETTINGS, GENERATED_SETTINGS } from './defaults';
import { randomString } from '../lib/crypto';
import { resolveDb, type DbHandle } from '../db/shard';
import { kvFor } from '../lib/kvRouter';

const KV_CACHE_KEY = 'settings:all:v1';
const KV_CACHE_TTL = 60;

/**
 * isolate 级内存缓存。
 *
 * 原来每个请求要读 **3 次** KV（`index.ts` 的自举标记读 + 中间件 `appContext`
 * 一次 + `resolveUser` 内一次），实测单次 KV get 200~500ms，等于白烧掉
 * 将近 1 秒的响应时间。设置是「读极多、写极少」的数据，放进模块级缓存后
 * 同一 isolate 内的所有请求共享一份，只有 TTL 到期才会再打 KV。
 *
 * 失效链路：`invalidateSettings()` 同时清 KV 与内存（后台改设置后立即生效）；
 * TTL 兜底那些跨 isolate 的改动（另一个 isolate 改了设置，这边最多晚
 * `MEMORY_TTL` 秒看到）。
 */
const MEMORY_TTL_MS = 5000;
let memoryCache: { at: number; map: Map<string, string> } | null = null;

/**
 * 归一化外部服务的 base URL（Meilisearch / Tika endpoint）。
 * 管理员常直接粘贴 `ms-xxx.meilisearch.io` 这种不带协议的主机名，
 * 直接拼路径 fetch 会得到 "Invalid URL"。这里统一补 `https://`、
 * 去首尾空白与尾部斜杠。带协议的输入原样保留（http 也不强制升 https，
 * 内网自建服务可能是 http）。
 */
function normalizeHttpBase(raw: string): string {
  let v = raw.trim().replace(/\/+$/, '');
  if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
  return v;
}

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
    // siteURL 设置值是逗号分隔的 URL 列表（上游 siteUrlPreProcessor 契约），
    // 拼直链 / 回调用第一个（主站点）。
    const configured = this.get('siteURL', '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)[0];
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
      meiliEndpoint: normalizeHttpBase(this.get('fts_meilisearch_endpoint')),
      meiliApiKey: this.get('fts_meilisearch_api_key', ''),
      meiliPageSize: this.getInt('fts_meilisearch_page_size', 5),
      meiliEmbedEnabled: this.getBool('fts_meilisearch_embed_enabled', false),
      meiliEmbedConfig: this.get('fts_meilisearch_embed_config', '{}'),
      tikaEndpoint: normalizeHttpBase(this.get('fts_tika_endpoint')),
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
export async function loadSettings(env: Env, db: DbHandle = resolveDb(env)): Promise<SettingsProvider> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.at < MEMORY_TTL_MS) {
    return new SettingsProvider(env, memoryCache.map);
  }

  // 站点设置是「读极多写极少」的纯缓存数据 → 独立的 site 角色 namespace，
  // 不与自举标记/会话状态抢同一个 KV。
  const cached = await kvFor(env, 'site').get(KV_CACHE_KEY, 'json');
  if (cached && typeof cached === 'object') {
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(cached as Record<string, unknown>)) {
      if (typeof v === 'string') map.set(k, v);
    }
    if (map.size > 0) {
      memoryCache = { at: Date.now(), map };
      return new SettingsProvider(env, map);
    }
  }

  const map = await refillSettingsFromDb(env, db);
  memoryCache = { at: Date.now(), map };
  return new SettingsProvider(env, map);
}

/** 清掉内存缓存（测试 / 手动失效用）。 */
export function clearSettingsMemoryCache(): void {
  memoryCache = null;
}

/**
 * 从数据库读全量设置并**覆盖写**进 KV。
 *
 * 这是「回源 + 写回」的唯一实现，被 `loadSettings` 的未命中路径与
 * `refreshSettingsCache` 共用 —— 避免「两份实现各写一遍键格式」而漂移。
 *
 * 不删旧键、不读缓存：直接算出一份新的再 put 覆盖。这样**不存在**
 * 「键被删掉、新值还没写」的空窗（空窗期间并发请求会全部回源打库）。
 */
async function refillSettingsFromDb(env: Env, db: DbHandle = resolveDb(env)): Promise<Map<string, string>> {
  const sql = db.sql;
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
  await kvFor(env, 'site').put(KV_CACHE_KEY, JSON.stringify(obj), { expirationTtl: KV_CACHE_TTL });
  return map;
}

/**
 * 强制回源数据库并**重新写回** KV 缓存（预热 / 定时刷新用）。
 *
 * 与 `loadSettings` 的区别：`loadSettings` 命中内存或 KV 就返回，**不会**
 * 刷新 KV 里的值；而定时任务要的正是「把 KV 里的旧值换成新值」。
 *
 * ## 为什么是「先算新值再覆盖」而不是「先删旧值」
 *
 * 早先的实现是 `delete(KV_CACHE_KEY)` + `loadSettings()` —— 能工作，
 * 但有两个毛病：
 *   1. **空窗**：删掉之后到新值写回之间，并发请求会全部回源打库
 *      （免费档 Neon 会被打限流，正是本项目最怕的那种放大）。
 *   2. **失败即丢缓存**：如果删完之后回源失败，一份本来可用的缓存
 *      就白白没了，站点从「读缓存」退化成「每个请求都回源」。
 * 改成「读出新的、再覆盖旧」后，两个毛病都没有：旧值一直可用，
 * 直到新值就位才被替换。这也是下面测试断言「预热零 delete」的原因。
 *
 * 顺带修一个潜在问题：`loadSettings` 命中 KV 时会 `memoryCache = {at: now}`，
 * 于是**每次命中都重置 TTL**，内存缓存实际上永不过期（只要请求不断）。
 * 对普通请求这反而是好事（少打 KV），但定时刷新要的是「拿到最新的」，
 * 所以这里显式清掉内存，保证真的回源。
 *
 * 失败返回 false，**不抛** —— 预热是优化，不能把定时任务打挂。
 */
export async function refreshSettingsCache(env: Env): Promise<boolean> {
  try {
    memoryCache = null;
    const map = await refillSettingsFromDb(env);
    memoryCache = { at: Date.now(), map };
    return true;
  } catch (e) {
    console.error('settings cache refresh failed', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** 后台改设置后调用，让 KV 缓存失效（内存缓存一并清掉）。 */
export async function invalidateSettings(env: Env): Promise<void> {
  memoryCache = null;
  await kvFor(env, 'site').delete(KV_CACHE_KEY);
}

/**
 * 首次启动的自举：把缺失的设置键写入数据库，
 * 并为 siteID / secret_key / hash_id_salt 生成一次性的随机值。
 */
export async function ensureSettings(env: Env, db: DbHandle = resolveDb(env)): Promise<void> {
  const sql = db.sql;
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
