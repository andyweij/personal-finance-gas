/**
 * Web App 安全保護模組 (security.ts)
 * - 提供可選 4~6 位數 App PIN 鎖（預設關閉，可於 Web App UI 內隨時開啟/修改/關閉）
 * - PIN 以隨機 Salt + SHA-256 雜湊存於 ScriptProperties（絕不明文儲存）
 * - 解鎖後透過 CacheService.getUserCache() 核發 15 分鐘滑動效期 Session Token
 * - 若忘記 PIN，可直接從 Google Sheets 自訂選單一鍵重設
 */

const SECURITY_PROP_KEYS = {
  PIN_ENABLED: 'FINANCE_APP_PIN_ENABLED',
  PIN_SALT: 'FINANCE_APP_PIN_SALT',
  PIN_HASH: 'FINANCE_APP_PIN_HASH',
} as const;

const SESSION_TOKEN_PREFIX = 'FINANCE_APP_SESSION_';
const SESSION_TTL_SECONDS = 900; // 15 分鐘閒置自動鎖定

/**
 * 計算 SHA-256 十六進位摘要
 */
function sha256Hex(input: string): string {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    input,
    Utilities.Charset.UTF_8
  );
  return digest
    .map((b) => {
      const unsigned = b < 0 ? b + 256 : b;
      return unsigned.toString(16).padStart(2, '0');
    })
    .join('');
}

/**
 * 驗證 PIN 格式（必須為 4~6 位純數字）
 */
function validatePinFormat(pin: string): string {
  const cleaned = String(pin || '').trim();
  if (!/^\d{4,6}$/.test(cleaned)) {
    throw new Error('PIN 碼必須為 4 至 6 位數字。');
  }
  return cleaned;
}

/**
 * 檢查目前是否已啟用 App PIN 鎖
 */
function isAppPinEnabled(): boolean {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty(SECURITY_PROP_KEYS.PIN_ENABLED) === 'true' &&
    Boolean(props.getProperty(SECURITY_PROP_KEYS.PIN_HASH));
}

/**
 * 驗證輸入的 PIN 是否與儲存的雜湊相符
 */
function verifyPinCode(pin: string): boolean {
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty(SECURITY_PROP_KEYS.PIN_SALT) || '';
  const storedHash = props.getProperty(SECURITY_PROP_KEYS.PIN_HASH) || '';
  if (!salt || !storedHash) {
    return false;
  }
  const computed = sha256Hex(`${salt}:${String(pin || '').trim()}`);
  if (computed.length !== storedHash.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 檢查並續期 Session Token（所有讀寫 API 入口皆須呼叫）
 */
function assertAuthorized(token?: string): void {
  if (!isAppPinEnabled()) {
    return;
  }
  const cleanToken = String(token || '').trim();
  if (!cleanToken) {
    throw new Error('AUTH_REQUIRED');
  }
  const cache = CacheService.getUserCache();
  const key = SESSION_TOKEN_PREFIX + cleanToken;
  const active = cache.get(key);
  if (active !== '1') {
    throw new Error('AUTH_REQUIRED');
  }
  // 滑動續期 15 分鐘
  cache.put(key, '1', SESSION_TTL_SECONDS);
}

/**
 * 前端啟動時查詢安全狀態（不回傳任何財務數據）
 */
function getSecurityStatus(): { pinEnabled: boolean; sessionTtlMinutes: number } {
  return {
    pinEnabled: isAppPinEnabled(),
    sessionTtlMinutes: Math.round(SESSION_TTL_SECONDS / 60),
  };
}

/**
 * 前端輸入 PIN 解鎖並取得 15 分鐘效期 Session Token
 */
function unlockWithPin(pin: string): { ok: boolean; token?: string; message?: string } {
  if (!isAppPinEnabled()) {
    return { ok: true, token: '' };
  }
  if (!verifyPinCode(pin)) {
    return { ok: false, message: 'PIN 碼錯誤，請重新輸入。' };
  }
  const token = Utilities.getUuid();
  CacheService.getUserCache().put(SESSION_TOKEN_PREFIX + token, '1', SESSION_TTL_SECONDS);
  return { ok: true, token };
}

/**
 * 手動立即上鎖（清除目前 Session Token）
 */
function lockSession(token?: string): { ok: boolean } {
  const cleanToken = String(token || '').trim();
  if (cleanToken) {
    CacheService.getUserCache().remove(SESSION_TOKEN_PREFIX + cleanToken);
  }
  return { ok: true };
}

/**
 * 在 Web App 內啟用、修改或關閉 App PIN 鎖
 */
function configureAppPin(
  token: string,
  payload: { enable: boolean; currentPin?: string; newPin?: string }
): { ok: boolean; pinEnabled: boolean; token: string; message: string } {
  assertAuthorized(token);

  const props = PropertiesService.getScriptProperties();
  const currentlyEnabled = isAppPinEnabled();

  if (currentlyEnabled) {
    if (!payload.currentPin || !verifyPinCode(payload.currentPin)) {
      throw new Error('目前的 PIN 碼不正確，無法變更安全設定。');
    }
  }

  if (!payload.enable) {
    props.setProperty(SECURITY_PROP_KEYS.PIN_ENABLED, 'false');
    props.deleteProperty(SECURITY_PROP_KEYS.PIN_HASH);
    props.deleteProperty(SECURITY_PROP_KEYS.PIN_SALT);
    if (token) {
      CacheService.getUserCache().remove(SESSION_TOKEN_PREFIX + token);
    }
    return {
      ok: true,
      pinEnabled: false,
      token: '',
      message: '已關閉 App PIN 鎖。',
    };
  }

  const validNewPin = validatePinFormat(payload.newPin || '');
  const salt = Utilities.getUuid();
  const hash = sha256Hex(`${salt}:${validNewPin}`);

  props.setProperties({
    [SECURITY_PROP_KEYS.PIN_ENABLED]: 'true',
    [SECURITY_PROP_KEYS.PIN_SALT]: salt,
    [SECURITY_PROP_KEYS.PIN_HASH]: hash,
  });

  // 立即核發有效 Token，避免剛設定完就被踢出畫面
  const nextToken = token || Utilities.getUuid();
  CacheService.getUserCache().put(SESSION_TOKEN_PREFIX + nextToken, '1', SESSION_TTL_SECONDS);

  return {
    ok: true,
    pinEnabled: true,
    token: nextToken,
    message: currentlyEnabled ? 'PIN 碼已更新！' : '已啟用 App PIN 鎖（閒置 15 分鐘自動鎖定）。',
  };
}

/**
 * Google Sheets 選單專用：若忘記 PIN 碼，可從試算表一鍵清除 PIN 鎖
 */
function resetAppPinMenu(): void {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(SECURITY_PROP_KEYS.PIN_ENABLED, 'false');
  props.deleteProperty(SECURITY_PROP_KEYS.PIN_HASH);
  props.deleteProperty(SECURITY_PROP_KEYS.PIN_SALT);

  const msg = '已重設並關閉 Web App PIN 鎖，您現在可以直接開啟手機 Web App 重新設定。';
  safeToast(msg, '安全設定已重設', 6);
  const ui = getUiOrNull();
  if (ui) {
    ui.alert('PIN 鎖已重設', msg, ui.ButtonSet.OK);
  }
}
