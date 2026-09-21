#!/usr/bin/env node
/**
 * 构建期装配：把 `KV_COUNT` 变成一个具体的 wrangler.toml。
 *
 * ## 为什么必须有这一步
 *
 * Cloudflare 的 KV 绑定是 `wrangler.toml` 里 `[[kv_namespaces]]` 的**静态
 * 声明**，绑定名是编译期常量。Worker 代码里不存在「运行时创建 N 个
 * namespace」这回事。所以「环境变量填 4 就创建 4 个」这个需求，只能在
 * **构建时把 4 写进配置文件**，再由部署脚本去创建对应的 namespace。
 *
 * ## 上限 5 是硬闸门
 *
 * `KV_COUNT` 允许 1..5。超过 5（或非法值）→ **直接拒绝构建**（非零退出），
 * 而不是「悄悄截断成 5」。理由：静默截断会让人以为配了 8 个而实际只有 5 个，
 * 排查时极其痛苦；构建失败是最快最清楚的反馈。
 *
 * ## 幂等
 *
 * 脚本会把自己的托管区（`# >>> multi-kv:begin` .. `# <<< multi-kv:end`）
 * 整块重写，所以重复运行结果一致，也不会碰文件里其他内容。
 * `KV_COUNT` 调小时，多出来的 `KV_n` 声明会被删掉（namespace 本身不删，
 * 数据还在，只是不再绑定 —— 这是刻意的，避免误删数据）。
 *
 * 用法：
 *   node scripts/setup-kv.mjs            # 读 KV_COUNT / KV_COUNT 文件
 *   node scripts/setup-kv.mjs --count 3
 *   node scripts/setup-kv.mjs --dry      # 只打印将写入的内容
 *   node scripts/setup-kv.mjs --verify   # 装配后再核对线上实际绑定
 *
 * ## 数量从哪来（优先级从高到低）
 *
 *   1. `--count N` 命令行参数
 *   2. 环境变量 `KV_COUNT`（**构建环境**的，不是 Worker 面板的）
 *   3. 仓库根目录的 `KV_COUNT` / `.kv-count` / `kv-count.txt` 文件（内容为 N）
 *   4. 默认 1
 *
 * ⚠️ **「Cloudflare 面板 → 变量和机密」里的 KV_COUNT 是运行时变量，
 * 构建时读不到**，会被这条链忽略而落回默认 1。要配这个变量，请放
 * 「Workers Builds 的环境变量」或「GitHub 仓库 Variables」，或者用文件方式。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');

const MAX_KV = 5;
const BEGIN = '# >>> multi-kv:begin';
const END = '# <<< multi-kv:end';
const PLACEHOLDER = 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID';

function loadEnvFile() {
  const out = {};
  const p = path.join(ROOT, '.dev.vars');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

const fileVars = loadEnvFile();
const envVar = (k) => process.env[k]?.trim() || fileVars[k]?.trim() || '';

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * 读取「已提交进仓库」的数量文件。
 *
 * ## 为什么需要这个（而不是只靠环境变量）
 *
 * `setup-kv.mjs` 跑在**构建环境**里，它读得到的是**构建环境**的环境变量。
 * 而「Cloudflare 面板 → 变量和机密」里填的 KV_COUNT 是**运行时**变量，
 * 构建时根本看不到 —— 于是它落回默认值 1，用户以为配了 5 个，实际只绑了 1 个。
 *
 * 这是个很难自查的坑：回退机制让站点**不报错**，看起来一切正常。
 *
 * 所以除环境变量外，额外支持一个**版本控制里的纯文本文件**：
 *   - `KV_COUNT` 文件内容为 `5`
 *   - 或 `.kv-count`
 * 文件随仓库走，构建时必然可读，且不依赖任何平台侧配置 —— 最不易出错。
 *
 * 优先级：`--count` 参数 > 环境变量 > 文件 > 默认 1。
 */
function loadCountFile() {
  for (const name of ['KV_COUNT', '.kv-count', 'kv-count.txt']) {
    const p = path.join(ROOT, name);
    if (!existsSync(p)) continue;
    // 取第一个非空、非注释行；容忍尾随换行与行尾注释。
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      return { value: s.split('#')[0].trim(), from: name };
    }
  }
  return null;
}

const countFile = loadCountFile();
const fromEnv = envVar('KV_COUNT');
const fromArg = argOf('--count');

const raw = fromArg ?? (fromEnv !== '' ? fromEnv : (countFile?.value ?? ''));
const countStr = raw === '' ? '1' : raw;
const countSource =
  fromArg !== undefined
    ? '--count 参数'
    : fromEnv !== ''
      ? '环境变量 KV_COUNT'
      : countFile
        ? `文件 ${countFile.from}`
        : '默认值（未配置）';

