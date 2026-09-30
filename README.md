# Attendly — Node.js Edition

A portfolio-ready attendance management application built with Node.js, Express, EJS, and SQLite.

## Features

- Employee registration and secure session authentication
- Punch in/out with shift-based late detection
- Admin shift library with configurable late grace periods
- Date-range schedules, weekday selection, days off, and bulk team assignment
- Employee roster for the next 14 days
- Early/on-time/late arrival tracking with minute differences
- Overnight shifts and clock-out across midnight
- Schedule-aware absence reporting and historical shift snapshots
- Monthly attendance dashboard
- Admin reporting by month and department
- Validated CSV attendance import
- CSRF protection, Helmet, bcrypt hashing, prepared SQL, and secure cookies
- Responsive employee and administrator interfaces

## Run locally

```bash
npm install
npm run setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```text
Demo Employee ID: ADMIN
Demo password:    admin123
```

The database is initialized automatically when the server starts.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server with reload |
| `npm start` | Standard server |
| `npm run setup` | Create and seed SQLite |
| `npm run check` | Validate JavaScript syntax |
| `npm test` | Run scheduling rules and HTTP workflow tests in isolated databases |

## Scheduling walkthrough

1. Sign in as **ADMIN** and open **Schedules**.
2. In **Create a shift**, enter a name, start/end times, and late grace period.
3. In **Assign a schedule**, select an employee (or all active employees), a shift or day off, dates, and weekdays. Save the schedule.
4. To change an existing assignment, check **Replace existing assignments**. Recorded attendance is locked.
5. Employees open **My schedule** on their dashboard to see the next 14 days.
6. Reports show scheduled shifts, present days, early arrivals, late arrivals, and missed completed shifts.

### Attendance rules

- A date-specific assignment overrides the employee's default shift.
- Without an assignment, the default shift applies Monday–Friday; weekends are days off.
- Early means arriving before scheduled start. Arrival through start plus the grace period is on time.
- For a 09:00 start and 5-minute grace, 08:50 is 10 minutes early, 09:05 is on time, and 09:06 is 6 minutes late. Late minutes are measured from scheduled start, not the end of grace.
- An end time earlier than start is an overnight shift. Attendance belongs to the shift's start date, even if punches occur after midnight.
- Clock-in is unavailable on days off or after shift end. An open shift must be closed before starting another.
- Absence is counted only after a scheduled shift ends without a punch-in; future shifts, days off, and dates before employment are excluded.
- Assignments that overlap adjacent shifts are rejected. Schedule changes do not alter the shift details saved with existing attendance.
- All dates and times use the server's local timezone, displayed in the app. Configure the server timezone before deployment.

### CSV import

Use `attendance-template.csv`. **Date** is the shift's start date (including overnight shifts). New rows use that employee's schedule and grace period for the date. Corrections to records with saved shift details retain that shift's rules. Invalid rows and days off are skipped and counted; old records without shift snapshots are preserved rather than overwritten.

Existing SQLite databases are upgraded automatically on startup with additive migrations. User accounts and previous attendance remain intact; older records show their original status without invented early/late minutes.

## Architecture

```text
node-app/
├── public/css/       # Responsive design
├── src/
│   ├── app.js        # Express routes and middleware
│   ├── db.js         # SQLite connection
│   ├── setup.js      # Schema and demo seed
│   └── scheduling.js # Shift resolution and attendance rules
├── views/            # EJS pages and shared partials
├── test/             # Scheduling and HTTP integration tests
└── package.json
```

For production, set a strong `SESSION_SECRET`, use a persistent session store, enable HTTPS, remove demo credentials, and add rate limiting and audit logs.
