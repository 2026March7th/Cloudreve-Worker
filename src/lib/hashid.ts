/**
 * HashID 编解码。对应 Cloudreve v4 的 `pkg/hashid/hash.go`。
 *
 * 原版用 `github.com/speps/go-hashids`，salt 取自站点设置 `hash_id_salt`，
 * 字母表用库默认值，minLength 为 0。这里的 `hashids` npm 包默认字母表与之
 * 逐字相同（`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890`），
 * 因此同一 salt 下产出的 ID 与 Go 版一致。
 *
 * 编码值恒为 `[id, type]` 两元组，解码时校验类型位，不匹配即报错。
 */
import Hashids from 'hashids';

/** ID 类型。数值即为 hashids 载荷的第二个元素，顺序必须与原版一致。 */
export const IDType = {
  Share: 0,
  User: 1,
  File: 2,
  Folder: 3,
  Tag: 4,
  Policy: 5,
  SourceLink: 6,
  Group: 7,
  Entity: 8,
  AuditLog: 9,
  Node: 10,
  Task: 11,
  DavAccount: 12,
  Payment: 13,
} as const;

export type IDTypeValue = (typeof IDType)[keyof typeof IDType];

export class HashIDCodec {
  private readonly hashids: Hashids;

  constructor(salt: string) {
    this.hashids = new Hashids(salt);
  }

  encode(id: number, type: IDTypeValue): string {
    return this.hashids.encode([id, type]);
  }

  /** 解码并校验类型位。类型不匹配或长度不对时返回 null。 */
  decode(raw: string, type: IDTypeValue): number | null {
    if (!raw) return null;
    let res: number[];
    try {
      res = this.hashids.decode(raw) as number[];
    } catch {
      return null;
    }
    if (res.length !== 2 || res[1] !== type) return null;
    return res[0];
  }

  /** 不校验类型、仅取第一个元素的宽松解码，用于「先解析再判断」的场景。 */
  decodeAny(raw: string): number[] | null {
    if (!raw) return null;
    try {
      const res = this.hashids.decode(raw) as number[];
      return res.length ? res : null;
    } catch {
      return null;
    }
  }

  encodeUserID(id: number): string {
    return this.encode(id, IDType.User);
  }
  encodeFileID(id: number): string {
    return this.encode(id, IDType.File);
  }
  encodeShareID(id: number): string {
    return this.encode(id, IDType.Share);
  }
  encodePolicyID(id: number): string {
    return this.encode(id, IDType.Policy);
  }
  encodeGroupID(id: number): string {
    return this.encode(id, IDType.Group);
  }
  encodeEntityID(id: number): string {
    return this.encode(id, IDType.Entity);
  }
  encodeSourceLinkID(id: number): string {
    return this.encode(id, IDType.SourceLink);
  }
  encodeTaskID(id: number): string {
    return this.encode(id, IDType.Task);
  }

  decodeUserID(raw: string): number | null {
    return this.decode(raw, IDType.User);
  }
  decodeFileID(raw: string): number | null {
    return this.decode(raw, IDType.File);
  }
  decodeShareID(raw: string): number | null {
    return this.decode(raw, IDType.Share);
  }
  decodePolicyID(raw: string): number | null {
    return this.decode(raw, IDType.Policy);
  }
  decodeGroupID(raw: string): number | null {
    return this.decode(raw, IDType.Group);
  }
  decodeEntityID(raw: string): number | null {
    return this.decode(raw, IDType.Entity);
  }
  decodeSourceLinkID(raw: string): number | null {
    return this.decode(raw, IDType.SourceLink);
  }
  decodeTaskID(raw: string): number | null {
    return this.decode(raw, IDType.Task);
  }
}
