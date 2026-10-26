/**
 * IM 表的建表 SQL。
 *
 * 为什么单独一个文件：store.ts 已逼近 400 行上限（AGENTS.md §硬规则），而 IM 表会随 P2 继续长
 * （会话游标、发货记录）；把 DDL 与 IM 的读写口（im-messages.ts）配套放，迁移列表只引用常量。
 * 这里只放 SQL 文本，不 import 任何模块，避免与 store.ts 形成环。
 * @module @bigfish/core/im-schema
 */

/**
 * v6：IM 聊天消息。唯一键 (account_id, message_id) 是去重的唯一依据——
 * 重连后平台补推历史、daemon 重启重放都靠它把重复消息挡在库外。
 * raw 存原始推送对象，只为排障（卡片/交易状态解析不出来时回放），写日志前必须脱敏。
 */
export const IM_MESSAGES_V6_SQL = `
CREATE TABLE IF NOT EXISTS im_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  cid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  chat_time_ms INTEGER NOT NULL,
  trade_status TEXT,
  raw TEXT,
  received_at INTEGER NOT NULL,
  UNIQUE(account_id, message_id),
  CHECK (kind IN ('text', 'card'))
);
CREATE INDEX IF NOT EXISTS idx_im_messages_cid ON im_messages(account_id, cid, chat_time_ms);
`
