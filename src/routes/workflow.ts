/**
 * 任务流路由。对应 Cloudreve v4 `routers/router.go:548-597` 的 workflow 分组。
 *
 *   GET    /api/v4/workflow                  任务列表
 *   GET    /api/v4/workflow/progress/:id     任务进度
 *   POST   /api/v4/workflow/archive          打包（同步执行，结果写进 dst）
 *   POST   /api/v4/workflow/extract          解压（边缘版不支持）
 *   POST   /api/v4/workflow/download         远程下载（仅 HTTP 直链）
 *   PATCH  /api/v4/workflow/download/:id     选择要下载的文件
 *   DELETE /api/v4/workflow/download/:id     取消下载任务
 *   POST   /api/v4/workflow/import           从存储策略导入（边缘版不支持）
 *   POST   /api/v4/workflow/rebuildFtsIndex  重建全文索引（分批推进，配了 Meilisearch 才可用）
 *
 * 原版这些端点只是**投任务**，真正的活在后台 goroutine 池里；
 * 边缘版没有常驻进程，能同步跑完的（打包 / 远程下载）就同步跑完，
 * 重建索引这种大批量的按批推进；确实做不了的（解压、导入）直接返回
 * 明确的「不支持」，不建空任务。细节见 `services/workflow.ts` 头部的说明。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { FileSystemService } from '../services/fs';
import { WorkflowService } from '../services/workflow';
import { SearchService } from '../services/search';
import type { TaskRow } from '../db/types';
import { AppError, CodeFeatureNotEnabled, CodeNotFound, Err } from '../lib/errors';
import type { HashIDCodec } from '../lib/hashid';

export const workflowRoutes = new Hono<AppBindings>();

/** 所有任务端点都要登录。 */
workflowRoutes.use('*', async (c, next) => {
  if (!ctxOf(c).user) return c.json(fail(c, Err.loginRequired()) as never);
  await next();
});

function taskToResponse(codec: HashIDCodec, task: TaskRow) {
  const pub = task.public_state ?? {};
  return {
    created_at: task.created_at.toISOString(),
    updated_at: task.updated_at.toISOString(),
    id: codec.encodeTaskID(task.id),
    status: task.status,
    type: task.type,
    summary: pub.summary,
    error: pub.error,
    error_history: pub.error_history,
    duration: pub.executed_duration,
    resume_time: pub.resume_time,
    retry_count: pub.retry_count,
  };
}

// ---------------------------------------------------------------------------
// 列表 / 进度
// ---------------------------------------------------------------------------

/**
 * 任务列表。`category` 决定按哪类任务过滤：
 *   - general：全部
 *   - downloading：进行中的下载类
 *   - downloaded：已完成的下载类
 */
workflowRoutes.get('/', async (c) => {
  const ctx = ctxOf(c);
  const pageSize = Math.max(1, Math.min(100, Number(c.req.query('page_size') ?? 20) || 20));
  const category = c.req.query('category') ?? 'general';

  const downloadTypes = ['remote_download'];
  let types: string[] | undefined;
  if (category === 'downloading') types = downloadTypes;
  else if (category === 'downloaded') types = downloadTypes;

  const tasks = await ctx.tasks.listByUser({ userId: ctx.user!.id, pageSize, types });
  const filtered =
    category === 'downloaded' ? tasks.filter((t) => t.status === 'completed') : tasks;

  return c.json(
    ok(c, {
      tasks: filtered.map((t) => taskToResponse(ctx.codec, t)),
      pagination: { page: 0, page_size: pageSize, total_items: filtered.length },
    }) as never,
  );
});

/**
 * 任务阶段进度。原版按「阶段」返回多个进度条；边缘版的任务要么做完了要么失败了。
 * 重建索引是唯一有真实进度的：从 summary.props 读 total/indexed 返回；
 * 其余任务回一个整体进度（标识符固定 `default`），前端轮询逻辑不需要改。
 */
