// ═══════════════════════════════════════════════════════════════════
// DDK GTS Web — app.js
// Arsitektur HYBRID:
//   - Supabase → langsung dari browser (history, duplikasi, insert)
//   - FTP → via bridge (cloudflared) atau Vercel serverless
//   - REPORT → via BRIDGE_REPORT (pg-agent.js untuk query database)
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  API:            "/api/send",         // Vercel serverless (saat di Vercel)
  RETRY_INTERVAL: 5 * 60 * 1000,      // 5 menit

  // ── SUPABASE ─────────────────────────────────────────────────────
  SB_URL:  "https://ekrutvxdeugconuylehq.supabase.co",
  SB_ANON: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrcnV0dnhkZXVnY29udXlsZWhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MTgzMzUsImV4cCI6MjA5MjA5NDMzNX0.kE9NOblhXsB4b9LHPDuOlgYnau-VsEC7jH2Up82lCrA",

  // ── BRIDGE (laptop kantor via cloudflared) ────────────────────────
  // Update URL ini setiap kali cloudflared dijalankan ulang
  BRIDGE_URL:   "https://leslie-carrying-considered-roman.trycloudflare.com",
  BRIDGE_TOKEN: "DDK_GTS_BRIDGE_2025",

  // ── BRIDGE BMKGSATU REPORT (khusus untuk query database report) ──────────
  // Ganti URL ini dengan URL cloudflared dari server yang menjalankan pg-agent.js
  BRIDGE_REPORT_URL:   "https://olympics-eight-chocolate-salmon.trycloudflare.com/",
  BRIDGE_REPORT_TOKEN: "DDK_GTS_BRIDGE_2025",
};

// ═══════════════════════════════════════════════════════════════════
// BRIDGE HEADERS HELPER
// ═══════════════════════════════════════════════════════════════════
function bridgeHeaders(withToken = false, isReport = false) {
  const h = {
    "Content-Type": "application/json",
    "User-Agent":   "DDK-GTS-Client/1.1",
    "Accept":       "application/json",
  };
  if (withToken) {
    if (isReport) {
      h["x-bridge-token"] = CONFIG.BRIDGE_REPORT_TOKEN;
    } else {
      h["x-bridge-token"] = CONFIG.BRIDGE_TOKEN;
    }
  }
  return h;
}

