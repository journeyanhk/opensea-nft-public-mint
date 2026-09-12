// Display and interpret mint times in Vietnam time (UTC+7).

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function toVNTime(date: Date): string {
  const vn = new Date(date.getTime() + VN_OFFSET_MS);
  const day = vn.getUTCDate();
  const month = vn.getUTCMonth() + 1;
  const year = vn.getUTCFullYear();
  const hours = vn.getUTCHours();
  const minutes = vn.getUTCMinutes().toString().padStart(2, "0");
  const seconds = vn.getUTCSeconds().toString().padStart(2, "0");
  return `${day}/${month}/${year}, ${hours.toString().padStart(2, "0")}:${minutes}:${seconds}`;
}

// "21:05" → today at 21:05 VN (UTC+7), expressed as a UTC Date.
export function vnTimeToDate(hhmm: string): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`Thời gian "${hhmm}" không hợp lệ — dùng HH:MM (24 giờ, VN (UTC+7))`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) throw new Error(`Thời gian "${hhmm}" không hợp lệ — dùng HH:MM (24 giờ, VN (UTC+7))`);

  const todayVN = new Date(Date.now() + VN_OFFSET_MS);
  todayVN.setUTCHours(hh, mm, 0, 0);
  return new Date(todayVN.getTime() - VN_OFFSET_MS);
}
