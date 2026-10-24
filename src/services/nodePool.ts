/**
 * 节点池：按能力位挑一台从节点跑任务。对应上游 `pkg/cluster/pool.go`。
 *
 * 上游有四类能力（none / createArchive / extractArchive / remoteDownload），
 * 其中 `none` 表示「这台机器什么任务都能接」，池子里永远有一个候选。边缘版的
 * 「none」就是 Worker 自己 —— 但它没有常驻进程，所以策略是：
 *
 *   - 有从节点具备该能力 → 任务丢过去，Worker 只负责建任务记录和轮询状态；
 *   - 没有 → 回落到「请求内同步跑完」（旧行为，受 MAX_WORKFLOW_BYTES 限制）。
 *
 * 选取算法照抄上游的平滑加权轮转（每个 item 累加自身权重，挑 current 最大的，
 * 然后减去总权重），所以多台同能力节点的分流比例与官方一致。
 */
import type { Env } from '../env';
import { listActiveNodes } from '../db/nodes';
import { BooleanSet } from '../lib/boolset';
import type { NodeRow } from '../db/types';

/** 能力位取值（`inventory/types.NodeCapability`）。 */
export const NodeCapability = {
  CreateArchive: 1,
  ExtractArchive: 2,
  RemoteDownload: 3,
} as const;

/**
 * 能力位判定。字段是 `boolset` 的 base64（标准编码带填充），第 `flag` 位在
 * `bytes[flag/8]` 的第 `flag%8` 位 —— 与上游 `pkg/boolset` 逐位一致。
 */
export function capabilityEnabled(raw: string | null | undefined, flag: number): boolean {
  return BooleanSet.fromBase64(raw).enabled(flag);
}

/** 池内每一项的轮转状态（isolate 内存，跨 isolate 不共享 —— 够用）。 */
const rotation = new Map<number, { current: number }>();

/**
 * 挑一台具备 `capability` 的 active 从节点；没有则返回 null（调用方回落到
 * 请求内执行）。`preferred` 为 0 或不在候选里时按权重挑。
 */
export async function pickNode(
  env: Env,
  capability: number,
  preferred = 0,
): Promise<NodeRow | null> {
  const nodes = (await listActiveNodes(env)).filter(
    (n) => n.type === 'slave' && capabilityEnabled(n.capabilities, capability),
  );
  if (nodes.length === 0) return null;

  let selected: NodeRow | null = null;
  if (preferred > 0) {
    selected = nodes.find((n) => n.id === preferred) ?? null;
  }
  if (!selected) {
    let total = 0;
    let best: NodeRow | null = null;
    let bestCurrent = -1;
    for (const node of nodes) {
      const weight = Math.max(1, Number(node.weight ?? 1));
      const state = rotation.get(node.id) ?? { current: 0 };
      state.current += weight;
      rotation.set(node.id, state);
      total += weight;
      if (best === null || state.current > bestCurrent) {
        best = node;
        bestCurrent = state.current;
      }
    }
    if (!best) return null;
    const state = rotation.get(best.id)!;
    state.current -= total;
    selected = best;
  }

  // 清理已消失节点的轮转状态，避免 isolate 内存无限增长
  if (rotation.size > nodes.length * 4) {
    const alive = new Set(nodes.map((n) => n.id));
    for (const id of [...rotation.keys()]) {
      if (!alive.has(id)) rotation.delete(id);
    }
  }
  return selected;
}
