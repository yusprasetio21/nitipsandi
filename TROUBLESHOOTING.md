# Troubleshooting Guide — DDK GTS Web

## Problem: Bridge Disconnect (Cloudflared "context canceled")

### Gejala
```
2026-04-20T01:10:07Z ERR error="Incoming request ended abruptly: context canceled"
2026-04-20T01:10:07Z ERR Request failed error="Incoming request ended abruptly: context canceled"
```

Bridge sering disconnect, hanya connect sebentar, tidak stabil.

### Penyebab Umum
1. **Port 3001 tidak listening** — Backend tidak running atau menggunakan port lain
2. **Timeout terlalu pendek** — Request panjang terputus sebelum selesai
3. **Network throttling** — ISP atau firewall memotong connection
4. **Cloudflared process hang** — Perlu restart

### Solusi

#### Step 1: Check Backend Port
```bash
# Di terminal, cek apakah port 3001 aktif
netstat -tuln | grep 3001
# atau
lsof -i :3001

# Jika tidak ada output, backend tidak running
```

#### Step 2: Restart Cloudflared
```bash
# 1. Stop tunnel yang lama (Ctrl+C di terminal)
# 2. Start ulang:
cloudflared tunnel --url http://localhost:3001

# Tunggu sampai keluar URL seperti:
# 2026-04-20T01:05:35Z INF Registered tunnel connection
# https://cut-conducted-fisheries-achieving.trycloudflare.com
```

#### Step 3: Update CONFIG di app.js
Setelah restart cloudflared, URL akan berubah. Update di **app.js** baris ~11:
```javascript
CONFIG = {
  API:            "/api/send",
  RETRY_INTERVAL: 5 * 60 * 1000,
  BRIDGE_URL:     "https://cut-conducted-fisheries-achieving.trycloudflare.com",  // ← Update ini
  BRIDGE_TOKEN:   "DDK_GTS_BRIDGE_2025",
};
```

Kemudian refresh browser (F5).

#### Step 4: Monitor Console untuk Detail Error
1. Buka DevTools (F12)
2. Console tab
3. Klik "Cek Ulang" di Dashboard
4. Lihat logs dengan prefix `[checkFTP]`:
   ```
   [checkFTP] Bridge attempt 1/2: https://...
   [checkFTP] Bridge response OK: {ftp1: true, ftp2: false}
   ```
   atau
   ```
   [checkFTP] Bridge attempt 1/2 failed: Timeout
   [checkFTP] Bridge attempt 2/2 failed: Timeout
   [checkFTP] Fallback: trying Vercel serverless
   ```

---

## Problem: Retry Gagal (0 dari 2 terkirim)

### Gejala
- Click "Kirim Ulang" di history detail
- Toast show: "✅ Berhasil dikirim ulang"
- Tapi status tetap **Pending**
- Atau show: "❌ FTP masih offline"

### Debug: Check Console Logs

1. **Open DevTools** (F12 → Console)
2. **Click "Kirim Ulang"** di history detail
3. Look for `[Retry]` logs:

**Success log:**
```
[Retry] Attempting to send item abc123...
[Retry] Response: {ok: true, ftp1: true, ftp2: false}
✅ Berhasil dikirim ulang ke FTP!
```

**Fail log:**
```
[Retry] Attempting to send item abc123...
[Retry] Server error: 500 Request timeout
❌ Server error: 500 - ...
```

### Common Issues & Solutions

#### Issue 1: FTP Credentials Wrong

**Error log:**
```
[FTP] Connection failed to 172.19.0.202: 530 Login incorrect
```

**Solusi:**
1. Verifikasi credentials di Vercel → Settings → Environment Variables:
   - `FTP_HOST` = `172.19.0.202`
   - `FTP_USER` = `rasonftp`
   - `FTP_PASS` = `rasonftp_1672`
   - `FTP_HOST_2` = `172.19.3.230`
   - `FTP_USER_2` = `bmksfty2022`
   - `FTP_PASS_2` = `Bmksfty2022`
   - `FTP_PORT` = `21`

2. Test FTP manual dari terminal:
   ```bash
   ftp -n 172.19.0.202
   > user rasonftp rasonftp_1672
   > dir
   > quit
   ```

#### Issue 2: FTP Server Offline

