const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('./db');
require('./setup').initializeDatabase(db);
const {
  localDate, localTimestamp, validDate, normalizeTime, addDays,
  datesBetween, shiftWindow, classifyArrival, createScheduling
} = require('./scheduling');

const app = express();
const port = Number(process.env.PORT) || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, fields: 2, files: 1 } });
const scheduling = createScheduling(db);
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 28800000 }
}));

function monthBounds(value) {
  const valid = /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || '') ? value : localDate().slice(0, 7);
  const [year, month] = valid.split('-').map(Number);
  return { value: valid, start: `${valid}-01`,
    end: `${valid}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}` };
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function requireAuth(req, res, next) {
  if (!res.locals.user?.is_active) {
    delete req.session.userId;
    flash(req, 'error', 'Please sign in to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user?.is_admin) {
    flash(req, 'error', 'Administrator access is required.');
    return res.redirect('/dashboard');
  }
  next();
}

function verifyCsrf(req, res, next) {
  const given = String(req.body?.csrfToken || '');
  const expected = req.session.csrfToken;
  if (Buffer.byteLength(given) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(403).render('error', { title: 'Request rejected', message: 'Refresh the page and try again.' });
  }
  next();
}

app.use((req, res, next) => {
  res.locals.user = req.session.userId
    ? db.prepare(`SELECT u.*, d.name department_name, s.name shift_name, s.start_time
        FROM users u LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN shifts s ON s.id = u.shift_id WHERE u.id = ?`).get(req.session.userId)
    : null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.dayNames = dayNames;
  res.locals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  next();
});

// Multipart tokens are checked after the bounded upload parser on that route.
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path === '/admin/import') return next();
  verifyCsrf(req, res, next);
});

