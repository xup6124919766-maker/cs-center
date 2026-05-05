# 競品深度調查報告：Omnichat vs 漸強實驗室

> 報告日期：2026-04-30
> 撰寫人：咕嚕（聖研 AI 辦公室情報研究員）
> 目的：協助老闆定義客服中心 SaaS 的功能路線圖，找出差距、機會與優先序

---

## Block 1：Omnichat 全功能盤點

**平台定性**：亞洲唯一同時獲得 Meta 官方 + LINE 官方雙認證的全通路 AI 對話商務平台。2025 年策略主軸：「Agentic AI + 全球擴張」，推出 Omni AI Agent Studio，全面往 AI Agent 服務模式轉型。全球超過 5,000 家企業客戶，主市場：台灣、香港、馬來西亞、新加坡。

---

### 📥 通道與整合

1. **LINE Official Account 整合**：支援 LINE Messaging API，包含一般訊息、貼圖、圖片、檔案收發，以及通知型訊息（PN，可對非好友發送）。
2. **Facebook Messenger 整合**：收發私訊、關鍵字自動觸發、按讚/留言轉私訊自動化。
3. **Instagram Direct 整合**：IG 私訊統一管理，支援 IG 限時動態提及自動回覆。
4. **WhatsApp Business Platform（API）**：Meta 官方 BSP 合作夥伴，支援高流量 API 發送、模板訊息（Template Message）、Catalog 商品目錄。
5. **WeChat 整合**：中國市場用，官方帳號訊息接入收件匣。
6. **網站 Live Chat 插件（Web Chat Widget）**：在品牌官網嵌入即時對話框，將訪客轉化為 LINE/WhatsApp 社群聯絡人（企業方案可自訂品牌外觀）。
7. **TikTok 整合**：TikTok 訊息接入（需確認：文件有提及但功能細節待驗證）。
8. **LINE LIFF 整合**：透過 LIFF App 實現社群身份綁定、手機號碼驗證、互動遊戲、會員卡開啟。
9. **IG/FB 貼文留言自動轉私訊**：偵測貼文關鍵字留言，系統自動發送私訊，引導轉化到一對一對話。
10. **行動 App（客服端）**：需確認是否有獨立的手機 App（漸強有，Omnichat 未見明確說明）。

### 💬 對話管理

11. **統一收件匣（Shared Inbox）**：LINE、FB Messenger、IG、WhatsApp、WeChat、Web Chat 全部進入同一後台介面處理。
12. **自動分流指派（Auto-Assignment）**：根據客服負載、來源通道、顧客標籤、時間排程，自動分配對話給適當專員或團隊。
13. **多人協作對話（2025 新功能）**：支援多位客服專員同時進入同一對話視窗協同處理複雜案件。
14. **預存回覆 / 快捷模板（Canned Replies）**：跨平台共用快速回覆語句庫，維持回覆品質。
15. **對話記錄 AI 自動摘要**：AI 自動濃縮長篇對話，讓接手專員秒懂案件背景。
16. **對話標籤 / 分類管理**：可對對話加標籤（如：退貨、VIP、急單），方便篩選與報表統計。
17. **黑名單 / 對話封鎖**：提供封鎖、刪除、設為未讀等精細化管控功能。
18. **轉接（Reassign）**：一鍵將對話移交給其他客服或部門，並保留完整歷史紀錄。
19. **內部備忘（Internal Note）**：在對話中加入只有內部人員可見的備註，不會傳送給顧客。
20. **CSAT 滿意度評分**：對話結束後自動發送評分邀請，追蹤顧客滿意度。

### 🤖 AI 與自動化

21. **Omni AI Agent Studio（2025 旗艦功能）**：企業可自行訓練品牌專屬 AI 代理人，涵蓋「客服 Agent（自動解答 FAQ）」「購物 Agent（商品推薦）」「行銷 Agent（文案生成）」三大模組，24/7 無人值守自主回覆。
22. **AI Copilot（真人客服輔助）**：為線上客服實時提供回覆建議、文案修飾與相關知識庫搜尋，提升回覆效率。
23. **AI 行銷活動產生器**：輸入活動目標，AI 自動生成對話腳本、推播文案、視覺素材建議。
24. **關鍵字自動回覆（Keyword Auto-Reply）**：設定關鍵字觸發條件，自動發送預設回覆，支援多條件組合。
25. **視覺化聊天機器人流程編輯器（Chatbot Flow Builder）**：拖拉式介面設計多步驟自動回覆流程，處理 FAQ、表單填寫、活動報名等。
26. **顧客旅程自動化（Customer Journey）**：依排程或行為觸發系列訊息（新客歡迎序列、生日禮、沉默喚醒）；屬於加購模組，需企業以上方案。
27. **AI 購物助理（AI Shopping Assistant）**：在對話中偵測顧客意圖，主動推薦商品並引導下單。

