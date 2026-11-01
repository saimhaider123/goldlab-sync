# Gold Lab Pro — Sync Server

Keeps the Windows PC and the Android phone on the same data (MongoDB Atlas).
Each device still works offline; it syncs automatically when online.

## 1. MongoDB Atlas
Atlas → your project → Database → Connect → Drivers → copy the connection string
(`mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/`).
Network Access → allow `0.0.0.0/0` (Render has no fixed IP).

## 2. Deploy on Render (free)
1. Push this `sync_server` folder to a **private** GitHub repo (e.g. `goldlab-sync`).
2. Render → New → Web Service → pick the repo.
   Build: `npm install` · Start: `npm start` · Plan: Free
3. Environment variables:
   - `MONGODB_URI` = the Atlas connection string
   - `ADMIN_TOKEN` = any long secret only you know
4. Deploy. Open `https://<your-service>.onrender.com/` → `{"ok":true,...}`

If the address is not `https://goldlab-sync.onrender.com`, change
`syncServerUrl` in `lib/core/constants.dart` (or enter it in the app under
Settings → Sync → Advanced).

## 3. Create a shop (one per customer)
PowerShell:
```
Invoke-RestMethod -Method Post -Uri https://goldlab-sync.onrender.com/admin/shops `
  -Headers @{ "x-admin-token" = "YOUR_ADMIN_TOKEN" } -ContentType "application/json" `
  -Body '{"name":"Jatin Soni"}'
```
Copy the `syncKey` (GLPxxxxxxxx.xxxxx…). Paste it in the app on every device:
Settings → Desktop & Mobile Sync → Connect. Connect the PC first, then the phone.

Block a shop: `POST /admin/shops/<id>/active` with body `{"active":false}`.

Never put the admin token or sync keys in the app source or on GitHub.
