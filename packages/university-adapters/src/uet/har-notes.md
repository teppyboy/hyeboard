# UET HAR Notes

Raw HAR files are not committed. These notes contain only sanitized endpoint and shape findings.

## StudentHub

Host: `studenthub.uet.edu.vn`

- `GET /api/student/detail`: profile fields including `studentCode`, `name`, `schoolEmail`, `classCode`, `programName`, `majorName`.
- `POST /api/student/term/getTerm`: term list with `id`, `index`, `termCode`, `name`.
- `POST /api/student/tkb`: timetable. Request body includes `termCode`. Items include `courseCode`, `courseName`, `roomName`, `sessionStart`, `sessionEnd`, `weekday`.
- `GET /api/student/kqht`: transcript fields `courseCode`, `courseCredit`, `point4`, `point10`, `termCode`.
- `GET /api/student/results`: GPA summary fields `cpa`, `gpa`, `totalCredits`, `totalAccumulatedCredits`.
- `POST /api/student/exam-schedule`: exam date, start time, room, method, type.
- `POST /api/student/getAllBills`: tuition/bill amounts, remaining amount, status, invoice URL.
- `GET /api/noti/user/{studentCode}`: paginated notifications.
- `GET /api/student/news`: news feed.

Auth capture shows Google OAuth callback, but auth headers/cookies are stripped from the HAR export. Live probing required.

## Canvas

Host: `portal.uet.vnu.edu.vn`

- `POST /login/saml`: SAML login response, 302 redirect. SAML payload redacted.
- `GET /api/v1/dashboard/dashboard_cards`: active Canvas courses.
- `GET /api/v1/planner/items`: planner items. Captured types include announcement, quiz, assignment.
- `GET /api/v1/users/self/missing_submissions`: missing assignments.
- `GET /api/v1/conversations/unread_count`: unread inbox count.

Official Canvas API docs recommend OAuth Bearer tokens. Web-session cookie + CSRF behavior is internal and should not be assumed as the primary auth model.