### 👥 客戶資料 / CRM

28. **Social CDP / Social CRM（顧客社群數據平台）**：整合跨渠道對話、標籤、購買記錄，建立 360 度顧客視圖；屬於 Customisation 方案加購功能。
29. **自動標籤系統（Auto-Tagging）**：根據顧客行為（如：點擊連結、輸入關鍵字、購買品項）自動貼標，實現精準分眾。
30. **數位會員卡（Social Loyalty）**：在 LINE / WhatsApp 建立品牌會員卡，顯示等級、點數、優惠券、條碼核銷，透過 LIFF 整合電商平台會員資料。
31. **跨平台身份識別（Identity Resolution）**：透過手機號碼或 Email 綁定，將不同平台的同一使用者合併為單一顧客檔案。
32. **自訂會員屬性（Custom Attributes）**：在顧客資料卡中自訂欄位，儲存品牌特有的客戶資訊（等級、生日、負責業務等）。
33. **OMO 業績追蹤（Online-Merge-Offline）**：門市人員掃碼綁定顧客 LINE，追蹤實體引導線上購物的業績貢獻；屬於 Customisation 方案。

### 📢 行銷 / 群發

34. **分眾推播廣播（Broadcast / Segmented Push）**：針對特定標籤受眾發送 LINE 或 WhatsApp 群發訊息，基礎方案即可用。
35. **購物車再行銷（Abandoned Cart Remarketing）**：自動偵測官網遺棄購物車，透過 LINE/WhatsApp 傳送提醒，Pro 方案以上才有，轉換率官方宣稱接近 30%，ROAS 可達 500。
36. **互動遊戲模組（Game Modules）**：內建抽獎輪盤、刮刮樂、問答等互動遊戲，需透過 LIFF，屬加購模組。
37. **優惠券管理中心（Coupon Management）**：在對話中發送、領取、核銷優惠券，並追蹤核銷成效；屬加購模組。
38. **Meta 廣告 CAPI 整合（Conversion API）**：將社群對話互動數據回傳 Meta 廣告系統，優化廣告精準度與降低 CPM。
39. **WhatsApp Catalog 商品目錄**：在 WhatsApp 中展示商品清單，讓顧客直接瀏覽下單，無需跳轉官網。

### 📊 分析 / 報表

40. **推播成效報告**：統計廣播訊息的開啟率、點擊率、引發訂單數與業績金額。
41. **轉換追蹤 / ROI 歸因（Conversion Tracking）**：追蹤從對話到成交的完整路徑，計算每個客服互動 / 行銷活動的業績 ROI；Pro 方案以上。
42. **客服績效分析（Agent Performance）**：統計各客服專員的平均首次回覆時間（FRT）、解決率、對話數、CSAT 分數。
43. **OMO 業績歸因報表**：追蹤門市業務透過社群引導線上成交的業績，支援業績分潤計算。

### 🔌 串接生態

44. **電商平台深度整合**：支援 Shopify、SHOPLINE、91APP、Cyberbiz、Adobe Commerce（Magento）深度串接，含購物車、訂單、會員資料同步。
45. **CRM/CDP 串接**：支援 Salesforce、HubSpot、Microsoft Dynamics 365 雙向同步聯絡人資料（Mar 2025 新功能）。
46. **Open API**：提供 REST API 供企業自行串接 ERP 或內部系統；Customisation 方案才開放。
47. **AWS Marketplace 上架**：可透過 AWS Marketplace 購買訂閱，適合企業統一採購管理。

### 🔐 帳號 / 權限 / 合規

