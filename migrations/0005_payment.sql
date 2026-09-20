-- 0005: 支付体系（边缘版自建 Pro 功能）
-- 对应前端增值服务：商店 / 订单 / 礼品卡 / 支付提供商（易支付协议）。
-- 上游闭源 Pro 的表结构不可得，这里按前端消费的形状自建：
--   orders     —— 支付订单（下单 → 支付回调 → 履行）
--   gift_codes —— 礼品卡（管理员批量生成，用户兑换，走同一履行逻辑）

CREATE TABLE IF NOT EXISTS orders (
    id                SERIAL PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,
    user_id           INTEGER     NOT NULL,
    order_no          TEXT        NOT NULL,
    product_type      TEXT        NOT NULL CHECK (product_type IN ('storage', 'group', 'credit')),
    -- 下单时的商品快照（商品随后可能被改/删，履行以快照为准）
    product_snapshot  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    amount            BIGINT      NOT NULL DEFAULT 0,  -- 单位：分
    status            TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'fulfilled', 'failed', 'canceled')),
    provider          TEXT        NOT NULL DEFAULT '',
    provider_trade_no TEXT,
    paid_at           TIMESTAMPTZ,
    fulfilled_at      TIMESTAMPTZ,
    error             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_no ON orders (order_no);
CREATE INDEX IF NOT EXISTS orders_user_id ON orders (user_id);

CREATE TABLE IF NOT EXISTS gift_codes (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    code            TEXT        NOT NULL,
    product_type    TEXT        NOT NULL CHECK (product_type IN ('storage', 'group', 'credit')),
    product_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
    batch           TEXT,
    used_by         INTEGER,
    used_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS gift_codes_code ON gift_codes (code);
CREATE INDEX IF NOT EXISTS gift_codes_batch ON gift_codes (batch);
