import { Box, Checkbox, FormControl, ListItemText, MenuItem, Select, Typography } from "@mui/material";
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

/**
 * 子策略权重编辑（对齐官方 Pro 权重语义：权重越大被选概率越高，0 不参与）。
 * 只显示当前已选中的 slave；未设置权重的按 1 处理。
 */
export const SlaveWeightInputs = ({
  ids,
  weights,
  onChange,
}: {
  ids: number[];
  weights: Record<string, number> | undefined;
  onChange: (weights: Record<string, number>) => void;
}) => {
  const candidates = useSlaveCandidates();
  const nameOf = (id: number): string => candidates.find((p) => p.id === id)?.name ?? `#${id}`;
  if (ids.length === 0) return null;

  return (
    <>
      {ids.map((id) => (
        <Box key={id} sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <DenseFilledTextField
            type="number"
            value={weights?.[String(id)] ?? 1}
            onChange={(e) => {
              const v = e.target.value === "" ? "" : Number(e.target.value);
              const next = { ...(weights ?? {}) };
              if (v === "" || !Number.isFinite(v)) delete next[String(id)];
              else next[String(id)] = v;
              onChange(next);
            }}
            inputProps={{ min: 0, max: 10000, step: 1 }}
            sx={{ width: 110 }}
          />
          <Typography variant="body2">
            {nameOf(id)} 的权重（0 = 不参与选路，默认 1）
          </Typography>
        </Box>
      ))}
    </>
  );
};

/** 编辑页「负载均衡」段：仅在策略 type 为 load_balance 时渲染。 */
const LoadBalanceSection = () => {
  const { values, setPolicy } = useContext(StoragePolicySettingContext);
  const slaves = values.settings?.slave_policy_ids ?? [];
  const weights = values.settings?.slave_policy_weights;

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
                  slave_policy_weights: ids.length > 0 ? p.settings?.slave_policy_weights : undefined,
                  load_balance_mode: p.settings?.load_balance_mode ?? "random",
                },
              }))
            }
          />
          <NoMarginHelperText>
            新上传的文件将按权重与算法分配到这些存储策略；已有文件不受影响，仍从原策略下载。
          </NoMarginHelperText>
        </FormControl>
      </SettingForm>
      {slaves.length > 0 && (
        <SettingForm title="子策略权重" lgWidth={12}>
          <SlaveWeightInputs
            ids={slaves}
            weights={weights}
            onChange={(w) =>
              setPolicy((p) => ({
                ...p,
                settings: { ...p.settings, slave_policy_weights: w },
              }))
            }
          />
          <NoMarginHelperText>
            权重越大，新文件被分配到该策略的概率越高；权重为 0 的策略不参与分配（对齐官方负载均衡语义）。
          </NoMarginHelperText>
        </SettingForm>
      )}
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
            <MenuItem value="random">按权重随机分配</MenuItem>
            <MenuItem value="round_robin">轮询分配（按顺序轮流）</MenuItem>
          </Select>
          <NoMarginHelperText>分配只在新增文件时生效，下载始终走文件实际所在的存储策略。</NoMarginHelperText>
        </FormControl>
      </SettingForm>
    </>
  );
};

export default LoadBalanceSection;
