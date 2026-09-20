// [edge patch] 组绑定存储策略多选版（edge 自建 Pro 功能）。
// 原版单选（value: number），这里改为 multiple Select（value: number[]），
// 与后端 group_storage_policies 多对多契约对齐；样式与原版保持一致。
import { Box, FormControl, SelectChangeEvent, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getStoragePolicyList } from "../../../../api/api";
import { StoragePolicy } from "../../../../api/dashboard";
import { useAppDispatch } from "../../../../redux/hooks";
import FacebookCircularProgress from "../../../Common/CircularProgress";
import { DenseSelect, SquareChip } from "../../../Common/StyledComponents";
import { SquareMenuItem } from "../../../FileManager/ContextMenu/ContextMenu";
export interface PolicySelectionInputProps {
  value: number[];
  onChange: (value: number[]) => void;
}

const PolicySelectionInput = ({ value, onChange }: PolicySelectionInputProps) => {
  const { t } = useTranslation("dashboard");
  const dispatch = useAppDispatch();
  const [policies, setPolicies] = useState<StoragePolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [policyMap, setPolicyMap] = useState<Record<number, StoragePolicy>>({});

  const handleChange = (event: SelectChangeEvent<unknown>) => {
    const {
      target: { value },
    } = event;
    // MUI multiple Select 的 value 是数组（元素可能为字符串）
    onChange((Array.isArray(value) ? value : [value]).map((v) => Number(v)));
  };

  useEffect(() => {
    setLoading(true);
    dispatch(getStoragePolicyList({ page: 1, page_size: 1000, order_by: "id", order_direction: "asc" }))
      .then((res) => {
        setPolicies(res.policies);
        setPolicyMap(
          res.policies.reduce(
            (acc, policy) => {
              acc[policy.id] = policy;
              return acc;
            },
            {} as Record<number, StoragePolicy>,
          ),
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <FormControl fullWidth>
      <DenseSelect
        multiple
        value={value}
        required
        onChange={handleChange}
        sx={{
          minHeight: 39,
        }}
        disabled={loading}
        renderValue={(selected) => {
          const ids = (Array.isArray(selected) ? selected : [selected]).map((v) => Number(v));
          if (loading) return <FacebookCircularProgress size={20} sx={{ mt: "1px" }} />;
          if (ids.length === 0) return <Box />;
          return (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
              {ids.map((id) => (
                <SquareChip size="small" key={id} label={policyMap[id]?.name ?? id} />
              ))}
            </Box>
          );
        }}
        MenuProps={{
          PaperProps: { sx: { maxWidth: 230 } },
          MenuListProps: {
            sx: {
              "& .MuiMenuItem-root": {
                whiteSpace: "normal",
              },
            },
          },
        }}
      >
        {policies.length > 0 &&
          policies.map((policy) => (
            <SquareMenuItem key={policy.id} value={policy.id}>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <Typography variant={"body2"} fontWeight={600}>
                  {policy.name}
                </Typography>
                <Typography variant={"caption"} color={"textSecondary"}>
                  {t(`policy.${policy.type}`)}
                </Typography>
              </Box>
            </SquareMenuItem>
          ))}
      </DenseSelect>
    </FormControl>
  );
};

export default PolicySelectionInput;
