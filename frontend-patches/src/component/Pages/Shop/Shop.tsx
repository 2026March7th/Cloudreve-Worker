/**
 * 商店页（edge 自建 Pro 功能，官方开源前端无此页面）。
 *
 * 路由 /shop，侧边栏在 shop_nav_enabled 打开时显示入口。
 * 数据来自 GET /api/v4/payment/shop；下单走易支付跳转支付，
 * 支付完成后回跳本页并按订单号轮询状态。
 */
import { LoadingButton } from "@mui/lab";
import {
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useSnackbar } from "notistack";
import { SecondaryButton, DenseFilledTextField } from "../../Common/StyledComponents.tsx";
import PageContainer from "../PageContainer.tsx";
import PageHeader from "../PageHeader.tsx";

// ---------------------------------------------------------------------------
// 类型与工具
// ---------------------------------------------------------------------------

interface ShopProvider {
  id: string;
  name: string;
  type: string;
  channel: string;
}
interface StorageProduct {
  id: string;
  name: string;
  price: number;
  size: number;
  duration: number;
}
interface GroupProduct {
  id: string;
  name: string;
  price: number;
  group_id: number;
  group_name?: string;
  duration: number;
}
interface CreditProduct {
  id: string;
  name: string;
  price: number;
  credit: number;
}
interface ShopInfo {
  providers: ShopProvider[];
  storage_products: StorageProduct[];
  group_products: GroupProduct[];
  credit_products: CreditProduct[];
  currency: { code: string; symbol: string; unit: number };
  credit_enabled: boolean;
  credit: number;
}
interface OrderInfo {
  id: number;
  order_no: string;
  product_type: string;
  product_name: string;
  amount: number;
  status: string;
  created_at: string;
}

const GB = 1024 * 1024 * 1024;

const fmtBytes = (n: number) => {
  if (!n) return "0";
  if (n >= GB) return Number((n / GB).toFixed(1)) + " GB";
  if (n >= 1024 * 1024) return Number((n / 1024 / 1024).toFixed(1)) + " MB";
  return n + " B";
};

const fmtDuration = (d: number) => (d > 0 ? d + " 天" : "永久");

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const session = JSON.parse(localStorage.getItem("cloudreve_session") || "{}");
  const first = Object.values(session?.sessions ?? {})[0] as
    | { token?: { access_token?: string } }
    | undefined;
  const token = first?.token?.access_token ?? "";
  const res = await fetch("/api/v4" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: "Bearer " + token,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (json.code !== undefined && json.code !== 0) throw new Error(json.msg || "request failed");
  return json.data as T;
}

