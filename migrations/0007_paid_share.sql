-- ---------------------------------------------------------------------------
-- 付费分享（edge 自建 Pro 功能）
--   shares.score            INT  分享价格（积分），0 表示免费分享
--   share_purchases         购买记录（谁为哪个分享付了多少），(share_id,user_id) 唯一
-- ---------------------------------------------------------------------------

ALTER TABLE shares ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS share_purchases (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    share_id    INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    amount      INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT share_purchases_unique UNIQUE (share_id, user_id)
);

CREATE INDEX IF NOT EXISTS share_purchases_share ON share_purchases (share_id);
CREATE INDEX IF NOT EXISTS share_purchases_user ON share_purchases (user_id);