// ── SUPABASE CLIENT (browser langsung) ───────────────────────────
const sb = {
  async request(endpoint, options = {}) {
    const url = `${CONFIG.SB_URL}/rest/v1/${endpoint}`;
    const headers = {
      'apikey': CONFIG.SB_ANON,
      'Authorization': `Bearer ${CONFIG.SB_ANON}`,
      'Content-Type': 'application/json',
      ...options.headers
    };

    try {
      const response = await fetch(url, { ...options, headers });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Supabase error:', response.status, errorText);
        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
      }

      return response.status === 204 ? null : await response.json();
    } catch (err) {
      console.error('Supabase request failed:', err);
      throw err;
    }
  },

  async select(table, params = "") {
    return this.request(`${table}?${params}`, { method: 'GET' });
  },

  async insert(table, data) {
    return this.request(table, {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(data)
    });
  },

  async update(table, id, data) {
    return this.request(`${table}?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  async delete(table, id) {
    return this.request(`${table}?id=eq.${id}`, { method: 'DELETE' });
  },
};

// ── STATE ─────────────────────────────────────────────────────────
let ftpStatus         = { ftp1: false, ftp2: false };
let ftpStatusPrevious = { ftp1: false, ftp2: false };
let retryTimer        = null;
let cdTimer           = null;
let retrySeconds      = 0;
let previewOriginal   = "";
let previewCleaned    = "";
let currentPage       = "dashboard";
let theme             = localStorage.getItem("ddk_theme") || "dark";
let isVercel          = false;

// ═══════════════════════════════════════════════════════════════════
// GENERATE FILENAME
// ═══════════════════════════════════════════════════════════════════
function generateFileName() {
  const now     = new Date();
  const year    = now.getFullYear();
  const month   = String(now.getMonth() + 1).padStart(2, '0');
  const day     = String(now.getDate()).padStart(2, '0');
  const hours   = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `GTS_${year}${month}${day}_${hours}${minutes}${seconds}.X`;
}

// ═══════════════════════════════════════════════════════════════════
// CLEANSING ENGINE — port dari cleanWhatsAppMessages() PHP
// ═══════════════════════════════════════════════════════════════════
function cleanWhatsAppMessages(text) {
  // 1. Hapus timestamp & nama pengirim WA
  const waPatterns = [
    /\[\d{1,2}:\d{2},\s\d{1,2}\/\d{1,2}\/\d{4}\]\s[^:]+:\s*/g,
    /\[\d{1,2}:\d{2},\s\d{1,2}\/\d{1,2}\/\d{4}\]\s[^:]+:\s*/g,
    /\[\d{1,2}\/\d{1,2}\/\d{4},\s\d{1,2}:\d{2}\]\s[^:]+:\s*/g,
    /\[\d{4}-\d{1,2}-\d{1,2},\s\d{1,2}:\d{2}\]\s[^:]+:\s*/g,
    /\d{1,2}:\d{2}\s-\s[^:]+:\s*/g,
    /[^:]+:\s*\[\d{1,2}:\d{2},\s\d{1,2}\/\d{1,2}\/\d{4}\]\s*/g,
  ];
  for (const p of waPatterns) text = text.replace(p, "");

  // 2. Hapus metadata WA
  const metaPatterns = [
    /\s*\(file attached\)\s*/gi,
    /\s*<Media omitted>\s*/gi,
    /\s*<media omitted>\s*/gi,
    /\s*Gambar tidak disertakan\s*/gi,
    /\s*Audio tidak disertakan\s*/gi,
    /\s*Video tidak disertakan\s*/gi,
    /\s*Dokumen tidak disertakan\s*/gi,
    /\s*Pesan ini telah dihapus\s*/gi,
    /\s*This message was deleted\s*/gi,
    /\s*‎[^a-zA-Z0-9\s]*\s*/gu,
  ];
  for (const p of metaPatterns) text = text.replace(p, "");

  // 3. Normalize line breaks
  text = text.replace(/\r\n|\r/g, "\n");

  // 4. Filter baris
  const lines = text.split("\n");
  const validLines = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[=\-~_*#]+$/.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;

    if (
      /^(SMID|MMID)\d{2}\s+[A-Z]{4}\s+\d{6}/i.test(line) ||
      /^WXREV\s+\d{5}/i.test(line) ||
      /^[A-Z0-9\s=.\/\-]+$/i.test(line) ||
      /^[A-Z]{4,6}\d{2}/i.test(line) ||
      /^\d{5}\s/.test(line) ||
      line.includes("=") ||
      line.includes("AAXX") ||
      line.includes("BBXX") ||
      line.includes("CCXX") ||
      /^\s*333/.test(line)
    ) {
      validLines.push(line);
    }
  }
  text = validLines.join("\n");

  // 5. Format khusus GTS
  let finalText = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const m1 = line.match(/^(\d{5}\s+.*?)\s+333\s+(.+)$/);
    if (m1) { finalText += m1[1] + "\n" + "  333 " + m1[2] + "\n"; continue; }

    const m2 = line.match(/^333\s+(.+)$/);
    if (m2) { finalText += "  333 " + m2[1] + "\n"; continue; }

    const m2b = line.match(/^(\d{5}\s+.*?)\s+333$/);
    if (m2b) { finalText += m2b[1] + "\n" + "  333\n"; continue; }

    const m3 = line.match(/^([A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6})\s+(AAXX|BBXX|CCXX\s+\d{5}\s*.*)$/i);
    if (m3) { finalText += m3[1] + "\n" + m3[2] + "\n"; continue; }

    finalText += line + "\n";
  }

  finalText = finalText
    .replace(/([A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6})\s+(AAXX\s+\d{5})/gi, "$1\n$2")
    .replace(/(\d{5})\s{2,}(\d{5})/g, "$1 $2")
    .replace(/^\s{1}333\s/gm, "  333 ")
    .replace(/^333\s/gm, "  333 ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/=\s*\n(?!\s*\n)/g, "=\n\n")
    .trim();

  return finalText;
}

function extractSandiList(cleanedText) {
  const sandis = [];
  const lines  = cleanedText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('  333') || trimmed.startsWith('AAXX') ||
        trimmed.startsWith('BBXX') || trimmed.startsWith('CCXX') ||
        trimmed.startsWith('SMID') || trimmed.startsWith('MMID') ||
        trimmed.startsWith('WXREV')) {
      continue;
    }

    let m = trimmed.match(/^(\d{5})\s/);
    if (m) { sandis.push(m[1]); continue; }

    m = trimmed.match(/^([A-Z]{4})\s/);
    if (m && !['AAXX', 'BBXX', 'CCXX'].includes(m[1])) { sandis.push(m[1]); continue; }

    m = trimmed.match(/^([A-Z0-9]{5})\s/);
    if (m && /^\d{5}$/.test(m[1])) sandis.push(m[1]);
  }

  return [...new Set(sandis)];
}

// ═══════════════════════════════════════════════════════════════════
// TEST KONEKSI BRIDGE
// ═══════════════════════════════════════════════════════════════════
async function testBridgeConnection() {
  if (!CONFIG.BRIDGE_URL) {
    showToast("Bridge URL tidak dikonfigurasi", "warn");
    return false;
  }

  showToast("Mengecek koneksi bridge...", "info");

  try {
    console.log(`Testing bridge at: ${CONFIG.BRIDGE_URL}/check`);

    const res = await fetch(`${CONFIG.BRIDGE_URL}/check`, {
      method:  "GET",
      headers: bridgeHeaders(),
      signal:  AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const data = await res.json();
      console.log("Bridge check response:", data);

      let statusMsg = "";
      if (data.ftp1 && data.ftp2)       statusMsg = "✅ Bridge online - FTP Main & InaSwitching OK";
      else if (data.ftp1)               statusMsg = "✅ Bridge online - Hanya FTP Main tersedia";
      else if (data.ftp2)               statusMsg = "✅ Bridge online - Hanya InaSwitching tersedia";
      else                              statusMsg = "⚠️ Bridge online tapi kedua FTP offline";

      showToast(statusMsg, data.ftp1 || data.ftp2 ? "success" : "warn");
      return data.ftp1 || data.ftp2;
    } else {
      showToast(`Bridge response error: ${res.status}`, "error");
      return false;
    }
  } catch (err) {
    console.error("Bridge test failed:", err);

    if (err.name === "AbortError") {
      showToast("❌ Timeout: Bridge tidak merespons dalam 8 detik", "error");
    } else if (err.message === "Failed to fetch" || err.name === "TypeError") {
      showToast("❌ CORS / Network Error — cek console untuk detail", "error");
      console.error("💡 Kemungkinan CORS atau cloudflare block. Pastikan bridge sudah restart dan URL sudah diupdate.");
    } else {
      showToast(`❌ Gagal konek ke bridge: ${err.message}`, "error");
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FTP STATUS
// ═══════════════════════════════════════════════════════════════════
async function checkFTP() {
  setFTPUI("checking", "checking");

  if (CONFIG.BRIDGE_URL) {
    let bridgeAttempt = 0;
    while (bridgeAttempt < 2) {
      try {
        bridgeAttempt++;
        console.log(`[checkFTP] Bridge attempt ${bridgeAttempt}/2: ${CONFIG.BRIDGE_URL}/check`);

        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(`${CONFIG.BRIDGE_URL}/check`, {
          method:  "GET",
          headers: bridgeHeaders(),
          signal:  controller.signal,
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          console.log("[checkFTP] Bridge response OK:", data);

          const wasFtpUp = ftpStatus.ftp1 || ftpStatus.ftp2;

          ftpStatus = {
            ftp1: data.ftp1 === true,
            ftp2: data.ftp2 === true,
          };

          const isFtpUpNow = ftpStatus.ftp1 || ftpStatus.ftp2;

          setFTPUI(
            ftpStatus.ftp1 ? "up" : "down",
            ftpStatus.ftp2 ? "up" : "down"
          );

          isVercel = true;

          const el = document.getElementById("retry-countdown");
          if (el && !ftpStatus.ftp1 && !ftpStatus.ftp2) {
            el.textContent = "⚠️ Kedua FTP offline";
          } else if (el) {
            el.textContent = "";
          }

          if (!wasFtpUp && isFtpUpNow) {
            console.log("[checkFTP] FTP just came online, checking for pending items...");
            handleFTPOnline();
          }

          return isFtpUpNow;
        } else {
          console.error(`[checkFTP] Bridge response error: ${res.status}`);
          if (bridgeAttempt < 2) continue;
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        console.error(`[checkFTP] Bridge attempt ${bridgeAttempt} failed:`, err.message);
        if (bridgeAttempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }
    }
  }

  // Fallback ke Vercel serverless
  try {
    console.log("[checkFTP] Fallback: trying Vercel serverless");
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${CONFIG.API}?action=check_ftp`, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`Vercel returned ${res.status}`);
    const data = await res.json();

    console.log("[checkFTP] Vercel response:", data);
    ftpStatus = { ftp1: data.ftp1, ftp2: data.ftp2 };
    setFTPUI(data.ftp1 ? "up" : "down", data.ftp2 ? "up" : "down");
    isVercel = true;
    return data.ftp1 || data.ftp2;
  } catch (err) {
    console.error("[checkFTP] Fallback failed:", err.message);
    isVercel = false;
    setFTPUI("down", "down");
    const el = document.getElementById("retry-countdown");
    if (el) el.textContent = "⚠️ Tidak terhubung ke bridge & Vercel";
    return false;
  }
}

