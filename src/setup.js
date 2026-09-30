const bcrypt = require('bcryptjs');
const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT
  );
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    department_id INTEGER,
    shift_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id)
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    punch_in_time TEXT,
    punch_out_time TEXT,
    is_late INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
`);

const insertDepartment = db.prepare('INSERT OR IGNORE INTO departments (name, description) VALUES (?, ?)');
insertDepartment.run('Operations', 'General business operations');
insertDepartment.run('Engineering', 'Product and platform engineering');
insertDepartment.run('People', 'People operations and HR');

const insertShift = db.prepare('INSERT OR IGNORE INTO shifts (name, start_time, end_time) VALUES (?, ?, ?)');
if (!db.prepare('SELECT 1 FROM shifts LIMIT 1').get()) {
  insertShift.run('Morning', '09:00:00', '17:00:00');
  insertShift.run('Evening', '17:00:00', '01:00:00');
}

if (!db.prepare('SELECT 1 FROM users WHERE employee_id = ?').get('ADMIN')) {
  const department = db.prepare('SELECT id FROM departments WHERE name = ?').get('People');
  const shift = db.prepare('SELECT id FROM shifts WHERE name = ?').get('Morning');
  db.prepare(`
    INSERT INTO users (employee_id, password_hash, first_name, last_name, email, department_id, shift_id, is_admin)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run('ADMIN', bcrypt.hashSync('admin123', 12), 'Admin', 'User', 'admin@attendly.local', department.id, shift.id);
  console.log('Created demo administrator: ADMIN / admin123');
}

console.log('Attendly database is ready.');
