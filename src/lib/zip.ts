/**
 * ZIP 打包器（store 模式，可流式输出）。
 *
 * 为什么自己写：上游打包走的是 `archiver` + 后台任务队列，边缘版没有后台 worker，
 * 而 Workers 上也没有可用的 zip 库。打包下载是文件管理器里最常用的功能之一，
 * 值得把它做出来。
 *
 * 设计取舍：
 *   - **只做 store（不压缩）**。Workers 的 CPU 时间很贵，deflate 一个大包很容易
 *     撞上 CPU 上限；store 模式只是拷贝字节，代价和一次下载差不多。
 *     压缩率换不来这个风险。
 *   - **流式输出**，不在内存里攒整个包。每个条目先写 local header（长度/CRC 留 0），
 *     数据边读边算 CRC 边吐给客户端，末尾补 data descriptor（bit 3）。
 *     只有中央目录需要攒着（每项 46+name 字节，很小）。
 *   - 不支持 ZIP64：单文件 >4GB 或条目 >65535 时直接报错，宁可明确失败也不要
 *     产出一个静默损坏的包。
 *
 * 格式依据 APPNOTE.TXT 6.3.x：`sendFullTextSearch` 同款严谨度没必要，
 * 但字段偏移一个字节都不能错，否则解压器读不出来。
 */

/** CRC32（IEEE 802.3，与 zlib 一致）。表在首次使用时惰性生成。 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export class Crc32 {
  private crc = 0xffffffff;

  update(bytes: Uint8Array): void {
    const table = getCrcTable();
    let c = this.crc;
    for (let i = 0; i < bytes.length; i += 1) {
      c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    this.crc = c >>> 0;
  }

  get value(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

/** 一个待打包的条目。 */
export interface ZipEntry {
  /** 包内路径。目录条目请以 `/` 结尾且 `data` 为 null。 */
  name: string;
  /**
   * 条目内容的字节流，或「取字节流」的惰性工厂。
   *
   * 打包大目录时每个条目的内容都要去对象存储拉一次，如果在这里就把所有流都
   * 打开，等于同时发起几百个请求。用工厂可以做到轮到谁才打开谁。
   */
  data: ReadableStream<Uint8Array> | (() => Promise<ReadableStream<Uint8Array>>) | null;
  /** 最后修改时间，用于 DOS 时间戳。 */
  modifiedAt?: Date;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** bit 3（长度与 CRC 走 data descriptor） + bit 11（文件名为 UTF-8）。 */
const GENERAL_FLAGS = 0x0008 | 0x0800;

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

export class ZipLimitError extends Error {}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 小端写入，返回新的游标。所有多字节字段都是 little-endian。 */
function writeU16(b: Uint8Array, at: number, v: number): number {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  return at + 2;
}

function writeU32(b: Uint8Array, at: number, v: number): number {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
  b[at + 3] = (v >>> 24) & 0xff;
  return at + 4;
}

interface CentralEntry {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/**
 * 打包成 ZIP 字节流。
 *
 * `entries` 会被**顺序消费**：每个条目的 `data` 只有在轮到它时才被读取，
 * 所以调用方可以放心传入「一打开就会去对象存储拉取」的惰性流。
 */
export function createZipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipLimitError(`Too many entries: ${entries.length} > ${MAX_ENTRIES}`);
  }

  const encoder = new TextEncoder();
  const central: CentralEntry[] = [];
  let index = 0;
  let offset = 0;

  // 当前条目正在吐数据时的 reader
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let current: CentralEntry | null = null;
  let crc = new Crc32();
  let size = 0;

