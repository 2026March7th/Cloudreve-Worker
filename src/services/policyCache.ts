/**
 * 存储策略的跨请求缓存（L1 isolate 内存 + L2 KV）。
 *
 * ## 为什么缓存它
 *
 * 策略行是典型的**读极多写极少**数据：每次文件列表（组绑定的策略集）、
 * 每次上传（resolvePolicy / assertPolicyAllowed）、每次下载与缩略图
 * （getUrls / thumbimg 按 entity 反查策略）都要读它，而写只发生在
 * 管理后台改配置时。负载均衡上线后组绑定的 LB 还会再查一次 slave，
 * 列表请求因此多了一次 ~350-500ms 的 Neon 往返——「加载又成一坨」
 * 的直接原因。缓存后热路径 0 往返（L1 命中）。
 *
 * ## 两级缓存与「哪些走 KV」的取舍（按往返次数模型）
 *
 *   L1  isolate 内存：0 网络往返。TTL 10s —— 策略几乎不改，10s 内
 *       管理端改动最晚这么久生效。
 *   L2  KV：**只用于单条读取（byId）**。KV 没有批量 get，`byIds`
 *       缺 N 条就要 N 次往返（每次 180-560ms），比一次批量 SQL
 *       （350-500ms）更贵 —— 所以批量路径只用 L1 + 一次 SQL。
 *       注意：KV 里存的是完整策略行（含 secret_key）—— 与 OneDrive
 *       凭证已存 KV 的先例一致，KV 与 Neon 同属一套 Worker 绑定，
 *       不引入新的暴露面。
 *
 * ## 失效（正确性关键）
 *
 *   1. PolicyRepo 的 create / update / softDelete 内部统一调
 *      `evictPolicyCache(id)`（touchCache 模式，与 UserRepo 相同 ——
 *      失效收口在仓储层，靠自觉一定会漏）；
 *   2. L1 / L2 都有 TTL 兜底，最坏晚 10s / 300s 看到；
 *   3. LB 的 slave 展开每次都从 `byIds` 现算（L1 命中后 0 往返），
 *      不做独立缓存，避免第二套失效逻辑。
 */
import type { Env } from '../env';
import type { StoragePolicyRow } from '../db/types';
import { kvFor } from '../lib/kvRouter';
import { normalizePolicy } from '../db/repo';
import type { Sql } from '../db';

const L1_TTL_MS = 10_000;
const L2_TTL_S = 300;
const L1_MAX = 100;

const KEY = (id: number) => `policy:v1:${id}`;

const l1 = new Map<number, { at: number; row: StoragePolicyRow }>();

function l1Get(id: number): StoragePolicyRow | null {
  const hit = l1.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > L1_TTL_MS) {
    l1.delete(id);
    return null;
  }
  return hit.row;
}

function l1Set(id: number, row: StoragePolicyRow): void {
  if (l1.size >= L1_MAX && !l1.has(id)) {
    const oldest = l1.keys().next();
    if (!oldest.done) l1.delete(oldest.value);
  }
  l1.set(id, { at: Date.now(), row });
}

/**
 * KV 反序列化后 Date 变字符串（与用户缓存同一个坑），这里复原。
 * 形状不对（旧键 / 损坏数据）返回 null 按未命中回源。
 */
function revivePolicyRow(raw: unknown): StoragePolicyRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || typeof r.type !== 'string' || typeof r.name !== 'string') {
    return null;
  }
  return {
    ...(r as object),
    created_at: new Date(r.created_at as string),
    updated_at: new Date(r.updated_at as string),
    deleted_at: r.deleted_at == null ? null : new Date(r.deleted_at as string),
  } as unknown as StoragePolicyRow;
}

async function queryUncached(sql: Sql, id: number): Promise<StoragePolicyRow | null> {
  const rows = (await sql`SELECT * FROM storage_policies WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`) as Record<
    string,
    unknown
  >[];
  return rows[0] ? normalizePolicy(rows[0]) : null;
}

/** 单条读取：L1 → L2(KV) → DB，命中即回填下一级。 */
export async function getCachedPolicy(sql: Sql, id: number): Promise<StoragePolicyRow | null> {
  const hit = l1Get(id);
  if (hit) return hit;

  const env = currentEnv;
  if (env) {
    try {
      const cached = await kvFor(env, 'session').get(KEY(id), 'json');
      if (cached) {
        const row = revivePolicyRow(cached);
        if (row) {
          l1Set(id, row);
          return row;
        }
      }
    } catch {
      // KV 抖动时静默回源，不能让缓存问题变成请求失败
    }
  }

  const row = await queryUncached(sql, id);
  if (!row) return null;
  l1Set(id, row);
  if (env) {
    try {
      await kvFor(env, 'session').put(KEY(id), JSON.stringify(row), { expirationTtl: L2_TTL_S });
    } catch {
      // 回填失败无所谓，下次请求会再试
    }
  }
  return row;
}

/**
 * 批量读取（组绑定策略集 / LB slave 展开）：L1 命中的直接返回，
 * 缺失项合并成一次 SQL 回源并回填 L1。**不走 KV** —— KV 没有批量
 * 接口，N 条缺失就是 N 次往返，比一次批量 SQL 更贵（见文件头）。
 * 返回顺序与入参一致，自动丢弃不存在 / 已软删的行。
 */
export async function getCachedPoliciesByIds(sql: Sql, ids: number[]): Promise<StoragePolicyRow[]> {
  if (ids.length === 0) return [];
  const out: (StoragePolicyRow | null)[] = new Array(ids.length).fill(null);
  const missing: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    // 同一请求里重复的 id 只查一次
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = l1Get(id);
    if (hit) out[i] = hit;
    else missing.push(i);
  }

  if (missing.length > 0) {
    const missingIds = Array.from(new Set(missing.map((i) => ids[i]!)));
    const rows = (await sql(
      `SELECT * FROM storage_policies
       WHERE deleted_at IS NULL AND id = ANY($1::int[])`,
      [missingIds],
    )) as Record<string, unknown>[];
    const byId = new Map<number, StoragePolicyRow>();
    for (const r of rows) {
      const row = normalizePolicy(r);
      byId.set(row.id, row);
      l1Set(row.id, row);
    }
    for (const i of missing) {
      out[i] = byId.get(ids[i]!) ?? null;
    }
  }

  return out.filter((r): r is StoragePolicyRow => r !== null);
}

export async function evictPolicyCache(id: number): Promise<void> {
  l1.delete(id);
  const env = currentEnv;
  if (!env) return;
  try {
    await kvFor(env, 'session').delete(KEY(id));
  } catch {
    // 删不掉就靠 TTL 兜底
  }
}

/** 测试用：清空 L1。 */
export function clearPolicyCacheMemory(): void {
  l1.clear();
}

/** 测试用：当前 L1 条数。 */
export function policyCacheSize(): number {
  return l1.size;
}

/**
 * repo 层没有 env（只持有 Sql），KV 回填/失效借请求装配时记下的
 * env（与 userCache.rememberEnv 同一模式，见 app.ts 装配点）。
 */
let currentEnv: Env | null = null;

/** 请求装配时调用，记下本 isolate 的 env 供缓存层使用。 */
export function rememberPolicyEnv(env: Env): void {
  currentEnv = env;
}
