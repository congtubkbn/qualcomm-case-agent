# Issue #193 — Static review: case-overview dashboard, gap so với mục tiêu "nắm status nhanh"

Wayfinder RESEARCH ticket, con của map issue #188. Chỉ review tĩnh code/thiết kế hiện có, **không**
đề xuất redesign UI (ngoài phạm vi ticket). Mọi khẳng định kèm `file:line` trỏ vào working tree tại
thời điểm review (branch `research/dashboard-status-clarity`, dựa trên `main` @ `dbcd6e8`).

Phạm vi đọc chính:
- `.claude/skills/qualcomm-case-overview/scripts/dashboard_renderer.mjs`
- `.claude/skills/qualcomm-case-overview/scripts/cli_renderer.mjs`
- `.claude/skills/qualcomm-case-overview/scripts/overview_store.mjs`
- `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs`
- Đối chiếu domain vocab tại `CONTEXT.md` (mục **Hide (case)**, **Case Status**).

Ghi chú bối cảnh: repo hiện chưa có `data/cases/` thật nào (thư mục bị gitignore và không tồn tại
trong worktree lúc review) — khớp với tiền đề của ticket rằng dashboard "chưa từng được build/xem
với dữ liệu thật trong repo này".

---

## 1. Có phân biệt trực quan theo `caseStatus` (màu/badge) không, hay chỉ là text verbatim?

**Có phân biệt màu, nhưng qua một lớp phân loại suy luận (heuristic), không phải map 1-1 từ status
gốc.**

- `getStatusCategory(status)` (`dashboard_renderer.mjs:25-33`) lowercase status rồi so khớp
  substring theo thứ tự ưu tiên cố định để gán 1 trong 5 category:
  `action_required` (chứa `action`/`need info`/`waiting`) → `closed` (chứa `close`) → `in_progress`
  (chứa `progress`/`investigat`/`fix`/`pending`) → `open` (chứa `open`) → `other`.
