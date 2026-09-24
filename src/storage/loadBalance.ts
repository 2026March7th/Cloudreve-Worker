/**
 * 负载均衡虚拟策略。
 *
 * 上游开源版没有 load_balance 的服务端实现（前端枚举与「Pro」标是给
 * 闭源 Pro 用的）。边缘版语义：
 *   - load_balance 策略**没有自己的驱动**，`settings.slave_policy_ids`
 *     指向一组真实存储策略，`settings.load_balance_mode` 决定选路算法；
 *   - 在策略解析层（context.resolvePolicy / groupPolicies）把它展开：
 *     上传时选中一个 slave，文件/实体落库记录的是 slave 的 id ——
 *     所以下载、直链、缩略图、预览全部走 slave 的真实驱动，天然工作；
 *   - 它永不下发给用户侧策略列表（groupPolicies 展开为 slave 并集），
 *     用户上传器看到的永远是具体策略，无感知。
 *
 * 选路算法：
 *   - `random`（默认）：每次上传随机挑一个；
 *   - `round_robin`：isolate 内轮询计数。跨 isolate 不保证严格轮流
 *     （KV 计数要给每次上传加一次往返，不值得），但分布足够均匀。
 */
import type { StoragePolicyRow } from '../db/types';
import { AppError } from '../lib/errors';
import { PolicyType } from '../lib/boolset';
import type { AppContext } from '../services/context';
import { isPolicyTypeSupported } from './index';

export type LoadBalanceMode = 'random' | 'round_robin';

/** isolate 内的轮询计数器（键 = load_balance 策略 id）。 */
const roundRobinCounters = new Map<number, number>();

/** 读出配置的 slave id 列表（容错：非法 JSON / 错误类型一律空数组）。 */
export function slavePolicyIds(policy: StoragePolicyRow): number[] {
  const raw = policy.settings?.slave_policy_ids;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function loadBalanceMode(policy: StoragePolicyRow): LoadBalanceMode {
  return policy.settings?.load_balance_mode === 'round_robin' ? 'round_robin' : 'random';
}

export function isLoadBalancePolicy(policy: StoragePolicyRow): boolean {
  return policy.type === PolicyType.LoadBalance;
}

/**
 * 展开 load_balance 为「可用的 slave 集合」（去重、按 id 排序、
 * 过滤已删除 / 类型无驱动的；slave 若嵌套 load_balance 一并忽略）。
 * 空集抛带策略名的明确错误 —— 上传时会直接展示给管理员看。
 */
export async function expandLoadBalance(
  ctx: Pick<AppContext, 'policies'>,
  policy: StoragePolicyRow,
): Promise<StoragePolicyRow[]> {
  const ids = slavePolicyIds(policy);
  if (ids.length === 0) {
    throw new AppError(40006, `负载均衡策略「${policy.name}」没有配置任何存储策略`);
  }
  const rows = await ctx.policies.byIds(ids);
  const usable = rows.filter((p) => isPolicyTypeSupported(p.type)).sort((a, b) => a.id - b.id);
  if (usable.length === 0) {
    throw new AppError(40006, `负载均衡策略「${policy.name}」配置的存储策略均不可用`);
  }
  return usable;
}

/** 展开 + 按算法挑出一个实际 slave 策略（上传/解析策略时的主入口）。 */
export async function pickSlavePolicy(
  ctx: Pick<AppContext, 'policies'>,
  policy: StoragePolicyRow,
): Promise<StoragePolicyRow> {
  const slaves = await expandLoadBalance(ctx, policy);
  if (slaves.length === 1) return slaves[0]!;
  if (loadBalanceMode(policy) === 'round_robin') {
    const next = (roundRobinCounters.get(policy.id) ?? Math.floor(Math.random() * slaves.length)) % slaves.length;
    roundRobinCounters.set(policy.id, next + 1);
    return slaves[next]!;
  }
  return slaves[Math.floor(Math.random() * slaves.length)]!;
}

/**
 * 管理端创建/更新 load_balance 策略时校验 settings：
 * slave 列表非空、全部真实存在、类型有驱动、不嵌套负载均衡、算法合法。
 */
export async function validateLoadBalanceSettings(
  policiesRepo: Pick<AppContext, 'policies'>['policies'],
  settings: Record<string, unknown> | undefined,
): Promise<void> {
  const raw = settings?.slave_policy_ids;
  const ids = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (ids.length === 0) {
    throw new AppError(40006, '负载均衡策略至少需要选择一个存储策略');
  }
  const unique = Array.from(new Set(ids));
  const rows = await policiesRepo.byIds(unique);
  if (rows.length !== unique.length) {
    throw new AppError(40006, '负载均衡配置中包含不存在的存储策略');
  }
  for (const row of rows) {
    if (isLoadBalancePolicy(row)) {
      throw new AppError(40006, '负载均衡策略不支持嵌套负载均衡');
    }
    if (!isPolicyTypeSupported(row.type)) {
      throw new AppError(40006, `存储策略「${row.name}」的类型在此部署不可用`);
    }
  }
  const mode = settings?.load_balance_mode;
  if (mode !== undefined && mode !== 'random' && mode !== 'round_robin') {
    throw new AppError(40006, 'load_balance_mode 仅支持 random / round_robin');
  }
}
