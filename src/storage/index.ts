/**
 * 驱动工厂。对应原版 `pkg/filemanager/manager/fs.go` 的 `GetStorageDriver`。
 *
 *   - `s3`       → 有 AK/SK 时走 S3CompatibleDriver（AWS / 任意 S3 兼容存储）；
 *                  无 AK/SK 且配置了 R2 绑定时走 R2Driver（Worker 绑定直连，
 *                  向后兼容内置的「R2 Default」策略）
 *   - `oss`      → 阿里云 OSS（S3 兼容层）
 *   - `cos`      → 腾讯云 COS（S3 兼容层）
 *   - `obs`      → 华为云 OBS（S3 兼容层）
 *   - `qiniu`    → 七牛（S3 兼容层）
 *   - `ks3`      → 金山 KS3（S3 兼容层）
 *   - `onedrive` → OneDriveDriver（Microsoft Graph）
 *
 * local / upyun / remote / load_balance 仍未实现（Workers 无本地文件系统、
 * upyun 非 S3 兼容协议、remote/load_balance 依赖节点模型），取驱动时抛
 * `CodePolicyNotAllowed`。
 */
import type { Env } from '../env';
import type { StoragePolicyRow } from '../db/types';
import { AppError, CodePolicyNotAllowed } from '../lib/errors';
import { PolicyType } from '../lib/boolset';
import { R2Driver } from './r2';
import { OneDriveDriver } from './onedrive';
import { S3CompatibleDriver } from './s3';
import type { StorageDriver } from './types';

/** 当前实现支持的策略类型。 */
export const SUPPORTED_POLICY_TYPES = [
  PolicyType.S3,
  PolicyType.Oss,
  PolicyType.Cos,
  PolicyType.Obs,
  PolicyType.Qiniu,
  PolicyType.Ks3,
  PolicyType.OneDrive,
] as const;

export function getStorageDriver(env: Env, policy: StoragePolicyRow): StorageDriver {
  switch (policy.type) {
    case PolicyType.S3:
      // 兼容内置 R2 策略：没填 AK/SK 就用 Worker 的 R2 绑定
      if (!policy.access_key && env.R2) return new R2Driver(env, policy);
      return new S3CompatibleDriver(policy);
    case PolicyType.Oss:
    case PolicyType.Cos:
    case PolicyType.Obs:
    case PolicyType.Qiniu:
    case PolicyType.Ks3:
      return new S3CompatibleDriver(policy);
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

/**
 * 可被创建/绑定/展示的策略类型 = 有驱动的 + 虚拟的 load_balance
 * （它没有驱动，但在策略解析层展开，见 storage/loadBalance.ts）。
 */
export function isSelectablePolicyType(type: string): boolean {
  return type === PolicyType.LoadBalance || isPolicyTypeSupported(type);
}

export * from './types';
export { R2Driver } from './r2';
export { OneDriveDriver } from './onedrive';
export { S3CompatibleDriver } from './s3';
