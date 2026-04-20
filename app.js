// ═══════════════════════════════════════════════════════════════════
// DDK GTS Web — app.js
// Arsitektur HYBRID:
//   - Supabase → langsung dari browser (history, duplikasi, insert)
//   - FTP → via bridge (cloudflared) atau Vercel serverless
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  API:            "/api/send",         // Vercel serverless (saat di Vercel)
  RETRY_INTERVAL: 5 * 60 * 1000,      // 5 menit

  // ── SUPABASE ─────────────────────────────────────────────────────
  SB_URL:  "https://ekrutvxdeugconuylehq.supabase.co",
  SB_ANON: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrcnV0dnhkZXVnY29udXlsZWhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MTgzMzUsImV4cCI6MjA5MjA5NDMzNX0.kE9NOblhXsB4b9LHPDuOlgYnau-VsEC7jH2Up82lCrA",

  // ── BRIDGE (laptop kantor via cloudflared) ────────────────────────
  // Update URL ini setiap kali cloudflared dijalankan ulang
  BRIDGE_URL:   "https://cut-conducted-fisheries-achieving.trycloudflare.com",
  BRIDGE_TOKEN: "DDK_GTS_BRIDGE_2025",
};

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
let ftpStatus    = { ftp1: false, ftp2: false };
let retryTimer   = null;
let cdTimer      = null;
let retrySeconds = 0;
let previewOriginal = "";
let previewCleaned  = "";
let currentPage  = "dashboard";
let theme        = localStorage.getItem("ddk_theme") || "dark";
let isVercel     = false;

// ═══════════════════════════════════════════════════════════════════
// CLEANSING ENGINE — port dari cleanWhatsAppMessages() PHP
// ═══════════════════════════════════════════════════════════════════
function cleanWhatsAppMessages(text) {
  // 1. Hapus timestamp & nama pengirim WA
  const waPatterns = [
    /\[\d{1,2}:\d{2},\s\d{1,2}\/\d{1,2}\/\d{4}\]\s[^:]+:\s*/g,
    /\[\d{1,2}\/\d{1,2}\/\d{4},\s\d{1,2}:\d{2}(?::\d{2})?\]\s[^:]+:\s*/g,
    /\[\d{4}-\d{1,2}-\d{1,2},\s\d{1,2}:\d{2}\]\s[^:]+:\s*/g,
    /\d{1,2}:\d{2}\s-\s[^:]+:\s*/g,
    /\[\d{1,2}\/\d{1,2}\/\d{4},\s\d{1,2}:\d{2}\s(?:AM|PM)\]\s[^:]+:\s*/gi,
  ];
  for (const p of waPatterns) text = text.replace(p, "");

  // 2. Hapus metadata WA
  const metaPatterns = [
    /\s*\(file attached\)\s*/gi,
    /\s*<Media omitted>\s*/gi,
    /\s*Gambar tidak disertakan\s*/gi,
    /\s*Audio tidak disertakan\s*/gi,
    /\s*Video tidak disertakan\s*/gi,
    /\s*Dokumen tidak disertakan\s*/gi,
    /\s*Pesan ini telah dihapus\s*/gi,
    /\s*This message was deleted\s*/gi,
  ];
  for (const p of metaPatterns) text = text.replace(p, "");

  // 3. Normalize line breaks
  text = text.replace(/\r\n|\r/g, "\n");

  // 4. Filter baris — hanya simpan yang terlihat seperti data GTS
  const lines = text.split("\n");
  const validLines = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[=\-~_*#]+$/.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (
      /^[A-Z0-9\s=.\/\-]+$/i.test(line) ||
      /^[A-Z]{4,6}\d{2}/i.test(line)    ||
      /^\d{5}\s/.test(line)              ||
      line.includes("=")                 ||
      line.includes("AAXX")             ||
      line.includes("BBXX")             ||
      line.includes("CCXX")             ||
      /^\s*333/.test(line)
    ) {
      validLines.push(line);
    }
  }
  text = validLines.join("\n");

  // 5. Format khusus GTS — perbaiki posisi "333"
  let finalText = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const m1 = line.match(/^(\d{5}\s+.*?)\s+333\s+(.+)$/);
    if (m1) { finalText += m1[1] + "\n" + "  333 " + m1[2] + "\n"; continue; }

    const m2 = line.match(/^333\s+(.+)$/);
    if (m2) { finalText += "  333 " + m2[1] + "\n"; continue; }

    const m3 = line.match(/^([A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6})\s+(AAXX\s+\d{5}\s*.*)$/);
    if (m3) { finalText += m3[1] + "\n" + m3[2] + "\n"; continue; }

    finalText += line + "\n";
  }

  // 6. Normalisasi final
  finalText = finalText
    .replace(/([A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6})\s+(AAXX\s+\d{5})/g, "$1\n$2")
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
  for (const line of cleanedText.split("\n")) {
    const m = line.trim().match(/^([A-Z]{4,6}\d{2})\s/);
    if (m) sandis.push(m[1]);
  }
  return [...new Set(sandis)];
}

