import { Button, FormControl, MenuItem, Select, Stack } from "@mui/material";
import { useState } from "react";
import { StoragePolicy } from "../../../../../api/dashboard";
import { PolicyType } from "../../../../../api/explorer";
import { DenseFilledTextField } from "../../../../Common/StyledComponents";
import SettingForm from "../../../../Pages/Setting/SettingForm";
import { NoMarginHelperText } from "../../../Settings/Settings";
import { AddWizardProps } from "../../AddWizardDialog";
import { SlavePolicySelect, SlaveWeightInputs } from "../../EditStoragePolicy/FormSections/LoadBalanceSection";

/**
 * 负载均衡创建向导。边缘版将 load_balance 实现为虚拟策略：
 * 本向导只收集名称、参与负载均衡的存储策略与选路算法，
 * 上传时由服务端展开成实际 slave 策略落盘，下载/直链/缩略图
 * 全部走 slave 的真实驱动。
 */
const LoadBalanceWizard = ({ onSubmit }: AddWizardProps) => {
  const [policy, setPolicy] = useState<StoragePolicy>({
    id: 0,
    name: "",
    type: PolicyType.load_balance,
    edges: {},
    settings: {
      slave_policy_ids: [],
      load_balance_mode: "random",
    },
  });
  const [submitting, setSubmitting] = useState(false);
  const slaves = policy.settings?.slave_policy_ids ?? [];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting || slaves.length === 0) return;
        setSubmitting(true);
        onSubmit(policy);
      }}
    >
      <Stack spacing={1}>
        <SettingForm lgWidth={12}>
          <FormControl fullWidth>
            <DenseFilledTextField
              required
              value={policy.name}
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
                  settings: { ...p.settings, slave_policy_ids: ids },
                }))
              }
            />
            <NoMarginHelperText>
              新上传的文件将按下方算法分配到这些存储策略；至少选择一个。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>
        <SettingForm title="子策略权重" lgWidth={12}>
          <SlaveWeightInputs
            ids={slaves}
            weights={policy.settings?.slave_policy_weights}
            onChange={(w) =>
              setPolicy((p) => ({
                ...p,
                settings: { ...p.settings, slave_policy_weights: w },
              }))
            }
          />
          <NoMarginHelperText>
            权重越大，新文件被分配到该策略的概率越高；权重为 0 的策略不参与分配。
          </NoMarginHelperText>
        </SettingForm>
        <SettingForm title="分配算法" lgWidth={12}>
          <FormControl fullWidth>
            <Select
              value={policy.settings?.load_balance_mode ?? "random"}
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
            <NoMarginHelperText>
              分配只在新增文件时生效；下载、直链、缩略图始终走文件实际所在的存储策略。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>
      </Stack>
      <Button
        disabled={submitting || slaves.length === 0 || !policy.name}
        variant="contained"
        color="primary"
        sx={{ mt: 2 }}
        type="submit"
      >
        创建
      </Button>
    </form>
  );
};

export default LoadBalanceWizard;
