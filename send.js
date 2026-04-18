// api/send.js — DDK GTS Web
// Handles: FTP check, FTP upload (main + InaSwitching), Supabase CRUD
//
// Vercel Environment Variables:
//   FTP_HOST      = 172.19.0.202
//   FTP_USER      = rasonftp
//   FTP_PASS      = rasonftp_1672
//   FTP_HOST_2    = 172.19.3.230
//   FTP_USER_2    = bmksfty2022
//   FTP_PASS_2    = Bmksfty2022
//   FTP_PORT      = 21
//   SUPABASE_URL  = https://ekrutvxdeugconuylehq.supabase.co
//   SUPABASE_KEY  = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrcnV0dnhkZXVnY29udXlsZWhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MTgzMzUsImV4cCI6MjA5MjA5NDMzNX0.kE9NOblhXsB4b9LHPDuOlgYnau-VsEC7jH2Up82lCrA

import * as ftp from "basic-ftp";

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_KEY;

// ── Supabase REST helpers ─────────────────────────────────────────
async function sbSelect(table, params = "") {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  return res.json();
}

async function sbInsert(table, data) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function sbUpdate(table, matchKey, matchVal, data) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${matchKey}=eq.${matchVal}`, {
    method: "PATCH",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  return res.ok;
}

// ── FTP connect helper ────────────────────────────────────────────
async function ftpConnect(host, user, pass, port = 21, timeoutMs = 8000) {
  const client = new ftp.Client(timeoutMs);
  await client.access({ host, user, password: pass, port: parseInt(port), secure: false });
  return client;
}

// ── Upload file content ke FTP ────────────────────────────────────
async function ftpUpload(client, content, fileName, ftpPath) {
  const { Readable } = await import("stream");
  if (ftpPath && ftpPath !== "/") await client.ensureDir(ftpPath);
  await client.uploadFrom(Readable.from([content]), fileName);
}

// ══════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;

  // ── GET /api/send?action=check_ftp ─────────────────────────────
  if (req.method === "GET" && action === "check_ftp") {
    const results = { ftp1: false, ftp2: false };

    // Cek FTP Main
    try {
      const c = await ftpConnect(process.env.FTP_HOST, process.env.FTP_USER, process.env.FTP_PASS, process.env.FTP_PORT || 21, 5000);
      c.close();
      results.ftp1 = true;
    } catch { results.ftp1 = false; }

    // Cek FTP InaSwitching
    try {
      const c = await ftpConnect(process.env.FTP_HOST_2, process.env.FTP_USER_2, process.env.FTP_PASS_2, process.env.FTP_PORT || 21, 5000);
      c.close();
      results.ftp2 = true;
    } catch { results.ftp2 = false; }

    return res.status(200).json({ ok: true, ...results });
  }

  // ── GET /api/send?action=history ───────────────────────────────
  if (req.method === "GET" && action === "history") {
    const { search = "", status = "", date = "", page = "1", limit = "20" } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let params = `select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
    if (status) params += `&status=eq.${status}`;
    if (date)   params += `&created_at=gte.${date}T00:00:00&created_at=lte.${date}T23:59:59`;
    if (search) params += `&or=(filename.ilike.*${search}*,user_input.ilike.*${search}*)`;

    const data = await sbSelect("upload_history", params);
    const countData = await sbSelect("upload_history", `select=id${status ? `&status=eq.${status}` : ""}${date ? `&created_at=gte.${date}T00:00:00&created_at=lte.${date}T23:59:59` : ""}`);

    return res.status(200).json({
      ok: true,
      data: data || [],
      total: Array.isArray(countData) ? countData.length : 0,
    });
  }

  // ── GET /api/send?action=check_duplicate ───────────────────────
  if (req.method === "GET" && action === "check_duplicate") {
    const { sandi_gts } = req.query;
    if (!sandi_gts) return res.status(400).json({ ok: false });

    const today = new Date().toISOString().slice(0, 10);
    const data = await sbSelect(
      "gts_messages",
      `select=id&sandi_gts=eq.${encodeURIComponent(sandi_gts)}&created_at=gte.${today}T00:00:00`
    );
    return res.status(200).json({ ok: true, isDupe: Array.isArray(data) && data.length > 0 });
  }

  // ── POST /api/send?action=send ─────────────────────────────────
  if (req.method === "POST" && action === "send") {
    const { content, fileName, sandiList, userInput, originalContent } = req.body;

    if (!content || !fileName) {
      return res.status(400).json({ ok: false, error: "Missing content or fileName" });
    }

    let ftp1Ok = false;
    let ftp2Ok = false;
    let ftpTarget = "";

    // Upload ke FTP Main
    try {
      const c = await ftpConnect(process.env.FTP_HOST, process.env.FTP_USER, process.env.FTP_PASS, process.env.FTP_PORT || 21, 12000);
      await ftpUpload(c, content, fileName, process.env.FTP_PATH || "/");
      c.close();
      ftp1Ok = true;
    } catch (e) {
      console.error("FTP1 error:", e.message);
    }

    // Upload ke FTP InaSwitching (selalu coba, bukan fallback)
    try {
      const c = await ftpConnect(process.env.FTP_HOST_2, process.env.FTP_USER_2, process.env.FTP_PASS_2, process.env.FTP_PORT || 21, 12000);
      await ftpUpload(c, content, fileName, process.env.FTP_PATH_2 || "/");
      c.close();
      ftp2Ok = true;
    } catch (e) {
      console.error("FTP2 error:", e.message);
    }

    const anySuccess = ftp1Ok || ftp2Ok;
    if (ftp1Ok && ftp2Ok) ftpTarget = "both";
    else if (ftp1Ok) ftpTarget = "main";
    else if (ftp2Ok) ftpTarget = "inaswitching";

    // Simpan history ke Supabase
    const historyRow = {
      filename: fileName,
      content: content,
      original_content: originalContent || "",
      status: anySuccess ? "success" : "pending",
      file_size: Buffer.byteLength(content, "utf8"),
      lines_count: content.split("\n").length,
      sandi_count: sandiList?.length || 0,
      sandi_list: sandiList || [],
      user_input: userInput || "anonymous",
      note: anySuccess
        ? `Uploaded to FTP (${ftpTarget})`
        : "FTP failed — saved to queue",
      ftp_target: ftpTarget,
    };

    const inserted = await sbInsert("upload_history", historyRow);

    // Simpan sandi ke gts_messages
    if (sandiList?.length) {
      for (const sandi of sandiList) {
        await sbInsert("gts_messages", {
          sandi_gts: sandi,
          timestamp_data: new Date().toISOString(),
          status_ftp: anySuccess ? 1 : 0,
          user_input: userInput || "anonymous",
        }).catch(() => {}); // ignore duplicate key
      }
    }

    return res.status(200).json({
      ok: anySuccess,
      ftp1: ftp1Ok,
      ftp2: ftp2Ok,
      ftpTarget,
      fileName,
      historyId: inserted?.[0]?.id,
    });
  }

  // ── POST /api/send?action=retry ────────────────────────────────
  if (req.method === "POST" && action === "retry") {
    const { historyId, content, fileName } = req.body;
    if (!historyId || !content || !fileName) {
      return res.status(400).json({ ok: false, error: "Missing params" });
    }

    let ftp1Ok = false, ftp2Ok = false;

    try {
      const c = await ftpConnect(process.env.FTP_HOST, process.env.FTP_USER, process.env.FTP_PASS, process.env.FTP_PORT || 21, 12000);
      await ftpUpload(c, content, fileName, process.env.FTP_PATH || "/");
      c.close();
      ftp1Ok = true;
    } catch {}

    try {
      const c = await ftpConnect(process.env.FTP_HOST_2, process.env.FTP_USER_2, process.env.FTP_PASS_2, process.env.FTP_PORT || 21, 12000);
      await ftpUpload(c, content, fileName, process.env.FTP_PATH_2 || "/");
      c.close();
      ftp2Ok = true;
    } catch {}

    const anySuccess = ftp1Ok || ftp2Ok;

    if (anySuccess) {
      await sbUpdate("upload_history", "id", historyId, {
        status: "success",
        note: `Retry sukses (${ftp1Ok && ftp2Ok ? "both" : ftp1Ok ? "main" : "inaswitching"})`,
        ftp_target: ftp1Ok && ftp2Ok ? "both" : ftp1Ok ? "main" : "inaswitching",
      });
    }

    return res.status(200).json({ ok: anySuccess, ftp1: ftp1Ok, ftp2: ftp2Ok });
  }

  // ── DELETE /api/send?action=delete ─────────────────────────────
  if (req.method === "POST" && action === "delete") {
    const { historyId } = req.body;
    if (!historyId) return res.status(400).json({ ok: false });

    await fetch(`${SB_URL}/rest/v1/upload_history?id=eq.${historyId}`, {
      method: "DELETE",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
