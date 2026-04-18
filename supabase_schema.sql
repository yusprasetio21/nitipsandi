-- ═══════════════════════════════════════════════════════════════════
-- DDK GTS Web — Supabase Schema
-- Port dari SQLite (gts_tracking.db)
-- Jalankan di: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Tabel tracking sandi GTS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS gts_messages (
  id                  bigserial PRIMARY KEY,
  sandi_gts           text NOT NULL,
  ttaaii              text,
  cccc                text,
  station_wmo_id      text,
  timestamp_data      timestamptz,
  timestamp_sent_data timestamptz,
  status_ftp          smallint DEFAULT 0,
  user_input          text DEFAULT 'anonymous',
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE(sandi_gts, timestamp_data)
);

-- ── 2. Tabel history upload (semua petugas) ───────────────────────
CREATE TABLE IF NOT EXISTS upload_history (
  id               bigserial PRIMARY KEY,
  filename         text NOT NULL,
  content          text,
  original_content text,
  status           text DEFAULT 'pending',   -- pending | success | failed
  file_size        integer DEFAULT 0,
  lines_count      integer DEFAULT 0,
  sandi_count      integer DEFAULT 0,
  sandi_list       jsonb DEFAULT '[]',
  user_input       text DEFAULT 'anonymous',
  note             text,
  ftp_target       text,                     -- 'main' | 'inaswitching' | 'both'
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- ── 3. Index ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_history_created  ON upload_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_status   ON upload_history(status);
CREATE INDEX IF NOT EXISTS idx_history_user     ON upload_history(user_input);
CREATE INDEX IF NOT EXISTS idx_sandi_gts        ON gts_messages(sandi_gts);
CREATE INDEX IF NOT EXISTS idx_timestamp_data   ON gts_messages(timestamp_data);

-- ── 4. Row Level Security (izinkan anon key baca/tulis) ───────────
ALTER TABLE gts_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_gts"     ON gts_messages   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_history" ON upload_history FOR ALL TO anon USING (true) WITH CHECK (true);

-- ── 5. Function auto-update updated_at ───────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gts_updated_at
  BEFORE UPDATE ON gts_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_history_updated_at
  BEFORE UPDATE ON upload_history
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
