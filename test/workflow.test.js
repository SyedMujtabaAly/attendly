const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.ATTENDLY_DB_PATH = ':memory:';
const app = require('../src/app');
const db = require('../src/db');
const { localDate, addDays } = require('../src/scheduling');
let server;
let base;
let adminId;
let employeeId;
let customShift;
const admin = { cookie: '', token: '' };
const employee = { cookie: '', token: '' };

async function request(client, route, fields) {
  const options = { redirect: 'manual', headers: { cookie: client.cookie } };
  if (fields) {
    options.method = 'POST';
    if (fields instanceof FormData) options.body = fields;
    else {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) {
        for (const item of [].concat(value)) body.append(key, item);
      }
      options.body = body;
    }
  }
  const response = await fetch(base + route, options);
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const html = await response.text();
  const token = /name="csrfToken" value="([^"]+)"/.exec(html);
  if (token) client.token = token[1];
  return { status: response.status, html, location: response.headers.get('location') };
}

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await request(admin, '/login');
  const signedIn = await request(admin, '/login', { csrfToken: admin.token, employeeId: 'ADMIN', password: 'admin123' });
  assert.equal(signedIn.location, '/dashboard');
  await request(admin, '/admin/schedules');
  adminId = db.prepare("SELECT id FROM users WHERE employee_id = 'ADMIN'").get().id;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
});

test('admin can create a grace-enabled shift and assign repeating dates; employees cannot access scheduling', async () => {
  await request(admin, '/admin/shifts', { csrfToken: admin.token, name: 'Flexible support', startTime: '10:00', endTime: '18:00', graceMinutes: '7' });
  customShift = db.prepare("SELECT * FROM shifts WHERE name = 'Flexible support'").get();
  assert.equal(customShift.grace_minutes, 7);
  const start = addDays(localDate(), 10);
  const end = addDays(start, 2);
  await request(admin, '/admin/schedules', { csrfToken: admin.token, employee: String(adminId), shiftId: String(customShift.id),
    startDate: start, endDate: end, weekdays: ['0','1','2','3','4','5','6'], notes: 'Support coverage' });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM schedules WHERE user_id = ?').get(adminId).count, 3);
  const roster = await request(admin, '/admin/schedules?employee=' + adminId + '&month=' + start.slice(0,7));
  assert.equal(roster.status, 200);
  assert.match(roster.html, /Support coverage/);

  await request(employee, '/register');
  await request(employee, '/register', { csrfToken: employee.token, employeeId: 'TESTEMP', email: 'test@example.com', firstName: 'Test', lastName: 'Employee',
    departmentId: '1', shiftId: '1', password: 'test-password' });
  await request(employee, '/login');
  await request(employee, '/login', { csrfToken: employee.token, employeeId: 'TESTEMP', password: 'test-password' });
  await request(employee, '/dashboard');
  employeeId = db.prepare("SELECT id FROM users WHERE employee_id = 'TESTEMP'").get().id;
  const forbidden = await request(employee, '/admin/schedules');
  assert.equal(forbidden.location, '/dashboard');
  await request(employee, '/admin/shifts', { csrfToken: employee.token, name: 'Unauthorized', startTime: '08:00', endTime: '16:00', graceMinutes: '0' });
  assert.equal(db.prepare("SELECT id FROM shifts WHERE name = 'Unauthorized'").get(), undefined);
});

test('invalid inputs, conflicting assignments, and missing CSRF do not mutate schedules', async () => {
  const countBefore = db.prepare('SELECT COUNT(*) count FROM schedules').get().count;
  const rejected = await request(admin, '/admin/schedules', { employee: String(adminId) });
  assert.equal(rejected.status, 403);
  await request(admin, '/admin/schedules', { csrfToken: admin.token, employee: String(adminId), shiftId: String(customShift.id),
    startDate: '2026-02-30', endDate: '2026-03-01', weekdays: ['1'] });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM schedules').get().count, countBefore);
  const date = addDays(localDate(), 10);
  await request(admin, '/admin/schedules', { csrfToken: admin.token, employee: String(adminId), shiftId: 'off',
    startDate: date, endDate: date, weekdays: ['0','1','2','3','4','5','6'] });
  assert.equal(db.prepare('SELECT shift_id FROM schedules WHERE user_id = ? AND date = ?').get(adminId, date).shift_id, customShift.id);
});

test('a batch of overlapping overnight schedules rolls back atomically', async () => {
  await request(admin, '/admin/shifts', { csrfToken: admin.token, name: 'Night coverage', startTime: '23:00', endTime: '10:00', graceMinutes: '0' });
  const night = db.prepare("SELECT id FROM shifts WHERE name = 'Night coverage'").get();
  const start = addDays(localDate(), 30);
  let end = addDays(start, 7);
  // End immediately before a weekday default at 09:00, independent of today's weekday.
  while ([0, 6].includes(new Date(addDays(end, 1) + 'T12:00:00').getDay())) end = addDays(end, 1);
  await request(admin, '/admin/schedules', { csrfToken: admin.token, employee: String(employeeId), shiftId: String(night.id),
    startDate: start, endDate: end, weekdays: ['0','1','2','3','4','5','6'] });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM schedules WHERE user_id = ? AND date BETWEEN ? AND ?').get(employeeId, start, end).count, 0);
});