function setFTPUI(s1, s2) {
  const labels = { up: "Online", down: "Offline", checking: "Mengecek..." };
  const dot1   = document.getElementById("dot-ftp1");
  const dot2   = document.getElementById("dot-ftp2");
  const t1     = document.getElementById("text-ftp1");
  const t2     = document.getElementById("text-ftp2");
  if (dot1) dot1.className = `dot ${s1}`;
  if (dot2) dot2.className = `dot ${s2}`;
  if (t1)   t1.textContent = labels[s1] || s1;
  if (t2)   t2.textContent = labels[s2] || s2;

  ["sb-ftp1","sb-ftp2"].forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    const st = i === 0 ? s1 : s2;
    el.className = `status-value ${st === "up" ? "online" : "offline"}`;
    if (el.querySelector("span")) {
      el.querySelector("span").textContent = st === "up" ? "Online" : "Offline";
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// PROCESS & SEND
// ═══════════════════════════════════════════════════════════════════
async function processAndSend(rawText, userInput = "anonymous") {
  if (!rawText.trim()) { showToast("Input kosong!", "warn"); return; }

  const cleaned   = cleanWhatsAppMessages(rawText);
  const sandiList = extractSandiList(cleaned);
  const fileName  = generateFileName();

  showToast(`${sandiList.length} sandi ditemukan — menyimpan...`, "info");
  setLoading(true);

  try {
    // ── A. Simpan ke Supabase langsung dari browser ───────────────
    const historyRow = {
      filename:         fileName,
      content:          cleaned,
      original_content: rawText,
      status:           "pending",
      file_size:        new Blob([cleaned]).size,
      lines_count:      cleaned.split("\n").length,
      sandi_count:      sandiList.length,
      sandi_list:       sandiList,
      user_input:       userInput || "anonymous",
      note:             "Disimpan, menunggu FTP...",
      ftp_target:       "",
    };

    const inserted  = await sb.insert("upload_history", historyRow);
    const historyId = inserted?.[0]?.id;

    // Simpan tiap sandi ke gts_messages
    for (const sandi of sandiList) {
      await sb.insert("gts_messages", {
        sandi_gts:      sandi,
        timestamp_data: new Date().toISOString(),
        status_ftp:     0,
        user_input:     userInput || "anonymous",
      }).catch(() => {});
    }

    // ── B. Kirim ke FTP via bridge ────────────────────────────────
    let ftpSuccess = false;
    let ftpTarget  = "";

    if (CONFIG.BRIDGE_URL) {
      try {
        console.log(`Mencoba mengirim ke bridge: ${CONFIG.BRIDGE_URL}/upload`);

        const res = await fetch(`${CONFIG.BRIDGE_URL}/upload`, {
          method:  "POST",
          headers: bridgeHeaders(true),
          body:    JSON.stringify({ content: cleaned, fileName }),
          signal:  AbortSignal.timeout(15000),
        });

        if (res.ok) {
          const data = await res.json();
          console.log("Bridge response:", data);

          if (data.ok === true || data.ok === undefined) {
            ftpSuccess = true;
            ftpTarget  = data.target || (
              data.ftp1 && data.ftp2 ? "both" :
              data.ftp1 ? "main" :
              data.ftp2 ? "inaswitching" : "FTP Server"
            );

            if (historyId) {
              await sb.update("upload_history", historyId, {
                status:     "success",
                note:       `Uploaded ke FTP (${ftpTarget})`,
                ftp_target: ftpTarget,
              });
            }
            showToast(`✅ Terkirim ke ${ftpTarget} — ${fileName}`, "success");
            stopRetry();
          } else {
            console.error("Bridge error:", data);
            showToast(`⚠️ ${data.message || "Gagal mengirim ke FTP"} — data tersimpan pending.`, "warn");
            startRetry();
          }
        } else {
          const errorText = await res.text();
          console.error(`Bridge HTTP ${res.status}:`, errorText);
          showToast(`⚠️ Bridge error (${res.status}) — data tersimpan pending.`, "warn");
          startRetry();
        }
      } catch (e) {
        console.error("Bridge connection error:", e);
        if (e.name === "AbortError") {
          showToast("⚠️ Bridge timeout — data tersimpan pending.", "warn");
        } else {
          showToast(`⚠️ Tidak bisa konek ke bridge: ${e.message} — data tersimpan pending.`, "warn");
        }
        startRetry();
      }
    } else {
      showToast("⚠️ Bridge URL tidak dikonfigurasi — data tersimpan di Supabase (pending).", "warn");
      startRetry();
    }

    loadHistory();
    updateQueueBadge();

  } catch (err) {
    showToast("❌ Error: " + err.message, "error");
    console.error(err);
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════════════════════════════
// RETRY PENDING
// ═══════════════════════════════════════════════════════════════════
async function handleFTPOnline() {
  if (!isVercel) return;

  try {
    const pending = await sb.select("upload_history", "select=id&status=eq.pending");
    if (!pending?.length) {
      console.log("[Auto-Retry] No pending items to send");
      stopRetry();
      return;
    }

    console.log(`[Auto-Retry] Found ${pending.length} pending items, starting auto-send...`);
    showToast(`🚀 FTP sudah online! Mengirim ${pending.length} file yang pending...`, "info");

    stopRetry();
    await retryPending();
  } catch (err) {
    console.error("[Auto-Retry] Error:", err);
  }
}

async function retryPending() {
  if (!CONFIG.BRIDGE_URL && !isVercel) {
    showToast("ℹ️ Tidak ada bridge maupun Vercel untuk retry.", "info");
    return;
  }

  const ftpUp = await checkFTP();
  if (!ftpUp) { showToast("FTP masih offline.", "warn"); return; }

  const pending = await sb.select("upload_history", "select=*&status=eq.pending&order=created_at.asc&limit=100");
  if (!pending?.length) { showToast("Tidak ada antrian pending.", "info"); return; }

  console.log(`[retryPending] Starting to send ${pending.length} items...`);
  showToast(`Mengirim ulang ${pending.length} item...`, "info");

  let success = 0;
  let failed  = [];

  for (const item of pending) {
    try {
      console.log(`[retryPending] Sending item ${item.id}: ${item.filename}`);

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 30000);

      let res;

      // ── Prioritas: Bridge dulu, baru Vercel serverless ──
      if (CONFIG.BRIDGE_URL) {
        console.log(`[retryPending] Using BRIDGE: ${CONFIG.BRIDGE_URL}/upload`);
        res = await fetch(`${CONFIG.BRIDGE_URL}/upload`, {
          method:  "POST",
          headers: bridgeHeaders(true),
          body:    JSON.stringify({ content: item.content, fileName: item.filename }),
          signal:  controller.signal,
        });
      } else {
        console.log(`[retryPending] Using VERCEL: ${CONFIG.API}?action=retry`);
        res = await fetch(`${CONFIG.API}?action=retry`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ historyId: item.id, content: item.content, fileName: item.filename }),
          signal:  controller.signal,
        });
      }

      clearTimeout(timeoutId);

      if (res.ok) {
        const d = await res.json();
        if (d.ok || d.ftp1 || d.ftp2) {
          console.log(`[retryPending] ✅ Item ${item.id} sent successfully`);
          
          // Update status di Supabase
          const ftpTarget = d.target || (
            d.ftp1 && d.ftp2 ? "both" :
            d.ftp1 ? "main" :
            d.ftp2 ? "inaswitching" : "FTP Server"
          );
          await sb.update("upload_history", item.id, {
            status:     "success",
            note:       `Retry sukses via ${CONFIG.BRIDGE_URL ? 'bridge' : 'vercel'} (${ftpTarget})`,
            ftp_target: ftpTarget,
          });
          
          success++;
        } else {
          console.warn(`[retryPending] ❌ Item ${item.id} FTP failed:`, d);
          failed.push(item.filename);
        }
      } else {
        console.error(`[retryPending] ❌ Item ${item.id} HTTP ${res.status}`);
        failed.push(item.filename);
      }
    } catch (err) {
      console.error(`[retryPending] ❌ Item error:`, err.message);
      failed.push(item.filename);
    }
  }

  console.log(`[retryPending] Done: ${success}/${pending.length} success, ${failed.length} failed`);
  showToast(`✅ ${success} dari ${pending.length} berhasil dikirim ulang.`, "success");
  if (failed.length > 0) console.warn(`[retryPending] Failed items:`, failed);
  if (success === pending.length) stopRetry();
  loadHistory();
  updateQueueBadge();
}

