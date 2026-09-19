import { Grid2, Typography } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import ProDialog from "../../Admin/Common/ProDialog";

// 边缘版没有 Pro 许可，所有 Pro 标记与「升级 Pro」弹窗统一隐藏，避免误导用户。
export const ProChip = (_props: Record<string, unknown>): null => null;

export interface SettingFormProps {
  title?: React.ReactNode;
  children: React.ReactNode;
  lgWidth?: number;
  secondary?: React.ReactNode;
  spacing?: number;
  anchorId?: string;
  noContainer?: boolean;
  pro?: boolean;
}

const SettingForm = ({
  title,
  children,
  lgWidth = 8,
  secondary,
  spacing,
  noContainer,
  anchorId,
  pro,
}: SettingFormProps) => {
  const [proOpen, setProOpen] = useState(false);
  useEffect(() => {
    if (anchorId && window.location.hash === `#${anchorId}`) {
      const anchor = document.getElementById(`anchor-${anchorId}`);
      if (anchor) {
        anchor.scrollIntoView({ behavior: "smooth" });
        // clear hash, not query
        window.history.replaceState({}, "", window.location.pathname + window.location.search);
      }
    }
  }, [anchorId]);

  const handleProClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (pro) {
        e.stopPropagation();
        setProOpen(true);
      }
    },
    [pro],
  );

  const inner = (
    <>
      <Grid2
        sx={{
          boxShadow: anchorId && window.location.hash === `#${anchorId}` ? "0 0 0 3px rgb(255 193 7 / 53%)" : "none",
        }}
        size={{
          md: lgWidth,
          xs: 12,
        }}
      >
        {title && (
          <Typography
            fontWeight={600}
            sx={{ mb: 0.5, display: "flex", alignItems: "center" }}
            variant={"body2"}
            id={anchorId ? `anchor-${anchorId}` : undefined}
          >
            {title}
            {pro && <ProChip label="Pro" color="primary" size="small" />}
          </Typography>
        )}
        <div onClick={handleProClick}>{children}</div>
      </Grid2>
      {secondary && secondary}
      {pro && <ProDialog open={proOpen} onClose={() => setProOpen(false)} />}
    </>
  );
  if (noContainer) {
    return inner;
  }
  return (
    <Grid2 container spacing={spacing ?? 0}>
      {inner}
    </Grid2>
  );
};

export default SettingForm;
