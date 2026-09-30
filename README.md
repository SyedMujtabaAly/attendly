# Attendly — Node.js Attendance System

A portfolio-ready attendance management web application built with Node.js, Express, EJS, and SQLite.

## Features

- Employee registration and secure session login
- Punch-in and punch-out workflow
- Shift-based late detection
- Monthly employee attendance dashboard
- Admin reporting by month and department
- CSV attendance import
- CSRF protection, secure cookies, Helmet, bcrypt password hashing, and prepared SQL statements
- Responsive, accessible interface

## Run locally

```bash
npm install
npm run setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Demo administrator:

```text
Employee ID: ADMIN
Password: admin123
```

The database is also initialized automatically when the server starts.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with automatic reload |
| `npm start` | Start normally |
| `npm run setup` | Create and seed the database |
| `npm run check` | Validate server-side JavaScript syntax |

## Project structure

```text
Attendly-NodeJS/
├── public/css/       # Responsive interface
├── src/
│   ├── app.js        # Express application and routes
│   ├── db.js         # SQLite connection
│   └── setup.js      # Schema and demo seed
├── views/
│   ├── partials/     # Shared layout
│   └── *.ejs         # Page templates
├── attendance-template.csv
└── package.json
```

## Portfolio notes

This prototype demonstrates authentication, role-based authorization, relational data modeling, secure state-changing forms, file processing, responsive UI design, and server-rendered Node.js architecture.

Before production deployment, use a persistent session store, configure environment variables, add rate limiting and audit logging, remove demo credentials, and serve the application behind HTTPS.
