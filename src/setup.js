const bcrypt = require('bcryptjs');
function initializeDatabase(db) {
db.exec(`
CREATE TABLE IF NOT EXISTS departments(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,description TEXT);
CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,start_time TEXT NOT NULL,end_time TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,employee_id TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,department_id INTEGER,shift_id INTEGER,is_active INTEGER NOT NULL DEFAULT 1,is_admin INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(department_id) REFERENCES departments(id),FOREIGN KEY(shift_id) REFERENCES shifts(id));
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,date TEXT NOT NULL,punch_in_time TEXT,punch_out_time TEXT,is_late INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,date),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id,date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);`);
db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 date TEXT NOT NULL,
 shift_id INTEGER REFERENCES shifts(id),
 notes TEXT NOT NULL DEFAULT '',
 created_by INTEGER REFERENCES users(id),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(date);
`);

// Additive migrations keep existing prototype data intact.
function addColumns(table, definitions) {
 const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
 for (const [name, type] of Object.entries(definitions)) {
  if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
 }
}
addColumns('shifts', { grace_minutes: 'INTEGER NOT NULL DEFAULT 0' });
addColumns('attendance', {
 scheduled_start: 'TEXT', scheduled_end: 'TEXT', shift_name: 'TEXT',
 grace_minutes: 'INTEGER NOT NULL DEFAULT 0', arrival_status: 'TEXT',
 early_minutes: 'INTEGER NOT NULL DEFAULT 0', late_minutes: 'INTEGER NOT NULL DEFAULT 0',
 punch_in_at: 'TEXT', punch_out_at: 'TEXT'
});
const addDepartment=db.prepare('INSERT OR IGNORE INTO departments(name,description) VALUES(?,?)');
[['Operations','General business operations'],['Engineering','Product engineering'],['People','People operations and HR']].forEach(row=>addDepartment.run(...row));
if(!db.prepare('SELECT 1 FROM shifts LIMIT 1').get()){const add=db.prepare('INSERT INTO shifts(name,start_time,end_time) VALUES(?,?,?)');add.run('Morning','09:00:00','17:00:00');add.run('Evening','17:00:00','01:00:00');}
if(!db.prepare('SELECT 1 FROM users WHERE employee_id=?').get('ADMIN')){
 const department=db.prepare('SELECT id FROM departments WHERE name=?').get('People');
 const shift=db.prepare('SELECT id FROM shifts WHERE name=?').get('Morning');
 db.prepare('INSERT INTO users(employee_id,password_hash,first_name,last_name,email,department_id,shift_id,is_admin) VALUES(?,?,?,?,?,?,?,1)').run('ADMIN',bcrypt.hashSync('admin123',12),'Admin','User','admin@attendly.local',department.id,shift.id);
 console.log('Created demo administrator: ADMIN / admin123');
}
}

if (require.main === module) {
 initializeDatabase(require('./db'));
 console.log('Attendly database is ready.');
}
module.exports = { initializeDatabase };
