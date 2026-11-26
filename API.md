# API quick reference

All responses are JSON. Staff endpoints require a valid session cookie.

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| GET | `/api/health` | Health check | No |
| POST | `/api/patients` | Register patient and create token | No |
| GET | `/api/queue?department=General` | Public token-only queue | No |
| POST | `/api/auth/login` | Staff login | No |
| POST | `/api/auth/logout` | Staff logout | Yes |
| GET | `/api/auth/me` | Current staff account | Yes |
| GET | `/api/patients?q=term` | Search records | Yes |
| GET | `/api/patients/:id/history` | Visit history | Yes |
| POST | `/api/queue/next` | Call next waiting token | Yes |
| PATCH | `/api/queue/:id/status` | Change token status | Yes |
| PATCH | `/api/queue/:id/priority` | Set waiting token priority | Yes |

Socket.IO broadcasts `queue:updated` after queue mutations.