48. **多層級權限管理**：可設定管理者、分店店長、一般客服等不同角色，控制功能存取與資料查看範圍。
49. **方案分級（Basic/Pro/Enterprise/Customisation）**：四層方案，Basic 最多 3 人、10,000 筆聯絡人；Enterprise 最多 10 人、100,000 筆；Customisation 無限制。
50. **14 天免費試用**：所有方案均提供 14 天試用，並附免費 Onboarding 支援（含 WhatsApp API 申請輔導）。

---

## Block 2：漸強實驗室 Crescendo Lab 全功能盤點

**平台定性**：2017 年成立，2022-2025 年連續 4 年 LINE 金級技術夥伴（亞洲唯一）。2025 年戰略：「AI-First Communication Cloud」，三大平台 MAAC（行銷）+ CAAC（客服）+ DAAC（數據）形成完整生態系。年發送訊息量 70 億則，800+ 企業客戶（以台灣、日本、泰國為主）。

---

### LINE 深度整合與行銷自動化（MAAC 核心）

1. **AI 智慧發送（AI Smart Sending）**：機器學習分析每位好友最常點擊 LINE 的時間段，在最佳時機精準推播，提高開封率。其他平台沒有的差異化功能。
2. **AI 智慧分眾（AI Segment / AImon）**：根據對話、行為、歷史購買數據，機器學習預測高購買潛力或高流失風險受眾，自動推薦最適合的受眾包。
3. **4D 標籤 AImon（自動貼標）**：AI 根據顧客點擊的 Rich Menu 按鈕、廣播連結、官網瀏覽行為自動貼標，省去人工設定數百個標籤的時間。
4. **全通路自動旅程（Omni Journey）**：串聯 LINE、Email、SMS，若顧客在 LINE 沒讀取，系統自動補發 SMS 確保觸達；觸發條件包含標籤、開封、購物車、購買商品等多元維度。
5. **AI 內容生成（AI Content Gen）**：整合 ChatGPT，根據品牌語調一鍵生成 LINE 推播文案，並可分析推播成效自動優化下一次文案。
6. **購物車再行銷（Cart Abandonment）**：串接電商官網，偵測未結帳商品並在指定時間自動發送 LINE 提醒，支援商品目錄同步，資料延遲縮短至 1 小時內（2024 Q4 Beta）。
7. **個人化 Rich Menu 圖文選單**：可依顧客標籤顯示不同圖文選單（已綁定會員 vs 訪客），按鈕點擊可自動貼標、觸發 Auto Reply、開啟官網、切換換頁選單；每個按鈕可追蹤點擊數、訂單數、營收。
8. **LINE 互動遊戲模組（Feversocial 合作）**：大轉盤、刮刮樂、扭蛋、抽籤等 20+ 款互動遊戲，透過 LIFF URL 放入 Rich Menu 或廣播，遊戲結束自動貼標。
9. **發票模組（OMO 線下數據整合）**：顧客在實體消費後，上傳發票至 LINE 參加活動，品牌藉此收集線下購買數據並觸發旅程。
10. **問卷調查系統（LIFF 問卷）**：在 LINE 內嵌入視覺化問卷，回答後自動標記顧客偏好，可觸發後續自動旅程。
11. **電商會員卡 / LINE 會員卡**：顧客在 LINE 查看點數、購物金、優惠券、訂單資訊；與 91APP、Cyberbiz、FLAPS（輔翼科技）整合，支援線上線下會員累積（2024 Q4 新功能）。
12. **產業 PR 值分析（MAAC AI Insights）**：業界獨家 5 大面向分析（增粉、導流、遊戲化、自動化、通知），提供與同產業對標的 PR 值評比與優化建議（2024 Q4 新功能）。
13. **MGM 增粉模組（Member Get Member）**：透過 LINE 傳播機制設計拉新活動，現有好友邀請新好友可獲得獎勵，追蹤每條邀請鏈的效果。

### 一對一客服與對話管理（CAAC 核心）

