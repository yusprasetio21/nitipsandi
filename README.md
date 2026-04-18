# DDK GTS Web — Vercel Edition

Port dari PHP ke HTML+JS+Vercel serverless. Backup darurat saat server kantor mati.

## Struktur File

```
ddk-gts/
├── index.html          ← UI utama (port dari PHP index.php)
├── style.css           ← Styling dark/light theme
├── app.js              ← Logic: cleansing WA, FTP, Supabase, history
├── api/
│   └── send.js         ← Serverless: FTP check, upload, Supabase CRUD
├── package.json
├── supabase_schema.sql ← Jalankan di Supabase SQL Editor
└── README.md
```

## Langkah Deploy

### 1. Setup Supabase
1. Buka https://supabase.com → New Project
2. SQL Editor → paste isi `supabase_schema.sql` → Run
3. Catat:
   - Project URL: `https://XXXXXXX.supabase.co`
   - Service Role Key: Settings → API → service_role (bukan anon!)

### 2. Push ke GitHub
```bash
git init
git add .
git commit -m "DDK GTS Web - Vercel Edition"
git remote add origin https://github.com/KAMU/ddk-gts.git
git push -u origin main
```

### 3. Deploy ke Vercel
1. https://vercel.com → New Project → import repo
2. **Environment Variables** (wajib semua):

| Key           | Value                      |
|---------------|----------------------------|
| FTP_HOST      | 172.19.0.202               |
| FTP_USER      | rasonftp                   |
| FTP_PASS      | rasonftp_1672              |
| FTP_HOST_2    | 172.19.3.230               |
| FTP_USER_2    | bmksfty2022                |
| FTP_PASS_2    | Bmksfty2022                |
| FTP_PORT      | 21                         |
| FTP_PATH      | /                          |
| FTP_PATH_2    | /                          |
| SUPABASE_URL  | https://XXXX.supabase.co   |
| SUPABASE_KEY  | eyJ... (service_role key)  |

3. Deploy!

## Cara Pakai

1. Buka URL Vercel
2. **Input Data** → paste chat WA mentah
3. Klik **Preview & Edit** untuk review sebelum kirim, atau langsung **Kirim ke FTP**
4. Sistem otomatis:
   - Bersihkan timestamp & metadata WA
   - Upload ke FTP Main (172.19.0.202) DAN InaSwitching (172.19.3.230)
   - Simpan history ke Supabase
   - Jika FTP down → tersimpan pending, retry tiap 5 menit
5. Pantau di **History** — semua petugas tampil di sini

## Fitur

| Fitur | Status |
|-------|--------|
| Cleansing WA chat (port dari PHP) | ✅ |
| Upload FTP Main + InaSwitching | ✅ |
| Preview & Edit sebelum kirim | ✅ |
| History semua petugas (Supabase) | ✅ |
| Duplikasi cek | ✅ |
| Queue offline + retry otomatis | ✅ |
| Dark/light theme | ✅ |
| Monitoring jadwal | ❌ dihapus |
| BmkgSoft checker | ❌ dihapus |

## Perbedaan vs PHP Existing

| | PHP (server kantor) | Vercel (backup) |
|---|---|---|
| Kondisi pakai | Normal | Darurat (listrik/inet mati) |
| Database | SQLite lokal | Supabase cloud |
| FTP | Main + InaSwitching | Main + InaSwitching |
| Akses | Intranet | Internet publik |
| Session | PHP session | localStorage + Supabase |