- Badge status được render tại `dashboard_renderer.mjs:181`:
  `<span class="status-tag status-tag-${category}" title="${escapedStatus}">${escapedStatus}</span>`
  — **text hiển thị là `escapedStatus` verbatim** (đúng theo domain rule "Case Status ... đọc verbatim,
  never inferred" ở `CONTEXT.md:14-17`), nhưng **class CSS (màu) lại lấy từ `category` suy luận**,
  không phải từ chính giá trị status.
- Màu được định nghĩa tại `dashboard_renderer.mjs:898-902`
  (`.status-tag-open`, `.status-tag-in_progress`, `.status-tag-closed`, `.status-tag-action_required`,
  `.status-tag-other`), mỗi category một màu chữ khác nhau (`dashboard_renderer.mjs:226-233` biến màu
  cho light theme, `256-266` cho dark).
- Priority cũng có badge riêng qua một heuristic khác:
  `priorityClass` tại `dashboard_renderer.mjs:145-150` (`pri-critical`/`pri-high`/`pri-normal` dựa
  trên substring `'1'`/`'critical'`/`'2'`/`'high'` trong `c.priority`).
- **Gap cụ thể**: heuristic `getStatusCategory` không phân biệt được "bên nào đang phải hành động".
  Ví dụ status thật trong `CONTEXT.md:15` là `"Pending Qualcomm"`. Chuỗi này chứa `pending` →
  rơi vào nhánh `in_progress` (`dashboard_renderer.mjs:30`), **cùng màu/badge** với một status kiểu
  `"Pending Customer"` (cũng chứa `pending`, cũng rơi vào `in_progress`) — dù về mặt nghiệp vụ đây là
  hai trạng thái đối lập nhau: một bên đang chờ Qualcomm phản hồi, bên kia là case đang chờ hành động
  từ chính người dùng/khách hàng. Badge màu vì vậy **không đáng tin để phân biệt "case cần tôi làm gì
  đó" vs "case đang chờ phía Qualcomm"** — trực tiếp mâu thuẫn với mục tiêu "nắm status nhanh" của
  issue. (Xem thêm mục 2 và 3.)
- CLI (`cli_renderer.mjs`) hoàn toàn không có màu/badge: `cli_renderer.mjs:33`
  (`Status: ${c.status || 'Unknown'}`) in thẳng text verbatim, không qua `getStatusCategory` — chỉ có
  ở dashboard HTML, không ở terminal.

---

## 2. Có cách nào nhanh chóng phát hiện case "bị kẹt"/cần hành động — ví dụ hiển thị `ballInCourt` từ
`summary.json`, hoặc gắn cờ case lâu không có update?

**Không.** Cả hai cơ chế đều tồn tại ở tầng dữ liệu nhưng bị bỏ qua ở tầng tổng hợp/hiển thị.

- **`ballInCourt` bị drop khi tổng hợp.** `summary.json.executive.ballInCourt` là field có thật
  trong domain (định nghĩa & dùng tại `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:118-120`
  và mô tả tại `.claude/skills/qualcomm-case-summary/references/workflow.md:75`), nhưng hàm đọc
  `summary.json` cho overview — `extractAiSummary()` tại `overview_store.mjs:64-81` — chỉ lấy
  `exec.resolution` (`overview_store.mjs:70`), `exec.rootCause` (`:71`), và
  `exec.blockerOrNextMilestone` (`:72-74`) để ghép thành chuỗi `aiSummary`. **Không có dòng nào đọc
  `exec.ballInCourt`.** Trường này chỉ tồn tại trong `.claude/skills/qualcomm-case-summary/*`, không
  bao giờ tới được `_overview.json`/`dashboard.html`/CLI table.
- **`lastCommentAt` được tính nhưng không bao giờ render.** `overview_store.mjs:130,138` tính
  `lastCommentAt` (timestamp của comment mới nhất) và gán vào record tại `overview_store.mjs:193`.
  `closedAt` cũng được đọc từ `case.json` tại `overview_store.mjs:114-116` và gán vào record tại
  `:187`. Grep cả `dashboard_renderer.mjs` và `cli_renderer.mjs`: **không có tham chiếu nào tới
  `c.lastCommentAt` hay `c.closedAt`** — hai field có sẵn để tính "case này im lặng bao lâu rồi" đã bị
  tính toán rồi bỏ xó, không lộ ra UI/CLI nào.
- **Không có bất kỳ ngưỡng staleness/no-update-in-N-days nào** trong cả 4 file được review — không
  `Date.now()`, không so sánh khoảng thời gian, không cờ "stale"/"stuck"/"overdue" ở đâu trong
  `dashboard_renderer.mjs`, `cli_renderer.mjs`, `overview_store.mjs`, `cases_overview.mjs` (đã grep,
  0 kết quả cho các từ khóa `stuck|stale|daysSince|no update in`).
- Điều duy nhất gần với "cần hành động" là badge màu `action_required` từ `getStatusCategory`
  (mục 1), nhưng như đã chỉ ra, heuristic đó gộp lẫn "Pending Qualcomm" và "Pending Customer" vào
  cùng nhánh `in_progress`, nên **không đáng tin cậy** để thay thế cho `ballInCourt` thật.
- Sắp xếp mặc định (mục 3) ưu tiên case sync gần nhất lên đầu — đây là proxy gián tiếp duy nhất cho
  "case nào đang hoạt động", nhưng nó phản ánh **thời điểm capture/summary chạy gần nhất**, không
  phải thời điểm Qualcomm/khách hàng có động thái mới trên case — hai việc khác nhau: một case bị bỏ
  quên 3 tháng nhưng vừa được `npm run case` chạy lại (dù "no-update") vẫn nhảy lên đầu danh sách y
  như case vừa có comment thật.

---

## 3. Sort/group/filter hiện có (`--filter=<status>`) có đủ để "nắm status nhanh" không, hay chỉ là
list phẳng?

**Chỉ là list phẳng có filter theo status/tìm kiếm text; không có group, không có sort tùy chỉnh.**

- **CLI**: `parseArgs()` tại `cases_overview.mjs:69-118` chỉ nhận `--rebuild`, `--json`, `--html`,
  `--open`/`--no-open`, `--filter=<status>`, `--cases-dir=<dir>`, `--help` — **không có flag `--sort`
  hay `--group`**. `applyFilter()` (`overview_store.mjs:395-405`) chỉ lọc theo substring
  case-insensitive trên `c.status`, không sort lại kết quả. Thứ tự hiển thị hoàn toàn phụ thuộc thứ tự
  đã có sẵn trong `overviewData.cases` (xem thứ tự sort mặc định bên dưới) — `renderCliTable()`
  (`cli_renderer.mjs:31-57`) chỉ `for (const c of cases)` in tuần tự, không group theo status/priority.
- **Thứ tự mặc định** được set một lần tại `buildOverviewData()` (`overview_store.mjs:253-258`) và lặp
  lại y hệt trong `syncCaseOverview()` (`overview_store.mjs:337-342`): sort giảm dần theo `syncedAt`
  (fallback `caseNumber`) — tức "mới sync gần đây nhất lên đầu", không phải theo priority, không theo
  status, không theo "cần hành động trước".
- **Dashboard**: các "filter tab" (`dashboard_renderer.mjs:1054-1059`,
  `All/Open/In Progress/Action Required/Closed/Hidden`) chỉ toggle `display: none` qua class `hidden`
  trên `<tr class="case-row">` (logic tại `dashboard_renderer.mjs:1199-1244`, đặc biệt
  `row.classList.add('hidden')` ở `:1227`) — đây là ẩn/hiện hàng trong **cùng một bảng phẳng**, không
  phải nhóm theo section/heading. Không có cột nào trong `<thead>`
  (`dashboard_renderer.mjs:1065-1074`: `Case & Details / Timeline / Status & Priority / Activity /
  Actions`) có thể click để sort — không có sort-by-column ở client-side JS
  (đã đọc toàn bộ `<script>` `dashboard_renderer.mjs:1107-1533`, không có handler nào gắn vào
  `<th>`).
- Vì vậy để "nắm status nhanh", người dùng chỉ có 2 công cụ: (a) filter tab dựa trên category suy luận
  từ mục 1 (đã chỉ ra là không tin cậy để tách "cần hành động" thật), và (b) search text tự do
  (`dashboard_renderer.mjs:1051`, đối chiếu với `data-search` index build tại `:72-87`) — không giúp
  "quét nhanh" nếu không biết trước từ khóa cần tìm.

---

## 4. Cơ chế `Hide` (client-side/localStorage, theo `CONTEXT.md`) có giúp focus vào case đang active
không, hay chỉ là dọn list?

**Chỉ là dọn list thủ công theo từng case; không có logic tự động liên hệ với "active".**

- Định nghĩa domain: `CONTEXT.md:59-63` — "per-browser, client-side-only flag... removes a case from
  active tab views. Stored in localStorage; touches no file on disk; fully reversible... Does not
  affect `_overview.json`, `_index.json`, or the case's cache directory."
- Cài đặt khớp đúng mô tả: `hiddenCases` là `Set` lưu trong `localStorage` key
  `qc_dashboard_hidden_cases` (`dashboard_renderer.mjs:1135`, đọc/ghi tại `:1141-1171`); nút Hide/Unhide
  gắn `data-case-id` (`dashboard_renderer.mjs:193-194`), xử lý click tại `:1265-1290` — chỉ sửa
  `localStorage`, không gọi API/ghi file nào khác trong toàn bộ script (đã đọc hết
  `dashboard_renderer.mjs`, không có `fetch`/`fs` nào trong phần `<script>`).
- **Tác dụng thật**: một khi hide, case biến mất khỏi **mọi** tab filter khác (`All`, `Open`, `In
  Progress`,...) — logic tại `applyFilters()`, `dashboard_renderer.mjs:1211-1219`:
  `if (isHidden) matchesFilter = false` cho mọi filter khác `'hidden'`. Case chỉ còn thấy được ở tab
  "Hidden Cases" (`:1059`). Theo nghĩa này nó **có** giúp giảm nhiễu khi lướt các tab chính.
- **Nhưng đây thuần túy là housekeeping thủ công, không phải "focus vào active"**:
  - Phải bấm Hide **từng case một** — không có action hàng loạt kiểu "hide tất cả Closed" hay "hide
    tất cả case không update > N ngày". Không có logic nào tự động hide dựa trên `caseStatus`,
    `closedAt`, hay bất kỳ tiêu chí "active"/"inactive" nào — hoàn toàn phụ thuộc trí nhớ/thao tác
    người dùng.
  - Không liên hệ gì với khái niệm "active" trong domain — không có rule tự re-show khi case
    reopen/update lại (per `CONTEXT.md:61`, Hide chỉ là 1 flag phẳng theo `caseNumber`, không có
    hook nào ở `overview_store.mjs`/`cases_overview.mjs` xóa case khỏi `hiddenCases` khi status đổi —
    thực ra hoàn toàn không thể, vì Hide sống ở trình duyệt, còn status sống ở server-render, hai bên
    không giao tiếp).
  - Per-browser: state không đồng bộ máy khác/session khác — mở dashboard ở máy/profile khác thấy lại
    toàn bộ case đã hide, nên "focus" chỉ có giá trị tạm thời/local, không phải điều hướng chung của
    team.
- Kết luận: Hide đúng là "list cleanup" (dọn nhiễu khỏi tầm mắt) chứ **không phải** cơ chế surfacing
  hoặc filtering theo "case nào đang cần tôi quan tâm" — nó chỉ ẩn được cái người dùng đã tự quyết
  định là không cần xem nữa, không tự suy luận giúp cái gì đang active.

---

## 5. Hook auto-sync `afterFinalize` (gọi từ `finalize_case.mjs` và `run_summary.mjs finalize`) có
đảm bảo dashboard luôn phản ánh state mới nhất không, hay có lag/race?

**Có lệch giữa tài liệu và code, và có rủi ro race condition thật khi ghi `_overview.json`.**

### 5a. Doc/code mismatch — `afterFinalize` không thực sự được gọi từ 2 nơi mà SKILL.md nói

- `SKILL.md:58-60` khẳng định: *"`_overview.json` và `dashboard.html` are automatically kept
  synchronized via downstream hooks: 1. `qualcomm-case-agent` (`finalize_case.mjs` -> `afterFinalize`)
  ... 2. `qualcomm-case-summary` (`run_summary.mjs finalize` -> `afterFinalize`) ..."*
- Thực tế: cả `finalize_case.mjs` và `run_summary.mjs` chỉ import `syncCaseOverview`, **không hề
  import hay gọi `afterFinalize`**:
  - `finalize_case.mjs:40` — `import { syncCaseOverview } from '../../qualcomm-case-overview/scripts/cases_overview.mjs';`
  - `finalize_case.mjs:948-960` — gọi trực tiếp `syncFn(caseCode, {...})` với
    `syncFn = options.syncCaseOverview || syncCaseOverview`, tự viết lại try/catch/`onError`/warn y hệt
    logic của `afterFinalize`.
  - `run_summary.mjs:22` — cùng pattern import `syncCaseOverview`.
  - `run_summary.mjs:192-203` — cùng pattern gọi trực tiếp `syncFn(...)`, tự lặp lại try/catch.
  - `afterFinalize` (định nghĩa tại `cases_overview.mjs:24-42`) chỉ được gọi trong test
    (`tests/cases_overview_after_finalize.test.mjs:31,43,57`), **không có call site nào trong code sản
    xuất** (`grep -rn "afterFinalize"` trên toàn repo chỉ ra định nghĩa, test, và 2 dòng mô tả trong
    `SKILL.md`/`docs/DESIGN.md:407,463` — không có ở `finalize_case.mjs` hay `run_summary.mjs`).
  - Hệ quả thực tế nhỏ (hai đường gọi `syncFn` tương đương logic với `afterFinalize`), nhưng đây là
    một API "tưởng như là hợp đồng tích hợp chính thức" (`afterFinalize`, export công khai, được đặt
    tên riêng, được tài liệu hoá tường minh) mà **không một call site production nào dùng nó** —
    rủi ro: sửa `afterFinalize` trong tương lai (ví dụ thêm log/metric) sẽ không có tác dụng gì với
    pipeline thật, vì 2 file gọi trực tiếp `syncCaseOverview` và tự duplicate logic riêng.

### 5b. Trong 1 lần chạy tuần tự: đồng bộ, không có "lag" thấy được

- `syncCaseOverview()` (`overview_store.mjs:282-371`) chạy đồng bộ ngay trong cùng process gọi nó,
  **trước khi** `finalize_case.mjs`/`run_summary.mjs` in verdict JSON cuối cùng ra stdout — tức nếu
  chạy 1 case tại 1 thời điểm, `_overview.json` và `dashboard.html` được cập nhật xong trước khi lệnh
  kết thúc.
- Mặc định `render: true` (`overview_store.mjs:286`) nên `renderDashboardHtml` được gọi ngay trong
  cùng lần sync (`overview_store.mjs:355-368`) — không phải chờ 1 cron/step riêng.

### 5c. Nhưng cả sync lẫn render đều "best-effort, never throw" — lỗi bị nuốt, không lộ ra verdict

- `overview_store.mjs:356-368`: nếu `renderDashboard()` (render HTML) throw, lỗi bị bắt tại chỗ, chỉ
  `process.stderr.write` cảnh báo (`:366`) và trả `rendered:false` — không throw ra ngoài.
- `finalize_case.mjs:947-960` và `run_summary.mjs:191-203`: cả *toàn bộ* lệnh gọi `syncFn(...)` (bao
  gồm cả bước đọc/ghi `_overview.json`, không riêng gì render) đều được bọc try/catch riêng ở tầng
  caller, cũng chỉ `process.stderr.write` cảnh báo, **không** làm thay đổi `status` trả về của chính
  `finalize()`/`finalize case` (verdict `created`/`updated`/`summarized`/...).
- Theo `CLAUDE.md`: *"Callers must branch on the `status` field in stdout, never on the shell
  exit-code label alone"* — nhưng verdict JSON đó **không chứa thông tin gì về việc overview sync có
  thành công hay không**. Một caller chỉ đọc field `status` trên stdout (đúng như hợp đồng được tài
  liệu hoá) sẽ **không có cách nào biết** dashboard/`_overview.json` đã stale sau lần chạy đó — cảnh
  báo duy nhất nằm ở stderr, kênh mà theo hợp đồng verdict không yêu cầu caller phải đọc.

### 5d. Race condition thật: không có lock khi đọc-sửa-ghi `_overview.json`

- `syncCaseOverview()` làm read-modify-write kinh điển không khoá:
  đọc `_overview.json` (`overview_store.mjs:298`, `JSON.parse(readFileSync(...))`) → sửa mảng
  `overviewData.cases` trong bộ nhớ (`:313-334`) → sort lại (`:337-342`) → ghi ra file tạm rồi
  `renameSync` (`:351-353`, atomic **per write**, nhưng không atomic cho cả chu trình
  đọc→sửa→ghi).
- Repo có `lock.mjs` (nêu trong `CLAUDE.md` ở tầng "Persistence + integrity") nhưng
  `overview_store.mjs`/`cases_overview.mjs` **không import/dùng lock nào** (đã grep
  `lock|withLock|acquireLock|Lock\(` trong `overview_store.mjs` — 0 kết quả liên quan đến file
  locking thật; 2 kết quả trùng khớp chỉ là substring `blocker` trong `blockerOrNextMilestone`).
  `finalize_case.mjs` cũng không dùng `lock.mjs` quanh đoạn gọi `syncFn` (`:947-960`).
- Hệ quả: nếu 2 tiến trình cùng gọi `syncCaseOverview` gần như đồng thời cho 2 case khác nhau (ví dụ
  một phiên đang `npm run case -- X` trong khi phiên khác đang chạy
  `run_summary.mjs finalize Y --input ...`), cả hai đều đọc cùng một bản `_overview.json` cũ, mỗi bên
  chỉ thêm/sửa case của mình vào bản sao trong bộ nhớ, rồi ghi đè `_overview.json` — **tiến trình ghi
  sau thắng, xoá mất update của tiến trình ghi trước** (lost update). Vì lỗi này (nếu random do timing)
  cũng chỉ log ra stderr như mục 5c, không có cơ chế nào tự phát hiện/tự phục hồi ngoài việc người
  dùng chủ động chạy `--rebuild` (`cases_overview.mjs:148`, `buildOverviewData` quét lại toàn bộ
  `data/cases/` từ đầu) khi họ tình cờ nhận ra dashboard thiếu case.
- Không có test nào trong `tests/cases_overview_after_finalize.test.mjs` hay
  `tests/cases_overview_e2e.test.mjs` mô phỏng 2 lời gọi `syncCaseOverview` chạy song song/interleave
  để bắt lost-update — cả 2 file test đều gọi tuần tự.

### Kết luận mục 5

Trong kịch bản 1-case-tại-1-thời-điểm (đúng usage pattern hiện tại: agent chạy tuần tự từng lệnh), cơ
chế đủ để dashboard "đồng bộ ngay" — không có lag đáng kể. Nhưng **guarantee không mạnh**: (1) tài
liệu hoá sai call path (`afterFinalize` không được dùng thật), (2) lỗi sync/render bị nuốt hoàn toàn,
không phản ánh vào verdict JSON mà theo hợp đồng chính thức là kênh duy nhất caller phải đọc, và (3)
không có khoá file nào chống lost-update nếu 2 tiến trình finalize từng chạy đồng thời — rủi ro race
condition có thật về mặt code, dù xác suất xảy ra trong thực tế phụ thuộc việc người dùng có bao giờ
chạy song song 2 phiên capture/summary hay không (điều mà tài liệu hiện tại không nói rõ là được phép
hay bị cấm).

---

## Tổng hợp gap chính (đối chiếu mục tiêu "nắm status nhanh" của issue #193)

1. Badge màu status dựa trên heuristic substring 1 chiều (`getStatusCategory`,
   `dashboard_renderer.mjs:25-33`), không phân biệt được "Pending Qualcomm" (chờ họ) và "Pending
   Customer" (chờ mình) — cả hai cùng màu `in_progress`.
2. `ballInCourt` — tín hiệu "ai đang cầm bóng" rõ ràng nhất trong domain — bị drop hoàn toàn ở
   `extractAiSummary()` (`overview_store.mjs:64-81`), không tới được dashboard/CLI.
3. `lastCommentAt`/`closedAt` được tính sẵn (`overview_store.mjs:114-116,130,138,187,193`) nhưng
   không render ở đâu cả — không có cách nào thấy "case này im lặng bao lâu rồi" dù dữ liệu đã có sẵn.
4. Không có sort/group theo priority/status/staleness — chỉ sort theo `syncedAt` giảm dần
   (`overview_store.mjs:253-258,337-342`) và filter tab dựa trên category không tin cậy (gap #1).
5. Hide là dọn nhiễu thủ công từng case (`dashboard_renderer.mjs:1265-1290`), không phải cơ chế
   surfacing "active"/"cần hành động" tự động.
6. Auto-sync hoạt động đồng bộ trong kịch bản tuần tự nhưng (a) tài liệu sai lệch với code thật về
   nơi gọi `afterFinalize` (`SKILL.md:58-60` vs `finalize_case.mjs:948-960`,
   `run_summary.mjs:192-197`), (b) lỗi sync bị nuốt không lộ ra verdict JSON, và (c) không khoá file
   khi ghi `_overview.json` → có nguy cơ lost-update nếu chạy song song.

Không có đề xuất thiết kế UI mới trong tài liệu này, theo đúng phạm vi ticket.