14. **全通路統一收件匣**：整合 LINE、Facebook Messenger、Instagram、WhatsApp，統一管理所有對話（2025 年陸續加入 Web Widget）。
15. **AI Support Agent（全天候自動回覆）**：知識庫管理 + 自主回覆，處理 FAQ；情緒感知偵測，判斷是否需要轉接真人客服。
16. **AI Sales Agent（對話式銷售）**：在對話中根據顧客語意主動推薦適合商品，以視覺化商品圖卡呈現，追蹤點擊轉換。
17. **AI Copilot（真人客服輔助）**：AI 讀取品牌知識庫，根據顧客訊息提供參考回覆建議，提高回覆效率與品質（2024 Q4 新功能）。
18. **AI 對話摘要（AI Summary）**：換班或轉交時，AI 自動產出對話重點讓接手者秒懂狀況。
19. **情緒偵測與警示**：AI 偵測對話中的憤怒或不滿情緒，優先通知管理員介入。
20. **多人協作指派**：可將對話分配給特定團隊或指定專員，支援自動指派邏輯，回傳指派結果通知（2024 Q4 升級）。
21. **行動客服 App**：前線業務人員用手機 App 即時處理 LINE 訊息，不受限於電腦端操作。
22. **91APP OMO 業績追蹤**：透過 API 整合追蹤客服專員的 OMO 銷售貢獻（2024 Q4 新功能）。
23. **Web Widget（官網互動工具）**：在官網提供即時對話服務，支援行為追蹤與個人化行銷（2024 Q4 推出）。
24. **語音通話整合（Voice）**：顧客可直接透過網頁語音通話聯繫客服，系統內建錄音與紀錄。

### 數據追蹤與 AI 洞察（DAAC）

25. **DAAC AI 數據顧問（全新 2025）**：整合 MAAC + CAAC 資料，對話式 AI 可即時回答「這週業績表現」「哪個族群最有貢獻」等問題，3 分鐘內完成過去需 3-5 天的跨部門報表；偵測異常並提供一鍵執行建議。
26. **360 度顧客畫像（Unified Profile）**：對話視窗旁即時顯示訂單歷史、官網瀏覽軌跡、行銷標籤、推播互動記錄。
27. **UTM + 轉換追蹤歸因**：精準統計單一推播帶來的官網訂單金額與 ROAS，支援多觸點歸因。
28. **Open API 串接**：支援企業內部 CRM、ERP 自定義串接，並深度整合 iKala 生態系（母公司為 iKala）。
29. **ISO 27001 資安認證 + 2FA**：提供企業級二階段驗證與細膩權限管控，每分鐘最高 12 萬則訊息發送速度。
30. **Google Agentspace 整合（2025 最新）**：導入 Google Agentspace 打造企業級 AI 新典範，加速 AI 工作流程（市場首波導入企業）。

---

## Block 3：對照矩陣

差距等級說明：
- ✅ 已有同等
- 🟡 部分有（簡單實作就能補齊）
- 🟠 沒有但可做（中等工作量，1-2 週）
- 🔴 沒有且難做（需要新基礎設施 / 第三方串接）
- 💎 我們可以做得更好（聖研有獨家資源）