async function retrySingleItem(item) {
  if (!CONFIG.BRIDGE_URL && !isVercel) {
    showToast("❌ Tidak ada bridge maupun Vercel untuk retry.", "error");
    return false;
  }

  const ftpUp = await checkFTP();
  if (!ftpUp) {
    showToast("❌ FTP masih offline. Silakan coba lagi nanti.", "warn");
    return false;
  }

  try {
    console.log(`[Retry] Attempting to send item ${item.id}...`);

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 30000);

    let res;

    // ── Prioritas: Bridge dulu, baru Vercel serverless ──
    if (CONFIG.BRIDGE_URL) {
      console.log(`[Retry] Using BRIDGE: ${CONFIG.BRIDGE_URL}/upload`);
      res = await fetch(`${CONFIG.BRIDGE_URL}/upload`, {
        method:  "POST",
        headers: bridgeHeaders(true),
        body:    JSON.stringify({ content: item.content, fileName: item.filename }),
        signal:  controller.signal,
      });
    } else {
      console.log(`[Retry] Using VERCEL: ${CONFIG.API}?action=retry`);
      res = await fetch(`${CONFIG.API}?action=retry`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ historyId: item.id, content: item.content, fileName: item.filename }),
        signal:  controller.signal,
      });
    }

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[Retry] Server error: ${res.status}`);
      showToast(`❌ Server error: ${res.status}`, "error");
      return false;
    }

    const d = await res.json();
    console.log(`[Retry] Response:`, d);

    if (d.ok || d.ftp1 || d.ftp2) {
      const ftpTarget = d.target || (
        d.ftp1 && d.ftp2 ? "both" :
        d.ftp1 ? "main" :
        d.ftp2 ? "inaswitching" : "FTP Server"
      );
      showToast(`✅ Berhasil dikirim ulang ke FTP (${ftpTarget})!`, "success");
      item.status     = "success";
      item.note       = `Retry sukses via ${CONFIG.BRIDGE_URL ? 'bridge' : 'vercel'} (${ftpTarget})`;
      item.ftp_target = ftpTarget;
      
      // Update Supabase
      await sb.update("upload_history", item.id, {
        status:     "success",
        note:       item.note,
        ftp_target: ftpTarget,
      });
      
      loadHistory();
      updateQueueBadge();
      return true;
    } else {
      let errorMsg = "FTP upload gagal";
      if (!d.ftp1 && !d.ftp2)      errorMsg = "Kedua FTP offline";
      else if (!d.ftp1 && d.ftp2)  errorMsg = "FTP Main gagal (InaSwitching OK)";
      else if (d.ftp1 && !d.ftp2)  errorMsg = "InaSwitching gagal (FTP Main OK)";
      showToast(`❌ ${errorMsg}`, "error");
      return false;
    }
  } catch (err) {
    console.error(`[Retry] Request error:`, err);
    showToast(`❌ Error: ${err.message}`, "error");
    return false;
  }
}

function startRetry() {
  stopRetry();
  retrySeconds = CONFIG.RETRY_INTERVAL / 1000;

  const el = document.getElementById("retry-countdown");
  if (el) el.textContent = `Akan retry dalam ${Math.floor(CONFIG.RETRY_INTERVAL / 60000)} menit...`;

  cdTimer = setInterval(() => {
    retrySeconds--;
    const m  = Math.floor(retrySeconds / 60);
    const s  = retrySeconds % 60;
    const el = document.getElementById("retry-countdown");
    if (el) el.textContent = `Akan retry dalam ${m}:${String(s).padStart(2,"0")}`;
    if (retrySeconds <= 0) stopRetry();
  }, 1000);

  retryTimer = setTimeout(async () => {
    console.log("[Retry] Checking FTP status...");
    const up = await checkFTP();
    if (up) {
      console.log("[Retry] FTP online, attempting to send pending items...");
      await retryPending();
    } else {
      console.log("[Retry] FTP still offline, will retry again...");
      startRetry();
    }
  }, CONFIG.RETRY_INTERVAL);
}

function stopRetry() {
  clearTimeout(retryTimer);
  clearInterval(cdTimer);
  const el = document.getElementById("retry-countdown");
  if (el) el.textContent = "";
}

// ═══════════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════════
async function loadHistory() {
  const search = document.getElementById("filter-search")?.value || "";
  const status = document.getElementById("filter-status")?.value || "";
  const date   = document.getElementById("filter-date")?.value   || "";

  const listEl = document.getElementById("history-list");
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty-state"><div class="spinner"></div><p>Memuat...</p></div>`;

  try {
    let params = "select=*&order=created_at.desc&limit=50";
    if (status) params += `&status=eq.${status}`;
    if (date)   params += `&created_at=gte.${date}T00:00:00&created_at=lte.${date}T23:59:59`;
    if (search) params += `&or=(filename.ilike.*${encodeURIComponent(search)}*,user_input.ilike.*${encodeURIComponent(search)}*)`;

    const data = await sb.select("upload_history", params);
    renderHistory(data || []);
    updateQueueBadge((data||[]).filter(d => d.status === "pending").length);
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><p>❌ Gagal memuat: ${err.message}</p><p style="font-size:11px;margin-top:8px">Pastikan RLS policy sudah diatur di Supabase</p></div>`;
  }
}

function renderHistory(items) {
  const listEl = document.getElementById("history-list");
  if (!listEl) return;

  if (!items.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>Tidak ada data.</p></div>`;
    return;
  }

  listEl.innerHTML = items.map(item => {
    const sandiList = Array.isArray(item.sandi_list) ? item.sandi_list : [];
    return `
    <div class="history-item status-${item.status}" onclick='showHistoryDetail(${JSON.stringify(item).replace(/'/g, "&#39;")})'>
      <div class="item-header">
        <div class="item-status">
          <i class="fas fa-${item.status === "success" ? "check-circle" : "clock"}"></i>
          <span class="status-text">${item.status === "success" ? "Terkirim" : "Pending"}</span>
          ${sandiList.length ? `<span class="badge-info">${sandiList.length} sandi</span>` : ""}
          <span class="badge-user"><i class="fas fa-user"></i> ${escHtml(item.user_input || "-")}</span>
          ${item.ftp_target ? `<span class="badge-ftp">FTP: ${item.ftp_target}</span>` : ""}
        </div>
        <div class="item-time"><i class="far fa-clock"></i> ${formatDate(item.created_at)}</div>
      </div>
      <div class="item-content">
        <div class="filename"><i class="far fa-file"></i> ${escHtml(item.filename)}</div>
        <div class="preview">${escHtml((item.content || "").slice(0, 150))}${(item.content||"").length > 150 ? "..." : ""}</div>
      </div>
      <div class="item-footer">
        <div class="item-meta">
          <span><i class="fas fa-bars"></i> ${item.lines_count} lines</span>
          <span><i class="fas fa-hdd"></i> ${((item.file_size||0)/1024).toFixed(2)} KB</span>
          <span>${sandiList.slice(0,3).join(", ")}${sandiList.length > 3 ? "..." : ""}</span>
        </div>
        <span class="note">${escHtml(item.note || "")}</span>
      </div>
    </div>`;
  }).join("");
}

