# 寶貝喝水提醒

可直接部署至 GitHub Pages 的靜態 PWA。

## GitHub Pages

1. 建立一個新的 GitHub repository。
2. 將此資料夾中的所有檔案放在 repository 根目錄。
3. 在 **Settings → Pages** 將來源設為 **Deploy from a branch**。
4. 選擇 `main` 與 `/ (root)` 後儲存。

GitHub Pages 會提供 HTTPS 網址。Windows Chrome 可直接允許通知；iPhone 請先用 Safari 開啟網站，再選擇「加入主畫面」，從主畫面開啟後允許通知。

## 推播後端

`service-worker.js` 已包含接收推播與點擊通知的行為。正式的定時推播仍需串接 Push API 後端（建議 Cloudflare Worker + Cron Trigger），並保存使用者的 push subscription。
