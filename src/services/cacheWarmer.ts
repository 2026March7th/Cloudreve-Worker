/**
 * 缓存清空 + 预热（cache purge & warm）。
 *
 * ## 用途
 *
 * 两处调用：
 *   1. **构建时**（`scripts/kv-purge-refill.mjs`）——每次部署都从零开始，
 *      保证线上没有上一版残留的缓存键。这是「清空所有 kv 数据库，然后把
 *      要缓存的东西重新填进去」的实现。走 wrangler CLI 的批量删接口，
 *      不受 Worker 子请求预算限制。
 *   2. **每小时**（Worker 的 cron `scheduled()`）——把缓存**刷新**一遍，
 *      保证内容不会因为「写路径漏了失效」而长期陈旧。
 *
 * ## ⚠️ 关键约束：Worker 里不能做全量清理
 *
 * KV 的绑定 API **没有批量删**（`delete(key: Key)` 只收单个键名，与
 * Durable Object 的 `delete(keys[])` 不同）。要清空就得「list 翻页 +
 * 逐键 delete」，而 Workers 免费档是 **50 subrequests/请求** ——
 * 清 200 个键就把预算烧光了，还没轮到发业务响应。
 *
 * 所以两者分工明确：
 *   - **清空**（list + 逐键删）只在**构建期脚本**里做（CLI 无预算限制）；
 *   - **刷新**（Worker 内）不做清理，只做**覆盖写**（回源后 put 新值，
 *     旧值被新值盖掉）—— 零额外的 list/delete 往返。
 *
 * 这也更符合需求本意：「每小时自动拉取一次，保证内容是新的」——要的是
 * **内容新**，而不是「键先消失再出现」。覆盖写能达到同样效果且更省。
 *
 * ## 为什么清空是安全的
 *
 * KV 在这里**纯粹是缓存**：唯一的真相在 Neon 里。被清掉的键要么下次请求
 * 时自动回填（站点设置、用户行），要么本来就是一次性令牌（验证码、
 * OAuth code）—— 清掉只是让用户重来一次。
 *
 * **唯一的例外是控制面标记**（`bootstrap:done:v*`）：清掉会触发整个站点
 * 重新自举（每次冷启动多跑两次全表扫描，免费档直接打限流）。所以
 * `flag` 角色在 `cacheRegistry` 里被显式标记 `purge: false`，这里也只清
 * `purgeableEntries()` 列出的条目 —— 永远不会碰它。
 */
import type { Env } from '../env';
import { kvFor } from '../lib/kvRouter';
import { CACHE_ENTRIES, purgeableEntries, type CacheEntry } from '../lib/cacheRegistry';

/** 单次 list 的条数上限（KV 硬上限就是 1000）。 */
const LIST_PAGE = 1000;

/**
 * Worker 内清理时允许删的键数上限。
 *
 * 之所以要上限：每删一个键 = 一个 subrequest，免费档总共只有 50 个。
 * 这个值只用于**诊断端点的手动触发**（`?purge=1`），正常 cron 不走清理路径。
 * 设得保守，避免一次误触发把预算烧光导致响应失败。
 */
const WORKER_PURGE_BUDGET = 20;

/** 一类缓存的清理结果。 */
export interface PurgeResult {
  id: string;
  label: string;
  role: string;
  deleted: number;
  /** 是否因为预算/翻页上限而还有残留（构建期脚本会循环清到干净）。 */
  truncated: boolean;
  /** 出错时的原因（清理失败不影响其它类）。 */
  error?: string;
}

/**
 * 清空**一个条目**描述的所有键。
 *
 * @param budget 本次最多删多少个键（subrequest 预算）。用 `Infinity`
 *               表示不限（仅供构建期脚本语义参考，实际脚本走 CLI）。
 *
 * 错误被吞进返回值而不是抛出：清理某一类失败不该阻断其它类。
 */
export async function purgeEntry(
  env: Env,
  entry: CacheEntry,
  budget = WORKER_PURGE_BUDGET,
): Promise<PurgeResult> {
  const result: PurgeResult = {
    id: entry.id,
    label: entry.label,
    role: entry.role,
    deleted: 0,
    truncated: false,
  };

  let ns: KVNamespace;
  try {
    ns = kvFor(env, entry.role);
  } catch {
    result.error = `角色 ${entry.role} 未绑定`;
    return result;
  }

  try {
    let cursor: string | undefined;
    while (result.deleted < budget) {
      const listed = await ns.list({
        prefix: entry.prefix,
        limit: Math.min(LIST_PAGE, budget - result.deleted),
        ...(cursor ? { cursor } : {}),
      });
      for (const k of listed.keys) {
        await ns.delete(k.name);
        result.deleted++;
        if (result.deleted >= budget) break;
      }
      if (listed.list_complete) {
        cursor = undefined;
        break;
      }
      cursor = listed.cursor;
      if (!cursor) break;
    }
    // 还有没删完的（撞上预算上限）
    result.truncated = result.deleted >= budget;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return result;
}

/**
 * 清空所有「可清理」的缓存类（受 subrequest 预算限制）。
 *
 * 返回逐类结果，供诊断端点展示。**任何一类失败都不影响其它类**，
 * 整体也从不抛异常。
 *
 * ⚠️ 只用于诊断端点的手动触发。构建期请用 `scripts/kv-purge-refill.mjs`
 * （走 CLI，无预算限制，且能清干净）。
 */
export async function purgeAllCaches(env: Env): Promise<PurgeResult[]> {
  const out: PurgeResult[] = [];
  let budget = WORKER_PURGE_BUDGET;
  for (const entry of purgeableEntries()) {
    if (budget <= 0) {
      out.push({
        id: entry.id,
        label: entry.label,
        role: entry.role,
        deleted: 0,
        truncated: true,
        error: 'subrequest 预算已用尽',
      });
      continue;
    }
    const r = await purgeEntry(env, entry, budget);
    budget -= r.deleted;
    out.push(r);
  }
  return out;
}

/**
 * 按清单预热 / 刷新所有缓存。
 *
 * 这是**每小时 cron 的路径**：只做覆盖写，不 list、不 delete，
 * 因此开销恒定（每类 1 次回源 + 1 次 KV put），不会随缓存键数增长。
 *
 * 失败逐条吞掉，返回成功与否。
 */
export async function warmAllCaches(env: Env): Promise<{ id: string; ok: boolean }[]> {
  const out: { id: string; ok: boolean }[] = [];
  for (const entry of CACHE_ENTRIES) {
    if (!entry.warm) continue;
    let ok = false;
    try {
      ok = await entry.warm(env);
    } catch (e) {
      console.error(`cache warm failed: ${entry.id}`, e instanceof Error ? e.message : String(e));
      ok = false;
    }
    out.push({ id: entry.id, ok });
  }
  return out;
}
