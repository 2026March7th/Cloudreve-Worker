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
 *   node scripts/setup-kv.mjs            # 读 KV_COUNT / KV_COUNT_1..5
 *   node scripts/setup-kv.mjs --count 3
 *   node scripts/setup-kv.mjs --dry      # 只打印将写入的内容
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

const raw = argOf('--count') ?? envVar('KV_COUNT') ?? '';
const countStr = raw === '' ? '1' : raw;

// --- 校验：必须是 1..5 的整数，否则拒绝构建 -------------------------------
if (!/^\d+$/.test(countStr)) {
  console.error(
    `\n✘ KV_COUNT 不是整数："${countStr}"\n` +
      `  取值必须是 1 到 ${MAX_KV} 之间的整数。\n`,
  );
  process.exit(1);
}
const count = Number(countStr);
if (count < 1) {
  console.error(`\n✘ KV_COUNT 不能小于 1（当前 ${count}）。至少要一个 KV 绑定。\n`);
  process.exit(1);
}
if (count > MAX_KV) {
  console.error(
    `\n✘ KV_COUNT = ${count} 超过上限 ${MAX_KV}，拒绝构建。\n` +
      `  Cloudflare 部署允许的 KV 绑定数有上限，且本项目按 5 个角色分工\n` +
      `  （site/session/upload/cred/flag）。改小到 ≤ ${MAX_KV} 再部署。\n`,
  );
  process.exit(1);
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
