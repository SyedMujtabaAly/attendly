const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const directory = path.join(__dirname, '..', 'data');
fs.mkdirSync(directory, { recursive: true });
const db = new Database(process.env.ATTENDLY_DB_PATH || path.join(directory, 'attendly.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
module.exports = db;
