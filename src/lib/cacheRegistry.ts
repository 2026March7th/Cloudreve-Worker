/**
 * 缓存清单（cache registry）—— 「哪些东西是可缓存、该重建的」的唯一权威表。
 *
 * ## 为什么要有这张表
 *
 * 需求是「构建时清空 KV 再把该缓存的重填回去」+「每小时自动刷新一次」。
 * 这两件事都需要同一个答案：**到底有哪些缓存、分别落在哪个角色、怎么重建**。
 *
 * 如果把它散在三个地方（清理脚本写一份、预热逻辑写一份、文档写一份），
 * 三份必然漂移：加了一个新缓存却忘了加进清理名单 → 清不掉（变成永久脏
 * 数据，正是「站点配置缓存旧键导致整页崩」那类故障）；忘了加进预热名单
 * → 每小时刷新漏掉它。所以这里集中定义，清理与预热都从这张表推导。
 *
 * ## 每一项是什么
 *
 * 每个条目描述**一类**缓存键（不是一个键）：
 *   - `role`    落在哪个 KV 角色（决定在哪个 namespace 里找）；
 *   - `prefix`  「可被整体清理」的键前缀。清理时按前缀 list + delete。
 *   - `warm`    重建函数：预热时调用，把缓存重新填回去。
 *   - `purge`   是否参与「清空」。默认 true；`false` 表示这类键**不能**
 *               被清（见下）。
 *   - `ttl`     建议的存活秒数（仅用于诊断与文档，真实 TTL 在写入点决定）。
 *
 * ## 绝对不能清的键（purge: false）
 *
 * `flag` 角色下的自举标记（`bootstrap:done:v*`）**必须**保留：
 *   - 它一旦被清，下一次冷启动会认为「站点还没自举」，重放
 *     `provision()` + `ensureSettings()`。虽然那两者是幂等的，但会：
 *       (a) 给每次冷启动加 1~2 次数据库全表扫描（免费档直接打限流）；
 *       (b) 与「清缓存让站点更快」的初衷完全相反。
 *   同理 `bootstrap:cooldown` 是失败熔断器，清掉等于放大故障。
 *
 * 也就是说：**清缓存只清业务缓存，绝不碰控制面标记**。这条规则是本文件
 * 最重要的不变量，`flag` 角色整体不参与清理（连 list 都不做）。
 */
import type { Env } from '../env';
import type { KvRole } from './kvRouter';

/** 一类缓存的自描述。 */
export interface CacheEntry {
  /** 稳定标识，用于日志与诊断端点。 */
  id: string;
  /** 人类可读的说明（中文，直接给运维看）。 */
  label: string;
  /** 落在哪个 KV 角色。 */
  role: KvRole;
  /**
   * 该类的键前缀（**不含**角色前缀 —— kvRouter 会自动加 `角色:`）。
   * 清理时按它 list 并删除，所以必须准确：前缀写宽了会误删（如用 `''`
   * 就会把整个 namespace 清掉），写窄了会漏清。
   */
  prefix: string;
  /**
   * 是否参与「构建时清空」。默认 true。
   * `flag` 角色与任何控制面键必须显式排除。
   */
  purge: boolean;
  /**
   * 建议的存活秒数。仅用于诊断展示与文档 —— 真实的 TTL 由**写入点**
   * 决定（各调用处的 `expirationTtl`），这张表不参与 TTL 计算。
   * 留空表示「无固定 TTL」（如长期保留的键）。
   */
  ttl?: number;
  /**
   * 重建函数：把这类缓存重新填回去。
   *
   * 返回 `true` 表示已预热（或本来就无需预热），`false` 表示失败/跳过。
   * **预热失败绝不能抛** —— 缓存预热是优化，不是业务前提。
   */
  warm?: (env: Env) => Promise<boolean>;
}

/**
 * 缓存清单。
 *
 * 顺序即预热顺序（先站点设置这类「所有请求都要读」的，再外围的）。
 */
export const CACHE_ENTRIES: readonly CacheEntry[] = [
  {
    id: 'settings',
    label: '站点设置（settings:all）',
    role: 'site',
    prefix: 'settings:',
    purge: true,
    ttl: 60,
    // 重建：回源 settings 表，写回 KV。这里用一个「读一次」的写法触发
    // `loadSettings` 的写回路径 —— 它自带 TTL 与内存缓存，预热就是读它。
    warm: async (env) => {
      const { refreshSettingsCache } = await import('../settings/provider');
      return refreshSettingsCache(env);
    },
  },
  {
    id: 'user',
    label: '用户行缓存（user:v2:*）',
    role: 'session',
    prefix: 'user:',
    purge: true,
    ttl: 120,
    // 用户缓存是**按需填充**的（谁登录就缓存谁），没有「全量预热」的合理
    // 做法：把百万用户全拉出来预热会把免费档 Neon 直接打爆。
    // 所以这里不做任何事 —— 清掉后下一次请求自然回填。
    // 保留条目是为了让「清理」能覆盖它（否则清完没人重建，等于没清干净的反面：
    // 旧值一直留着）。
    warm: async () => true,
  },
  {
    id: 'captcha',
    label: '验证码（captcha:*，一次性、短 TTL）',
    role: 'session',
    prefix: 'captcha:',
    purge: true,
    ttl: 1800,
    // 一次性令牌，清了只会让正在填验证码的用户重新取一张 —— 无副作用。
    warm: async () => true,
  },
  {
    id: 'oneshot-session',
    label: '会话类一次性状态（吊销名单 / 2FA / 密码重置 / OIDC state / OAuth code / passkey）',
    role: 'session',
    prefix: 'session:',
    purge: true,
    // ⚠️ 清理这一类的**副作用**：正在进行的登录流程（OIDC 回跳、OAuth
    // 授权码兑换、2FA 挑战）会失效，用户需要重新发起。这是可接受的：
    // 清缓存是运维动作，不是高频操作；而留着它们意味着「清不干净」。
    warm: async () => true,
  },
  {
    id: 'upload',
    label: '上传 / 打包 / WebDAV 锁 / WOPI 会话',
    role: 'upload',
    prefix: 'upload',
    purge: true,
    // ⚠️ 同理：清理会中断**正在进行中**的上传。已经上传完的实体不受影响
    // （实体信息在数据库里），只是分片会话需要重来。
    // 前缀用 `upload` 而不是 `upload:` 是为了同时覆盖 `upload_xxx` 这类
    // 下划线命名的历史键。
    warm: async () => true,
  },
  {
    id: 'cred',
    label: '外部服务凭据与元数据缓存（OneDrive token / OIDC discovery）',
    role: 'cred',
    prefix: '',
    purge: true,
    // 这个 namespace 里**只有**缓存（凭据按需重新拉取），整块清空是安全的。
    // 清掉后下一次用到时会自动重新获取（多一次外部请求而已）。
    warm: async () => true,
  },
  {
    id: 'flag',
    label: '自举 / 迁移标记（控制面，**永不清理**）',
    role: 'flag',
    prefix: 'bootstrap:',
    // ★ 最关键的一条：purge=false。清掉自举标记会让每次冷启动重放
    // provision + ensureSettings，把免费档 Neon 打出限流。见文件头注释。
    purge: false,
    warm: async () => true,
  },
];

/** 取所有参与清理的条目。 */
export function purgeableEntries(): CacheEntry[] {
  return CACHE_ENTRIES.filter((e) => e.purge);
}

/** 按 id 取条目。 */
export function cacheEntry(id: string): CacheEntry | undefined {
  return CACHE_ENTRIES.find((e) => e.id === id);
}
