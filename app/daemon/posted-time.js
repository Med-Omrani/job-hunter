'use strict';

function computePostedAt(item, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;

  const hours = item.postedHoursAgo;
  if (typeof hours === 'number' && Number.isFinite(hours) && hours >= 0 && hours <= 24 * 365) {
    return new Date(now - hours * 3600e3);
  }

  const raw = [item.pubDate, item.publishedAt, item.postedAtHint,
    typeof item.date === 'string' && item.date, item.published]
    .filter((x) => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
  const rel = raw.join(' | ');

  const m = rel.match(/il y a\s+(\d+)\s*(min(?:ute)?s?|heure|heures|h|jour|jours)\b/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const ms = u.startsWith('min') ? n * 60e3
      : u.startsWith('heure') || u === 'h' ? n * 3600e3
      : n * 86400e3;
    return new Date(now - ms);
  }
  const m2 = rel.match(/(\d+)\s*(min(?:ute)?s?|heure|heures|h|jour|jours)\b/i);
  if (m2) {
    const n = Number(m2[1]);
    const u = m2[2].toLowerCase();
    const ms = u.startsWith('min') ? n * 60e3
      : u.startsWith('heure') || u === 'h' ? n * 3600e3
      : n * 86400e3;
    return new Date(now - ms);
  }
  if (/hier/i.test(rel)) return new Date(now - 86400e3);
  if (/aujourd'?hui/i.test(rel)) return new Date(now);

  for (const s of raw) {
    const dm = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    if (dm) {
      const dd = new Date(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]));
      if (!Number.isNaN(dd.getTime())) return dd;
    }
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      if (Math.abs(d.getTime() - now) < 24 * 365 * 3600e3) return d;
    }
  }

  const num = item.date;
  if (typeof num === 'number' && Number.isFinite(num)) {
    const ms = num > 10000000000 ? num : num * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

module.exports = { computePostedAt };