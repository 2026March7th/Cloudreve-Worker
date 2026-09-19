#!/usr/bin/env node
/**
 * 一条命令完成部署（CI 友好，专为 Cloudflare Workers Builds 这类
 * 「构建命令 + 部署命令」两格配置的场景设计）：
 *
 *   1. KV namespace 不存在就自动创建，并把真实 ID 回填进 wrangler.toml
 *      （替换 REPLACE_WITH_YOUR_KV_* 占位符）。
 *   2. R2 bucket 不存在就自动创建。
 *   3. `wrangler deploy` 发布；若 CI 环境变量里给了 SITE_URL / FRONTEND_URL，
 *      用 --var 覆盖 wrangler.toml 里的空值，无需改文件。
 *   4. 若 CI 环境变量里给了 DATABASE_URL，部署成功后自动 `wrangler secret put`
 *      写进 Worker 运行时，面板里连 Secret 都不用手动加。
 *
 * 认证：Cloudflare Workers Builds 会自动注入 API token，本机手工跑则需要
 * 先 `npx wrangler login`。任何一步失败都会带出真实报错并以非零码退出，
 * 让构建日志直接看到原因。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');
const WORKER_NAME = 'cloudreve-worker';
const R2_BUCKET = 'cloudreve-worker';

const KV_ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID';
const KV_PREVIEW_PLACEHOLDER = 'REPLACE_WITH_YOUR_KV_PREVIEW_ID';

function run(cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    shell: process.platform === 'win32',
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    all: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function runOrDie(cmd, args, label, opts) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) {
    console.error(`\n✘ ${label} 失败（exit ${r.code}）：\n${r.all}`);
    process.exit(r.code);
  }
  return r;
}

/** npx 在 Windows 上需要 shell；CI 是 Linux。 */
function npxArgs(args) {
  return process.platform === 'win32' ? args : ['--yes', 'wrangler', ...args];
}
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/**
 * 从 wrangler 输出里提取 JSON 数组。stdout 可能混着警告横幅
 * （如 `[wrangler warn]`，同样在行首），所以逐个行首 `[` 尝试解析，
 * 第一个能完整解析成数组的生效；都没有返回 null，不抛错。
 */
function extractJsonArray(text) {
  for (const m of text.matchAll(/^\[/gm)) {
    const start = m.index;
    const end = text.lastIndexOf(']');
    if (end <= start) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 换下一个行首 [ 继续 */
    }
  }
  return null;
}

console.log('▶ 1/4 检查 KV namespace…');

let toml = readFileSync(TOML_PATH, 'utf8');
const needProvision =
  toml.includes(KV_ID_PLACEHOLDER) || toml.includes(KV_PREVIEW_PLACEHOLDER);

if (!needProvision) {
  console.log(`  wrangler.toml 已含真实 KV ID，跳过开通。`);
} else {
  // 列出现有 namespace，找标题形如 <worker名>-KV 的
  const list = run(NPX, npxArgs(['kv', 'namespace', 'list']));
  let nsId = null;
  if (list.code === 0) {
    const arr = extractJsonArray(list.stdout);
    const hit = Array.isArray(arr)
      ? arr.find((n) => typeof n?.title === 'string' && n.title === `${WORKER_NAME}-KV`)
      : null;
    if (hit?.id) nsId = hit.id;
  }

  if (!nsId) {
    console.log(`  未找到 ${WORKER_NAME}-KV，创建…`);
    const created = runOrDie(
      NPX,
      npxArgs(['kv', 'namespace', 'create', 'KV']),
      '创建 KV namespace',
    );
    const m = created.all.match(/id\s*=\s*"([0-9a-f]{32})"/i);
    if (!m) {
      console.error(`\n✘ 无法从 wrangler 输出中解析新 namespace 的 ID：\n${created.all}`);
      process.exit(1);
    }
    nsId = m[1];
  } else {
    console.log(`  已存在（${nsId}），直接复用。`);
  }

  toml = toml
    .replace(
      new RegExp(`id\\s*=\\s*"${KV_ID_PLACEHOLDER}"`),
      `id = "${nsId}"`,
    )
    .replace(
      new RegExp(`preview_id\\s*=\\s*"${KV_PREVIEW_PLACEHOLDER}"`),
      `preview_id = "${nsId}"`,
    );
  writeFileSync(TOML_PATH, toml);
  console.log(`  已把 KV ID 回填进 wrangler.toml。`);
}

console.log('▶ 2/4 检查 R2 bucket…');
{
  const list = run(NPX, npxArgs(['r2', 'bucket', 'list']));
  let exists = false;
  if (list.code === 0) {
    const arr = extractJsonArray(list.stdout);
    exists = Array.isArray(arr) && arr.some((b) => b?.name === R2_BUCKET);
  }
  if (exists) {
    console.log(`  ${R2_BUCKET} 已存在。`);
  } else {
    const created = run(NPX, npxArgs(['r2', 'bucket', 'create', R2_BUCKET]));
    if (created.code !== 0 && !/already exists|10041/i.test(created.all)) {
      console.error(`\n✘ 创建 R2 bucket 失败（exit ${created.code}）：\n${created.all}`);
      process.exit(created.code);
    }
    console.log(`  ${R2_BUCKET} 就绪。`);
  }
}

console.log('▶ 3/4 发布 Worker…');
{
  const args = ['deploy'];
  for (const key of ['SITE_URL', 'FRONTEND_URL']) {
    const v = process.env[key];
    // wrangler --var 会覆盖 toml 里的 [vars]，只在 CI 环境变量真的给了值时传
    if (v && v.trim()) args.push('--var', `${key}:${v.trim()}`);
  }
  const deployed = runOrDie(NPX, npxArgs(args), 'wrangler deploy');
  console.log(deployed.stdout.trimEnd());
}

if (process.env.DATABASE_URL) {
  console.log('▶ 4/4 把 DATABASE_URL 写入 Worker Secret…');
  // secret put 非交互时从 stdin 读值；失败不阻断（也许面板里已手动设过）
  const r = run(NPX, npxArgs(['secret', 'put', 'DATABASE_URL']), {
    input: `${process.env.DATABASE_URL}\n`,
  });
  console.log(r.code === 0 ? '  已写入。' : `  写入失败（可忽略，若面板里已设置）：\n${r.all}`);
} else {
  console.log('▶ 4/4 跳过 Secret（CI 环境变量里没有 DATABASE_URL）。');
  console.log('  记得到 Cloudflare 面板 → 该 Worker → 设置 → 变量和机密，添加 DATABASE_URL。');
}

console.log('\n✅ 部署完成。');