function generateFileName() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `DDK_SHIFT_${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.X`;
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
      method: "GET",
      headers: {
        "x-bridge-token": CONFIG.BRIDGE_TOKEN,
      },
      signal: AbortSignal.timeout(5000)
    });
    
    if (res.ok) {
      const data = await res.json();
      console.log("Bridge check response:", data);
      
      let statusMsg = "";
      if (data.ftp1 && data.ftp2) {
        statusMsg = "✅ Bridge online - FTP Main dan InaSwitching tersedia";
      } else if (data.ftp1) {
        statusMsg = "✅ Bridge online - Hanya FTP Main tersedia";
      } else if (data.ftp2) {
        statusMsg = "✅ Bridge online - Hanya InaSwitching tersedia";
      } else {
        statusMsg = "⚠️ Bridge online tapi kedua FTP offline";
      }
      
      showToast(statusMsg, data.ftp1 || data.ftp2 ? "success" : "warn");
      return data.ftp1 || data.ftp2;
    } else {
      showToast(`Bridge response error: ${res.status}`, "error");
      return false;
    }
  } catch (err) {
    console.error("Bridge test failed:", err);
    showToast(`❌ Gagal konek ke bridge: ${err.message}`, "error");
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FTP STATUS
// ═══════════════════════════════════════════════════════════════════
async function checkFTP() {
  setFTPUI("checking", "checking");

  // Coba bridge langsung dengan token
  if (CONFIG.BRIDGE_URL) {
    try {
      console.log(`Checking FTP via bridge: ${CONFIG.BRIDGE_URL}/check`);
      
      const res = await fetch(`${CONFIG.BRIDGE_URL}/check`, { 
        method: "GET",
        headers: {
          "x-bridge-token": CONFIG.BRIDGE_TOKEN,
        },
        signal: AbortSignal.timeout(8000) 
      });
      
      if (res.ok) {
        const data = await res.json();
        console.log("FTP check response:", data);
        
        ftpStatus = { 
          ftp1: data.ftp1 === true, 
          ftp2: data.ftp2 === true 
        };
        
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
        
        return ftpStatus.ftp1 || ftpStatus.ftp2;
      } else {
        console.error(`Bridge check failed: ${res.status}`);
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.error("Bridge check error:", err);
    }
  }

  // Fallback: coba via Vercel serverless
  try {
    console.log("Fallback: checking via Vercel serverless");
    const res = await fetch(`${CONFIG.API}?action=check_ftp`);
    if (!res.ok) throw new Error("no serverless");
    const data = await res.json();
    ftpStatus = { ftp1: data.ftp1, ftp2: data.ftp2 };
    setFTPUI(data.ftp1 ? "up" : "down", data.ftp2 ? "up" : "down");
    isVercel = true;
    return data.ftp1 || data.ftp2;
  } catch (err) {
    console.error("Fallback check failed:", err);
    isVercel = false;
    setFTPUI("down", "down");
    const el = document.getElementById("retry-countdown");
    if (el) el.textContent = "⚠️ Bridge tidak terjangkau — pastikan cloudflared running";
    return false;
  }
}

function setFTPUI(s1, s2) {
  const labels = { up: "Online", down: "Offline", checking: "Mengecek..." };
  const dot1 = document.getElementById("dot-ftp1");
  const dot2 = document.getElementById("dot-ftp2");
  const t1   = document.getElementById("text-ftp1");
  const t2   = document.getElementById("text-ftp2");
  if (dot1) dot1.className = `dot ${s1}`;
  if (dot2) dot2.className = `dot ${s2}`;
  if (t1)  t1.textContent  = labels[s1] || s1;
  if (t2)  t2.textContent  = labels[s2] || s2;

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

    const inserted = await sb.insert("upload_history", historyRow);
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

    // ── B. Kirim ke FTP via bridge ─────────────────────
    let ftpSuccess = false;
    let ftpTarget = "";

    if (CONFIG.BRIDGE_URL) {
      try {
        console.log(`Mencoba mengirim ke bridge: ${CONFIG.BRIDGE_URL}/upload`);
        
        const res = await fetch(`${CONFIG.BRIDGE_URL}/upload`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-bridge-token": CONFIG.BRIDGE_TOKEN,
          },
          body: JSON.stringify({ 
            content: cleaned, 
            fileName: fileName,
            ftp1: true,
            ftp2: true
          }),
          signal: AbortSignal.timeout(15000),
        });
        
        if (res.ok) {
          const data = await res.json();
          console.log("Bridge response:", data);
          
          if (data.success || data.ok) {
            ftpSuccess = true;
            ftpTarget = data.ftp1 && data.ftp2 ? "Main + InaSwitching" : 
                       data.ftp1 ? "FTP Main" : 
                       data.ftp2 ? "InaSwitching" : "FTP Server";
            
            if (historyId) {
              await sb.update("upload_history", historyId, {
                status: "success",
                note: `Uploaded ke FTP (${ftpTarget})`,
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
        showToast(`⚠️ Tidak bisa konek ke bridge: ${e.message} — data tersimpan pending.`, "warn");
        startRetry();
      }
    } else {
      showToast(`⚠️ Bridge URL tidak dikonfigurasi — data tersimpan di Supabase (pending).`, "warn");
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
async function retryPending() {
  if (!isVercel) {
    showToast("ℹ️ Retry FTP hanya bisa di Vercel. Di sini data sudah tersimpan di Supabase.", "info");
    return;
  }

  const ftpUp = await checkFTP();
  if (!ftpUp) { showToast("FTP masih offline.", "warn"); return; }

  const pending = await sb.select("upload_history", "select=*&status=eq.pending&order=created_at.asc&limit=100");
  if (!pending?.length) { showToast("Tidak ada antrian pending.", "info"); return; }

  showToast(`Mengirim ulang ${pending.length} item...`, "info");
  let success = 0;
  for (const item of pending) {
    try {
      const res = await fetch(`${CONFIG.API}?action=retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId: item.id, content: item.content, fileName: item.filename }),
      });
      const d = await res.json();
      if (d.ok) { success++; }
    } catch {}
  }

  showToast(`✅ ${success} dari ${pending.length} berhasil dikirim ulang.`, "success");
  if (success === pending.length) stopRetry();
  loadHistory();
  updateQueueBadge();
}

function startRetry() {
  stopRetry();
  retrySeconds = CONFIG.RETRY_INTERVAL / 1000;
  cdTimer = setInterval(() => {
    retrySeconds--;
    const m = Math.floor(retrySeconds / 60);
    const s = retrySeconds % 60;
    const el = document.getElementById("retry-countdown");
    if (el) el.textContent = `Retry dalam ${m}:${String(s).padStart(2,"0")}`;
    if (retrySeconds <= 0) stopRetry();
  }, 1000);
  retryTimer = setTimeout(async () => {
    const up = await checkFTP();
    if (up) await retryPending();
    else startRetry();
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
  
  const timeEl = modal.querySelector("#detail-time");
  const filenameEl = modal.querySelector("#detail-filename");
  const statusEl = modal.querySelector("#detail-status");
  const sizeEl = modal.querySelector("#detail-size");
  const linesEl = modal.querySelector("#detail-lines");
  const noteEl = modal.querySelector("#detail-note");
  const userEl = modal.querySelector("#detail-user");
  const ftpEl = modal.querySelector("#detail-ftp");
  const sandiEl = modal.querySelector("#detail-sandi");
  const contentEl = modal.querySelector("#detail-content");
  
  if (timeEl) timeEl.textContent = formatDate(item.created_at);
  if (filenameEl) filenameEl.textContent = item.filename;
  if (statusEl) {
    statusEl.textContent = item.status?.toUpperCase();
    statusEl.className = `status-${item.status}`;
  }
  if (sizeEl) sizeEl.textContent = `${((item.file_size||0)/1024).toFixed(2)} KB`;
  if (linesEl) linesEl.textContent = `${item.lines_count} lines`;
  if (noteEl) noteEl.textContent = item.note || "-";
  if (userEl) userEl.textContent = item.user_input || "-";
  if (ftpEl) ftpEl.textContent = item.ftp_target || "-";
  if (sandiEl) sandiEl.textContent = sandiList.join(", ") || "-";
  if (contentEl) contentEl.textContent = item.content || "";

  const delBtn = modal.querySelector("#detail-delete-btn");
  const retryBtn = modal.querySelector("#detail-retry-btn");

  if (delBtn) delBtn.onclick = () => deleteHistory(item.id);

  if (retryBtn) {
    retryBtn.style.display = item.status === "pending" && isVercel ? "inline-flex" : "none";
    retryBtn.onclick = async () => {
      closeModal("log-modal");
      const res = await fetch(`${CONFIG.API}?action=retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId: item.id, content: item.content, fileName: item.filename }),
      });
      const d = await res.json();
      showToast(d.ok ? "✅ Berhasil dikirim ulang!" : "❌ FTP masih offline.", d.ok ? "success" : "warn");
      loadHistory();
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
    badge.textContent = count;
    badge.style.display = count > 0 ? "inline-block" : "none";
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
    editEl.value = previewCleaned;
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
  const tabBtn = document.querySelector(`.preview-tab[data-tab="${tab}"]`);
  const content = document.getElementById(`preview-content-${tab}`);
  if (tabBtn) tabBtn.classList.add("active");
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
    btn.disabled = on;
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
  const el = document.getElementById(id);
  const text = el?.textContent || el?.value || "";
  navigator.clipboard.writeText(text).then(() => showToast("Disalin!", "success"));
}

function showToast(msg, type = "info") {
  const existing = document.querySelector(".toast:not(#auto-toast)");
  if (existing) existing.remove();
  
  const icons = { success: "check-circle", error: "exclamation-circle", warn: "exclamation-triangle", info: "info-circle" };
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i class="fas fa-${icons[type]||"info-circle"}"></i><span>${msg}</span><button onclick="this.parentElement.remove()">×</button>`;
  document.body.appendChild(t);
  setTimeout(() => t?.remove(), 5000);
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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
    
    const testBtn = document.createElement("button");
    testBtn.id = "test-bridge-btn";
    testBtn.innerHTML = '<i class="fas fa-plug"></i> Test Bridge';
    testBtn.className = "btn-secondary";
    testBtn.style.marginLeft = "10px";
    testBtn.onclick = testBridgeConnection;
    
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn && sendBtn.parentNode) {
      sendBtn.parentNode.insertBefore(testBtn, sendBtn.nextSibling);
    }
  }
}

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
        const up = await checkFTP();
        if (up) await retryPending();
        else startRetry();
      }
    } catch {}
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

  // ========== MOBILE FEATURES ==========
  initMobileFeatures();
});


// ========== MOBILE MENU IMPROVEMENTS ==========
function initMobileFeatures() {
  const sidebar = document.querySelector('.sidebar');
  const menuToggle = document.getElementById('menu-toggle');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  
  if (menuToggle && sidebar) {
    // Toggle sidebar on menu button click
    menuToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sidebar.classList.toggle('open');
      if (sidebarOverlay) {
        sidebarOverlay.style.display = sidebar.classList.contains('open') ? 'block' : 'none';
      }
    });
    
    // Close sidebar when clicking overlay
    if (sidebarOverlay) {
      sidebarOverlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        sidebarOverlay.style.display = 'none';
      });
    }
    
    // Close sidebar on navigation (after menu click)
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
    
    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', (e) => {
      if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
        if (!sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
          sidebar.classList.remove('open');
          if (sidebarOverlay) sidebarOverlay.style.display = 'none';
        }
      }
    });
    
    // Prevent body scroll when sidebar is open
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          if (sidebar.classList.contains('open')) {
            document.body.style.overflow = 'hidden';
          } else {
            document.body.style.overflow = '';
          }
        }
      });
    });
    
    observer.observe(sidebar, { attributes: true });
  }
  
  // Add pull-to-refresh on dashboard
  let touchStart = 0;
  let touchStartY = 0;
  const contentArea = document.querySelector('.content-area');
  
  if (contentArea) {
    contentArea.addEventListener('touchstart', (e) => {
      touchStart = e.touches[0].clientY;
      touchStartY = contentArea.scrollTop;
    });
    
    contentArea.addEventListener('touchmove', (e) => {
      const touchEnd = e.touches[0].clientY;
      const diff = touchEnd - touchStart;
      
      if (diff > 60 && touchStartY === 0 && currentPage === 'dashboard') {
        e.preventDefault();
        const refreshIndicator = document.createElement('div');
        refreshIndicator.className = 'pull-to-refresh';
        refreshIndicator.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing...';
        refreshIndicator.style.position = 'fixed';
        refreshIndicator.style.top = '10px';
        refreshIndicator.style.left = '50%';
        refreshIndicator.style.transform = 'translateX(-50%)';
        refreshIndicator.style.background = 'var(--primary)';
        refreshIndicator.style.color = 'white';
        refreshIndicator.style.padding = '8px 16px';
        refreshIndicator.style.borderRadius = '20px';
        refreshIndicator.style.zIndex = '9999';
        refreshIndicator.style.fontSize = '12px';
        document.body.appendChild(refreshIndicator);
        
        checkFTP();
        updateQueueBadge();
        showToast('🔄 Refreshing data...', 'info');
        
        setTimeout(() => {
          refreshIndicator.remove();
        }, 1000);
        
        touchStart = 0;
      }
    });
  }
  
  // Better modal handling on mobile
  const modals = document.querySelectorAll('.modal-overlay');
  modals.forEach(modal => {
    let modalTouchStart = 0;
    const modalBox = modal.querySelector('.modal-box');
    
    if (modalBox && window.innerWidth <= 768) {
      modalBox.addEventListener('touchstart', (e) => {
        modalTouchStart = e.touches[0].clientY;
      });
      
      modalBox.addEventListener('touchmove', (e) => {
        const touchEnd = e.touches[0].clientY;
        const diff = touchEnd - modalTouchStart;
        
        if (diff > 50) {
          closeModal(modal.id);
        }
      });
    }
  });
  
  // Fix for iOS input zoom
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
  
  // Add active state feedback for touch
  const touchElements = document.querySelectorAll('button, .nav-item, .action-btn, .history-item');
  touchElements.forEach(el => {
    el.addEventListener('touchstart', () => {
      el.classList.add('touch-active');
    });
    el.addEventListener('touchend', () => {
      setTimeout(() => {
        el.classList.remove('touch-active');
      }, 100);
    });
    el.addEventListener('touchcancel', () => {
      el.classList.remove('touch-active');
    });
  });
}

// Add CSS for touch feedback (tambahkan ke style.css jika belum ada)
const touchFeedbackStyle = document.createElement('style');
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
    from {
      transform: translate(-50%, -100%);
      opacity: 0;
    }
    to {
      transform: translate(-50%, 0);
      opacity: 1;
    }
  }
  
  @media (max-width: 768px) {
    .modal-box {
      animation: slideUp 0.3s ease;
    }
    
    @keyframes slideUp {
      from {
        transform: translateY(100%);
      }
      to {
        transform: translateY(0);
      }
    }
  }
`;
document.head.appendChild(touchFeedbackStyle);