**Error log:**
```
[FTP] Connection failed to 172.19.0.202: Connection refused / Timeout
```

**Solusi:**
- Check di "Dashboard" tab apakah FTP Main / InaSwitching offline
- Pastikan router/firewall tidak blok port 21
- Test ping: `ping 172.19.0.202`

#### Issue 3: File Size Terlalu Besar

**Error log:**
```
[FTP] Upload failed for DDK_SHIFT_20260420_010000.X: Connection timeout
```

**Solusi:**
- Timeout sekarang 20 detik (naik dari 8 detik)
- Jika masih timeout, naikkan di `send.js`:
  ```javascript
  // Cari:
  await ftpConnect(..., 20000);  // 20 second timeout
  // Ubah jadi:
  await ftpConnect(..., 30000);  // 30 second timeout
  ```

#### Issue 4: Path FTP Salah

**Error log:**
```
[FTP] Upload failed for ...: Permission denied / No such directory
```

**Solusi:**
- Check Environment Variables:
  - `FTP_PATH` = `/` (atau folder yang sudah exist)
  - `FTP_PATH_2` = `/` (atau folder yang sudah exist)
- Atau gunakan default `/` di kedua FTP

---

## Problem: Pending Items Tidak Otomatis Kirim

### Expected Behavior
1. Refresh page → check pending items
2. Jika FTP online → auto send semua pending
3. Jika FTP offline → start retry timer (5 menit)
4. Jika FTP status berubah online → otomatis trigger send

### Debug Steps

#### Step 1: Check Init Logs
Saat page load, lihat console:
```
[Init] Found pending items, checking FTP...
[Init] FTP online, starting auto-retry...
✅ X dari Y berhasil dikirim ulang.
```

atau

```
[Init] Found pending items, checking FTP...
[Init] FTP offline, starting retry timer...
Akan retry dalam 5:00
```

#### Step 2: Verify isVercel Status
Di console, ketik:
```javascript
console.log("isVercel:", isVercel)
```

Harus return `true`. Jika `false`, artinya tidak bisa konek ke Vercel API.

#### Step 3: Check Supabase Connection
1. Buka "History" tab
2. Jika semua loading/error → Supabase koneksi gagal
3. Check Console untuk Supabase error

#### Step 4: Manual Test
Click "Retry Pending" button di Quick Actions. Lihat console:
```
[retryPending] Starting to send 2 items...
[retryPending] Sending item abc123: DDK_SHIFT_20260420_010000.X
[retryPending] ✅ Item abc123 sent successfully
[retryPending] Sending item def456: DDK_SHIFT_20260420_010001.X
[retryPending] ❌ Item def456 HTTP 500
[retryPending] Done: 1/2 success, 1 failed
✅ 1 dari 2 berhasil dikirim ulang.
```

---

## Advanced: Check Vercel Function Logs

### View Real-Time Logs
1. Go to https://vercel.com → Select project → Settings → Functions
2. Atau gunakan Vercel CLI:
   ```bash
   npm install -g vercel
   vercel logs --tail
   ```

### Common Vercel Errors
- **502 Bad Gateway** — Function crash/timeout
- **500 Internal Server Error** — FTP connection error
- **503 Service Unavailable** — Vercel overload

---

## Tips: Better Debugging

### Enable Verbose Logging
Di `app.js`, bisa add lebih banyak logging:
```javascript
// Contoh: di retryPending function
console.log("[retryPending] Processing:", { pending: pending.length, ftpStatus });
console.log("[retryPending] Item details:", item);
```

### Check Network Tab
1. DevTools → Network tab
2. Click "Retry" button
3. Lihat request ke `/api/send?action=retry`:
   - **Status**: 200 (OK) atau 500 (Error)
   - **Response**: JSON dengan hasil upload

### Browser Storage
Di console:
```javascript
// Check localStorage
console.log(localStorage);

// Check Supabase data
await sb.select("upload_history", "limit=5");
```

---

## Getting Help

Jika masih error, kumpulkan:
1. **Console screenshot** (F12 → Console, full logs)
2. **Vercel logs** (function logs)
3. **FTP test result** dari terminal
4. **Network tab screenshot** dari failed request

Kemudian share untuk diagnosis lebih lanjut.
