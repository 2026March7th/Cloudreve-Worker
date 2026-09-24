import { Checkbox, FormControl, ListItemText, MenuItem, Select } from "@mui/material";
import { useContext, useEffect, useState } from "react";
import { getStoragePolicyList } from "../../../../../api/api";
import { StoragePolicy } from "../../../../../api/dashboard";
import { useAppDispatch } from "../../../../../redux/hooks";
import { DenseFilledTextField } from "../../../../Common/StyledComponents";
import SettingForm from "../../../../Pages/Setting/SettingForm";
import { NoMarginHelperText } from "../../../Settings/Settings";
import { StoragePolicySettingContext } from "../StoragePolicySettingWrapper";

/**
 * 拉取可作为负载均衡 slave 的候选策略。
 * 排除负载均衡自身（不支持嵌套）与类型无驱动支持的策略
 * （响应里的 supported 字段由后端下发，false = 无驱动）。
 */
export const useSlaveCandidates = (): StoragePolicy[] => {
  const dispatch = useAppDispatch();
  const [candidates, setCandidates] = useState<StoragePolicy[]>([]);

  useEffect(() => {
    let cancelled = false;
    dispatch(
      getStoragePolicyList({
        page: 1,
        page_size: 100,
        order_by: "id",
        order_direction: "asc",
      }),
    )
      .then((res) => {
        if (cancelled) return;
        setCandidates(
          (res.policies ?? []).filter(
            (p) => p.type !== "load_balance" && p.supported !== false,
          ),
        );
      })
      .catch(() => {
        /* 列表拉取失败时保持空候选，用户可稍后重试 */
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  return candidates;
};

/** slave 策略多选框（创建向导与编辑页共用）。 */
export const SlavePolicySelect = ({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) => {
  const candidates = useSlaveCandidates();
  const nameOf = (id: number): string => candidates.find((p) => p.id === id)?.name ?? `#${id}`;

  return (
    <Select
      fullWidth
      multiple
      value={value.map(String)}
      onChange={(e) => {
        const raw = e.target.value as string[];
        onChange(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0));
      }}
      renderValue={(selected) =>
        (selected as string[]).length === 0
          ? "请选择参与负载均衡的存储策略"
          : (selected as string[]).map((v) => nameOf(Number(v))).join("、")
      }
    >
      {candidates.length === 0 && <MenuItem disabled>没有可用的存储策略</MenuItem>}
      {candidates.map((p) => (
        <MenuItem key={p.id} value={String(p.id)}>
          <Checkbox checked={value.indexOf(p.id) !== -1} />
          <ListItemText primary={p.name} secondary={p.type} />
        </MenuItem>
      ))}
    </Select>
  );
};

/** 编辑页「负载均衡」段：仅在策略 type 为 load_balance 时渲染。 */
const LoadBalanceSection = () => {
  const { values, setPolicy } = useContext(StoragePolicySettingContext);
  const slaves = values.settings?.slave_policy_ids ?? [];

  return (
    <>
      <SettingForm lgWidth={12}>
        <FormControl fullWidth>
          <DenseFilledTextField
            required
            value={values.name}
            onChange={(e) => setPolicy((p) => ({ ...p, name: e.target.value }))}
          />
          <NoMarginHelperText>策略名称</NoMarginHelperText>
        </FormControl>
      </SettingForm>
      <SettingForm title="参与负载均衡的存储策略" lgWidth={12}>
        <FormControl fullWidth>
          <SlavePolicySelect
            value={slaves}
            onChange={(ids) =>
              setPolicy((p) => ({
                ...p,
                settings: {
                  ...p.settings,
                  slave_policy_ids: ids.length > 0 ? ids : undefined,
                  load_balance_mode: p.settings?.load_balance_mode ?? "random",
                },
              }))
            }
          />
          <NoMarginHelperText>
            新上传的文件将按下方算法分配到这些存储策略；已有文件不受影响，仍从原策略下载。
          </NoMarginHelperText>
        </FormControl>
      </SettingForm>
      <SettingForm title="分配算法" lgWidth={12}>
        <FormControl fullWidth>
          <Select
            value={values.settings?.load_balance_mode ?? "random"}
            onChange={(e) =>
              setPolicy((p) => ({
                ...p,
                settings: { ...p.settings, load_balance_mode: e.target.value as "random" | "round_robin" },
              }))
            }
          >
            <MenuItem value="random">随机分配（每次上传随机挑选）</MenuItem>
            <MenuItem value="round_robin">轮询分配（按顺序轮流）</MenuItem>
          </Select>
          <NoMarginHelperText>分配只在新增文件时生效，下载始终走文件实际所在的存储策略。</NoMarginHelperText>
        </FormControl>
      </SettingForm>
    </>
  );
};

export default LoadBalanceSection;
