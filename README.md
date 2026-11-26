# Hospital Queue Management System — Replit-ready

Full-stack academic prototype using HTML, CSS, JavaScript, Node.js, Express, SQLite and Socket.IO.

## Included
- Patient registration and daily department token generation
- Four department queues
- Staff login with bcrypt password hashes and sessions
- Staff dashboard: call next, set waiting-token priority, complete/cancel tokens
- Public live display with token numbers only (no patient names)
- Patient search for authenticated staff
- JSON REST API and real-time Socket.IO events
- SQLite database and SQLite-backed session store

## Run on Replit
1. Import this ZIP into a Replit App.
2. Open Shell and run `npm install`.
3. In Secrets, add:
   - `SESSION_SECRET`: long random string
   - `ADMIN_USERNAME`: admin (or your chosen username)
   - `ADMIN_PASSWORD`: strong unique password
   - `NODE_ENV`: production
4. If the app has already started before secrets were set, restart it. The admin account is created on first startup when the credentials are present.
5. Run `npm start`.
6. Open the Webview. Replit routes the app using the `PORT` environment variable. The server binds to `0.0.0.0`.
7. Test the API at `/api/health`.

## Local run
Copy `.env.example` to `.env`, set a strong `SESSION_SECRET` and `ADMIN_PASSWORD`, then run `npm install` and `npm start`.

## Pages
- `/` registration
- `/display.html` public token display
- `/login.html` staff sign-in
- `/dashboard.html` staff dashboard

## API overview
- `GET /api/health` health check
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/patients` public registration
- `GET /api/patients?q=` authenticated patient search
- `GET /api/patients/:id/history` authenticated visit history
- `GET /api/queue?department=General` public token-only queue view
- `POST /api/queue/next` authenticated call-next action
- `PATCH /api/queue/:id/status` authenticated status update
- `PATCH /api/queue/:id/priority` authenticated priority update

## Storage and deployment notes
SQLite data is stored in `database/hospital.db`; session data is stored in `database/sessions.sqlite`. Do not commit these files or `.env`.
For a persistent public deployment, confirm the selected Replit deployment's filesystem persistence and backup behavior. If its local filesystem is ephemeral, migrate the database to managed PostgreSQL before relying on saved records. Replit Object Storage is for files/objects, not a direct replacement for relational queue tables.

## Safety and limitations
This is a student demonstration prototype, not a production clinical system. Use fictional patient data only. It does not diagnose or triage patients. Priority must be assigned by authorized staff. Do not use real patient data. Production use needs security review, HTTPS, backups, rate limiting, CSRF protection, robust staff management and appropriate privacy/legal review.
