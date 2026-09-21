/**
 * 校验 src/routes/site.ts 中 DEFAULT_FILE_VIEWERS 的结构正确性。
 * 用法: node scripts/validate-file-viewers.mjs
 *
 * 校验目标（对照 inventory/types/types.go 的 Viewer/ViewerGroup JSON tag
 * 与 inventory/setting.go 的 defaultFileViewers，以及前端
 * redux/siteConfigSlice.ts 的 preProcessor 消费逻辑）：
 *  - 根为 ViewerGroup 数组，恰好 1 组、13 个查看器，id 与上游一致
 *  - 每个 viewer: id/type(builtin|custom|wopi)/display_name/exts 合法
 *  - custom 查看器必须带含 {$src} 的 url 与 max_size>0
 *  - builtin 查看器不带 url
 *  - archive 的 required_group_permission=[5]（GroupPermissionArchiveTask）
 *  - templates 每项含 {ext, display_name}
 *  - JSON.stringify 产物可被 JSON.parse 还原（settings 存储往返一致）
 */
import { readFileSync } from 'node:fs';

const srcPath = new URL('../src/routes/site.ts', import.meta.url);
const src = readFileSync(srcPath, 'utf8');

const MARKER = 'const DEFAULT_FILE_VIEWERS = JSON.stringify(';
const start = src.indexOf(MARKER);
if (start < 0) {
  console.error('FATAL: 找不到 DEFAULT_FILE_VIEWERS 定义');
  process.exit(1);
}

// 括号配平提取数组字面量（比正则稳，不怕引号/嵌套）
let i = start + MARKER.length;
let depth = 1;
let end = -1;
let inStr = null;
while (i < src.length) {
  const ch = src[i];
  const prev = src[i - 1];
  if (inStr) {
    if (ch === inStr && prev !== '\\') inStr = null;
  } else if (ch === "'" || ch === '"' || ch === '`') {
    inStr = ch;
  } else if (ch === '(') {
    depth++;
  } else if (ch === ')') {
    depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  i++;
}
if (end < 0) {
  console.error('FATAL: 括号不配平，提取失败');
  process.exit(1);
}

const literal = src.slice(start + MARKER.length, end);
const groups = new Function(`return (${literal})`)();

let failed = 0;
const ok = (cond, msg) => {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    console.error(`FAIL  ${msg}`);
    failed++;
  }
};

const EXPECTED_IDS = [
  'music', 'epub', 'googledocs', 'm365online', 'pdf', 'video', 'markdown',
  'drawio', 'image', 'monaco', 'photopea', 'excalidraw', 'archive',
];

console.log('== DEFAULT_FILE_VIEWERS 结构校验 ==');
ok(Array.isArray(groups), '根为数组（ViewerGroup[]）');
ok(groups.length === 1, `恰好 1 个组（实际 ${groups.length}）`);
const viewers = Array.isArray(groups) && groups[0]?.viewers;
ok(Array.isArray(viewers), 'group.viewers 为数组');
ok(viewers?.length === 13, `13 个查看器（实际 ${viewers?.length}）`);

const ids = (viewers ?? []).map((v) => v.id);
ok(
  EXPECTED_IDS.every((id) => ids.includes(id)) && ids.length === EXPECTED_IDS.length,
  `id 集合与上游一致（${ids.join(',')}）`,
);

for (const v of viewers ?? []) {
  ok(typeof v.id === 'string' && v.id, `[${v.id}] id 合法`);
  ok(['builtin', 'custom', 'wopi'].includes(v.type), `[${v.id}] type=${v.type} 合法`);
  ok(
    Array.isArray(v.exts) && v.exts.length > 0 && v.exts.every((e) => typeof e === 'string'),
    `[${v.id}] exts 非空字符串数组（${v.exts?.length} 个）`,
  );
  ok(typeof v.display_name === 'string' && v.display_name, `[${v.id}] display_name 合法`);
  if (v.type === 'custom') {
    ok(typeof v.url === 'string' && v.url.includes('{$src}'), `[${v.id}] custom 必须带 {$src} url`);
    ok(typeof v.max_size === 'number' && v.max_size > 0, `[${v.id}] custom max_size>0`);
  } else {
    ok(v.url === undefined, `[${v.id}] builtin 不应带 url`);
  }
  if (v.templates !== undefined) {
    ok(
      Array.isArray(v.templates) &&
        v.templates.every((t) => typeof t.ext === 'string' && typeof t.display_name === 'string'),
      `[${v.id}] templates 每项含 ext/display_name`,
    );
  }
}

const archive = (viewers ?? []).find((v) => v.id === 'archive');
ok(
  archive && JSON.stringify(archive.required_group_permission) === '[5]',
  'archive.required_group_permission === [5]（ArchiveTask 位，与 boolset.ts:84 一致）',
);
ok(
  archive && JSON.stringify(archive.exts) === '["zip","7z"]',
  'archive.exts === [zip, 7z]',
);

const json = JSON.stringify(groups);
const reparsed = JSON.parse(json);
ok(JSON.stringify(reparsed) === json, 'JSON.parse(JSON.stringify(...)) 往返一致');

const video = (viewers ?? []).find((v) => v.id === 'video');
ok(
  video && JSON.stringify(video.exts) === '["mp4","mkv","webm","avi","mov","m3u8","flv"]',
  'video.exts 覆盖 mp4/mkv/webm/avi/mov/m3u8/flv',
);

if (failed > 0) {
  console.error(`\n${failed} 项校验失败`);
  process.exit(1);
}
console.log('\n全部校验通过 ✓');
