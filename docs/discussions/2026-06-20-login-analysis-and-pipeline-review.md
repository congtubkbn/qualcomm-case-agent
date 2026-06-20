# Discussion: Qualcomm Login Analysis & Pipeline Review

**Date:** 2026-06-20  
**Branch:** `claude/qualcomm-login-analysis-57pirr`  
**Participants:** User + Claude Code  

---

## Summary

Cuộc thảo luận phân tích toàn bộ cơ chế đăng nhập và pipeline extraction của Qualcomm Case Agent. Kết quả chính:

1. **Auth (Phase 1)** được thiết kế đúng và đã verify empirically — cơ chế persistent Chrome profile hoạt động tốt.
2. **Extraction (Phase 3)** chưa bao giờ được test end-to-end — `selectors.json` toàn null, `scrape_case.mjs` sẽ luôn exit code 6 ngay khi chạy.
3. **Hai kỹ thuật quan trọng chưa làm:** Selector Discovery (cần DOM thật sau khi đăng nhập) và fix robustness của `abRun()` (stdin pipe → không chạy được daemon mới).
4. **Giải pháp đề xuất:** B+C — thêm daemon-check + đổi `execSync` → `spawnSync(stdin:'ignore')`.
5. **Blocking item thực tế:** Cần máy local có display để đăng nhập, inspect DOM, điền `selectors.json`, sau đó commit lại.

---

## 1. Phân tích flow đăng nhập Qualcomm

### 1.1 Cơ chế xác thực

| Thành phần | Chi tiết |
|---|---|
| Auth provider | Okta OAuth tại `account.qualcomm.com` → redirect đến `support.qualcomm.com` |
| MFA | Email OTP — mã 6 số gửi về hộp thư Samsung, hiệu lực ~5 phút |
| Login ID | `the.thoi@samsung.com` (chỉ dùng để login, KHÔNG bao giờ lưu mật khẩu) |
| Session store | Persistent Chrome profile tại `data/chrome-profile/` |

### 1.2 Chiến lược Profile-first

Vì Qualcomm bắt buộc Email OTP, không thể tự động hoàn toàn bằng password. Giải pháp là **persistent Chrome profile**:

```bash
P="data/chrome-profile"
agent-browser --headed --profile "$P" open "https://support.qualcomm.com"
agent-browser snapshot -c
```

- `--profile` trỏ đến **cùng một thư mục** mỗi lần chạy → Chrome giữ cookies/tokens
- `--headed` → cửa sổ hiển thị để user can thiệp khi cần
- Đăng nhập **1 lần duy nhất** → session tự persist, các lần sau bỏ qua password + OTP
- **Không có bước "save session" riêng** — profile tự động ghi

### 1.3 Decision tree

```
Mở support.qualcomm.com
       │
       ├── Dashboard render bình thường?  → Session còn hạn → tiếp tục
       │
       ├── Redirect đến account.qualcomm.com / Okta?
       │       → DỪNG, yêu cầu user:
       │         1. Nhập password Qualcomm ID trong browser
       │         2. Chờ OTP email về Samsung mailbox
       │         3. Paste OTP vào trang
       │       → Profile lưu session mới tự động
       │
       └── Email unavailable + session expired?
               → BÁO LỖI và DỪNG (không retry)
```

### 1.4 Phát hiện auth trong code (`scrape_case.mjs:258-266`)

```javascript
const snap = browserSnapshot();
if (/account\.qualcomm\.com|okta\.com|sign.?in/i.test(snap)) {
  emit({ code: EXIT.AUTH_NEEDED, reason: 'redirected to authentication', url: caseUrl });
  process.exit(EXIT.AUTH_NEEDED);  // Exit code 3
}
```

---

## 2. Verify các ràng buộc kỹ thuật

### Ràng buộc 1: Browser launch hang ✅ Đúng + phát hiện thêm chi tiết code

Docs ghi `(verified)` và `(observed: the command never returns)` — đây là empirical observation thật.

**Chi tiết bỏ sót trong phân tích ban đầu** — `scrape_case.mjs:162-164`:

```javascript
function abRun(args) {
  return execSync(`agent-browser ${args}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']  // stdin là PIPE, không phải TTY
  }).trim();
}
```

`browserOpen()` trong script cũng gọi qua `abRun` → cũng bị non-TTY. Điều này có nghĩa:

- Nếu Phase 1 đã khởi động daemon trước → `agent-browser open <url>` chỉ điều hướng URL → **không hang**
- Nếu daemon chưa chạy → `agent-browser open` phải khởi động daemon mới → **hang ngay**

Script **phụ thuộc ngầm** vào Phase 1 đã chạy trước. Không có enforcement trong code.

### Ràng buộc 2: Single instance ✅ Đúng

Chrome lock thư mục `user-data-dir` — chỉ một process được dùng cùng lúc.

### Ràng buộc 3: Windows "Input redirection" ✅ Đúng

Liên quan đến cùng root cause (non-interactive stdin) nhưng biểu hiện khác trên Windows.

### Ràng buộc 4: OTP expired ✅ Đúng

Mã OTP hết hạn sau ~5 phút. User phải request mã mới, không dùng lại mã cũ.

---

## 3. Vấn đề nghiêm trọng bị bỏ qua — `selectors.json` toàn null

**Phát hiện khi verify code thực tế:**

```json
// config/selectors.json — HIỆN TẠI
{
  "fields":   { "title": null, "status": null, ... },
  "comments": { "container": null, "body": null, ... },
  "displayedCommentCount": null
}
```

`validateSelectors()` tại `scrape_case.mjs:20-27` check 4 key bắt buộc — tất cả null → `valid = false` → **script exit code 6 ngay lập tức**, trước khi mở bất kỳ URL nào.

`extraction.md:99` xác nhận rõ ràng:
> **TODO — not yet captured (DOM only visible after login)**

### Kết luận: Solution đã được verify chưa?

| Phần | Đã verify? |
|---|---|
| Auth mechanism (persistent profile, OTP flow) | ✅ Verified — docs ghi "observed", "verified" |
| Browser launch hang | ✅ Verified empirically |
| Phase 1 → Phase 2 (auth + navigate) | ✅ Có thể hoạt động nếu user sign in thủ công |
| **Phase 3 — scrape_case.mjs chạy được** | ❌ CHƯA — script luôn exit code 6 vì selectors null |
| **CSS selectors DOM thực** | ❌ CHƯA — extraction.md nói "TODO, DOM only visible after login" |
| **End-to-end flow** | ❌ CHƯA bao giờ chạy thành công |

---

## 4. Những gì cần làm để hoàn thiện

### Trạng thái hiện tại (verified 2026-06-20)

| Layer | Trạng thái |
|---|---|
| Unit tests (pure logic) | ✅ 20/20 pass |
| Render tests (render_case.mjs) | ✅ 3/3 pass |
| Node.js | ✅ v22.22.2 |
| `agent-browser` installed | ❌ Chưa cài |
| `selectors.json` | ❌ Tất cả null |
| End-to-end với browser thật | ❌ Chưa bao giờ chạy |

### Bước 1 — Cài agent-browser (trên máy local có display)

Remote environment không có display server. Phải làm trên máy local Windows/Mac.

```bash
npm i -g agent-browser
agent-browser install       # download bundled Chromium
agent-browser --version     # verify
```

### Bước 2 — Selector Discovery (blocker chính — phải làm 1 lần)

```bash
# Khởi động browser headed với persistent profile
agent-browser --headed --profile "data/chrome-profile" open "https://support.qualcomm.com"
# User đăng nhập (Okta password + OTP email)
# Navigate đến case thật, sau đó:
agent-browser snapshot -c    # xem DOM
```

Từ snapshot, xác định CSS selectors và ghi vào `selectors.json`:

```json
{
  "_version": 1,
  "_discoveredAt": "<ISO timestamp>",
  "caseUrlBase": "https://support.qualcomm.com",
  "caseUrlPattern": "<URL thật sau khi navigate>",
  "fields": { "title": "<selector>", "status": "<selector>", ... },
  "comments": { "container": "<selector>", "body": "<selector>", ... },
  "displayedCommentCount": "<selector>"
}
```

### Bước 3 — Test scrape_case.mjs end-to-end

```bash
node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE>
echo "Exit: $?"
```

| Exit code | Ý nghĩa | Hành động |
|---|---|---|
| 0 | Thành công | Kiểm tra `data/cases/<CODE>.json` |
| 3 | Session hết hạn | User đăng nhập lại |
| 5 | Captured < displayed | Selectors sai, fix lại |
| 6 | Selectors vẫn thiếu | Fix `selectors.json`, retry |

### Bước 4 — Test render + Enrich

```bash
node ".claude/skills/qualcomm-case-agent/scripts/render_case.mjs" "data/cases/<CODE>.json"
ls data/cases/   # kiểm tra .report.md, .md, .html
```

### Bước 5 — Commit selectors.json

Sau khi selectors được xác nhận, commit lại:
```bash
git add .claude/skills/qualcomm-case-agent/config/selectors.json
git commit -m "feat: populate selectors.json from live DOM discovery"
```

`selectors.json` không chứa data nhạy cảm nên commit được (khác với `chrome-profile/` và `data/cases/` đều đã gitignore).

---

## 5. Tại sao dùng `.mjs` và giải thích command

### 5.1 Tại sao `.mjs`

Node.js có hai hệ thống module:

| | CommonJS (CJS) | ES Module (ESM) |
|---|---|---|
| Cú pháp | `require()` / `module.exports` | `import` / `export` |
| Extension mặc định | `.js` | `.mjs` |
| Kích hoạt | mặc định | `.mjs` hoặc `"type":"module"` trong package.json |

`scrape_case.mjs` dùng ESM vì:
1. Dùng `import` syntax và `import.meta.url` (chỉ có trong ESM)
2. Export các hàm (`export const EXIT`, `export function validateSelectors`) để test có thể import
3. `.mjs` extension đảm bảo hoạt động từ bất kỳ thư mục nào, không phụ thuộc vào `package.json` của caller

Skill folder có `"type":"module"` trong `package.json`, nhưng lệnh chạy từ workspace root — `.mjs` làm rõ ràng và an toàn hơn.

### 5.2 Mục đích command

```bash
node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE>
echo "Exit: $?"
```

- **Lệnh 1:** Chạy scraper với case code. Script giao tiếp bằng exit code có nghĩa (0/2/3/4/5/6) và JSON trên stdout.
- **Lệnh 2:** `$?` = exit code của lệnh trước — agent dùng để điều hướng xử lý tiếp theo.

### 5.3 Các giải pháp cho vấn đề `execSync` + non-TTY

**Giải pháp A — Giữ nguyên (hiện tại)**  
Pros: Đơn giản, đúng với human-in-the-loop  
Cons: Phụ thuộc ngầm vào Phase 1 đã chạy trước, không có enforcement

**Giải pháp B — Thêm daemon-check**
```js
function ensureDaemonRunning() {
  try {
    execSync('agent-browser version', { stdio: ['pipe','pipe','pipe'], timeout: 3000 });
  } catch {
    emit({ code: EXIT.AUTH_NEEDED, reason: 'browser daemon not running — run Phase 1 first' });
    process.exit(EXIT.AUTH_NEEDED);
  }
}
```
Pros: Fail fast với thông báo rõ thay vì hang  
Cons: Vẫn cần Phase 1 thủ công

**Giải pháp C — Đổi `execSync` → `spawnSync(stdin:'ignore')**
```js
import { spawnSync } from 'node:child_process';

function abRun(args) {
  const result = spawnSync('agent-browser', args.split(' '), {
    stdio: ['ignore', 'pipe', 'pipe'],  // stdin: ignore, không block trên TTY check
    timeout: 30000,
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(result.stderr || 'agent-browser failed');
  return result.stdout.trim();
}
```
Pros: Robust hơn, loại bỏ TTY dependency cho non-launch commands  
Cons: Vẫn không khởi động daemon mới được

**Giải pháp D — Playwright trực tiếp**  
Thay agent-browser bằng Playwright API trong Node.js  
Pros: Kiểm soát hoàn toàn  
Cons: Phá vỡ thiết kế harness-agnostic, viết lại nhiều

### 5.4 Giải pháp tốt nhất: B + C kết hợp

- Thêm daemon-check đầu `main()` → fail fast thay vì hang
- Đổi `execSync` → `spawnSync` với `stdin: 'ignore'` → robust hơn với non-TTY

Giải pháp D về lý thuyết tốt nhất nhưng không xứng công bỏ ra ở giai đoạn này.

---

## Action items

- [ ] Cài `agent-browser` trên máy local có display
- [ ] Đăng nhập lần đầu, discover CSS selectors từ DOM thật
- [ ] Điền `selectors.json` và commit
- [ ] Test `scrape_case.mjs` end-to-end với case thật
- [ ] Implement fix B+C cho `abRun()` (daemon-check + spawnSync)
- [ ] Test render sau khi có `.json` thật