app.get('/', (req, res) => res.render('index', { title: 'Smart Attendance, Simplified' }));
app.get('/login', (req, res) => res.locals.user ? res.redirect('/dashboard') : res.render('login', { title: 'Sign in' }));
app.post('/login', (req, res) => {
  const id = String(req.body.employeeId || '').trim().toUpperCase();
  const user = db.prepare('SELECT * FROM users WHERE employee_id = ? AND is_active = 1').get(id);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    flash(req, 'error', 'Invalid Employee ID or password.');
    return res.redirect('/login');
  }
  req.session.regenerate(error => {
    if (error) return res.status(500).render('error', { title: 'Sign-in error', message: 'Please try again.' });
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    flash(req, 'success', `Welcome back, ${user.first_name}!`);
    res.redirect('/dashboard');
  });
});
app.get('/register', (req, res) => res.render('register', {
  title: 'Create account',
  departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
  shifts: db.prepare('SELECT * FROM shifts ORDER BY start_time').all()
}));
app.post('/register', (req, res) => {
  const id = String(req.body.employeeId || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  const department = db.prepare('SELECT id FROM departments WHERE id = ?').get(Number(req.body.departmentId) || 0);
  const shift = db.prepare('SELECT id FROM shifts WHERE id = ?').get(Number(req.body.shiftId) || 0);
  if (!id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !firstName || !lastName ||
      password.length < 8 || !department || !shift) {
    flash(req, 'error', 'Complete every field, select a department and shift, and use a password of at least 8 characters.');
    return res.redirect('/register');
  }
  try {
    db.prepare(`INSERT INTO users (employee_id, password_hash, first_name, last_name, email, department_id, shift_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, bcrypt.hashSync(password, 12), firstName, lastName, email, department.id, shift.id);
    flash(req, 'success', 'Account created. You can now sign in.');
    res.redirect('/login');
  } catch {
    flash(req, 'error', 'That Employee ID or email is already registered.');
    res.redirect('/register');
  }
});
app.post('/logout', requireAuth, (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/dashboard', requireAuth, (req, res) => {
  const now = new Date();
  const today = localDate(now);
  const month = monthBounds(today.slice(0, 7));
  const userId = res.locals.user.id;
  const attendance = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC')
    .all(userId, month.start, month.end);
  const openRecord = db.prepare(`SELECT * FROM attendance WHERE user_id = ? AND punch_in_time IS NOT NULL
    AND punch_out_time IS NULL ORDER BY date DESC LIMIT 1`).get(userId);
  const todaySchedule = scheduling.forPunch(userId, now);
  const todayRecord = openRecord || db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(userId, todaySchedule.date);
  const upcoming = datesBetween(today, addDays(today, 13)).map(date => scheduling.resolve(userId, date));
  res.render('dashboard', {
    title: 'Dashboard', attendance, todayRecord, todaySchedule, upcoming, today,
    ...scheduling.summary(res.locals.user, month.start, month.end, now)
  });
});

app.post('/attendance/punch-in', requireAuth, (req, res) => {
  const userId = res.locals.user.id;
  const now = new Date();
  const schedule = scheduling.forPunch(userId, now);
  const open = db.prepare(`SELECT id FROM attendance WHERE user_id = ? AND punch_in_time IS NOT NULL
    AND punch_out_time IS NULL LIMIT 1`).get(userId);
  const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(userId, schedule.date);
  if (open) flash(req, 'error', 'Punch out of your open attendance record before starting another shift.');
  else if (schedule.off) flash(req, 'error', 'Today is a day off. Ask an administrator to assign a shift before punching in.');
  else if (existing?.punch_in_time) flash(req, 'error', 'Attendance has already been recorded for this shift date.');
  else if (now >= new Date(schedule.end)) flash(req, 'error', 'This scheduled shift has already ended.');
  else {
    const arrival = localTimestamp(now);
    const result = classifyArrival(schedule.start, arrival, schedule.graceMinutes);
    db.prepare(`INSERT INTO attendance
      (user_id, date, punch_in_time, is_late, scheduled_start, scheduled_end, shift_name,
       grace_minutes, arrival_status, early_minutes, late_minutes, punch_in_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET punch_in_time = excluded.punch_in_time,
      is_late = excluded.is_late, scheduled_start = excluded.scheduled_start, scheduled_end = excluded.scheduled_end,
      shift_name = excluded.shift_name, grace_minutes = excluded.grace_minutes,
      arrival_status = excluded.arrival_status, early_minutes = excluded.early_minutes,
      late_minutes = excluded.late_minutes, punch_in_at = excluded.punch_in_at, updated_at = CURRENT_TIMESTAMP`)
      .run(userId, schedule.date, arrival.slice(11), result.status === 'Late' ? 1 : 0, schedule.start,
        schedule.end, schedule.name, schedule.graceMinutes, result.status, result.earlyMinutes, result.lateMinutes, arrival);
    const detail = result.status === 'Early' ? ` · ${result.earlyMinutes} min early`
      : result.status === 'Late' ? ` · ${result.lateMinutes} min late` : ' · On time';
    flash(req, 'success', `Punch-in recorded at ${arrival.slice(11, 16)}${detail}.`);
  }
  res.redirect('/dashboard');
});

app.post('/attendance/punch-out', requireAuth, (req, res) => {
  const record = db.prepare(`SELECT * FROM attendance WHERE user_id = ? AND punch_in_time IS NOT NULL
    AND punch_out_time IS NULL ORDER BY date DESC LIMIT 1`).get(res.locals.user.id);
  if (!record) flash(req, 'error', 'There is no open shift to punch out of.');
  else {
    const now = localTimestamp();
    db.prepare('UPDATE attendance SET punch_out_time = ?, punch_out_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(now.slice(11), now, record.id);
    flash(req, 'success', `Punch-out recorded at ${now.slice(11, 16)} for the shift on ${record.date}.`);
  }
  res.redirect('/dashboard');
});

app.get('/admin/schedules', requireAuth, requireAdmin, (req, res) => {
  const month = monthBounds(String(req.query.month || ''));
  const employeeId = Number(req.query.employee || 0);
  const employees = db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY first_name, last_name').all();
  const assignments = db.prepare(`SELECT r.*, u.employee_id, u.first_name, u.last_name,
    s.name shift_name, s.start_time, s.end_time, s.grace_minutes,
    EXISTS(SELECT 1 FROM attendance a WHERE a.user_id = r.user_id AND a.date = r.date AND a.punch_in_time IS NOT NULL) locked
    FROM schedules r JOIN users u ON u.id = r.user_id LEFT JOIN shifts s ON s.id = r.shift_id
    WHERE r.date BETWEEN ? AND ? AND (? = 0 OR r.user_id = ?) ORDER BY r.date, u.first_name`)
    .all(month.start, month.end, employeeId, employeeId);
  const roster = employeeId && employees.some(user => user.id === employeeId)
    ? datesBetween(month.start, month.end).map(date => scheduling.resolve(employeeId, date)) : [];
  res.render('schedules', {
    title: 'Shift schedules', month, employeeId, employees, assignments, roster, today: localDate(),
    shifts: db.prepare('SELECT * FROM shifts ORDER BY start_time, name').all()
  });
});

app.post('/admin/shifts', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const start = normalizeTime(req.body.startTime);
  const end = normalizeTime(req.body.endTime);
  const grace = Number(req.body.graceMinutes);
  if (!name || name.length > 60 || !start || !end || start === end ||
      !Number.isInteger(grace) || grace < 0 || grace > 120) {
    flash(req, 'error', 'Enter a shift name, different valid start/end times, and a grace period between 0 and 120 minutes.');
  } else if (db.prepare('SELECT id FROM shifts WHERE lower(name) = lower(?)').get(name)) {
    flash(req, 'error', 'A shift with that name already exists.');
  } else {
    db.prepare('INSERT INTO shifts (name, start_time, end_time, grace_minutes) VALUES (?, ?, ?, ?)').run(name, start, end, grace);
    flash(req, 'success', `Created the "${name}" shift. You can now assign it to employees.`);
  }
  res.redirect('/admin/schedules');
});

app.post('/admin/schedules', requireAuth, requireAdmin, (req, res) => {
  const start = String(req.body.startDate || '');
  const end = String(req.body.endDate || '');
  const shiftId = req.body.shiftId === 'off' ? null : Number(req.body.shiftId);
  const notes = String(req.body.notes || '').trim();
  const rawDays = [].concat(req.body.weekdays || []).map(Number);
  const weekdays = new Set(rawDays);
  const employeeValue = String(req.body.employee || '');
  const users = employeeValue === 'all'
    ? db.prepare('SELECT * FROM users WHERE is_active = 1').all()
    : db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').all(Number(employeeValue) || 0);
  const shift = shiftId ? db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) : null;
  const fail = message => { flash(req, 'error', message); return res.redirect('/admin/schedules'); };
  if (!validDate(start) || !validDate(end) || end < start || start < localDate()) {
    return fail('Choose today or a future start date, and an end date on or after the start date.');
  }
  if (datesBetween(start, end).length > 93) return fail('Assign a maximum of 93 days at a time.');
  if (!users.length || (shiftId !== null && !shift) || !weekdays.size ||
      rawDays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || notes.length > 200) {
    return fail('Select employees, a shift or day off, at least one weekday, and notes of at most 200 characters.');
  }
  const dates = datesBetween(start, end).filter(date => weekdays.has(new Date(`${date}T12:00:00`).getDay()));
  if (!dates.length) return fail('No dates in that range match the selected weekdays.');
  const dateSet = new Set(dates);
  const findAttendance = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ? AND punch_in_time IS NOT NULL');
  const findExisting = db.prepare('SELECT id FROM schedules WHERE user_id = ? AND date = ?');
  const upsert = db.prepare(`INSERT INTO schedules (user_id, date, shift_id, notes, created_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET shift_id = excluded.shift_id, notes = excluded.notes,
    created_by = excluded.created_by, updated_at = CURRENT_TIMESTAMP`);
  try {
    db.transaction(() => {
      for (const user of users) {
        const effective = date => dateSet.has(date)
          ? (shift ? { off: false, ...shiftWindow(date, shift) } : { off: true })
          : scheduling.resolve(user.id, date);
        for (const date of dates) {
          if (findAttendance.get(user.id, date)) throw new Error(`${user.employee_id} has already punched in on ${date}. Recorded shifts cannot be replaced.`);
          if (findExisting.get(user.id, date) && req.body.replace !== 'yes') {
            throw new Error(`${user.employee_id} already has an assignment on ${date}. Check "Replace existing assignments" to update it.`);
          }
          const candidate = effective(date);
          if (!candidate.off) {
            for (const neighborDate of [addDays(date, -1), addDays(date, 1)]) {
              const neighbor = effective(neighborDate);
              if (!neighbor.off && candidate.start < neighbor.end && neighbor.start < candidate.end) {
                throw new Error(`The shift for ${user.employee_id} on ${date} overlaps the shift on ${neighborDate}. Assign a different shift or day off first.`);
              }
            }
          }
        }
      }
      for (const user of users) for (const date of dates) upsert.run(user.id, date, shiftId, notes, res.locals.user.id);
    })();
    flash(req, 'success', `Saved ${dates.length * users.length} assignment(s) for ${users.length} employee(s).`);
  } catch (error) {
    flash(req, 'error', error.message);
  }
  res.redirect(`/admin/schedules?month=${start.slice(0, 7)}`);
});

app.post('/admin/schedules/:id/remove', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(req.params.id) || 0);
  const locked = row && db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ? AND punch_in_time IS NOT NULL').get(row.user_id, row.date);
  if (!row || row.date < localDate() || locked) {
    flash(req, 'error', 'Only current or future assignments without recorded attendance can be reset.');
  } else {
    const fallback = db.prepare('SELECT s.* FROM users u JOIN shifts s ON s.id = u.shift_id WHERE u.id = ?').get(row.user_id);
    const weekday = new Date(`${row.date}T12:00:00`).getDay();
    const candidate = fallback && weekday !== 0 && weekday !== 6 ? shiftWindow(row.date, fallback) : null;
    const overlapping = candidate && [addDays(row.date, -1), addDays(row.date, 1)].some(date => {
      const neighbor = scheduling.resolve(row.user_id, date);
      return !neighbor.off && candidate.start < neighbor.end && neighbor.start < candidate.end;
    });
    if (overlapping) flash(req, 'error', 'Resetting would overlap an adjacent shift. Adjust that assignment first.');
    else {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(row.id);
      flash(req, 'success', 'Assignment reset to the employee’s default weekday shift or weekend day off.');
    }
  }
  res.redirect('/admin/schedules');
});

app.get('/admin/report', requireAuth, requireAdmin, (req, res) => {
  const month = monthBounds(String(req.query.month || ''));
  const departmentId = Number(req.query.department || 0);
  const users = db.prepare(`SELECT u.*, d.name department_name FROM users u
    LEFT JOIN departments d ON d.id = u.department_id WHERE u.is_active = 1 AND (? = 0 OR u.department_id = ?)
    ORDER BY d.name, u.employee_id`).all(departmentId, departmentId);
  const employees = users.map(user => ({ ...user, ...scheduling.summary(user, month.start, month.end) }));
  res.render('report', { title: 'Attendance report', month, departmentId, employees,
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all() });
});

app.post('/admin/import', requireAuth, requireAdmin, upload.single('attendanceFile'), verifyCsrf, (req, res) => {
  if (!req.file || !req.file.originalname.toLowerCase().endsWith('.csv')) {
    flash(req, 'error', 'Choose a CSV file up to 2 MB.');
    return res.redirect('/admin/report');
  }
  try {
    const rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    const findUser = db.prepare('SELECT id FROM users WHERE employee_id = ? AND is_active = 1');
    const findRecord = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?');
    const upsert = db.prepare(`INSERT INTO attendance
      (user_id, date, punch_in_time, punch_out_time, is_late, scheduled_start, scheduled_end,
       shift_name, grace_minutes, arrival_status, early_minutes, late_minutes, punch_in_at, punch_out_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET punch_in_time = excluded.punch_in_time,
      punch_out_time = excluded.punch_out_time, is_late = excluded.is_late,
      scheduled_start = excluded.scheduled_start, scheduled_end = excluded.scheduled_end,
      shift_name = excluded.shift_name, grace_minutes = excluded.grace_minutes,
      arrival_status = excluded.arrival_status, early_minutes = excluded.early_minutes,
      late_minutes = excluded.late_minutes, punch_in_at = excluded.punch_in_at,
      punch_out_at = excluded.punch_out_at, updated_at = CURRENT_TIMESTAMP`);
    let imported = 0;
    let skipped = 0;
    db.transaction(() => {
      for (const row of rows) {
        const id = String(row['Employee ID'] || row.employee_id || '').trim().toUpperCase();
        const date = row.Date || row.date;
        const input = normalizeTime(row['Punch In Time'] || row.punch_in);
        const rawOut = row['Punch Out Time'] || row.punch_out || '';
        const output = rawOut ? normalizeTime(rawOut) : null;
        const user = findUser.get(id);
        if (!user || !validDate(date) || !input || (rawOut && !output) || date > localDate()) { skipped++; continue; }
        const existing = findRecord.get(user.id, date);
        const assigned = scheduling.resolve(user.id, date);
        const schedule = existing?.scheduled_start
          ? { start: existing.scheduled_start, end: existing.scheduled_end, name: existing.shift_name, graceMinutes: existing.grace_minutes }
          : assigned;
        if (schedule.off || (!existing?.scheduled_start && existing?.punch_in_time)) { skipped++; continue; }
        const arrivalDate = schedule.end.slice(0, 10) !== date && input < schedule.start.slice(11)
          && input <= schedule.end.slice(11) ? addDays(date, 1) : date;
        const arrival = `${arrivalDate}T${input}`;
        const departure = output ? `${output < input ? addDays(arrivalDate, 1) : arrivalDate}T${output}` : null;
        if (new Date(arrival) >= new Date(schedule.end) || new Date(arrival) > new Date() ||
            (departure && (new Date(departure) <= new Date(arrival) || new Date(departure) > new Date()))) { skipped++; continue; }
        const result = classifyArrival(schedule.start, arrival, schedule.graceMinutes);
        upsert.run(user.id, date, input, output, result.status === 'Late' ? 1 : 0, schedule.start, schedule.end,
          schedule.name, schedule.graceMinutes, result.status, result.earlyMinutes, result.lateMinutes, arrival, departure);
        imported++;
      }
    })();
    flash(req, 'success', `Imported ${imported} attendance record(s); skipped ${skipped} invalid, unscheduled, or legacy row(s).`);
  } catch {
    flash(req, 'error', 'The CSV could not be read. Check its headers and formatting.');
  }
  res.redirect('/admin/report');
});

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you requested does not exist.' }));
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    flash(req, 'error', 'Upload one CSV file up to 2 MB.');
    return res.redirect('/admin/report');
  }
  console.error(error);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
});
if (require.main === module) {
  app.listen(port, () => console.log(`Attendly is running at http://localhost:${port}`));
}
module.exports = app;
