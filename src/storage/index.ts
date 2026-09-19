/**
 * 驱动工厂。对应原版 `pkg/filemanager/manager/fs.go` 的 `GetStorageDriver`。
 *
 * 原版是一个覆盖 10 种策略类型的 switch；边缘版只实现两种：
 *   - `r2`       → R2Driver（Cloudflare 对象存储，走 Worker 绑定）
 *   - `onedrive` → OneDriveDriver（Microsoft Graph）
 *
 * 其余类型（local / s3 / oss / cos / obs / ks3 / qiniu / upyun / remote）
 * 未实现，取驱动时会抛 `CodePolicyNotAllowed`。
 */
import type { Env } from '../env';
import type { StoragePolicyRow } from '../db/types';
import { AppError, CodePolicyNotAllowed } from '../lib/errors';
import { PolicyType } from '../lib/boolset';
import { R2Driver } from './r2';
import { OneDriveDriver } from './onedrive';
import type { StorageDriver } from './types';

/** 当前实现支持的策略类型。 */
export const SUPPORTED_POLICY_TYPES = [PolicyType.R2, PolicyType.OneDrive] as const;

export function getStorageDriver(env: Env, policy: StoragePolicyRow): StorageDriver {
  switch (policy.type) {
    case PolicyType.R2:
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
