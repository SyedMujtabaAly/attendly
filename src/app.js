const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT) || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

function dateOnly(date = new Date()) {
  return date.toLocaleDateString('en-CA');
}

function timeOnly(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function monthBounds(value) {
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(value || '') ? value : dateOnly().slice(0, 7);
  const [year, month] = valid.split('-').map(Number);
  const end = new Date(year, month, 0).getDate();
  return { value: valid, start: `${valid}-01`, end: `${valid}-${String(end).padStart(2, '0')}`, year, month };
}

function elapsedWeekdays(year, month) {
  const now = new Date();
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  if (first > now) return 0;
  const end = last > now ? now : last;
  let total = 0;
  for (const day = new Date(first); day <= end; day.setDate(day.getDate() + 1)) {
    if (day.getDay() !== 0 && day.getDay() !== 6) total += 1;
  }
  return total;
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    setFlash(req, 'error', 'Please sign in to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user?.is_admin) {
    setFlash(req, 'error', 'Administrator access is required.');
    return res.redirect('/dashboard');
  }
  next();
}

app.use((req, res, next) => {
  res.locals.user = req.session.userId
    ? db.prepare(`SELECT u.*, d.name department_name, s.name shift_name, s.start_time
        FROM users u LEFT JOIN departments d ON d.id=u.department_id
        LEFT JOIN shifts s ON s.id=u.shift_id WHERE u.id=?`).get(req.session.userId)
    : null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

app.use((req, res, next) => {
  if (req.method === 'POST' && !crypto.timingSafeEqual(
    Buffer.from(String(req.body.csrfToken || '').padEnd(64).slice(0, 64)),
    Buffer.from(req.session.csrfToken)
  )) return res.status(403).render('error', { title: 'Request rejected', message: 'Refresh the page and try again.' });
  next();
});

app.get('/', (req, res) => res.render('index', { title: 'Smart Attendance, Simplified' }));

app.get('/login', (req, res) => res.locals.user ? res.redirect('/dashboard') : res.render('login', { title: 'Sign in' }));
app.post('/login', (req, res) => {
  const employeeId = String(req.body.employeeId || '').trim().toUpperCase();
  const user = db.prepare('SELECT * FROM users WHERE employee_id=? AND is_active=1').get(employeeId);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    setFlash(req, 'error', 'Invalid Employee ID or password.');
    return res.redirect('/login');
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).render('error', { title: 'Sign-in error', message: 'Please try again.' });
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    setFlash(req, 'success', `Welcome back, ${user.first_name}!`);
    res.redirect('/dashboard');
  });
});

app.get('/register', (req, res) => {
  res.render('register', {
    title: 'Create account',
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    shifts: db.prepare('SELECT * FROM shifts ORDER BY start_time').all()
  });
});
app.post('/register', (req, res) => {
  const employeeId = String(req.body.employeeId || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!employeeId || !email || !req.body.firstName || !req.body.lastName || password.length < 8) {
    setFlash(req, 'error', 'Complete every field and use a password of at least 8 characters.');
    return res.redirect('/register');
  }
  try {
    db.prepare(`INSERT INTO users
      (employee_id,password_hash,first_name,last_name,email,department_id,shift_id)
      VALUES (?,?,?,?,?,?,?)`).run(employeeId, bcrypt.hashSync(password, 12), String(req.body.firstName).trim(),
      String(req.body.lastName).trim(), email, Number(req.body.departmentId), Number(req.body.shiftId));
    setFlash(req, 'success', 'Account created. You can now sign in.');
    res.redirect('/login');
  } catch {
    setFlash(req, 'error', 'That Employee ID or email is already registered.');
    res.redirect('/register');
  }
});

app.post('/logout', requireAuth, (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/dashboard', requireAuth, (req, res) => {
  const today = dateOnly();
  const month = monthBounds(today.slice(0, 7));
  const attendance = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date DESC')
    .all(res.locals.user.id, month.start, month.end);
  const todayRecord = attendance.find((record) => record.date === today);
  const present = attendance.filter((record) => record.punch_in_time).length;
  const late = attendance.filter((record) => record.is_late).length;
  res.render('dashboard', {
    title: 'Dashboard', attendance, todayRecord, present, late,
    absent: Math.max(0, elapsedWeekdays(month.year, month.month) - present), today
  });
});