function showHistoryDetail(item) {
  const modal = document.getElementById("log-modal");
  if (!modal) return;
  const sandiList = Array.isArray(item.sandi_list) ? item.sandi_list : [];

  const timeEl     = modal.querySelector("#detail-time");
  const filenameEl = modal.querySelector("#detail-filename");
  const statusEl   = modal.querySelector("#detail-status");
  const sizeEl     = modal.querySelector("#detail-size");
  const linesEl    = modal.querySelector("#detail-lines");
  const noteEl     = modal.querySelector("#detail-note");
  const userEl     = modal.querySelector("#detail-user");
  const ftpEl      = modal.querySelector("#detail-ftp");
  const sandiEl    = modal.querySelector("#detail-sandi");
  const contentEl  = modal.querySelector("#detail-content");

  if (timeEl)     timeEl.textContent     = formatDate(item.created_at);
  if (filenameEl) filenameEl.textContent = item.filename;
  if (statusEl) {
    statusEl.textContent = item.status?.toUpperCase();
    statusEl.className   = `status-${item.status}`;
  }
  if (sizeEl)    sizeEl.textContent    = `${((item.file_size||0)/1024).toFixed(2)} KB`;
  if (linesEl)   linesEl.textContent   = `${item.lines_count} lines`;
  if (noteEl)    noteEl.textContent    = item.note || "-";
  if (userEl)    userEl.textContent    = item.user_input || "-";
  if (ftpEl)     ftpEl.textContent     = item.ftp_target || "-";
  if (sandiEl)   sandiEl.textContent   = sandiList.join(", ") || "-";
  if (contentEl) contentEl.textContent = item.content || "";

  const delBtn   = modal.querySelector("#detail-delete-btn");
  const retryBtn = modal.querySelector("#detail-retry-btn");

  if (delBtn) delBtn.onclick = () => deleteHistory(item.id);

  if (retryBtn) {
    retryBtn.style.display = item.status === "pending" ? "inline-flex" : "none";
    retryBtn.disabled      = false; // Always enabled now because we use Bridge as priority
    retryBtn.title         = "Kirim ulang ke FTP";
    retryBtn.onclick       = async () => {
      retryBtn.disabled = true;
      retryBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Mengirim...`;
      const success = await retrySingleItem(item);
      if (success) {
        closeModal("log-modal");
      } else {
        retryBtn.disabled  = false;
        retryBtn.innerHTML = `<i class="fas fa-redo"></i> Kirim Ulang`;
      }
    };
  }

  openModal("log-modal");
}

async function deleteHistory(id) {
  if (!confirm("Hapus item ini dari database?")) return;
  await sb.delete("upload_history", id);
  closeModal("log-modal");
  showToast("Item dihapus.", "info");
  loadHistory();
}

async function updateQueueBadge(count = null) {
  if (count === null) {
    try {
      const data = await sb.select("upload_history", "select=id&status=eq.pending");
      count = (data || []).length;
    } catch { count = 0; }
  }
  const badge = document.getElementById("badge-queue");
  if (badge) {
    badge.textContent    = count;
    badge.style.display  = count > 0 ? "inline-block" : "none";
  }
}

// ═══════════════════════════════════════════════════════════════════
// PREVIEW & EDIT
// ═══════════════════════════════════════════════════════════════════
function openPreview() {
  const raw = document.getElementById("gts-input")?.value || "";
  if (!raw.trim()) { showToast("Input kosong!", "warn"); return; }

  previewOriginal = raw;
  previewCleaned  = cleanWhatsAppMessages(raw);

  const origEl = document.getElementById("preview-original");
  if (origEl) origEl.textContent = previewOriginal;
  setPreviewStats("original", previewOriginal);

  const cleanEl = document.getElementById("preview-cleaned");
  if (cleanEl) cleanEl.textContent = previewCleaned;
  setPreviewStats("cleaned", previewCleaned);

  const editEl = document.getElementById("preview-editable");
  if (editEl) {
    editEl.value   = previewCleaned;
    editEl.oninput = () => setPreviewStats("editable", editEl.value);
  }
  setPreviewStats("editable", previewCleaned);

  switchPreviewTab("cleaned");
  openModal("preview-modal");
}

function setPreviewStats(prefix, text) {
  const chars = document.getElementById(`${prefix}-chars`);
  const lines = document.getElementById(`${prefix}-lines`);
  if (chars) chars.textContent = text.length;
  if (lines) lines.textContent = text.split("\n").length;
}

function switchPreviewTab(tab) {
  document.querySelectorAll(".preview-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".preview-content").forEach(c => c.classList.remove("active"));
  const tabBtn  = document.querySelector(`.preview-tab[data-tab="${tab}"]`);
  const content = document.getElementById(`preview-content-${tab}`);
  if (tabBtn)  tabBtn.classList.add("active");
  if (content) content.classList.add("active");
}

async function sendFromPreview() {
  const editEl    = document.getElementById("preview-editable");
  const userInput = document.getElementById("user-input-field")?.value || "anonymous";
  const text      = editEl?.value || previewCleaned;
  closeModal("preview-modal");
  await processAndSend(text, userInput);
}

async function sendDirect() {
  const raw       = document.getElementById("gts-input")?.value || "";
  const userInput = document.getElementById("user-input-field")?.value || "anonymous";
  await processAndSend(raw, userInput);
}

// ═══════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll(".page-section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  const section = document.getElementById(`section-${tab}`);
  const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (section) section.classList.add("active");
  if (navItem) navItem.classList.add("active");
  currentPage = tab;
  const subtitle = document.getElementById("header-subtitle");
  if (subtitle) subtitle.textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
  if (tab === "history")   loadHistory();
  if (tab === "dashboard") { checkFTP(); updateQueueBadge(); }
  if (tab === "report")    { loadReportData(); }
  if (tab === "session")   { refreshSessionData(); }
}

function openModal(id) {
  const m = document.getElementById(id);
  if (m) { m.style.display = "flex"; document.body.style.overflow = "hidden"; }
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) { m.style.display = "none"; document.body.style.overflow = ""; }
}

function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem("ddk_theme", theme);
  document.documentElement.setAttribute("data-theme", theme);
  const icon = document.getElementById("theme-icon");
  if (icon) icon.className = `fas ${theme === "dark" ? "fa-sun" : "fa-moon"}`;
}

function setLoading(on) {
  const btn = document.getElementById("send-btn");
  if (btn) {
    btn.disabled  = on;
    btn.innerHTML = on
      ? `<i class="fas fa-spinner fa-spin"></i> Mengirim...`
      : `<i class="fas fa-paper-plane"></i> Kirim ke FTP`;
  }
}

function updateClock() {
  const str = new Date().toLocaleTimeString("id-ID");
  document.querySelectorAll(".clock").forEach(el => el.textContent = str);
}

function updateCharCounter() {
  const ta = document.getElementById("gts-input");
  const cc = document.getElementById("char-count");
  const lc = document.getElementById("line-count");
  if (!ta) return;
  if (cc) cc.textContent = ta.value.length;
  if (lc) lc.textContent = ta.value.split("\n").length;
}

function copyText(id) {
  const el   = document.getElementById(id);
  const text = el?.textContent || el?.value || "";
  navigator.clipboard.writeText(text).then(() => showToast("Disalin!", "success"));
}

function showToast(msg, type = "info") {
  const existing = document.querySelector(".toast:not(#auto-toast)");
  if (existing) existing.remove();

  const icons = { success: "check-circle", error: "exclamation-circle", warn: "exclamation-triangle", info: "info-circle" };
  const t     = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i class="fas fa-${icons[type]||"info-circle"}"></i><span>${msg}</span><button onclick="this.parentElement.remove()">×</button>`;
  document.body.appendChild(t);
  setTimeout(() => t?.remove(), 5000);
}

function escHtml(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
}

async function testSupabaseConnection() {
  try {
    console.log('Testing Supabase connection...');
    const test = await sb.select('upload_history', 'limit=1');
    console.log('✅ Supabase connected!', test);
    showToast('✅ Koneksi Supabase berhasil', 'success');
    return true;
  } catch (err) {
    console.error('❌ Supabase connection failed:', err);
    showToast('⚠️ Gagal konek ke Supabase. Periksa RLS policies.', 'error');
    return false;
  }
}

function addTestButton() {
  const dashboard = document.getElementById("section-dashboard");
  if (dashboard) {
    const existingBtn = document.getElementById("test-bridge-btn");
    if (existingBtn) return;

    const testBtn      = document.createElement("button");
    testBtn.id         = "test-bridge-btn";
    testBtn.innerHTML  = '<i class="fas fa-plug"></i> Test Bridge';
    testBtn.className  = "btn-secondary";
    testBtn.style.marginLeft = "10px";
    testBtn.onclick    = testBridgeConnection;

    const sendBtn = document.getElementById("send-btn");
    if (sendBtn && sendBtn.parentNode) {
      sendBtn.parentNode.insertBefore(testBtn, sendBtn.nextSibling);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// MOBILE FEATURES
// ═══════════════════════════════════════════════════════════════════
function initMobileFeatures() {
  const sidebar        = document.querySelector('.sidebar');
  const menuToggle     = document.getElementById('menu-toggle');
  const sidebarOverlay = document.getElementById('sidebar-overlay');

  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sidebar.classList.toggle('open');
      if (sidebarOverlay) {
        sidebarOverlay.style.display = sidebar.classList.contains('open') ? 'block' : 'none';
      }
    });

    if (sidebarOverlay) {
      sidebarOverlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        sidebarOverlay.style.display = 'none';
      });
    }

    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          setTimeout(() => {
            sidebar.classList.remove('open');
            if (sidebarOverlay) sidebarOverlay.style.display = 'none';
          }, 150);
        }
      });
    });

    document.addEventListener('click', (e) => {
      if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
        if (!sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
          sidebar.classList.remove('open');
          if (sidebarOverlay) sidebarOverlay.style.display = 'none';
        }
      }
    });

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : '';
        }
      });
    });
    observer.observe(sidebar, { attributes: true });
  }

  let touchStart  = 0;
  let touchStartY = 0;
  const contentArea = document.querySelector('.content-area');

  if (contentArea) {
    contentArea.addEventListener('touchstart', (e) => {
      touchStart  = e.touches[0].clientY;
      touchStartY = contentArea.scrollTop;
    });

    contentArea.addEventListener('touchmove', (e) => {
      const touchEnd = e.touches[0].clientY;
      const diff     = touchEnd - touchStart;

      if (diff > 60 && touchStartY === 0 && currentPage === 'dashboard') {
        e.preventDefault();
        const refreshIndicator             = document.createElement('div');
        refreshIndicator.className         = 'pull-to-refresh';
        refreshIndicator.innerHTML         = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing...';
        refreshIndicator.style.position   = 'fixed';
        refreshIndicator.style.top        = '10px';
        refreshIndicator.style.left       = '50%';
        refreshIndicator.style.transform  = 'translateX(-50%)';
        refreshIndicator.style.background = 'var(--primary)';
        refreshIndicator.style.color      = 'white';
        refreshIndicator.style.padding    = '8px 16px';
        refreshIndicator.style.borderRadius = '20px';
        refreshIndicator.style.zIndex     = '9999';
        refreshIndicator.style.fontSize   = '12px';
        document.body.appendChild(refreshIndicator);

        checkFTP();
        updateQueueBadge();
        showToast('🔄 Refreshing data...', 'info');

        setTimeout(() => { refreshIndicator.remove(); }, 1000);
        touchStart = 0;
      }
    });
  }

  const modals = document.querySelectorAll('.modal-overlay');
  modals.forEach(modal => {
    let modalTouchStart = 0;
    const modalBox      = modal.querySelector('.modal-box');

    if (modalBox && window.innerWidth <= 768) {
      modalBox.addEventListener('touchstart', (e) => {
        modalTouchStart = e.touches[0].clientY;
      });
      modalBox.addEventListener('touchmove', (e) => {
        const touchEnd = e.touches[0].clientY;
        const diff     = touchEnd - modalTouchStart;
        if (diff > 50) closeModal(modal.id);
      });
    }
  });

  const inputs = document.querySelectorAll('input, textarea, select');
  inputs.forEach(input => {
    input.addEventListener('focus', () => {
      if (window.innerWidth <= 768) {
        setTimeout(() => {
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
      }
    });
  });

  const touchElements = document.querySelectorAll('button, .nav-item, .action-btn, .history-item');
  touchElements.forEach(el => {
    el.addEventListener('touchstart',  () => { el.classList.add('touch-active'); });
    el.addEventListener('touchend',    () => { setTimeout(() => el.classList.remove('touch-active'), 100); });
    el.addEventListener('touchcancel', () => { el.classList.remove('touch-active'); });
  });
}

// CSS untuk touch feedback
const touchFeedbackStyle     = document.createElement('style');
touchFeedbackStyle.textContent = `
  .touch-active {
    opacity: 0.7;
    transform: scale(0.97);
    transition: transform 0.05s, opacity 0.05s;
  }
  .pull-to-refresh {
    animation: slideDown 0.3s ease;
  }
  @keyframes slideDown {
    from { transform: translate(-50%, -100%); opacity: 0; }
    to   { transform: translate(-50%, 0);     opacity: 1; }
  }
  @media (max-width: 768px) {
    .modal-box { animation: slideUp 0.3s ease; }
    @keyframes slideUp {
      from { transform: translateY(100%); }
      to   { transform: translateY(0);    }
    }
  }
`;
document.head.appendChild(touchFeedbackStyle);

// ═══════════════════════════════════════════════════════════════════
// CHECK REPORT DATABASE (via BRIDGE REPORT - server terpisah)
// ═══════════════════════════════════════════════════════════════════

// Store current report data globally
let currentReportData = { rows: [], latency: 0 };

async function loadReportData() {
  const listEl = document.getElementById("report-list");
  const countEl = document.getElementById("report-count");
  const latencyEl = document.getElementById("report-latency");
  const deleteAllBtn = document.getElementById("delete-all-reports-btn");
  
  if (!listEl) return;
  
  // Show loading state
  listEl.innerHTML = `<div class="empty-state"><div class="spinner"></div><p>Memuat data dari database report...</p></div>`;
  
  // Check if report bridge is available
  if (!CONFIG.BRIDGE_REPORT_URL) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>Bridge Report URL tidak dikonfigurasi.<br/>Pastikan pg-agent.js running di server report dan cloudflared tunnel aktif.</p></div>`;
    return;
  }
  
  try {
    console.log(`[Report] Fetching from REPORT BRIDGE: ${CONFIG.BRIDGE_REPORT_URL}/query`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(`${CONFIG.BRIDGE_REPORT_URL}/query`, {
      method: "GET",
      headers: bridgeHeaders(true, true),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
    }
    
    const data = await response.json();
    console.log("[Report] Response from report bridge:", data);
    
    if (!data.ok) {
      throw new Error(data.error || "Unknown error from report bridge");
    }
    
    // Store data globally
    currentReportData = {
      rows: data.rows || [],
      latency: data.latency || 0
    };
    
    // Update stats
    const rowCount = data.rows?.length || 0;
    if (countEl) countEl.textContent = rowCount;
    if (latencyEl) latencyEl.textContent = data.latency || "-";
    
    // Show/hide delete all button
    if (deleteAllBtn) {
      deleteAllBtn.style.display = rowCount > 0 ? "inline-flex" : "none";
    }
    
    // Render report list as TABLE
    renderReportTable(data.rows || []);
    
    // Update badge
    const badge = document.getElementById("badge-report");
    if (badge) {
      badge.textContent = rowCount;
      badge.style.display = rowCount > 0 ? "inline-block" : "none";
    }
    
    if (rowCount === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>Tidak ada data dengan at_flag = 1</p></div>`;
    }
    
  } catch (err) {
    console.error("[Report] Error:", err);
    
    let errorMsg = err.message;
    if (err.name === "AbortError") {
      errorMsg = "Timeout: Bridge Report tidak merespons dalam 15 detik";
    } else if (err.message === "Failed to fetch") {
      errorMsg = "Tidak dapat terhubung ke Bridge Report. Pastikan pg-agent.js running dan tunnel aktif.";
    }
    
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">❌</div>
        <p>Gagal memuat data dari Report Bridge</p>
        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 8px;">${errorMsg}</p>
        <button class="btn btn-primary" style="margin-top: 16px;" onclick="loadReportData()">
          <i class="fas fa-redo"></i> Coba Lagi
        </button>
      </div>
    `;
  }
}

function getAgeClass(createdAt) {
  if (!createdAt) return '';
  
  const created = new Date(createdAt);
  const now = new Date();
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const diffMonths = diffDays / 30;
  
  if (diffDays >= 365) {
    return 'age-1year';
  } else if (diffMonths >= 1) {
    return 'age-1month';
  }
  return '';
}

function renderReportTable(rows) {
  const listEl = document.getElementById("report-list");
  if (!listEl) return;
  
  if (!rows || rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>Tidak ada data dengan at_flag = 1</p></div>`;
    return;
  }
  
  const tableHtml = `
    <div class="legend-box">
      <span class="legend-color age-1year"></span> ≥ 1 tahun (merah)
      <span class="legend-color age-1month" style="margin-left:16px;"></span> ≥ 1 bulan (oranye)
      <span class="legend-color" style="background:transparent;border:1px solid var(--border);"></span> < 1 bulan (normal)
    </div>
    <div class="table-responsive">
      <table class="report-table">
        <thead>
          <tr>
            <th width="50">ID</th>
            <th width="70">Action</th>
            <th width="180">Created At</th>
            <th width="180">Updated At</th>
            <th width="80">Status</th>
            <th>Content Preview</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => {
            const createdAt = row.at_create ? new Date(row.at_create).toLocaleString("id-ID") : "-";
            const updatedAt = row.at_update ? new Date(row.at_update).toLocaleString("id-ID") : "-";
            const content = row.req_content || "-";
            const contentPreview = content.length > 100 ? content.substring(0, 100) + "..." : content;
            const ageClass = getAgeClass(row.at_create);
            const escapedContent = escHtml(content).replace(/"/g, '&quot;');
            
            return `
              <tr class="${ageClass}" data-id="${row.id}">
                <td><code>${row.id}</code></td>
                <td>
                  <button class="btn btn-danger btn-icon-sm" onclick="deleteReportItem(${row.id})" title="Hapus data">
                    <i class="fas fa-times"></i>
                  </button>
                 </td>
                <td><small>${createdAt}</small></td>
                <td><small>${updatedAt}</small></td>
                <td>
                  <span class="status-badge status-${row.req_status === 1 ? 'success' : 'pending'}">
                    ${row.req_status || 0}
                  </span>
                 </td>
                <td>
                  <div class="content-preview" title="${escapedContent}">
                    ${escHtml(contentPreview)}
                  </div>
                  <button class="btn-link" onclick="viewFullContent(${row.id})">Lihat lengkap</button>
                 </td>
               </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  
  listEl.innerHTML = tableHtml;
}

