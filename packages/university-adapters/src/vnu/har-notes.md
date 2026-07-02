# VNU (daotao.vnu.edu.vn) HAR Notes

Raw HAR files are not committed. These notes contain only sanitized endpoint and shape findings.

## Site

Host: `daotao.vnu.edu.vn` — classic ASP (not .NET), the shared "Cổng thông tin đào tạo đại học"
(undergraduate training portal) used across VNU member schools (not UET-specific). Distinct system
from UET's StudentHub/Canvas. Session model is classic ASP cookie auth, not bearer tokens.

## Auth

- `POST /dkmh/login.asp`: form-urlencoded body `txtLoginId` (username, often the student code),
  `txtPassword`, `chkSubmit`. On success, sets one or more session cookies (ASP session id +
  internal user-id cookies). On failure, re-renders the login form with HTTP 200 (no distinct
  error status), so credential validity must be verified by fetching an authenticated page
  afterward and checking the response isn't the login form again.
- No token/API auth path exists anywhere in the captured traffic — the whole portal is
  cookie-session based.

## Pages (all require the session cookie; paths are root-level, not under `/dkmh/`)

- `GET /StdInfo/TabStdSelf.asp`: student profile. Disabled/readonly fields: student code, full
  name, DOB, gender, degree level, training mode, program type, cohort, managing class, faculty,
  major. Also exposes a hidden `hidStdID` (internal student id) and the selected `UnivID` option
  value (internal faculty/university id) — both needed as query params for the exam page.
- `GET /ListPoint/listpoint_Brc1.asp`: transcript/grades, grouped by term (newest first, full
  history on one page, no pagination). Per-course columns: code, name, credits, 10-point score,
  letter grade, 4-point score. Trailing summary lines give total credits, cumulative credits, and
  cumulative GPA (4.0 scale). `Brc2.asp`/`Brc3.asp` use the same table shape for double-major /
  transferred-in credits but are typically empty for most students.
- `GET /StdInfo/TabStdStudy.asp`: academic-progress tabs. Only the "Thông tin học tập" section has
  reliable per-student data: a term-by-term table of conduct/training score (0-100), term GPA, and
  cumulative GPA. Other sub-sections (commendations, discipline, scholarships, awards, overseas
  travel) render only an empty "add new" template row for most students — treated as empty state,
  not scraped as data.
- `GET /StdExamination/StdExamination.asp?selViewType=StdExam`: exam schedule. Requires
  `selUniv`/`selStd` (from the profile page's `UnivID`/`hidStdID`) and `vTermID` (an internal term
  id distinct from the grades page's term code — resolved by scraping this page's own term
  `<select>` options and matching against the target term code). Populated rows contain exam code
  (term-course composite), exam/course name, date, session+time, method (written / on-computer /
  listening+speaking), room (or "submit grade" for non-room exam types), and seat number.
- `GET /SiteManager/Syllabus/default.asp`: paginated syllabus/curriculum PDF listing (course code,
  name, credits, download link, file size, upload date). Only the first page is scraped — no
  adapter use case needs the full multi-page listing.
- `POST /Register/enrschedule.asp` and `/Register/RegisterPrint.asp`: both are dead ends for
  timetable data. One returns a "registration temporarily suspended" message; the other says
  course-registration viewing has moved entirely to a separate, uncaptured domain
  (`dangkyhoc.vnu.edu.vn`). Confirms this adapter cannot support timetable/registration.
- `GET /sitemanager/Forms/default.asp`: administrative forms list, same pagination shape as
  Syllabus, empty for the captured account. Not implemented.
- No notification, tuition/billing, or news endpoint was found anywhere in the captured traffic.

## Capability summary

`profile`, `terms`, `grades`, `exams`, `trainingPoints`, `documents` (syllabus) are supported.
`timetable`, `courses`, `assignments`, `attendance`, `notifications`, `tuition`, `news`,
`requests` are not — no verified real data source exists for them on this portal.