| # | 功能 | 客服中心（現況） | Omnichat | 漸強 | 差距等級 | 備註 |
|---|---|---|---|---|---|---|
| 1 | LINE OA 訊息收發整合 | webhook skeleton 就緒，等 token | ✓ 完整 | ✓ 完整 | 🟡 | token 一填就通 |
| 2 | Facebook Messenger 收發 | webhook skeleton 就緒，等 token | ✓ 完整 | ✓ 完整 | 🟡 | 同上 |
| 3 | Instagram Direct 整合 | 無 | ✓ 完整 | ✓ 完整 | 🟠 | 串接 IG API，2 週可做 |
| 4 | WhatsApp Business API | 無 | ✓ 旗艦功能 | ✓ 有 | 🔴 | 需 Meta BSP 資格，不是重點（台灣用戶少用 WA） |
| 5 | 統一收件匣（多通道合一） | ✓ 三欄 UI 已實作 | ✓ | ✓ | ✅ | 現有架構已到位 |
| 6 | 多業主 SaaS 架構 | ✓ multi-tenant 完整 | 無（企業型，非 SaaS） | 無 | 💎 | 這是我們的差異化優勢 |
| 7 | 快捷模板 / 預存回覆 | ✓ 7 個預設模板 | ✓ 完整 | ✓ 完整 | ✅ | 數量可擴充，架構已對 |
| 8 | 對話轉接（Reassign） | 無 | ✓ 完整 | ✓ 完整 | 🟠 | 1 週可實作基礎版 |
| 9 | 多人協作（多客服同時在線） | 無 | ✓ 2025 新功能 | ✓ 有 | 🟠 | 需 WebSocket，P2 一起做 |
| 10 | 自動分流指派 | 無 | ✓ 完整 | ✓ 完整 | 🟠 | 可先做輪詢/手動指派 |
| 11 | 對話標籤 / 分類 | 無（顧客有 tags，對話無） | ✓ 完整 | ✓ 完整 | 🟡 | 對話物件加 tag 欄位即可 |
| 12 | 內部備忘（Internal Note） | 無 | ✓ 有 | ✓ 有 | 🟡 | 訊息加 type=internal 欄位，2-3 天 |
| 13 | 顧客 360 資料卡 | ✓ 顧客資訊面板（notes/tags） | ✓ 完整 | ✓ 完整 | 🟡 | 缺訂單歷史、電商串接 |
| 14 | 自訂顧客屬性欄位 | 無（固定欄位） | ✓ 完整 | ✓ 完整 | 🟡 | 在 customers 表加 JSON custom_fields 欄 |
| 15 | AI 草擬回覆（AI Copilot） | 無（P2 規劃中） | ✓ AI Copilot | ✓ AI Copilot | 🟠 | 接 Claude API 即可，P2 核心功能 |
| 16 | AI FAQ 自動回覆機器人 | 無 | ✓ AI Agent Studio | ✓ AI Support Agent | 🟠 | 需知識庫建立 UI + LLM 推理 |
| 17 | 關鍵字自動回覆 | 無 | ✓ 完整 | ✓ 完整 | 🟠 | 規則引擎，約 1 週可做 |
| 18 | 視覺化聊天流程編輯器 | 無 | ✓ Flow Builder | ✓ 有 | 🔴 | 工作量大，需獨立子系統 |
| 19 | 品牌 DNA / 語調設定 | ✓ DNA 編輯器（tone/禁字/signature） | 無（需確認） | 無 | 💎 | 接 AI 草擬後，品牌一致性是獨家優勢 |
| 20 | 意圖分類（P3 規劃中） | 無 | 部分（AI Agent） | 部分（AI Agent） | 🟠 | 接 Claude API 做意圖分類，P3 |
| 21 | 顧客 CRUD（備註/標籤編輯） | ✓ 完整 | ✓ 完整 | ✓ 完整 | ✅ | 已對等 |
| 22 | 黑名單 / 對話封鎖 | 無 | ✓ 有 | ✓ 有 | 🟡 | 顧客加 is_blocked 欄位 |
| 23 | 對話搜尋 / 全文檢索 | 無（P 規劃外） | ✓ 有 | ✓ 有 | 🟠 | 接 PostgreSQL full-text search，1 週 |
| 24 | CSAT 顧客滿意度評分 | 無 | ✓ 有 | ✓ 有 | 🟠 | 對話結束發送 1-5 星評分按鈕 |
| 25 | 儀表板 KPI | ✓ 有（基礎） | ✓ 完整 | ✓ 完整 | 🟡 | 現有基礎，擴充指標即可 |
| 26 | 客服績效分析（回覆時間/解決率） | 無 | ✓ 完整 | ✓ 完整 | 🟠 | 在 audit log 基礎上計算，2 週 |
| 27 | 分眾推播廣播 | 無（P4 規劃） | ✓ 完整 | ✓ 完整 | 🔴 | 需 LINE / Meta API 廣播端點整合 |
| 28 | 購物車再行銷 | 無 | ✓ Pro+ 方案 | ✓ 有 | 🔴 | 需電商 webhook + 行為追蹤 SDK |
| 29 | 顧客旅程自動化（序列訊息） | 無 | ✓ Enterprise+ | ✓ 完整 | 🔴 | 需時序觸發引擎，排程任務複雜度高 |
| 30 | 行為觸發訊息（Event-triggered） | 無 | ✓ 有 | ✓ 完整 | 🔴 | 需 web SDK + 事件系統 |
| 31 | 優惠券管理 | 無 | ✓ 加購模組 | 有（透過電商整合） | 🔴 | 需設計核銷邏輯，中高複雜度 |
| 32 | 互動遊戲模組（抽獎/刮刮樂） | 無 | ✓ 加購 | ✓ 20+ 款 | 🔴 | 高工作量，考慮 API 串接 Feversocial |
| 33 | Rich Menu 圖文選單管理 | 無 | 無明確提及 | ✓ 完整（個人化 Rich Menu） | 🟠 | 透過 LINE API 可做，但需後台編輯器 |
| 34 | 電商平台串接（Shopify/91APP/SHOPLINE） | 無 | ✓ 深度整合 | ✓ 深度整合 | 🔴 | P4 核心，需逐一串接 API |
| 35 | 訂單查詢（顧客在對話問訂單）| 無 | ✓ 有 | ✓ 有 | 🟠 | 透過電商 API 拉單，接著展示在資料卡 |
| 36 | 數位會員卡（LINE 內查點數/等級） | 無 | ✓ 加購模組 | ✓ 有 | 🔴 | 需 LIFF App 開發 |
| 37 | 手機號碼綁定（身份識別） | 無 | ✓ 有 | 有（透過 LIFF） | 🔴 | 需 LIFF + OTP 驗證 |
| 38 | OMO 門市業績追蹤 | 無 | ✓ Customisation 方案 | ✓ 有 | 🔴 | 需要業務端手機掃碼 App，高工作量 |
| 39 | Meta CAPI 廣告整合 | 無 | ✓ 有 | 部分 | 🔴 | 需 Meta CAPI 串接，但廣告投放業主是高價值功能 |
| 40 | AI 對話摘要 | 無 | ✓ AI 功能 | ✓ AI 功能 | 🟠 | 接 Claude API 做摘要，P2 附加功能 |
| 41 | AI 智慧發送時機 | 無 | 無明確提及 | ✓ 漸強獨家 | 🔴 | 需大量發送歷史數據訓練，長期才有 |
| 42 | AI 產業 PR 值分析 | 無 | 無 | ✓ MAAC AI Insights 獨家 | 🔴 | 需產業 benchmarking 資料庫 |
| 43 | 廣告 ROAS 整合分析 | 無 | 部分（CAPI） | 部分（轉換追蹤） | 💎 | 聖研有廣告數據，可做深度 ROAS 儀表板 |
| 44 | 品牌 SEO 內容聯動 | 無 | 無 | 無 | 💎 | 聖研有 SEO 工具，對話觸發 SEO 導流 |
| 45 | 推播成效報告 | 無 | ✓ 完整 | ✓ 完整 | 🔴 | 需廣播功能先完成 |
| 46 | 轉換追蹤 ROI 歸因 | 無 | ✓ Pro+ | ✓ 有 | 🔴 | 需電商串接完成後才能算 |
| 47 | WebSocket 即時推送 | 無（P 規劃中） | ✓ 有 | ✓ 有 | 🟠 | P2 必做，用 socket.io |
| 48 | Audit Log（操作記錄） | ✓ 完整 | ✓ 有 | ✓ 有 | ✅ | 已有，且比一般競品更完整 |
| 49 | AES-256 + bcrypt 資安 | ✓ 完整 | 有（企業資安） | ✓ ISO 27001 | ✅ | 已到企業級 |
| 50 | Token 設定後台 | ✓ 完整 | 無（SaaS 不需要） | 無 | ✅ | multi-tenant 架構的必要設計 |
| 51 | 多語言支援 | 無 | ✓ 有（亞洲多語） | 部分 | 🟠 | 中英文 i18n，視市場需求 |
| 52 | 發票模組（線下購買數據） | 無 | 部分 | ✓ MAAC 獨家 | 🔴 | 需 O2O 場景，與台灣 B2C 品牌相關 |
| 53 | 問卷調查（LIFF 問卷） | 無 | 無 | ✓ 有 | 🟠 | 可做簡版表單，存入顧客自訂屬性 |
| 54 | 行動 App（客服端） | 無 | 無（需確認） | ✓ 有 | 🔴 | 高工作量，PWA 是更快的替代方案 |
| 55 | AI 數據分析儀（自然語言問報表） | 無 | 部分（Agentic AI） | ✓ DAAC 全新產品 | 🔴 | 需大量整合資料後才有意義，長期目標 |
| 56 | 知識庫管理（FAQ 訓練資料） | 無 | ✓ 有 | ✓ 有 | 🟠 | 做 markdown 知識庫 CRUD + 向量搜尋，P2-P3 |
| 57 | 第三方 API 開放接口 | 無 | ✓ Customisation 方案 | ✓ Open API | 🟠 | 在多業主架構下，開 API Key 機制相對容易 |
| 58 | 品牌矩陣（多品牌管理） | 可擴充（multi-tenant 架構） | 無（單企業） | 無 | 💎 | 管理多個 brand 的 DNA + 客服，這是我們的 SaaS 賣點 |