async function deleteReportItem(id, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  
  if (!confirm(`Hapus data dengan ID ${id}?\n\nData akan dihapus permanen dari database.`)) return;
  
  if (!CONFIG.BRIDGE_REPORT_URL) {
    showToast("Bridge Report URL tidak dikonfigurasi", "error");
    return;
  }
  
  try {
    showToast(`Menghapus ID ${id}...`, "info");
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(`${CONFIG.BRIDGE_REPORT_URL}/delete`, {
      method: "POST",
      headers: bridgeHeaders(true, true),
      body: JSON.stringify({ id: String(id) }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.ok) {
      showToast(`✅ Berhasil menghapus ID ${id}`, "success");
      await loadReportData();
    } else {
      throw new Error(data.error || "Delete failed");
    }
    
  } catch (err) {
    console.error("[Delete] Error:", err);
    showToast(`❌ Gagal menghapus: ${err.message}`, "error");
  }
}

async function deleteAllReportItems() {
  const confirmMsg = `⚠️ PERINGATAN BERAT ⚠️\n\nAnda akan menghapus SEMUA data dengan at_flag = 1 dari database report.\n\nTindakan ini TIDAK DAPAT DIURKAN.\n\nYakin ingin melanjutkan?`;
  
  if (!confirm(confirmMsg)) return;
  
  if (!CONFIG.BRIDGE_REPORT_URL) {
    showToast("Bridge Report URL tidak dikonfigurasi", "error");
    return;
  }
  
  try {
    showToast("Menghapus semua data...", "info");
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    const response = await fetch(`${CONFIG.BRIDGE_REPORT_URL}/delete-all`, {
      method: "POST",
      headers: bridgeHeaders(true, true),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.ok) {
      showToast(`✅ Berhasil menghapus ${data.deleted} data`, "success");
      await loadReportData();
    } else {
      throw new Error(data.error || "Delete all failed");
    }
    
  } catch (err) {
    console.error("[DeleteAll] Error:", err);
    showToast(`❌ Gagal menghapus semua: ${err.message}`, "error");
  }
}

function viewFullContent(id) {
  if (currentReportData && currentReportData.rows) {
    const item = currentReportData.rows.find(r => r.id == id);
    if (item && item.req_content) {
      showModalContent(item.req_content, item.id);
      return;
    }
  }
  
  const row = document.querySelector(`.report-table tr[data-id="${id}"]`);
  if (row) {
    const previewDiv = row.querySelector('.content-preview');
    if (previewDiv && previewDiv.getAttribute('title')) {
      const fullContent = previewDiv.getAttribute('title');
      showModalContent(fullContent, id);
      return;
    }
  }
  
  showToast("Tidak dapat menemukan konten", "error");
}

function showModalContent(content, id) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal-box" style="max-width: 800px; width: 90%;">
      <div class="modal-header">
        <h3><i class="fas fa-file-alt"></i> Full Content - ID: ${id}</h3>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
      </div>
      <div class="modal-body">
        <pre style="white-space: pre-wrap; font-family: monospace; font-size: 12px; max-height: 500px; overflow: auto;">${escHtml(content)}</pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="copyTextFromModal('${escHtml(content).replace(/'/g, "\\'")}')">
          <i class="fas fa-copy"></i> Copy
        </button>
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Tutup</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function copyTextFromModal(text) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  const decodedText = textarea.value;
  
  navigator.clipboard.writeText(decodedText).then(() => {
    showToast("✅ Content disalin ke clipboard", "success");
  }).catch(() => {
    showToast("❌ Gagal menyalin", "error");
  });
}

function refreshReportData() {
  loadReportData();
}

/* ════════════════════════════════════════════════════════════
   CHECK SESSION — gBmkgSatu
   ════════════════════════════════════════════════════════════ */

const SESSION_TOKEN = 'DDK_GTS_BRIDGE_2025';
const SESSION_ENDPOINT = '/cek-session';

let sessionAutoRefreshTimer = null;

/**
 * Refresh data session dari bridge
 */
async function refreshSessionData() {
  const btn = document.getElementById('btn-refresh-session');
  const countEl = document.getElementById('session-count');
  const latencyEl = document.getElementById('session-latency');
  const tsEl = document.getElementById('session-ts');
  const tsWrap = document.getElementById('session-timestamp');
  const listEl = document.getElementById('session-list');
  const summaryEl = document.getElementById('session-summary');
  const dbEl = document.getElementById('session-db-name');

  // Loading state
  if (btn) {
    btn.classList.add('loading');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Loading...';
  }

  try {
    // ── PERBAIKAN: Gunakan BRIDGE_REPORT_URL (bridge ke-2) ──
    // Endpoint /cek-session ada di server database bmkgsatu_report (olympics-eight-chocolate-salmon)
    let bridgeBase = (typeof CONFIG !== 'undefined' && CONFIG.BRIDGE_REPORT_URL)
      ? CONFIG.BRIDGE_REPORT_URL.replace(/\/+$/, '') // Hilangkan trailing slash jika ada
      : window.location.origin;
      
    const url = bridgeBase + SESSION_ENDPOINT;

    const t0 = performance.now();
    const resp = await fetch(url, {
      headers: { 'x-bridge-token': SESSION_TOKEN }
    });
    const t1 = performance.now();

    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const data = await resp.json();
    const clientLatency = Math.round(t1 - t0);

    if (!data.ok) throw new Error(data.error || 'Response not ok');

    // Update stats
    const sessions = data.sessions || [];
    if (countEl) countEl.textContent = sessions.length;
    if (latencyEl) latencyEl.textContent = data.latency || clientLatency;

    if (data.ts && tsWrap && tsEl) {
      tsWrap.style.display = '';
      tsEl.textContent = formatTimestamp(data.ts);
    }

    if (data.database && dbEl) {
      dbEl.textContent = data.database;
    }

    // Update badge
    updateSessionBadge(sessions.length);

    // Render
    if (sessions.length === 0) {
      if (summaryEl) summaryEl.style.display = 'none';
      if (listEl) listEl.innerHTML = `
        <div class="session-all-clear">
          <div class="clear-icon">✅</div>
          <h3>Tidak Ada Active Session</h3>
          <p>Database ${escHtml(data.database || '-')} bersih, tidak ada query yang berjalan.</p>
        </div>`;
    } else {
      renderSessionSummary(sessions);
      renderSessionTable(sessions);
    }

  } catch (err) {
    console.error('[Session] Error:', err);
    if (countEl) countEl.textContent = '-';
    if (latencyEl) latencyEl.textContent = '-';
    if (listEl) listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon" style="color:var(--danger,#f43f5e)">⚠️</div>
        <p>Gagal memuat data session</p>
        <p class="session-empty-sub">${escHtml(err.message)}</p>
      </div>`;
    if (summaryEl) summaryEl.style.display = 'none';
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
    }
  }
}

function renderSessionSummary(sessions) {
  const summaryEl = document.getElementById('session-summary');
  if (summaryEl) summaryEl.style.display = '';

  let slow = 0, medium = 0, fast = 0;
  const userSet = new Set();

  sessions.forEach(s => {
    userSet.add(s.usename);
    const totalSec = durationToSeconds(s.duration);
    if (totalSec >= 1800) slow++;
    else if (totalSec >= 300) medium++;
    else fast++;
  });

  const sumSlow = document.getElementById('sum-slow');
  const sumMedium = document.getElementById('sum-medium');
  const sumFast = document.getElementById('sum-fast');
  const sumUsers = document.getElementById('sum-users');

  if (sumSlow) sumSlow.textContent = slow;
  if (sumMedium) sumMedium.textContent = medium;
  if (sumFast) sumFast.textContent = fast;
  if (sumUsers) sumUsers.textContent = userSet.size;

  if (sumSlow) sumSlow.style.color = slow > 0 ? '#f43f5e' : '';
}

function renderSessionTable(sessions) {
  const listEl = document.getElementById('session-list');
  if (!listEl) return;

  const sorted = [...sessions].sort((a, b) => {
    return durationToSeconds(b.duration) - durationToSeconds(a.duration);
  });

  let html = `<div class="session-table-wrap"><table class="session-table">
    <thead>
      <tr>
        <th>PID</th>
        <th>User</th>
        <th>Database</th>
        <th>Query</th>
        <th>Started</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody>`;

  sorted.forEach((s, i) => {
    const totalSec = durationToSeconds(s.duration);
    const durClass = totalSec >= 1800 ? 'dur-slow' : totalSec >= 300 ? 'dur-medium' : 'dur-fast';
    const durText = formatDuration(s.duration);
    const queryId = 'q-' + i;
    const truncLen = 120;
    const queryText = s.query || '';
    const isTruncated = queryText.length > truncLen;

    const startParts = parseQueryStart(s.query_start);

    html += `<tr>
      <td class="cell-pid">${s.pid}</td>
      <td class="cell-user">${escHtml(s.usename)}</td>
      <td><span class="cell-db">${escHtml(s.datname)}</span></td>
      <td class="cell-query">
        <span class="q-truncated" onclick="toggleQueryExpand('${queryId}')">${escHtml(queryText.substring(0, truncLen))}${isTruncated ? '<span class="q-ellipsis"> ...klik untuk expand</span>' : ''}</span>
        ${isTruncated ? `<div class="query-full" id="${queryId}">${escHtml(queryText)}</div>` : ''}
      </td>
      <td class="cell-start">
        <span class="s-date">${startParts.date}</span>
        <span class="s-time">${startParts.time}</span>
      </td>
      <td><span class="dur-badge ${durClass}"><i class="fas fa-clock"></i> ${durText}</span></td>
    </tr>`;
  });

  html += '</tbody></table></div>';
  listEl.innerHTML = html;
}

function toggleQueryExpand(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('show');
}

function updateSessionBadge(count) {
  const badge = document.getElementById('badge-session');
  if (!badge) return;
  if (count > 0) {
    badge.style.display = '';
    badge.textContent = count;
  } else {
    badge.style.display = 'none';
  }
}

function toggleSessionAutoRefresh() {
  const cb = document.getElementById('session-auto-refresh');
  if (cb && cb.checked) {
    sessionAutoRefreshTimer = setInterval(() => {
      const section = document.getElementById('section-session');
      if (section && section.classList.contains('active')) {
        refreshSessionData();
      }
    }, 10000);
  } else {
    if (sessionAutoRefreshTimer) {
      clearInterval(sessionAutoRefreshTimer);
      sessionAutoRefreshTimer = null;
    }
  }
}

/* ── Session Helper Functions ── */

function durationToSeconds(dur) {
  if (!dur) return 0;
  return (dur.minutes || 0) * 60 + (dur.seconds || 0) + (dur.milliseconds || 0) / 1000;
}

function formatDuration(dur) {
  if (!dur) return '-';
  const m = dur.minutes || 0;
  const s = dur.seconds || 0;
  const ms = Math.round(dur.milliseconds || 0);

  if (m > 0) {
    return m + 'm ' + String(s).padStart(2, '0') + 's';
  }
  if (s > 0) {
    return s + '.' + String(ms).padStart(3, '0') + 's';
  }
  return ms + 'ms';
}

function parseQueryStart(isoStr) {
  if (!isoStr) return { date: '-', time: '-' };
  try {
    const d = new Date(isoStr);
    const date = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return { date, time };
  } catch {
    return { date: '-', time: isoStr };
  }
}

function formatTimestamp(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch {
    return isoStr;
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORT FUNCTIONS TO GLOBAL WINDOW SCOPE (For HTML onclick)
// ═══════════════════════════════════════════════════════════════════
window.refreshReportData = refreshReportData;
window.deleteAllReportItems = deleteAllReportItems;
window.deleteReportItem = deleteReportItem;
window.viewFullContent = viewFullContent;

window.refreshSessionData = refreshSessionData;
window.toggleSessionAutoRefresh = toggleSessionAutoRefresh;
window.toggleQueryExpand = toggleQueryExpand;

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  // Theme
  document.documentElement.setAttribute("data-theme", theme);
  const icon = document.getElementById("theme-icon");
  if (icon) icon.className = `fas ${theme === "dark" ? "fa-sun" : "fa-moon"}`;

  // Clock
  updateClock();
  setInterval(updateClock, 1000);

  // Char counter
  const ta = document.getElementById("gts-input");
  if (ta) ta.addEventListener("input", updateCharCounter);

  // Test Supabase connection
  await testSupabaseConnection();

  // Cek FTP
  await checkFTP();

  // Update badge
  await updateQueueBadge();

  // Tambah tombol test bridge
  addTestButton();

  // Auto retry pending
  if (isVercel) {
    try {
      const pending = await sb.select("upload_history", "select=id&status=eq.pending&limit=1");
      if (pending?.length > 0) {
        console.log("[Init] Found pending items, checking FTP...");
        const up = await checkFTP();
        if (up) {
          console.log("[Init] FTP online, starting auto-retry...");
          await retryPending();
        } else {
          console.log("[Init] FTP offline, starting retry timer...");
          startRetry();
        }
      }
    } catch (err) {
      console.error("[Init] Auto-retry check failed:", err);
    }
  }

  // Modal close on outside click & ESC
  document.querySelectorAll(".modal-overlay").forEach(m => {
    m.addEventListener("click", e => { if (e.target === m) closeModal(m.id); });
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") document.querySelectorAll(".modal-overlay").forEach(m => closeModal(m.id));
  });

  // Preview tabs
  document.querySelectorAll(".preview-tab").forEach(btn => {
    btn.addEventListener("click", () => switchPreviewTab(btn.dataset.tab));
  });

  // Loading overlay hide
  setTimeout(() => {
    const lo = document.getElementById("loading-overlay");
    if (lo) { lo.style.opacity = "0"; setTimeout(() => lo.remove(), 300); }
  }, 300);

  // Test bridge otomatis setelah 2 detik
  setTimeout(async () => {
    await testBridgeConnection();
  }, 2000);

  // Mobile features
  initMobileFeatures();
});