  const push = (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array) => {
    controller.enqueue(bytes);
    offset += bytes.length;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 阶段一：逐条目输出 local header + 数据 + data descriptor
      while (index < entries.length) {
        if (reader) {
          const { done, value } = await reader.read();
          if (done) {
            // 收尾：data descriptor
            const desc = new Uint8Array(16);
            writeU32(desc, 0, DATA_DESCRIPTOR_SIG);
            writeU32(desc, 4, crc.value);
            writeU32(desc, 8, size);
            writeU32(desc, 12, size);
            push(controller, desc);

            current!.crc = crc.value;
            current!.size = size;
            central.push(current!);

            reader = null;
            current = null;
            index += 1;
            continue;
          }
          const chunk = value as Uint8Array;
          crc.update(chunk);
          size += chunk.length;
          if (size > MAX_SIZE) throw new ZipLimitError('Entry exceeds the 4 GiB ZIP limit');
          push(controller, chunk);
          continue;
        }

        const entry = entries[index]!;
        const nameBytes = encoder.encode(entry.name);
        const { time, date } = dosDateTime(entry.modifiedAt ?? new Date());

        const header = new Uint8Array(30 + nameBytes.length);
        let at = writeU32(header, 0, LOCAL_HEADER_SIG);
        at = writeU16(header, at, 20); // version needed
        at = writeU16(header, at, GENERAL_FLAGS);
        at = writeU16(header, at, 0); // store
        at = writeU16(header, at, time);
        at = writeU16(header, at, date);
        at = writeU32(header, at, 0); // crc -> data descriptor
        at = writeU32(header, at, 0); // compressed size -> data descriptor
        at = writeU32(header, at, 0); // uncompressed size -> data descriptor
        at = writeU16(header, at, nameBytes.length);
        writeU16(header, at, 0); // extra length
        // 文件名本体紧跟在 30 字节定长头之后 —— 别忘了真的写进去，
        // 只写长度不写内容是解压器报 "File name in directory X and header Y differ" 的经典原因
        header.set(nameBytes, 30);

        // 记录 local header 的起始偏移，中央目录要用
        const entryOffset = offset;
        push(controller, header);

        crc = new Crc32();
        size = 0;
        current = { nameBytes, crc: 0, size: 0, offset: entryOffset, time, date };

        if (entry.data) {
          const stream =
            typeof entry.data === 'function' ? await entry.data() : entry.data;
          reader = stream.getReader();
        } else {
          // 目录条目：没有数据，直接收尾
          const desc = new Uint8Array(16);
          writeU32(desc, 0, DATA_DESCRIPTOR_SIG);
          writeU32(desc, 4, 0);
          writeU32(desc, 8, 0);
          writeU32(desc, 12, 0);
          push(controller, desc);
          current.crc = 0;
          current.size = 0;
          central.push(current);
          current = null;
          index += 1;
        }
      }

      // 阶段二：中央目录
      const centralStart = offset;
      for (const c of central) {
        const header = new Uint8Array(46 + c.nameBytes.length);
        let at = writeU32(header, 0, CENTRAL_HEADER_SIG);
        at = writeU16(header, at, 20); // version made by
        at = writeU16(header, at, 20); // version needed
        at = writeU16(header, at, GENERAL_FLAGS);
        at = writeU16(header, at, 0); // store
        at = writeU16(header, at, c.time);
        at = writeU16(header, at, c.date);
        at = writeU32(header, at, c.crc);
        at = writeU32(header, at, c.size);
        at = writeU32(header, at, c.size);
        at = writeU16(header, at, c.nameBytes.length);
        at = writeU16(header, at, 0); // extra
        at = writeU16(header, at, 0); // comment
        at = writeU16(header, at, 0); // disk number start
        at = writeU16(header, at, 0); // internal attrs
        at = writeU32(header, at, 0); // external attrs
        at = writeU32(header, at, c.offset);
        header.set(c.nameBytes, at);
        push(controller, header);
      }
      const centralSize = offset - centralStart;

      // 阶段三：EOCD
      const eocd = new Uint8Array(22);
      let e = writeU32(eocd, 0, EOCD_SIG);
      e = writeU16(eocd, e, 0);
      e = writeU16(eocd, e, 0);
      e = writeU16(eocd, e, central.length);
      e = writeU16(eocd, e, central.length);
      e = writeU32(eocd, e, centralSize);
      e = writeU32(eocd, e, centralStart);
      writeU16(eocd, e, 0); // comment length
      push(controller, eocd);

      controller.close();
    },
  });
}
