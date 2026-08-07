export interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  ASSETS: Fetcher;
  UPLOAD_RATE_LIMITER: RateLimit;
  GLOBAL_UPLOAD_RATE_LIMITER: RateLimit;
  ENVIRONMENT: "local" | "test" | "production";
  BASE_URL: string;
}

export interface FileRecord {
  id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  password_hash: string | null;
  edit_password_hash: string;
  created_at: string;
  expires_at: string | null;
  downloads: number;
  last_downloaded_at: string | null;
}

export interface MultipartRecord {
  file_id: string;
  upload_id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  expected_size: number;
  password_hash: string | null;
  edit_password_hash: string;
  created_at: string;
  expires_at: string;
}

export interface PublicFile {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  expires_at: string | null;
  created_at: string;
  downloads: number;
  last_downloaded_at?: string | null;
}
