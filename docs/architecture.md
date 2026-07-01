# Hyeboard Architecture

Hyeboard is split into a client-heavy dashboard and a small Cloudflare Worker BFF.

```txt
Cloudflare Pages web app
  -> Hyeboard Worker API
  -> university adapter registry
  -> UET adapter
  -> StudentHub + Canvas upstream APIs
```

The frontend never calls university upstream systems directly. University-specific behavior lives in adapters.

## UET Sources

- StudentHub (`studenthub.uet.edu.vn`): profile, timetable, terms, grades, GPA, bills, exams, notifications, news, training points, service requests.
- Canvas (`portal.uet.vnu.edu.vn`): courses, planner items, assignments/quizzes/announcements, missing submissions, unread conversations, optional files.

## Session Model

Separate web/API origins make third-party cookies fragile. Hyeboard therefore uses an encrypted Bearer token:

1. API receives or discovers upstream credentials.
2. API encrypts them with AES-GCM using `HYEB_SESSION_SECRET`.
3. Web stores the opaque token and sends `Authorization: Bearer <token>`.
4. API decrypts per request and replays credentials upstream.

No upstream cookies, tokens, SAML payloads, or personal data are logged.