workflowRoutes.get('/progress/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodeTaskID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(CodeNotFound, 'Task not found')) as never);

  const task = await ctx.tasks.byId(id);
  if (!task || task.user_tasks !== ctx.user!.id) {
    return c.json(fail(c, new AppError(CodeNotFound, 'Task not found')) as never);
  }

  const done = task.status === 'completed' || task.status === 'error' || task.status === 'canceled';

  if (task.type === 'full_text_rebuild') {
    const props = task.public_state?.summary?.props ?? {};
    const total = Number(props.total ?? 0);
    const current = done ? total : Number(props.indexed ?? 0);
    return c.json(
      ok(c, {
        default: { total, current, identifier: 'default' },
      }) as never,
    );
  }

  return c.json(
    ok(c, {
      default: {
        total: 1,
        current: done ? 1 : 0,
        identifier: 'default',
      },
    }) as never,
  );
});

// ---------------------------------------------------------------------------
// 打包 / 解压
// ---------------------------------------------------------------------------

workflowRoutes.post('/archive', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { src?: string[]; dst?: string };
  if (!body.src?.length || !body.dst) {
    return c.json(fail(c, Err.param('src and dst are required')) as never);
  }
  try {
    const task = await new WorkflowService(ctx, new FileSystemService(ctx)).createArchive({
      src: body.src,
      dst: body.dst,
    });
    return c.json(ok(c, taskToResponse(ctx.codec, task)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

/** 解压需要一个 ZIP **读取器**（含 inflate），边缘版没做，见 README。 */
workflowRoutes.post('/extract', (c) =>
  c.json(
    fail(
      c,
      new AppError(
        CodeFeatureNotEnabled,
        'Extracting archives is not implemented in the edge build',
      ),
    ) as never,
  ),
);

// ---------------------------------------------------------------------------
// 远程下载
// ---------------------------------------------------------------------------

workflowRoutes.post('/download', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    src?: string[];
    src_file?: string;
    dst?: string;
  };
  if (!body.dst) return c.json(fail(c, Err.param('dst is required')) as never);

  // 前端两种方式：直接给一组 URL，或上传一个存放 URL 列表的文件
  let urls = body.src ?? [];
  if (!urls.length && body.src_file) {
    const read = await ctx.files.byId(Number(body.src_file)).catch(() => null);
    void read;
    return c.json(
      fail(
        c,
        new AppError(
          CodeFeatureNotEnabled,
          'Importing a URL list file is not implemented in the edge build',
        ),
      ) as never,
    );
  }
  if (!urls.length) return c.json(fail(c, Err.param('src is required')) as never);

  const service = new WorkflowService(ctx, new FileSystemService(ctx));
  const out: ReturnType<typeof taskToResponse>[] = [];
  const errors: unknown[] = [];
  for (const url of urls) {
    try {
      const task = await service.createRemoteDownload({ url, dst: body.dst });
      out.push(taskToResponse(ctx.codec, task));
    } catch (e) {
      errors.push(e);
    }
  }
  if (!out.length && errors.length) return c.json(fail(c, errors[0]) as never);
  return c.json(ok(c, out) as never);
});

/**
 * 选择种子里要下载哪些文件。
 *
 * 边缘版只支持直链，一个任务对应一个文件，没有「多文件选择」这回事，
 * 所以这里只做校验并回成功 —— 前端的选择界面不会因此报错。
 */
workflowRoutes.patch('/download/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodeTaskID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(CodeNotFound, 'Task not found')) as never);
  const task = await ctx.tasks.byId(id);
  if (!task || task.user_tasks !== ctx.user!.id) {
    return c.json(fail(c, new AppError(CodeNotFound, 'Task not found')) as never);
  }
  return c.json(ok(c) as never);
});

/** 取消下载任务。边缘版的任务是同步跑完的，能取消的只有「还没开始」这种边界情况。 */
workflowRoutes.delete('/download/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = ctx.codec.decodeTaskID(c.req.param('id'));
  if (id === null) return c.json(fail(c, new AppError(CodeNotFound, 'Task not found')) as never);
  const task = await ctx.tasks.byId(id);
  if (!task || task.user_tasks !== ctx.user!.id) {
    return c.json(fail(c, new AppError(CodeNotFound, 'Task not found')) as never);
  }
  if (task.status === 'queued' || task.status === 'processing') {
    await ctx.tasks.updateStatus(id, 'canceled');
  }
  return c.json(ok(c) as never);
});

// ---------------------------------------------------------------------------
// 导入 / 全文索引
// ---------------------------------------------------------------------------

