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

## StudentHub — parent/guardian account

Captured from a second StudentHub HAR logged in as a **parent/guardian** account (not a student). Same host (`studenthub.uet.edu.vn`), but a fundamentally different login flow and a wider set of endpoints.

**Auth model differs from the student flow**: parent accounts log in via `POST /api/auth/login` with a plain `{ userName, password }` body — no Google OAuth popup at all. Response: `{ code, msgCode, data: { accountCode, username, name, email, accessToken, role, dependAccountCode, staffCode, facultyCode } }`. `role` and `dependAccountCode` (linking the parent account to the student it manages) confirm this is a distinct account type, not just the student's own login reused. All subsequent calls send both `Cookie` and `Authorization: Bearer <accessToken>` — same bearer-token pattern as the student flow once authenticated, just reached via a different login endpoint. The parent-facing notification endpoint uses an account code prefixed `PH...` (`GET /api/noti/user/PH{code}`) — likely "Phụ huynh" (Vietnamese for parent/guardian) — a distinct account-code namespace from student codes.

Endpoints seen in this capture not in the student-flow list above:

- `GET /api/student/admission/info`: admission document tracking (`graduationCert`, `transcript`, `cccdFront/Back`, `birthCert`, `militaryDoc`, `priorityDoc`, `studentBankInfo`, `workflowState`, `isLocked` — all null/placeholder in this capture).
- `GET /api/student/avatar`: avatar (plain text response, likely a URL or base64).
- `GET /api/student/criteria/role/is-committee`: `{ check: bool }` — role/committee membership check.
- `GET /api/student/criteria/student-info?studentCode=`: lookup by student code (returned null in this capture).
- `GET /api/student/dktn` / `GET /api/student/dktn/course`: course registration ("đăng ký tín chỉ") — `course` variant groups courses by a numeric category id with `courses`/`typeName`.
- `POST /api/student/getBill/bill-optional/list`: optional/elective bill line items, same shape family as `getAllBills`.
- `POST /api/student/getBill/checkno`: returned null data in this capture — purpose unclear, needs a populated capture to confirm.
- `GET /api/student/memorial-message/detail`: returned **400** in this capture — unknown/unused feature, don't assume it's supported.
- `GET /api/student/person/detail`: extended personal info (address fields by category — `now`/`qq`/`tt`/`ll`/`ns` prefixes — plus military/party-membership history, disability fields).
- `GET /api/student/person/family-detail`: father/mother name, birth year, phone, job (no email/address populated in this capture).
- `GET /api/student/person/healthcare_detail`: health insurance card fields (`healthcareCode`, owner fields — mostly null in this capture).
- `GET /api/student/program`: program structure — `programDetails` (code/name/credit requirements) plus `groupedCourses` keyed by category id.
- `GET /api/student/programs/dky-window`: registration window (`startAt`, `endAt`, `manualMode`).
- `GET /api/student/semester-advice`, `GET /api/student/semester-advice/status`, `GET /api/student/semester-expected`: semester course-planning/advising data.
- `GET /api/student/student-info-canvas`: Canvas account link status (`userCanvasId`, `lastReqAt`, `curLoginAt`).
- `GET /api/student/training-points/is-lock`: companion to the existing training-points/assessment endpoints (null data in this capture).
- `POST /api/student/vn/{blood,district,nation,province,ward}/search`: paginated reference/lookup data for form dropdowns (blood type, province/district/ward, nationality) — generic Spring Data `Page` shape (`content`, `pageable`, `totalElements`, etc.), same pagination envelope as the notifications endpoint.
- `GET /dashboard-banner.json`: static site-wide banner config (`title`, `content`, `isShow`, `status`, `stopAt`).

Unrelated noise in this capture (Google Identity Services / FedCM traffic — `accounts.google.com/gsi/*`, `/gsi/fedcm/*`, `www.google.com/.well-known/web-identity`): this is Chrome's own browser-level "sign in with Google" suggestion UI rendering on the page, not an actual StudentHub auth mechanism — no `/api/auth/google/callback` hit anywhere in this capture, confirming the parent login never touches Google OAuth at all.

## Canvas

Host: `portal.uet.vnu.edu.vn`

- `POST /login/saml`: SAML login response, 302 redirect. SAML payload redacted.
- `GET /api/v1/dashboard/dashboard_cards`: active Canvas courses.
- `GET /api/v1/planner/items`: planner items. Captured types include announcement, quiz, assignment.
- `GET /api/v1/users/self/missing_submissions`: missing assignments.
- `GET /api/v1/conversations/unread_count`: unread inbox count.

Official Canvas API docs recommend OAuth Bearer tokens. Web-session cookie + CSRF behavior is internal and should not be assumed as the primary auth model.
