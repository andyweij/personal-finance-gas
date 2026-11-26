import { APP_TIMEZONE } from './constants';

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  ymd: string;
  yearMonth: string;
}

/**
 * v1.8.13: calendar date of an instant in a time zone (APP_TIMEZONE by default) via Intl.DateTimeFormat —
 * replaces the hard-coded +8 hour shift. Falls back to Asia/Taipei for an unknown zone name.
 */
export function getDatePartsInTimeZone(date: Date, timeZone: string = APP_TIMEZONE): ZonedDateParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
  return { year, month, day, ymd: `${yearMonth}-${String(day).padStart(2, '0')}`, yearMonth };
}

/** "Today" (YYYY-MM-DD) in the app's time zone — the single helper for every "today" in the app. */
export function todayInTimeZone(timeZone: string = APP_TIMEZONE, now: Date = new Date()): string {
  return getDatePartsInTimeZone(now, timeZone).ymd;
}

/** The YYYY-MM month before `yearMonth`. */
export function previousYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

/** v1.8.15: YYYY-MM-DD of a stored ISO timestamp in the app time zone (admin screens, file names) */
export function ymdInTimeZone(iso: string, timeZone: string = APP_TIMEZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(0, 10);
  return getDatePartsInTimeZone(d, timeZone).ymd;
}