app.post('/attendance/punch-in', requireAuth, (req, res) => {
  const today = dateOnly();
  const now = timeOnly();
  const existing = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(res.locals.user.id, today);
  if (existing?.punch_in_time) {
    setFlash(req, 'error', 'You have already punched in today.');
  } else {
    const late = res.locals.user.start_time && now > res.locals.user.start_time ? 1 : 0;
    db.prepare(`INSERT INTO attendance (user_id,date,punch_in_time,is_late) VALUES (?,?,?,?)
      ON CONFLICT(user_id,date) DO UPDATE SET punch_in_time=excluded.punch_in_time,is_late=excluded.is_late,updated_at=CURRENT_TIMESTAMP`)
      .run(res.locals.user.id, today, now, late);
    setFlash(req, 'success', `Punch-in recorded at ${now.slice(0, 5)}${late ? ' (Late)' : ''}.`);
  }
  res.redirect('/dashboard');
});

app.post('/attendance/punch-out', requireAuth, (req, res) => {
  const record = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(res.locals.user.id, dateOnly());
  if (!record?.punch_in_time) setFlash(req, 'error', 'Punch in before punching out.');
  else if (record.punch_out_time) setFlash(req, 'error', 'You have already punched out today.');
  else {
    const now = timeOnly();
    db.prepare('UPDATE attendance SET punch_out_time=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(now, record.id);
    setFlash(req, 'success', `Punch-out recorded at ${now.slice(0, 5)}.`);
  }
  res.redirect('/dashboard');
});

app.get('/admin/report', requireAuth, requireAdmin, (req, res) => {
  const month = monthBounds(String(req.query.month || ''));
  const departmentId = Number(req.query.department || 0);
  const employees = db.prepare(`SELECT u.id,u.employee_id,u.first_name,u.last_name,d.name department_name,
    COUNT(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 END) present,
    COALESCE(SUM(a.is_late),0) late
    FROM users u LEFT JOIN departments d ON d.id=u.department_id
    LEFT JOIN attendance a ON a.user_id=u.id AND a.date BETWEEN ? AND ?
    WHERE u.is_active=1 AND (?=0 OR u.department_id=?)
    GROUP BY u.id ORDER BY d.name,u.employee_id`).all(month.start, month.end, departmentId, departmentId);
  const workingDays = elapsedWeekdays(month.year, month.month);
  res.render('report', {
    title: 'Attendance report', month, departmentId, workingDays,
    employees, departments: db.prepare('SELECT * FROM departments ORDER BY name').all()
  });
});

app.post('/admin/import', requireAuth, requireAdmin, upload.single('attendanceFile'), (req, res) => {
  if (!req.file || !req.file.originalname.toLowerCase().endsWith('.csv')) {
    setFlash(req, 'error', 'Choose a CSV file up to 2 MB.');
    return res.redirect('/admin/report');
  }
  try {
    const rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    const findUser = db.prepare('SELECT u.id,s.start_time FROM users u LEFT JOIN shifts s ON s.id=u.shift_id WHERE u.employee_id=?');
    const upsert = db.prepare(`INSERT INTO attendance (user_id,date,punch_in_time,punch_out_time,is_late)
      VALUES (?,?,?,?,?) ON CONFLICT(user_id,date) DO UPDATE SET punch_in_time=excluded.punch_in_time,
      punch_out_time=excluded.punch_out_time,is_late=excluded.is_late,updated_at=CURRENT_TIMESTAMP`);
    let imported = 0;
    db.transaction(() => {
      for (const row of rows) {
        const employeeId = row['Employee ID'] || row.employee_id;
        const date = row.Date || row.date;
        const punchIn = row['Punch In Time'] || row.punch_in;
        if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !punchIn) continue;
        const user = findUser.get(String(employeeId).toUpperCase());
        if (!user) continue;
        const normalizedIn = punchIn.length === 5 ? `${punchIn}:00` : punchIn;
        const rawOut = row['Punch Out Time'] || row.punch_out || null;
        upsert.run(user.id, date, normalizedIn, rawOut?.length === 5 ? `${rawOut}:00` : rawOut, normalizedIn > user.start_time ? 1 : 0);
        imported += 1;
      }
    })();
    setFlash(req, 'success', `Imported ${imported} attendance record(s).`);
  } catch {
    setFlash(req, 'error', 'The CSV could not be read. Check its headers and formatting.');
  }
  res.redirect('/admin/report');
});

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you requested does not exist.' }));
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
});

if (require.main === module) {
  require('./setup');
  app.listen(port, () => console.log(`Attendly is running at http://localhost:${port}`));
}

module.exports = app;