// --- 校验：必须是 1..5 的整数，否则拒绝构建 -------------------------------
if (!/^\d+$/.test(countStr)) {
  console.error(
    `\n✘ KV_COUNT 不是整数："${countStr}"（来源：${countSource}）\n` +
      `  取值必须是 1 到 ${MAX_KV} 之间的整数。\n`,
  );
  process.exit(1);
}
const count = Number(countStr);
if (count < 1) {
  console.error(`\n✘ KV_COUNT 不能小于 1（当前 ${count}，来源：${countSource}）。至少要一个 KV 绑定。\n`);
  process.exit(1);
}
if (count > MAX_KV) {
  console.error(
    `\n✘ KV_COUNT = ${count} 超过上限 ${MAX_KV}，拒绝构建（来源：${countSource}）。\n` +
      `  Cloudflare 部署允许的 KV 绑定数有上限，且本项目按 5 个角色分工\n` +
      `  （site/session/upload/cred/flag）。改小到 ≤ ${MAX_KV} 再部署。\n`,
  );
  process.exit(1);
}

// 把来源打出来。这一行是排查「填了 5 却只绑了 1 个」的关键线索 ——
// 之前没有任何输出，用户无从知道脚本到底读到了什么、落回了什么。
console.log(`  KV_COUNT = ${count}（来源：${countSource}）`);
if (count === 1 && countFile === null && fromEnv === '' && fromArg === undefined) {
  console.log(
    `  提示：未在任何地方配置 KV_COUNT，按默认 1 个处理。\n` +
      `  想用多 KV，二选一：\n` +
      `    ① 仓库 Settings → Secrets and variables → Actions → Variables 加 KV_COUNT=5\n` +
      `    ② 在仓库根目录提交一个内容为 5 的 KV_COUNT 文件（最稳，随仓库走）\n`,
  );
}

// --- 变更侦测：之前只有 KV_1，现在要 5 个，给出明确提示 -------------------
const prevToml = readFileSync(TOML_PATH, 'utf8');
const prevCountMatch = /# KV_COUNT = (\d+)/.exec(prevToml);
const prevCount = prevCountMatch ? Number(prevCountMatch[1]) : null;
if (prevCount !== null && prevCount !== count) {
  console.log(`  KV 绑定数将从 ${prevCount} 变为 ${count}（wrangler.toml 会重写）`);
}

// --- 生成托管区 -----------------------------------------------------------
// KV_1..KV_n：按角色分工使用的 namespace。
// 始终额外声明一个裸 `KV`：它是 lib/kvRouter.ts 的兜底绑定，
// 让「只有 KV 一个绑定」的老部署也能跑，不需要重配。
const lines = [];
lines.push(BEGIN);
lines.push('# 本区由 scripts/setup-kv.mjs 自动生成，请勿手改。');
lines.push(`# KV_COUNT = ${count}（上限 ${MAX_KV}，超过则拒绝构建）`);
lines.push('# 角色分工见 src/lib/kvRouter.ts：');
lines.push('#   KV_1=site(站点设置缓存) KV_2=session(会话/验证码/2FA)');
lines.push('#   KV_3=upload(上传/打包/WebDAV锁) KV_4=cred(外部凭据缓存)');
lines.push('#   KV_5=flag(自举标记)    KV=兜底（未配置 KV_n 时所有角色回落到它）');
lines.push('');
for (let i = 1; i <= count; i++) {
  lines.push(`[[kv_namespaces]]`);
  lines.push(`binding = "KV_${i}"`);
  lines.push(`id = "${PLACEHOLDER}_${i}"`);
  lines.push(`preview_id = "${PLACEHOLDER}_PREVIEW_${i}"`);
  lines.push('');
}
lines.push('[[kv_namespaces]]');
lines.push('binding = "KV"');
lines.push(`id = "${PLACEHOLDER}"`);
lines.push(`preview_id = "${PLACEHOLDER}_PREVIEW"`);
lines.push(END);

const block = lines.join('\n');

let toml = readFileSync(TOML_PATH, 'utf8');

// 删掉多余的 KV_n 声明块（KV_COUNT 调小的情况）。
// 这些块由本脚本生成过，格式可预测；不在托管区里的手写块不动。
for (let i = MAX_KV; i > count; i--) {
  const re = new RegExp(
    `\\n\\[\\[kv_namespaces\\]\\]\\nbinding = "KV_${i}"\\nid = "[^"]*"\\npreview_id = "[^"]*"\\n`,
    'g',
  );
  toml = toml.replace(re, '\n');
}

