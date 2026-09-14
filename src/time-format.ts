// Display and interpret mint times in UTC+8.

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function toUtc8Time(date: Date): string {
  const utc8 = new Date(date.getTime() + UTC8_OFFSET_MS);
  const day = utc8.getUTCDate();
  const month = utc8.getUTCMonth() + 1;
  const year = utc8.getUTCFullYear();
  const hours = utc8.getUTCHours();
  const minutes = utc8.getUTCMinutes().toString().padStart(2, "0");
  const seconds = utc8.getUTCSeconds().toString().padStart(2, "0");
  return `${day}/${month}/${year}, ${hours.toString().padStart(2, "0")}:${minutes}:${seconds}`;
}

// "21:05" → today at 21:05 UTC+8, expressed as a UTC Date.
export function utc8TimeToDate(hhmm: string): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`Invalid time "${hhmm}" — use HH:MM (24h, UTC+8)`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) throw new Error(`Invalid time "${hhmm}" — use HH:MM (24h, UTC+8)`);

  const todayUtc8 = new Date(Date.now() + UTC8_OFFSET_MS);
  todayUtc8.setUTCHours(hh, mm, 0, 0);
  return new Date(todayUtc8.getTime() - UTC8_OFFSET_MS);
}