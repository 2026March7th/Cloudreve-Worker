/**
 * 分享有效性判定。逐条对应原版 `inventory/share.go`：
 *   - `IsShareExpired`：过了有效期，或剩余下载次数用尽；
 *   - `IsValidShare`：过期之外，还要求分享者状态正常、源文件未被删除且属主一致；
 *   - （上游 PR #3524）分享者当前所属组必须仍有 Share 权限位 —— 组权限被
 *     关掉或被换到无 Share 权限的组后，其分享立即失效，不用等管理员手动删。
 *
 * 抽成独立模块是因为 `fs.ts`（share navigator）与 `share.ts`（列表/详情）
 * 都要用；放在任一者里都会形成循环依赖。
 */
import type { FileRow, GroupRow, ShareRow, UserRow } from '../db/types';
import { BooleanSet, GroupPermission } from '../lib/boolset';

/** `inventory.IsShareExpired`。 */
export function isShareExpired(share: ShareRow): boolean {
  if (share.expires && share.expires.getTime() < Date.now()) return true;
  if (share.remain_downloads !== null && share.remain_downloads <= 0) return true;
  return false;
}

/**
 * `inventory.IsValidShare`。
 *
 * 注意源文件那一项：原版写的是 `file.FileChildren == 0`，而 `file_children`
 * 在库里可空，NULL 读进 Go 的 int 就是 0 —— 所以「0」实际等价于
 * 「NULL 或 0」，即根目录或回收站项，两种情况源文件都不可用。
 *
 * `ownerGroup` 传 `undefined`（旧调用方未查组）时跳过权限位检查；显式传
 * `null`（组加载失败/已被删）或权限位关闭都判无效 —— 与上游 PR #3524 的
 * `Edges.GroupOrErr()` 语义一致。
 */
export function isShareInvalid(
  share: ShareRow,
  file: FileRow | null,
  owner: UserRow | null,
  ownerGroup?: GroupRow | null,
): boolean {
  if (isShareExpired(share)) return true;
  if (!owner || owner.status !== 'active') return true;
  if (ownerGroup !== undefined) {
    if (!ownerGroup) return true;
    if (!new BooleanSet(ownerGroup.permissions).enabled(GroupPermission.Share)) return true;
  }
  if (!file) return true;
  if (file.file_children === null) return true;
  if (file.owner_id !== owner.id) return true;
  return false;
}
