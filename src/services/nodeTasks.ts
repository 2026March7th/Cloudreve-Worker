/**
 * 从节点任务分派与状态同步。对应上游 `pkg/filemanager/workflows` 里的
 * `allocateNode` + 后台队列对从节点任务的轮询。
 *
 * ## 为什么需要轮询
 *
 * 上游的主站有常驻队列线程，5 秒问一次从节点任务进度。Workers 没有常驻进程，
 * 所以这里改成**由 cron 每分钟同步一次**：把仍处于 queued/processing 的
 * 已分派任务拉一遍状态，写回 `tasks` 表。前端本来就在轮询任务列表，所以
 * 感知延迟最多一分钟。
 *
 * ## 分派条件
 *
 * 只有当**存在具备对应能力位的 active 从节点**时才分派；否则回落到
 * 「请求内同步跑完」（`MAX_WORKFLOW_BYTES` 那套闸门）。分派信息记在
 * `tasks.private_state` 里：
 *
 *   {"node_id": 3, "node_task_id": 12, "type": "remote_download"}
 *
 * 产物注册不走这条路上的额外端点 —— 从节点按上游协议回头调
 * `/api/v4/slave/statelessUpload/*`（见 `routes/slave.ts`），文件行和实体行
 * 都在那一步落库。
 */
import type { Env } from '../env';
import type { AppContext } from './context';
import type { TaskRow } from '../db/types';
import { loadSettings } from '../settings/provider';
import { BACKEND_VERSION } from '../lib/version';
import { pickNode, NodeCapability } from './nodePool';
import { createNodeTask, getNodeTask, type NodeSiteMeta } from '../lib/nodeRpc';

/** 私有状态里标记「这个任务已经分派给从节点」。 */
const DISPATCH_MARKER = '"node_task_id"';

/** 从节点状态 → 主站任务状态。名字与上游一致，直接映射。 */
const NODE_STATUS_MAP: Record<string, string> = {
  queued: 'queued',
  processing: 'processing',
  suspending: 'suspending',
  error: 'error',
  canceled: 'canceled',
  completed: 'completed',
};

async function siteMeta(env: Env): Promise<NodeSiteMeta> {
  const settings = await loadSettings(env);
  return {
    siteId: settings.siteId,
    siteUrl: settings.siteUrl,
    version: BACKEND_VERSION,
  };
}

/** 任务是否已分派给从节点。 */
export function isDispatched(task: TaskRow): boolean {
  return typeof task.private_state === 'string' && task.private_state.includes(DISPATCH_MARKER);
}

export interface DispatchResult {
  /** 分派成功时返回；null 表示没有可用节点，调用方应回落到请求内执行 */
  nodeTaskId: number;
  nodeId: number;
}

/**
 * 把远程下载任务丢给具备 `remoteDownload` 能力的从节点。
 *
 * `state` 是上游 `SlaveTaskProps` + 工作流状态的并集：节点需要知道找谁、
 * 下什么、下到哪、主站在哪（回调用）。
 */
export async function dispatchRemoteDownload(
  env: Env,
  args: { taskId: number; userId: number; url: string; dst: string },
): Promise<DispatchResult | null> {
  const node = await pickNode(env, NodeCapability.RemoteDownload);
  if (!node) return null;

  const meta = await siteMeta(env);
  const state = JSON.stringify({
    node_id: node.id,
    user_id: args.userId,
    url: args.url,
    dst: args.dst,
    master_site_url: meta.siteUrl,
    master_site_id: meta.siteId,
    master_site_version: meta.version,
  });

  const nodeTaskId = await createNodeTask(node, meta, { type: 'remote_download', state });
  return { nodeTaskId, nodeId: node.id };
}

/**
 * 同步已分派任务的状态（cron 调用）。
 *
 * 从节点回报的进度（`private_state` / `progress`）原样并进任务的
 * `public_state.summary`，前端直接渲染，不做二次解释。
 */
export async function syncNodeTasks(env: Env): Promise<{ checked: number; updated: number }> {
  const settings = await loadSettings(env);
  const { AppContext } = await import('./context');
  const { HashIDCodec } = await import('../lib/hashid');
  const { JWTService } = await import('../lib/jwt');
  const ctx = new AppContext(
    env,
    settings,
    new HashIDCodec(settings.hashIdSalt),
    new JWTService(settings.secretKey),
  );

  const tasks = await ctx.tasks.listNodeDispatched(50);
  let updated = 0;
  const meta = await siteMeta(env);

  for (const task of tasks) {
    let info: { node_id: number; node_task_id: number };
    try {
      info = JSON.parse(task.private_state ?? '{}') as typeof info;
    } catch {
      continue;
    }
    if (!info.node_task_id) continue;

    const node = await ctx.nodes.byId(info.node_id);
    if (!node) {
      // 节点被删了：任务不可能再完成，置错并把原因写清楚
      await ctx.tasks.updateStatus(task.id, 'error', {
        summary: { props: {}, error: `Node ${info.node_id} no longer exists` },
      });
      updated += 1;
      continue;
    }

    try {
      const summary = await getNodeTask(node, meta, info.node_task_id);
      const next = NODE_STATUS_MAP[summary.status] ?? 'processing';
      if (next !== task.status) {
        const publicState = {
          ...(task.public_state ?? {}),
          summary: {
            props: (task.public_state?.summary as { props?: unknown } | undefined)?.props ?? {},
            ...(summary.progress ? { progress: summary.progress } : {}),
          },
        };
        if (summary.error) (publicState as Record<string, unknown>).error = summary.error;
        await ctx.tasks.updateState(
          task.id,
          next,
          publicState as Record<string, unknown>,
          task.private_state ?? '',
        );
        updated += 1;
      }
    } catch (e) {
      // 单条同步失败不影响其它任务；下一轮 cron 再试
      console.error(`node task sync failed for task ${task.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { checked: tasks.length, updated };
}

/** 供路由层把分派信息写进任务（见 `routes/workflow.ts`）。 */
export async function markDispatched(
  ctx: AppContext,
  taskId: number,
  info: { nodeId: number; nodeTaskId: number },
): Promise<void> {
  const task = await ctx.tasks.byId(taskId);
  if (!task) return;
  await ctx.tasks.updateState(
    taskId,
    'queued',
    (task.public_state ?? {}) as Record<string, unknown>,
    JSON.stringify({ node_id: info.nodeId, node_task_id: info.nodeTaskId }),
  );
}