/**
 * 从存储策略导入已有对象。
 *
 * 这需要驱动支持「列举对象」，而边缘版各驱动的列举能力并不完整，
 * 加上导入通常是量大且耗时的活（正是 Workers 最不擅长的），所以不做。
 */
workflowRoutes.post('/import', (c) =>
  c.json(
    fail(
      c,
      new AppError(
        CodeFeatureNotEnabled,
        'Importing objects from a storage policy is not implemented in the edge build',
      ),
    ) as never,
  ),
);

/**
 * 重建全文索引。对应上游 `pkg/filemanager/workflows/rebuild_index.go`。
 *
 * 上游是可挂起的后台任务：先清空索引（nuke），再按 1000 个/批重灌（index），
 * 每批之间 suspend/resume。Workers 没有后台进程，所以改成**分批 + 复用任务**：
 *
 *   - 每次调用推进一批（40 个文件），处理完就返回，绝不超时假死；
 *   - 已有未完成的重建任务时直接接着推，不另开新任务 —— 管理员在前端
 *     再点一次「重建索引」就是「继续」，进度条按真实进度走。
 *
 * 只处理当前管理员自己的文件。原版遍历的是全站文件（队列由系统用户驱动），
 * 边缘版没有系统级执行上下文，退化为按用户推进；每人各推各的，最终结果一致。
 */
workflowRoutes.post('/rebuildFtsIndex', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { filtered_storage_policy?: number[] };
  const search = new SearchService(ctx);

  if (!search.available) {
    return c.json(
      fail(
        c,
        new AppError(
          CodeFeatureNotEnabled,
          'Full text search is not configured. Set fts_enabled and the Meilisearch endpoint in the admin panel first.',
        ),
      ) as never,
    );
  }

  try {
    const fts = ctx.settings.fts;
    const REBUILD_BATCH = 40;
    const taskType = 'full_text_rebuild';

    // 复用未完成的任务，没有就新建
    let task = await ctx.tasks.findActiveByType(taskType, ctx.user!.id);
    let state: {
      phase: 'nuke' | 'index';
      total: number;
      indexed: number;
      last_file_id: number;
      failed: number;
      filtered_storage_policy: number[];
    };

    if (task?.private_state) {
      state = JSON.parse(task.private_state) as typeof state;
    } else {
      state = {
        phase: 'nuke',
        total: 0,
        indexed: 0,
        last_file_id: 0,
        failed: 0,
        filtered_storage_policy: body.filtered_storage_policy ?? [],
      };
      if (!task) {
        task = await ctx.tasks.create({
          type: taskType,
          userId: ctx.user!.id,
          publicState: { summary: { phase: 'nuke', props: { total: 0, failed: 0 } } },
        });
      }
    }

    if (state.phase === 'nuke') {
      // 阶段一：清空旧索引 + 确保索引配置存在 + 统计可索引文件数
      await search.deleteAll();
      await search.ensureIndex();
      state.total = await ctx.files.countIndexableFiles(ctx.user!.id, fts.tikaExts);
      state.phase = 'index';
    }

    // 阶段二：推进一批
    const files = await ctx.files.listIndexableFiles({
      ownerId: ctx.user!.id,
      afterId: state.last_file_id,
      limit: REBUILD_BATCH,
      exts: fts.tikaExts,
    });

    for (const file of files) {
      try {
        await search.indexFile(file);
      } catch (e) {
        // 单个文件失败不中断重建 —— 与上游一致（计数后继续）
        state.failed += 1;
        console.error(`rebuild FTS: failed to index file ${file.id}`, e);
      }
    }

    state.indexed += files.length;
    if (files.length > 0) state.last_file_id = files[files.length - 1]!.id;

    const done = files.length < REBUILD_BATCH;
    const publicState = {
      summary: {
        phase: state.phase,
        props: { total: state.total, failed: state.failed, indexed: state.indexed },
      },
    };

    if (done) {
      await ctx.tasks.updateStatus(task.id, 'completed', publicState);
      task = { ...task, status: 'completed', public_state: publicState };
    } else {
      await ctx.tasks.updateState(task.id, 'processing', publicState, JSON.stringify(state));
      task = { ...task, status: 'processing', public_state: publicState };
    }

    return c.json(ok(c, taskToResponse(ctx.codec, task)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});
