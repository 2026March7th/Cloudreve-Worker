/**
 * 布尔位集。对应 Cloudreve v4 的 `pkg/boolset/boolset.go`。
 *
 * 存储形态是 `[]byte`（数据库列类型 bytea），位序为 **LSB-first**：
 * 第 flag 位位于字节 `flag / 8` 的第 `flag % 8` 位（从最低位起数）。
 * 对外字符串表示是 **base64**（Go 里 `[]byte` 经 encoding/json 默认编码为 base64），
 * 这一点前端会直接读到，必须保持一致。
 */
import { base64ToBytes, bytesToBase64 } from './crypto';

export class BooleanSet {
  private bytes: Uint8Array;

  constructor(bytes?: Uint8Array | null) {
    this.bytes = bytes && bytes.length ? Uint8Array.from(bytes) : new Uint8Array(0);
  }

  static fromBase64(b64: string | null | undefined): BooleanSet {
    if (!b64) return new BooleanSet();
    try {
      return new BooleanSet(base64ToBytes(b64));
    } catch {
      return new BooleanSet();
    }
  }

  static fromFlags(...flags: number[]): BooleanSet {
    const bs = new BooleanSet();
    for (const f of flags) bs.set(f, true);
    return bs;
  }

  enabled(flag: number): boolean {
    if (flag >= this.bytes.length * 8) return false;
    return (this.bytes[flag >> 3]! & (1 << (flag & 7))) !== 0;
  }

  set(flag: number, enabled: boolean): this {
    const needed = (flag >> 3) + 1;
    if (this.bytes.length < needed) {
      const grown = new Uint8Array(needed);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    if (enabled) {
      this.bytes[flag >> 3]! |= 1 << (flag & 7);
    } else {
      this.bytes[flag >> 3]! &= ~(1 << (flag & 7)) & 0xff;
    }
    return this;
  }

  /** 转 base64 字符串，用于 JSON 响应。 */
  toBase64(): string {
    return bytesToBase64(this.bytes);
  }

  /** 原始字节，用于写库。 */
  toBytes(): Uint8Array {
    return this.bytes;
  }

  /** 任意一位为真即为「非空」。 */
  get isEmpty(): boolean {
    return this.bytes.every((b) => b === 0);
  }

  clone(): BooleanSet {
    return new BooleanSet(this.bytes);
  }
}

/**
 * 用户组权限位。取自 `inventory/types/types.go` 的 GroupPermission。
 * 「CommunityPlaceholder」是社区版占位位，语义上无对应功能，
 * 保留编号以免位序错乱。
 */
export const GroupPermission = {
  IsAdmin: 0,
  IsAnonymous: 1,
  Share: 2,
  WebDAV: 3,
  ArchiveDownload: 4,
  ArchiveTask: 5,
  WebDAVProxy: 6,
  ShareDownload: 7,
  CommunityPlaceholder1: 8,
  RemoteDownload: 9,
  CommunityPlaceholder2: 10,
  RedirectedSource: 11,
  AdvanceDelete: 12,
  CommunityPlaceholder3: 13,
  CommunityPlaceholder4: 14,
  SetExplicitUserPlaceholder: 15,
  IgnoreFileOwnership: 16,
  UniqueRedirectDirectLink: 17,
} as const;

/** 文件 / 文件夹类型。对应 `types.FileType`。 */
export const FileType = {
  File: 0,
  Folder: 1,
} as const;

export type FileTypeValue = (typeof FileType)[keyof typeof FileType];

/** 实体类型。对应 `types.EntityType`。 */
export const EntityType = {
  Version: 0,
  Thumbnail: 1,
  LivePhoto: 2,
} as const;

/** 实体来源类型字符串（`entities.recycle_options` 等 JSON 列用不到，此处供驱动使用）。 */
export const PolicyType = {
  Local: 'local',
  Qiniu: 'qiniu',
  Upyun: 'upyun',
  Oss: 'oss',
  Cos: 'cos',
  S3: 's3',
  Ks3: 'ks3',
  OneDrive: 'onedrive',
  Remote: 'remote',
  Obs: 'obs',
  // 负载均衡是「虚拟策略」：没有自己的驱动，在策略解析层
  // （context.resolvePolicy / groupPolicies）展开成实际 slave 策略。
  // 前端 PolicyType 枚举有这个值（StoragePolicyCard 按 type 查
  // PolicyPropsMap 渲染），库里出现它不会让前端崩。
  LoadBalance: 'load_balance',
  // 注意：不引入自造类型。R2 走 S3 兼容 API，对内对外都用 's3'
  //（上游前端 PolicyType 枚举没有 'r2'，出现未知 type 会让
  // StoragePolicyCard 的 PolicyPropsMap[type].img 直接抛 undefined）。
} as const;

export type PolicyTypeValue = (typeof PolicyType)[keyof typeof PolicyType];
