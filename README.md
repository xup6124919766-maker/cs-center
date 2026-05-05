# 客服中心

LINE + FB Messenger 統一客服收件匣 + AI 草擬協作平台（multi-tenant SaaS）。支援雙重驗證、CSAT、知識庫自學、遊戲抽獎、旅程自動化、廣播排程、電商整合等功能。

## 本機啟動

```bash
npm install
cp .env.example .env        # 填入 ENCRYPTION_KEY / SESSION_SECRET
npm start
# http://localhost:8080  預設帳號：admin / changeme123
```

## Railway 部署

在 Railway 設定以下環境變數（必填）：

| 變數 | 說明 |
|------|------|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | 隨機 hex，`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ENCRYPTION_KEY` | 64 字元 hex（32 bytes），同上指令 |
| `ADMIN_PASS_HASH` | bcrypt hash，用 `node -e "const b=require('bcryptjs');console.log(b.hashSync('你的密碼',10))"` |
| `ANTHROPIC_API_KEY` | 或填 `GEMINI_API_KEY`，至少一個 |
| `TRUST_PROXY` | `1`（Railway 走 reverse proxy） |

可選變數：`GEMINI_API_KEY`、`AI_MODEL`、`DB_PATH`、`GIT_SHA`。
