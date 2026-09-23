// Chat exports write local wall-clock time and rarely say which time zone.
// Times are read as if they were UTC: the differences between messages are
// right, and no zone is invented. A daylight-saving switch skews one gap by an
// hour, which the statistics can live with.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMERIC_DATE = /(\d{1,4})[./-] ?(\d{1,2})[./-] ?(\d{1,4})/;
const DAY_MONTH_NAME = /(\d{1,2})[ -]([A-Za-z]{3})[a-z]*\.?[ -](\d{2,4})/;
const MONTH_NAME_DAY = /([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/;
const TIME = /(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?/;
const MERIDIEM = /\b([AaPp])\.? ?[Mm]\b\.?|오전|오후|午前|午後/;
const AFTERNOON = /^[Pp]|오후|午後/;

/**
 * Turns each message's raw stamp into milliseconds, or null when it holds no
 * full date and time. Numbers pass through. Whether 03/04 is March or April is
 * decided once for the whole chat, because a single stamp can't tell.
 */
export function readStamps(stamps) {
  const dates = stamps.map((stamp) => (typeof stamp === 'string' ? readDate(stamp) : null));
  const dayFirst = isDayFirst(dates, stamps);

  return stamps.map((stamp, i) => {
    if (typeof stamp === 'number') return stamp;
    const date = dates[i];
    const time = date && readTime(date.rest);
    if (!time) return null;
    const [day, month] = date.pair ? (dayFirst ? date.pair : [date.pair[1], date.pair[0]]) : [date.day, date.month];
    return toMs({ year: date.year, month, day, ...time });
  });
}

function readDate(stamp) {
  let m = NUMERIC_DATE.exec(stamp);
  if (m) {
    const rest = stamp.slice(m.index + m[0].length);
    const [a, b, c] = m.slice(1).map(Number);
    if (m[1].length === 4) return { year: a, month: b, day: c, rest };
    return { year: fullYear(c), pair: [a, b], rest };
  }
  m = DAY_MONTH_NAME.exec(stamp);
  if (m) return namedDate(m[1], m[2], m[3], stamp.slice(m.index + m[0].length));
  m = MONTH_NAME_DAY.exec(stamp);
  if (m) return namedDate(m[2], m[1], m[3], stamp.slice(m.index + m[0].length));
  return null;
}

function namedDate(day, monthName, year, rest) {
  const month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
  return month ? { year: fullYear(Number(year)), month, day: Number(day), rest } : null;
}

function fullYear(year) {
  return year < 100 ? 2000 + year : year;
}

/**
 * A number above 12 settles the order. Otherwise AM/PM hints at the US order
 * (month first); everyone else writes the day first.
 */
function isDayFirst(dates, stamps) {
  const pairs = dates.filter((date) => date?.pair).map((date) => date.pair);
  if (pairs.some(([first]) => first > 12)) return true;
  if (pairs.some(([, second]) => second > 12)) return false;
  return !stamps.some((stamp) => typeof stamp === 'string' && /\b[AaPp]\.? ?[Mm]\b/.test(stamp));
}

function readTime(text) {
  const m = TIME.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const meridiem = MERIDIEM.exec(text)?.[0];
  if (meridiem) hour = (hour % 12) + (AFTERNOON.test(meridiem) ? 12 : 0);
  return { hour, minute: Number(m[2]), second: Number(m[3] ?? 0) };
}

function toMs({ year, month, day, hour, minute, second }) {
  const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour < 24 && minute < 60 && second < 60;
  return valid ? Date.UTC(year, month - 1, day, hour, minute, second) : null;
}