---

## Block 4：Claude Code SKILL 搜尋 + 安裝建議

### 本機現有 SKILL（`~/.claude/skills/`）

| SKILL 名稱 | 本機路徑 | 對應客服中心功能模組 | 為什麼有用 |
|---|---|---|---|
| **ui-ux-pro-max** | `~/.claude/skills/ui-ux-pro-max/` | 全 UI 介面（三欄收件匣、儀表板、設定頁） | 50+ 設計風格、99 條 UX 指南、Tailwind/shadcn 支援，讓 UI 直接達到企業級外觀 |
| **ui-styling** | `~/.claude/skills/ui-styling/` | CSS / Tailwind 元件樣式 | 色彩系統、字型、動畫，強化氣泡 UI 視覺細節 |
| **brand** | `~/.claude/skills/brand/` | 品牌 DNA 編輯器、多業主品牌設定 | 品牌語調定義、一致性檢查，直接對應品牌 DNA 模組邏輯 |
| **design-system** | `~/.claude/skills/design-system/` | 組件庫設計 | 設計 token、元件規範，建立客服中心 UI 元件庫 |
| **ad-creative** | `~/.claude/skills/ad-creative/` | AI 草擬回覆（品牌文案風格） | 廣告文案生成邏輯可移植到 AI 草擬功能，幫助 AI 草擬符合品牌調性 |
| **paid-ads** | `~/.claude/skills/paid-ads/` | Meta CAPI 廣告整合、ROAS 分析儀表板 | 廣告投放策略 + ROAS 計算邏輯，配合廣告 ROAS 整合模組 |
| **fb-social-content** | `~/.claude/skills/fb-social-content/` | FB Messenger 模板 / 快捷回覆 | 社群文案策略，協助生成 FB 客服模板內容 |
| **fb-copywriting** | `~/.claude/skills/fb-copywriting/` | AI 草擬 FB 對話回覆 | 文案框架可做為 AI 草擬 FB 端訊息的底層 prompt |
| **image** | `~/.claude/skills/image/` | 優惠券 / 視覺商品卡 | 圖片生成輔助，可用於生成推播用的商品圖片 |
| **ak-threads** | `~/.claude/skills/ak-threads/` | Threads 跨平台行銷自動化（未來擴充通道） | 若未來加入 Threads 通道，直接可用 |

