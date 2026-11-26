# Manual test checklist

Use fictional data only and record actual outcomes.

- [ ] `/api/health` returns `{ "ok": true }`.
- [ ] Register a valid fictional patient; token appears.
- [ ] Invalid or missing fields are rejected.
- [ ] Each department receives its own token prefix.
- [ ] Public queue contains token numbers, not patient names.
- [ ] Open two tabs; registration refreshes queue via Socket.IO.
- [ ] Wrong staff password is rejected.
- [ ] Correct staff login opens dashboard.
- [ ] Unauthenticated patient search is rejected.
- [ ] Staff can change a waiting token's priority.
- [ ] Call Next chooses highest priority, then oldest waiting token.
- [ ] Staff can complete/cancel a token.
- [ ] Display screen updates when staff calls a token.
- [ ] Restart server and verify local SQLite records remain.