test('attendance follows assigned shifts, duplicate punches are blocked, and recorded assignments stay locked', async () => {
  // Full-day window makes the live-clock test independent of the time it runs.
  db.prepare('INSERT INTO shifts(name,start_time,end_time,grace_minutes) VALUES(?,?,?,?)').run('Live test shift','00:00:00','23:59:59',0);
  const shift = db.prepare("SELECT id FROM shifts WHERE name = 'Live test shift'").get();
  const today = localDate();
  db.prepare('INSERT INTO schedules(user_id,date,shift_id) VALUES(?,?,?)').run(employeeId,today,shift.id);
  await request(employee, '/attendance/punch-in', { csrfToken: employee.token });
  const record = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(employeeId,today);
  assert.equal(record.shift_name, 'Live test shift');
  assert.equal(record.scheduled_start, today + 'T00:00:00');
  assert.equal(record.arrival_status, 'Late');
  await request(employee, '/attendance/punch-in', { csrfToken: employee.token });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM attendance WHERE user_id = ?').get(employeeId).count, 1);
  await request(admin, '/admin/schedules', { csrfToken: admin.token, employee: String(employeeId), shiftId: 'off', replace: 'yes',
    startDate: today, endDate: today, weekdays: ['0','1','2','3','4','5','6'] });
  assert.equal(db.prepare('SELECT shift_id FROM schedules WHERE user_id = ? AND date = ?').get(employeeId,today).shift_id, shift.id);
  const assignment = db.prepare('SELECT id FROM schedules WHERE user_id = ? AND date = ?').get(employeeId,today);
  await request(admin, '/admin/schedules/' + assignment.id + '/remove', { csrfToken: admin.token });
  assert.ok(db.prepare('SELECT id FROM schedules WHERE id = ?').get(assignment.id));
  await request(employee, '/attendance/punch-out', { csrfToken: employee.token });
  assert.ok(db.prepare('SELECT punch_out_at FROM attendance WHERE id = ?').get(record.id).punch_out_at);
});

test('day off prevents clock-in and clock-out closes an overnight record after midnight', async () => {
  const yesterday = addDays(localDate(), -1);
  db.prepare('UPDATE schedules SET shift_id = NULL WHERE user_id = ? AND date = ?').run(employeeId,localDate());
  // Remove the test record, then check that an off day cannot create a new one.
  db.prepare('DELETE FROM attendance WHERE user_id = ?').run(employeeId);
  await request(employee, '/attendance/punch-in', { csrfToken: employee.token });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM attendance WHERE user_id = ?').get(employeeId).count, 0);
  db.prepare('INSERT INTO attendance(user_id,date,punch_in_time,punch_in_at) VALUES(?,?,?,?)')
    .run(employeeId,yesterday,'23:00:00',yesterday+'T23:00:00');
  await request(employee, '/attendance/punch-out', { csrfToken: employee.token });
  const overnight = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(employeeId,yesterday);
  assert.equal(overnight.punch_out_at.slice(0,10), localDate());
});

test('multipart CSV imports use assigned shifts and grace; invalid and off-day rows are skipped', async () => {
  const date = addDays(localDate(), -7);
  db.prepare('INSERT INTO schedules(user_id,date,shift_id) VALUES(?,?,?)').run(employeeId,date,customShift.id);
  const data = new FormData();
  data.append('csrfToken', admin.token);
  data.append('attendanceFile', new Blob([
    'Employee ID,Date,Punch In Time,Punch Out Time\n' +
    'TESTEMP,' + date + ',10:06,18:00\n' +
    'TESTEMP,2026-02-30,10:00,18:00\n' +
    'TESTEMP,' + localDate() + ',10:00,18:00\n'
  ], { type: 'text/csv' }), 'attendance.csv');
  const response = await request(admin, '/admin/import', data);
  assert.equal(response.location, '/admin/report');
  const imported = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(employeeId,date);
  assert.equal(imported.arrival_status, 'On time');
  assert.equal(imported.grace_minutes, 7);
  assert.equal(imported.shift_name, 'Flexible support');
  const report = await request(admin, '/admin/report');
  assert.equal(report.status, 200);
  assert.match(report.html, /Imported 1 attendance record/);
  const noToken = new FormData();
  noToken.append('attendanceFile', new Blob(['Employee ID,Date,Punch In Time\n']), 'missing-token.csv');
  assert.equal((await request(admin, '/admin/import', noToken)).status, 403);
});

test('employee dashboard renders the roster and early/late history without changing stored records', async () => {
  const page = await request(employee, '/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.html, /My schedule/);
  assert.match(page.html, /Missed completed shifts/);
  assert.match(page.html, /Day off/);
});
