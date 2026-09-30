// All schedules use the server's local timezone, consistently with clock-in/out.
function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localTimestamp(date = new Date()) {
  return `${localDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDate(date) === value && date.getFullYear() >= 2000 && date.getFullYear() <= 2100;
}

function normalizeTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) return null;
  return value.length === 5 ? `${value}:00` : value;
}

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function datesBetween(start, end) {
  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function shiftWindow(date, shift) {
  const start = `${date}T${normalizeTime(shift.start_time)}`;
  const overnight = shift.end_time <= shift.start_time;
  const end = `${overnight ? addDays(date, 1) : date}T${normalizeTime(shift.end_time)}`;
  return { start, end, overnight };
}

function classifyArrival(start, arrival, graceMinutes = 0) {
  const difference = (new Date(arrival) - new Date(start)) / 60000;
  if (difference < 0) return { status: 'Early', earlyMinutes: Math.ceil(-difference), lateMinutes: 0 };
  if (difference > graceMinutes) return { status: 'Late', earlyMinutes: 0, lateMinutes: Math.ceil(difference) };
  return { status: 'On time', earlyMinutes: 0, lateMinutes: 0 };
}

function createScheduling(db) {
  const findOverride = db.prepare(`SELECT r.*, s.name, s.start_time, s.end_time, s.grace_minutes
    FROM schedules r LEFT JOIN shifts s ON s.id = r.shift_id WHERE r.user_id = ? AND r.date = ?`);
  const findDefault = db.prepare(`SELECT s.* FROM users u JOIN shifts s ON s.id = u.shift_id WHERE u.id = ?`);

  function resolve(userId, date) {
    const override = findOverride.get(userId, date);
    let shift;
    let source;
    if (override) {
      if (!override.shift_id) return { date, off: true, source: 'Assigned day off', notes: override.notes, id: override.id };
      shift = override;
      source = 'Assigned schedule';
    } else {
      const day = new Date(`${date}T12:00:00`).getDay();
      shift = day !== 0 && day !== 6 ? findDefault.get(userId) : null;
      if (!shift) return { date, off: true, source: 'Day off', notes: '' };
      source = 'Default weekday shift';
    }
    return { date, off: false, source, notes: shift.notes || '', id: override?.id,
      shiftId: override ? override.shift_id : shift.id, name: shift.name,
      graceMinutes: shift.grace_minutes, ...shiftWindow(date, shift) };
  }

  function forPunch(userId, now) {
    const yesterday = resolve(userId, addDays(localDate(now), -1));
    if (!yesterday.off && yesterday.overnight && now >= new Date(yesterday.start) && now < new Date(yesterday.end)) return yesterday;
    return resolve(userId, localDate(now));
  }

  function summary(user, start, end, now = new Date()) {
    const records = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date BETWEEN ? AND ?').all(user.id, start, end);
    const byDate = new Map(records.map(record => [record.date, record]));
    let absent = 0;
    let scheduled = 0;
    // SQLite's CURRENT_TIMESTAMP is UTC; roster dates are local.
    const employmentStart = localDate(new Date(user.created_at.replace(' ', 'T') + 'Z'));
    for (const date of datesBetween(start, end)) {
      if (date < employmentStart) continue;
      const record = byDate.get(date);
      const schedule = resolve(user.id, date);
      // Completed records retain their original shift even if templates change.
      const expectedEnd = record?.scheduled_end || (!schedule.off ? schedule.end : null);
      if (!expectedEnd) continue;
      scheduled++;
      if (new Date(expectedEnd) <= now && !record?.punch_in_time) absent++;
    }
    return { scheduled, absent,
      present: records.filter(record => record.punch_in_time).length,
      late: records.filter(record => record.punch_in_time && record.is_late).length,
      early: records.filter(record => record.arrival_status === 'Early').length };
  }

  return { resolve, forPunch, summary };
}

module.exports = { localDate, localTimestamp, validDate, normalizeTime, addDays, datesBetween, shiftWindow, classifyArrival, createScheduling };
