CREATE TABLE IF NOT EXISTS building_register_documents (
  id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL,
  pin TEXT NOT NULL,
  pin_fmt TEXT,
  record_type TEXT,
  address TEXT NOT NULL,
  road_addr TEXT,
  building TEXT,
  floor TEXT,
  room TEXT,
  document_type TEXT NOT NULL,
  status TEXT NOT NULL,
  eais_receipt_no TEXT,
  eais_mgm_no TEXT,
  eais_application_date TEXT,
  eais_report_name TEXT,
  eais_register_kind_cd TEXT,
  eais_mjrfmly_yn TEXT,
  eais_bldrgst_seqno TEXT,
  r2_key TEXT,
  content_type TEXT,
  byte_size INTEGER,
  page_count INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  downloaded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_building_register_documents_record
  ON building_register_documents(record_key, document_type);

CREATE INDEX IF NOT EXISTS idx_building_register_documents_status
  ON building_register_documents(status, expires_at);

CREATE TABLE IF NOT EXISTS building_register_downloads (
  id TEXT PRIMARY KEY,
  selection_hash TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  merged_r2_key TEXT,
  file_name TEXT NOT NULL,
  source_document_ids TEXT NOT NULL,
  byte_size INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  downloaded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_building_register_downloads_selection
  ON building_register_downloads(selection_hash, format);

CREATE INDEX IF NOT EXISTS idx_building_register_downloads_status
  ON building_register_downloads(status, expires_at);
