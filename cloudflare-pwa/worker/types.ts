import type { UserRole } from '../shared/types';

export interface WorkerEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  SETUP_SECRET?: string;
  APP_TIMEZONE?: string;
  /** H5 / H6: D1 queries allowed per invocation (default 50 = Workers Free; Paid allows 1000) */
  D1_QUERY_BUDGET?: string;
  /** H6: external subrequests allowed per invocation (default 50 = Workers Free) */
  SUBREQUEST_BUDGET?: string;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  password_salt: string;
  pin_enabled: number;
  pin_hash: string | null;
  pin_salt: string | null;
  show_utility_tab: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface PasskeyRow {
  credential_id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_name: string;
  created_at: string;
}

export interface InviteRow {
  id: string;
  code_hash: string;
  note: string;
  created_by: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface PasswordResetRow {
  id: string;
  target_user_id: string;
  token_hash: string;
  created_by: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}
