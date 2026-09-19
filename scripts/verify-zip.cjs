/**
 * ZIP 打包器的验证脚本（一次性工具，不参与构建）。
 *
 * 自己写的打包器最容易在「字段偏移写错一字节」上翻车，而这类错误类型检查
 * 抓不到，只能让真正的解压器去读。所以这里生成几个包，交给 Python 标准库的
 * `zipfile`（配合 `testzip()` 逐条校验 CRC）去判定，比自说自话靠谱得多。
 *
 * 覆盖的点：
 *   1. 文本文件、二进制文件、空目录条目
 *   2. 中文文件名（依赖 general flags 的 UTF-8 bit 11）
 *   3. 多分片流（验证 pull 循环在跨 chunk 时 CRC 累加正确）
 *   4. 空包（0 条目）也要能产出合法 EOCD
 */
const fs = require('fs');
const path = require('path');
const { createZipStream, Crc32 } = require('./zip.js');

const OUT_DIR = path.join(__dirname, '..', '_verify');

function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** 分多次吐出，专门验证跨 chunk 的 CRC 累加。 */
function streamOfChunks(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]);
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

async function drainToFile(stream, file) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  fs.writeFileSync(file, Buffer.concat(chunks.map((c) => Buffer.from(c))));
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).length;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const text = new TextEncoder().encode('Hello, ZIP! 这是一段用于验证的中文文本。');
  const binary = new Uint8Array(512);
  for (let i = 0; i < binary.length; i += 1) binary[i] = i & 0xff;

  // 1. 常规包
  const entries = [
    { name: 'hello.txt', data: streamOf(text) },
    { name: 'empty-dir/', data: null },
    { name: 'nested/deep/中文文件.txt', data: streamOfChunks([text.slice(0, 5), text.slice(5)]) },
    { name: 'bin.dat', data: streamOf(binary) },
  ];
  const size1 = await drainToFile(createZipStream(entries), path.join(OUT_DIR, 'normal.zip'));
  console.log(`normal.zip written (${size1} bytes)`);

  // 2. 空包
  const size2 = await drainToFile(createZipStream([]), path.join(OUT_DIR, 'empty.zip'));
  console.log(`empty.zip written (${size2} bytes)`);

  // 3. CRC32 对已知值（"The quick brown fox jumps over the lazy dog" 的 CRC32 = 0x414FA339）
  const crc = new Crc32();
  crc.update(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'));
  const expected = 0x414fa339;
  const ok = crc.value === expected;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  CRC32 已知值 期望=0x${expected.toString(16)} 实际=0x${crc.value.toString(16)}`,
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
