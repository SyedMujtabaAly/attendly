const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeDatabase } = require('../src/setup');
const { createScheduling, classifyArrival, shiftWindow, validDate, normalizeTime, localDate } = require('../src/scheduling');
const db = new Database(':memory:');
let service;
let admin;
let morning;
let evening;
before(() => {
  db.pragma('foreign_keys = ON');
  initializeDatabase(db);
  service = createScheduling(db);
  admin = db.prepare("SELECT * FROM users WHERE employee_id = 'ADMIN'").get();
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run('2026-09-01 00:00:00', admin.id);
  admin.created_at = '2026-09-01 00:00:00';
  morning = db.prepare("SELECT * FROM shifts WHERE name = 'Morning'").get();
  evening = db.prepare("SELECT * FROM shifts WHERE name = 'Evening'").get();
});
after(() => db.close());

test('early, exact-start, grace boundary, and late arrivals are classified precisely', () => {
  const start = '2026-09-30T09:00:00';
  assert.deepEqual(classifyArrival(start, '2026-09-30T08:45:00', 5), { status: 'Early', earlyMinutes: 15, lateMinutes: 0 });
  assert.equal(classifyArrival(start, start, 5).status, 'On time');
  assert.equal(classifyArrival(start, '2026-09-30T09:05:00', 5).status, 'On time');
  assert.deepEqual(classifyArrival(start, '2026-09-30T09:05:01', 5), { status: 'Late', earlyMinutes: 0, lateMinutes: 6 });
  assert.equal(classifyArrival(start, '2026-09-30T09:00:01', 0).status, 'Late');
});

test('schedule overrides the default, explicit days off override workdays, and weekends default to off', () => {
  assert.equal(service.resolve(admin.id, '2026-10-01').name, 'Morning');
  db.prepare('INSERT INTO schedules(user_id, date, shift_id) VALUES (?, ?, ?)').run(admin.id, '2026-10-01', evening.id);
  assert.equal(service.resolve(admin.id, '2026-10-01').name, 'Evening');
  db.prepare('INSERT INTO schedules(user_id, date, shift_id) VALUES (?, ?, NULL)').run(admin.id, '2026-10-02');
  assert.equal(service.resolve(admin.id, '2026-10-02').off, true);
  assert.equal(service.resolve(admin.id, '2026-10-03').off, true);
  db.prepare('INSERT INTO schedules(user_id, date, shift_id) VALUES (?, ?, ?)').run(admin.id, '2026-10-03', morning.id);
  assert.equal(service.resolve(admin.id, '2026-10-03').off, false);
});

test('overnight shifts resolve to the previous shift date after midnight', () => {
  const window = shiftWindow('2026-10-01', evening);
  assert.equal(window.end, '2026-10-02T01:00:00');
  assert.equal(service.forPunch(admin.id, new Date('2026-10-02T00:30:00')).date, '2026-10-01');
  assert.equal(service.forPunch(admin.id, new Date('2026-10-02T01:00:00')).off, true);
  assert.equal(classifyArrival(window.start, '2026-10-02T00:30:00', 0).lateMinutes, 450);
});

test('absence excludes days off, unfinished shifts, future shifts, and dates before employment', () => {
  const add = db.prepare('INSERT INTO schedules(user_id, date, shift_id) VALUES (?, ?, ?)');
  add.run(admin.id, '2026-09-28', null);
  add.run(admin.id, '2026-09-29', evening.id);
  add.run(admin.id, '2026-09-30', morning.id);
  const duringShift = service.summary(admin, '2026-09-28', '2026-10-01', new Date('2026-09-30T12:00:00'));
  assert.equal(duringShift.absent, 1);
  assert.equal(duringShift.scheduled, 3);
  const afterShift = service.summary(admin, '2026-09-28', '2026-10-01', new Date('2026-09-30T18:00:00'));
  assert.equal(afterShift.absent, 2);
  const localMidnight = new Date('2026-09-30T00:00:00').toISOString().slice(0,19).replace('T',' ');
  const newEmployee = { ...admin, created_at: localMidnight };
  assert.equal(service.summary(newEmployee, '2026-09-28', '2026-10-01', new Date('2026-09-30T12:00:00')).absent, 0);
});

test('attendance snapshots keep arrival and shift history intact across later schedule changes', () => {
  db.prepare(`INSERT INTO attendance(user_id, date, punch_in_time, scheduled_start, scheduled_end,
    shift_name, arrival_status, early_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(admin.id, '2026-09-30', '08:50:00', '2026-09-30T09:00:00', '2026-09-30T17:00:00', 'Morning', 'Early', 10);
  db.prepare('UPDATE schedules SET shift_id = NULL WHERE user_id = ? AND date = ?').run(admin.id, '2026-09-30');
  const totals = service.summary(admin, '2026-09-30', '2026-09-30', new Date('2026-09-30T18:00:00'));
  assert.equal(totals.scheduled, 1);
  assert.equal(totals.present, 1);
  assert.equal(totals.early, 1);
  assert.equal(totals.absent, 0);
});

test('database upgrades are idempotent and preserve existing attendance and accounts', () => {
  initializeDatabase(db);
  initializeDatabase(db);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM users').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM attendance').get().count, 1);
  assert.ok(db.prepare('PRAGMA table_info(attendance)').all().some(column => column.name === 'scheduled_start'));
});

test('date and time validation rejects invalid calendar days and times', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(normalizeTime('25:00'), null);
  assert.equal(normalizeTime('09:15'), '09:15:00');
  assert.equal(localDate(new Date(2026, 8, 30, 0, 30)), '2026-09-30');
});