const statusChip = (s: string) => {
  const map: Record<string, { label: string; color: "success" | "warning" | "default" | "error" }> = {
    fulfilled: { label: "已完成", color: "success" },
    paid: { label: "已支付", color: "warning" },
    pending: { label: "待支付", color: "warning" },
    failed: { label: "失败", color: "error" },
    canceled: { label: "已取消", color: "default" },
  };
  const cfg = map[s] ?? { label: s, color: "default" as const };
  return <Chip size="small" color={cfg.color} label={cfg.label} />;
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

const Shop = () => {
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [orders, setOrders] = useState<OrderInfo[]>([]);
  const [trackingOrder, setTrackingOrder] = useState<OrderInfo | null>(null);

  const symbol = shop?.currency.symbol ?? "¥";
  const priceLabel = (fen: number) => symbol + (fen / 100).toFixed(2);

  const loadShop = useCallback(() => {
    api<ShopInfo>("GET", "/payment/shop")
      .then((res) => setShop(res))
      .catch((e) => enqueueSnackbar(String((e as Error).message ?? e), { variant: "error" }))
      .finally(() => setLoading(false));
  }, [enqueueSnackbar]);

  const loadOrders = useCallback(() => {
    api<{ orders: OrderInfo[] }>("GET", "/payment/order?page=1&page_size=20")
      .then((res) => setOrders(res.orders ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadShop();
    loadOrders();
    // 支付回跳带 order_no：进入订单追踪，支付网关异步通知可能有几秒延迟，轮询几次
    const orderNo = searchParams.get("order_no");
    if (orderNo) {
      setTab(1);
      let tries = 0;
      const poll = () => {
        api<OrderInfo>("GET", "/payment/order/" + encodeURIComponent(orderNo))
          .then((res) => {
            setTrackingOrder(res);
            if (res.status === "pending" && tries < 10) {
              tries += 1;
              window.setTimeout(poll, 3000);
            }
          })
          .catch(() => undefined);
      };
      poll();
    }
  }, [loadShop, loadOrders, searchParams]);

  const buy = async (productType: string, productId: string) => {
    const providers = shop?.providers ?? [];
    if (!providers.length) {
      enqueueSnackbar("站点尚未配置可用的支付方式", { variant: "warning" });
      return;
    }
    setBuying(productType + ":" + productId);
    try {
      const res = await api<{ order_no: string; pay_url: string }>("POST", "/payment/order", {
        product_type: productType,
        product_id: productId,
        provider_id: providers[0].id,
      });
      window.location.href = res.pay_url;
    } catch (e) {
      enqueueSnackbar(String((e as Error).message ?? e), { variant: "error" });
      setBuying(null);
    }
  };

  const redeem = async () => {
    if (!redeemCode.trim()) return;
    setRedeeming(true);
    try {
      const res = await api<{ product_type: string; name: string }>("POST", "/payment/redeem", {
        code: redeemCode.trim(),
      });
      enqueueSnackbar("兑换成功：" + (res.name ?? res.product_type), { variant: "success" });
      setRedeemCode("");
      loadShop();
    } catch (e) {
      enqueueSnackbar(String((e as Error).message ?? e), { variant: "error" });
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <PageContainer>
      <Container maxWidth="lg">
        <PageHeader title={"商店"} />
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="商品" />
          <Tab label="我的订单" />
          <Tab label="兑换礼品卡" />
        </Tabs>

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {tab === 0 && (
              <Stack spacing={4}>
                {shop?.providers.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    站点管理员尚未启用支付提供商，暂无法购买。
                  </Typography>
                )}
                {!!shop?.storage_products.length && (
                  <Box>
                    <Typography variant="subtitle1" sx={{ mb: 1 }}>
                      容量包
                    </Typography>
                    <ProductCardRow>
                      {shop.storage_products.map((p) => (
                        <Card key={p.id} sx={{ width: 220 }}>
                          <CardContent>
                            <Typography variant="subtitle2">{p.name}</Typography>
                            <Typography variant="h6" color="primary">
                              {priceLabel(Math.round(p.price * 100))}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {fmtBytes(p.size)} · {fmtDuration(p.duration)}
                            </Typography>
                          </CardContent>
                          <CardActions>
                            <LoadingButton
                              size="small"
                              variant="contained"
                              loading={buying === "storage:" + p.id}
                              onClick={() => buy("storage", p.id)}
                            >
                              购买
                            </LoadingButton>
                          </CardActions>
                        </Card>
                      ))}
                    </ProductCardRow>
                  </Box>
                )}
                {!!shop?.group_products.length && (
                  <Box>
                    <Typography variant="subtitle1" sx={{ mb: 1 }}>
                      用户组
                    </Typography>
                    <ProductCardRow>
                      {shop.group_products.map((p) => (
                        <Card key={p.id} sx={{ width: 220 }}>
                          <CardContent>
                            <Typography variant="subtitle2">{p.name}</Typography>
                            <Typography variant="h6" color="primary">
                              {priceLabel(Math.round(p.price * 100))}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {p.group_name || "用户组 " + p.group_id} · {fmtDuration(p.duration)}
                            </Typography>
                          </CardContent>
                          <CardActions>
                            <LoadingButton
                              size="small"
                              variant="contained"
                              loading={buying === "group:" + p.id}
                              onClick={() => buy("group", p.id)}
                            >
                              购买
                            </LoadingButton>
                          </CardActions>
                        </Card>
                      ))}
                    </ProductCardRow>
                  </Box>
                )}
                {shop?.credit_enabled && !!shop.credit_products.length && (
                  <Box>
                    <Typography variant="subtitle1" sx={{ mb: 1 }}>
                      积分（当前余额：{shop.credit}）
                    </Typography>
                    <ProductCardRow>
                      {shop.credit_products.map((p) => (
                        <Card key={p.id} sx={{ width: 220 }}>
                          <CardContent>
                            <Typography variant="subtitle2">{p.name}</Typography>
                            <Typography variant="h6" color="primary">
                              {priceLabel(Math.round(p.price * 100))}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {p.credit} 积分
                            </Typography>
                          </CardContent>
                          <CardActions>
                            <LoadingButton
                              size="small"
                              variant="contained"
                              loading={buying === "credit:" + p.id}
                              onClick={() => buy("credit", p.id)}
                            >
                              购买
                            </LoadingButton>
                          </CardActions>
                        </Card>
                      ))}
                    </ProductCardRow>
                  </Box>
                )}
              </Stack>
            )}

            {tab === 1 && (
              <Stack spacing={2}>
                {trackingOrder && (
                  <Card>
                    <CardContent>
                      <Typography variant="subtitle2">支付回跳订单：{trackingOrder.order_no}</Typography>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
                        {statusChip(trackingOrder.status)}
                        <Typography variant="body2">
                          {trackingOrder.product_name} · {priceLabel(trackingOrder.amount)}
                        </Typography>
                      </Stack>
                      {trackingOrder.status === "pending" && (
                        <Typography variant="caption" color="text.secondary">
                          等待支付结果确认中……如长时间未更新请稍后刷新。
                        </Typography>
                      )}
                    </CardContent>
                  </Card>
                )}
                {orders.length === 0 && !trackingOrder ? (
                  <Typography variant="body2" color="text.secondary">
                    暂无订单
                  </Typography>
                ) : (
                  orders.map((o) => (
                    <Box key={o.id}>
                      <Stack direction="row" spacing={2} alignItems="center">
                        {statusChip(o.status)}
                        <Typography variant="body2" sx={{ minWidth: 90 }}>
                          {o.product_name}
                        </Typography>
                        <Typography variant="body2" color="primary">
                          {priceLabel(o.amount)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {new Date(o.created_at).toLocaleString()} · {o.order_no}
                        </Typography>
                        <Box sx={{ flexGrow: 1 }} />
                        {o.status === "pending" && (
                          <SecondaryButton
                            size="small"
                            onClick={() => {
                              setTrackingOrder(o);
                              setTab(1);
                            }}
                          >
                            查询状态
                          </SecondaryButton>
                        )}
                      </Stack>
                      <Divider sx={{ mt: 1 }} />
                    </Box>
                  ))
                )}
              </Stack>
            )}

            {tab === 2 && (
              <Stack spacing={2} sx={{ maxWidth: 480 }}>
                <DenseFilledTextField
                  fullWidth
                  label="礼品卡卡密"
                  value={redeemCode}
                  onChange={(e) => setRedeemCode(e.target.value)}
                />
                <Button variant="contained" loading={redeeming} onClick={redeem}>
                  兑换
                </Button>
                <Typography variant="caption" color="text.secondary">
                  兑换后立即生效：容量叠加到组上限之上、用户组立即切换（到期自动回退）、积分即时到账。
                </Typography>
              </Stack>
            )}
          </>
        )}
      </Container>
    </PageContainer>
  );
};

/** 横向卡片行。 */
function ProductCardRow(props: { children: ReactNode }) {
  return <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>{props.children}</Stack>;
}

export default Shop;
