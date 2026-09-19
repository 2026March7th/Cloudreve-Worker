/**
 * 驱动工厂。对应原版 `pkg/filemanager/manager/fs.go` 的 `GetStorageDriver`。
 *
 * 原版是一个覆盖 10 种策略类型的 switch；边缘版只实现两种：
 *   - `s3`       → R2Driver（Cloudflare R2，走 Worker 绑定；R2 兼容 S3 API，
 *                  上游前端 PolicyType 枚举没有 'r2'，必须以 's3' 呈现）
 *   - `onedrive` → OneDriveDriver（Microsoft Graph）
 *
 * 其余类型（local / oss / cos / obs / ks3 / qiniu / upyun / remote /
 * load_balance）未实现，取驱动时会抛 `CodePolicyNotAllowed`。
 */
import type { Env } from '../env';
import type { StoragePolicyRow } from '../db/types';
import { AppError, CodePolicyNotAllowed } from '../lib/errors';
import { PolicyType } from '../lib/boolset';
import { R2Driver } from './r2';
import { OneDriveDriver } from './onedrive';
import type { StorageDriver } from './types';

/** 当前实现支持的策略类型。 */
export const SUPPORTED_POLICY_TYPES = [PolicyType.S3, PolicyType.OneDrive] as const;

export function getStorageDriver(env: Env, policy: StoragePolicyRow): StorageDriver {
  switch (policy.type) {
    case PolicyType.S3:
      return new R2Driver(env, policy);
    case PolicyType.OneDrive:
      return new OneDriveDriver(env, policy);
    default:
      throw new AppError(
        CodePolicyNotAllowed,
        `Storage policy type "${policy.type}" is not supported by the edge build`,
      );
  }
}

/** 该策略类型是否可用（用于过滤策略列表、校验用户组绑定）。 */
export function isPolicyTypeSupported(type: string): boolean {
  return (SUPPORTED_POLICY_TYPES as readonly string[]).includes(type);
}

export * from './types';
export { R2Driver } from './r2';
export { OneDriveDriver } from './onedrive';