### 需要但本機沒有的 SKILL — 建議新增或自建

| 功能需求 | 建議 SKILL 或工具 | 來源 | 安裝指令 |
|---|---|---|---|
| **WebSocket 即時推送** | 需自建：使用 `socket.io` | npm package | `npm install socket.io` |
| **向量搜尋 / 知識庫 RAG** | 需自建：使用 `pgvector` + `openai embeddings` | PostgreSQL 擴充 | `CREATE EXTENSION vector;` |
| **LINE Messaging API 整合** | 需自建：`@line/bot-sdk` | npm | `npm install @line/bot-sdk` |
| **意圖分類（NLU）** | 需自建：接 Claude API 做 zero-shot 分類 | Anthropic API | 現有 API key 可直接用 |
| **全文搜尋** | 需自建：PostgreSQL `tsvector` | 內建功能 | 無需安裝，加 migration 即可 |
| **前端視覺化流程編輯器** | 建議用 `React Flow` | npm | `npm install @xyflow/react` |
| **Anthropic 官方 document-skills** | PDF/DOCX/XLSX 文件技能 | github.com/anthropics/skills | `/plugin install document-skills@anthropic-agent-skills` |

---

## Block 5：我的判斷

### 必補的 5 個功能（按時序）

1. **WebSocket 即時推送（P2 第一優先）**：現在沒有即時感的客服系統完全不及格，這是基礎設施，不補等同失去競爭力。
2. **AI 草擬回覆（P2 核心）**：接 Claude API + 品牌 DNA，差異化立刻出現，且技術實作最短（1 週），ROI 最高。
3. **對話搜尋 + 對話標籤（P2 附加）**：PostgreSQL full-text search + 對話加 tag，1 週補齊，客服效率關鍵。
4. **對話轉接 + 多客服指派（P2-P3）**：多業主 SaaS 要讓業主有多個客服，轉接是基本功，不做 SaaS 沒辦法販賣。
5. **電商 API 串接（P4 前置）**：先做訂單查詢（在顧客資料卡顯示訂單），再慢慢擴展到購物車再行銷，從小切口進入電商整合。

