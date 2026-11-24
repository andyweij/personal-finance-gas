export interface WorkerEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  SETUP_SECRET?: string;
  APP_TIMEZONE?: string;
}

export interface AuthOwnerRow {
  id: number;
  password_hash: string;
  password_salt: string;
  pin_enabled: number;
  pin_hash: string | null;
  pin_salt: string | null;
  updated_at: string;
}

export interface PasskeyRow {
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_name: string;
  created_at: string;
}