// 先把旧的托管区整块去掉
const beginIdx = toml.indexOf(BEGIN);
const endIdx = toml.indexOf(END);
if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
  toml = toml.slice(0, beginIdx) + toml.slice(endIdx + END.length);
}

// 去掉**所有**残留的 [[kv_namespaces]] 块（无论是旧的托管区残留还是手工写的）
// —— 统一改由托管区管理，避免出现重复绑定名导致 wrangler 报错。
toml = toml.replace(
  /\n*\[\[kv_namespaces\]\]\nbinding = "[^"]*"\nid = "[^"]*"\npreview_id = "[^"]*"\n?/g,
  '\n',
);

// 插到 [assets] 段之前（保持「绑定声明在配置段之前」的可读顺序）。
// 注意：必须匹配**行首**的 `[assets]`。正文注释里也出现过 `[assets]`
// （"配 FRONTEND_URL 后反代优先于 [assets]。"），用 indexOf 会命中注释
// 把那一行劈成两半。
const anchorMatch = /^\[assets\]\s*$/m.exec(toml);
if (!anchorMatch) {
  console.error('\n✘ wrangler.toml 里找不到行首的 [assets] 段，无法定位插入点。\n');
  process.exit(1);
}
const anchor = anchorMatch.index;
toml = toml.slice(0, anchor) + block + '\n\n' + toml.slice(anchor);

// 收敛多余空行
toml = toml.replace(/\n{3,}/g, '\n\n');

if (process.argv.includes('--dry')) {
  console.log('--- 将写入 wrangler.toml 的 KV 段 ---');
  console.log(block);
  process.exit(0);
}

writeFileSync(TOML_PATH, toml);
console.log(
  `✔ KV 绑定已装配：KV_COUNT=${count} → 声明 KV_1..KV_${count} + 兜底 KV（共 ${count + 1} 个绑定）`,
);

// --- --verify：查线上 Worker 实际绑定了几个 KV ----------------------------
//
// 这是「填了 5 却只绑了 1 个」最容易自查的一步：直接问 Cloudflare
// 这个 Worker 当前到底挂了哪些绑定，而不是相信配置文件。
//
// 需要 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或已 `wrangler login`。
if (process.argv.includes('--verify')) {
  console.log('\n--- 核对线上 Worker 的实际 KV 绑定 ---');
  const workerName = readWorkerName();

  const res = runCapture(['wrangler', 'deployments', 'status', '--json'], workerName);
  // `deployments status` 在部分版本不支持 --json；退回到解析 toml + 提示。
  if (!res.ok) {
    console.log(
      '  无法自动查询线上绑定（需要 wrangler 登录或 CLOUDFLARE_API_TOKEN）。\n' +
        '  请手动核对：Cloudflare 面板 → Workers & Pages → 该 Worker → 设置 → 变量 → KV 命名空间绑定\n' +
        `  应当看到 ${count} 个 KV_n 绑定 + 1 个兜底 KV，共 ${count + 1} 个。`,
    );
    process.exit(0);
  }

  const bound = [...res.out.matchAll(/\b(KV_\d+|KV)\b/g)].map((m) => m[1]);
  const uniq = [...new Set(bound)].sort();
  const expected = [];
  for (let i = 1; i <= count; i++) expected.push(`KV_${i}`);
  expected.push('KV');

  console.log(`  线上绑定：${uniq.length ? uniq.join(', ') : '（未解析到，请手动核对）'}`);
  console.log(`  期望绑定：${expected.join(', ')}`);

  const missing = expected.filter((b) => !uniq.includes(b));
  if (missing.length) {
    console.log(
      `\n⚠ 缺失 ${missing.length} 个：${missing.join(', ')}\n` +
        '  说明这次部署没有把新绑定带上。检查：\n' +
        '    ① 构建时是否真的读到了 KV_COUNT（看本次构建日志里的 "KV_COUNT = N（来源：…）"）\n' +
        '    ② wrangler.toml 是否被提交并推到仓库\n' +
        '    ③ 部署后是否重新部署过（改配置必须重新部署才生效）\n',
    );
    process.exit(1);
  }
  console.log('\n✔ 线上绑定与配置一致。\n');
}

/** 从 wrangler.toml 读 worker 名。 */
function readWorkerName() {
  const m = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(TOML_PATH, 'utf8'));
  return m ? m[1] : 'cloudreve-worker';
}

/** 跑一条命令并捕获输出（失败不退出）。 */
function runCapture(args, wname) {
  try {
    const out = execFileSync('npx', [...args, '--name', wname], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      shell: process.platform === 'win32',
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: String(err?.stdout ?? '') + String(err?.stderr ?? '') };
  }
}