### 可砍的 5 個功能（避免功能膨脹）

1. **WhatsApp Business API**：台灣用戶量遠不如 LINE/FB，需要 BSP 資格成本高，暫時不做。
2. **互動遊戲模組（抽獎/刮刮樂）**：高工作量但核心價值不高，可留給漸強做，我們專注客服+行銷。
3. **語音通話整合（Voice）**：台灣客服場景以文字為主，暫不需要，漸強的 Voice 功能也是罕用。
4. **AI 數據分析儀（DAAC 類型）**：需要大量歷史數據才有意義，現在做是為了功能而功能，等業主數到 10+ 再考慮。
5. **發票模組（線下消費上傳）**：很台灣在地化，但需要 O2O 整合基礎設施，工作量高 ROI 不確定。

### 獨家機會 3 個

1. **品牌 DNA x AI 草擬 = 真正的「品牌語氣一致性」客服**：兩家競品都沒有深度的品牌 DNA 編輯器，我們的 tone/禁字/signature 設計，加上 Claude API，可以做到 AI 草稿永遠符合品牌調性，這是保養品/服飾業主最痛的痛點——客服語氣不統一。
2. **聖研廣告數據 x 顧客對話 = ROAS 歸因儀表板**：聖研有廣告後台資料，若把 FB/LINE 廣告點擊 → 對話 → 購買的完整路徑打通，可以做出 Omnichat CAPI 做不到的深度 ROAS 歸因，直接成為業主願意付費的殺手級功能。
3. **多品牌矩陣 SaaS = 台灣中小品牌的共同客服 + 聯合行銷基礎**：梵森 + 聖研 + 未來更多品牌，在同一套系統下共享 AI 知識庫訓練成本，形成網路效應。競品都是單企業授權模式，我們的 multi-tenant 架構天然支援這個方向，這是他們想做也做不快的。

---

## 附錄：資料來源

- Omnichat 客服功能頁：https://www.omnichat.ai/customer-service/
- Omnichat Pricing 頁：https://www.omnichat.ai/pricing/
- Omnichat 教學文件（Mar 2025 更新）：https://docs.omnichat.ai/release-note/mar-19-2025
- Omnichat 部落格 AI CRM：https://blog.omnichat.ai/tw/ai-crm-module/
- Omnichat 2025 Highlight：https://blog.omnichat.ai/omnichat-2025-highlight/
- 漸強實驗室 MAAC 頁：https://www.cresclab.com/tw/product/maac
- 漸強 CAAC 比較：https://www.cresclab.com/tw-a
- 漸強 2024 Q4 產品更新：https://blog.cresclab.com/zh-tw/2024q4-product-launch
- 漸強 LINE 廠商比較：https://blog.cresclab.com/zh-tw/line-oa-techpartner-comparison
- 漸強 DAAC 新聞：https://www.bnext.com.tw/article/84509/ai-first-communication-cloud
- 漸強 Rich Menu 功能介紹：https://medium.com/漸強實驗室-crescendo-lab/rich-menu-maac-7a17c6053e14
- 漸強遊戲模組教學：https://crescendolab.zendesk.com/hc/en-us/articles/36493267779609
- Anthropic Skills 官方 repo：https://github.com/anthropics/skills
- Omnichat G2 評測：https://www.g2.com/products/omnichat/reviews

> 注意：Omnichat 定價不公開，需直接聯繫業務報價。部分功能（如多人協作、OMO）屬加購模組，實際費用需確認。漸強實驗室同樣不公開定價。
