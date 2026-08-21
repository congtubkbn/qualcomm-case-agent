# PRD & Technical Spec: Dọn dẹp & Chuẩn hóa Auth và Search Landing (qualcomm-case-agent)

- **Feature Name**: `cleanup-auth-and-search-landing`
- **Target Component**: `qualcomm-case-agent` (Authentication, Case Search/Landing, SKILL.md, References)
- **Status**: Ready for Implementation
- **Author**: Antigravity & User Alignment Session

---

## 1. Problem Statement

Skill `qualcomm-case-agent` sau các đợt nâng cấp (từ CLI `agent-browser` sang Native CDP WebSocket + Fast Landing) hiện còn tồn đọng nhiều nợ kỹ thuật (technical debt) và tài liệu lỗi thời:

1. **Mã nguồn còn chứa logic legacy dư thừa**: `scripts/run_case.mjs` vẫn còn các hàm điều hướng dự phòng CLI cũ (`landOnCase`, `findCaseLink`, `pollReadiness`) vốn phụ thuộc vào việc spawn CLI và polling cố định `sleep()`, làm phình to mã nguồn và gây phân mảnh luồng xử lý so với `scripts/fast_landing.mjs`.
2. **Tài liệu tham khảo (References) bị rườm rà và lỗi thời**:
   - `references/manual-flow.md` có hơn 480 dòng chứa các lệnh `agent-browser` thủ công, các bước gõ lệnh PowerShell, các tàn dư ghi chú về DPAPI/mật khẩu tự động đã bị khai tử.
   - `references/login-flow.md` cần được chuẩn hoá súc tích để làm kim chỉ nam duy nhất cho cơ chế đăng nhập (Session Reuse + Người dùng tự nhập OTP vào Chrome profile bền vững).
3. **Phân tán nhận thức của AI/Agent**: Khi gặp lỗi hoặc cần tra cứu, Agent có thể đọc nhầm các hướng dẫn legacy trong `manual-flow.md` thay vì thực thi luồng Fast CDP chuẩn, gây lãng phí token và thời gian.

---

## 2. Solution & Architectural Decisions

Thực hiện dọn dẹp toàn diện (Docs + Code) với các quyết định kiến trúc:

### 2.1. Chuẩn hóa Luồng Điều hướng & Tìm kiếm Case (Navigation & Search Access)
- **Mô hình**: Fast Landing chuẩn (`fast_landing.mjs` + `cdp_client.mjs`).
  - *Direct URL*: Nếu case đã có trong cache và có `caseUrl` hợp lệ, điều hướng trực tiếp bằng CDP native.
  - *Fallback / New Case*: Nếu case mới hoặc URL lỗi, điều hướng đến `https://support.qualcomm.com/s/global-search/<case_code>`.
  - *In-Page MutationObserver*: Bóc tách link SFID thật và header fields ngay khi DOM hydrate; click / navigate vào case tin cậy.
- **Dọn dẹp code**: Tinh gọn `run_case.mjs`, loại bỏ các hàm landing legacy không còn cần thiết, đồng nhất việc sử dụng `fastLandOnCase`.

### 2.2. Chuẩn hóa Cơ chế Đăng nhập (Authentication Model)
- **Cơ chế**: Pure Session Reuse qua Persistent Chrome Profile (`data/chrome-profile/` trên CDP port `9222`).
- **Xử lý hết hạn phiên**: Khi trang chuyển hướng sang `account.qualcomm.com` (Okta SSO):
  - Agent dừng lại với verdict `{"status": "auth-required", ...}` (exit code 3).
  - Không có bất kỳ cơ chế autofill mật khẩu / DPAPI ngầm nào.
  - Người dùng tự đăng nhập thủ công trên cửa sổ Chrome hiển thị (Email OTP đến hộp thư Samsung ~5 phút).
  - Sau khi đăng nhập thành công, chạy lại lệnh capture.

### 2.3. Tinh gọn & Chuẩn hóa Tài liệu (Documentation & References)
- **`references/login-flow.md`**: Làm tài liệu súc tích, ngắn gọn, chuẩn xác về quy trình Okta SSO + OTP + Chrome Persistent Profile.
- **`references/manual-flow.md`**: Cắt giảm triệt để các hướng dẫn dòng lệnh `agent-browser` cũ, chỉ giữ lại các kịch bản xử lý sự cố (Troubleshooting & Recovery) thực sự hữu ích.
- **`SKILL.md`**: Cập nhật mô tả luồng capture & login tinh gọn, loại bỏ các nhắc đến cơ chế cũ.

---

## 3. User Stories / Definition of Done (DoD)

### **US-1: Dọn dẹp mã nguồn điều hướng & landing trong `run_case.mjs`**
- **Là một** nhà phát triển bảo trì agent,
- **Tôi muốn** `run_case.mjs` sử dụng luồng điều hướng `fastLandOnCase` sạch sẽ, không còn các hàm legacy dư thừa (`landOnCase`, `findCaseLink` dạng polling cũ),
- **Để** mã nguồn dễ hiểu, giảm độ phức tạp và tập trung vào kiến trúc CDP native.
- **DoD**:
  - `run_case.mjs` gọn gàng, loại bỏ các khối code fallback CLI không dùng.
  - Xử lý mượt mà cả 2 trường hợp: Direct Landing (cache) và Global Search Landing (`/s/global-search/<CODE>`).
  - Trả về đúng mã lỗi `auth-required` (exit 3) khi phát hiện `AUTH`.

### **US-2: Tinh gọn tài liệu đăng nhập `references/login-flow.md`**
- **Là một** AI Agent hoặc kỹ sư vận hành,
- **Tôi muốn** một tài liệu `login-flow.md` rõ ràng, chính xác, ngắn gọn,
- **Để** hiểu ngay cách thức hoạt động của session reuse và quy trình xử lý khi phiên Okta hết hạn.
- **DoD**:
  - Mô tả rõ: Chrome Profile tại `data/chrome-profile/`, port 9222.
  - Hướng dẫn rõ: Khi gặp `auth-required`, người dùng mở Chrome đăng nhập thủ công bằng tài khoản Samsung và nhập OTP.
  - Không còn nhắc đến DPAPI, tự động inject mật khẩu hay script cũ.

### **US-3: Tinh gọn sổ tay xử lý sự cố `references/manual-flow.md`**
- **Là một** AI Agent cần khắc phục sự cố khi lệnh capture bị `blocked`,
- **Tôi muốn** một tài liệu `manual-flow.md` súc tích, tập trung vào nguyên nhân gốc rễ và cách xử lý,
- **Để** không bị quá tải token (token bloat) bởi hàng trăm dòng lệnh CLI lỗi thời.
- **DoD**:
  - Giảm dung lượng file từ ~480 dòng xuống còn tài liệu ngắn gọn (~80-120 dòng).
  - Loại bỏ các bước gõ lệnh `agent-browser eval` và PowerShell pipe phức tạp cũ.
  - Giữ lại các mục Recovery hữu ích: Recovery 0 (Chrome / CDP Port Reset), Recovery 1 (Okta Manual Login), Recovery 2 (Case Not Found / Wrong Code).

### **US-4: Đồng bộ `SKILL.md` và Kiểm thử hồi quy toàn diện (`npm test`)**
- **Là một** QA / Maintainer,
- **Tôi muốn** toàn bộ test suite (`npm test`) chạy thành công và `SKILL.md` được cập nhật chính xác,
- **Để** đảm bảo không có bất kỳ regression nào trong toàn bộ pipeline cào và xử lý case.
- **DoD**:
  - Cập nhật `tests/run_case.test.mjs` và các test liên quan nếu cần.
  - `npm test` vượt qua 100% (pipeline, scrape_case, run_case, cdp_client, fast_landing).
  - `SKILL.md` thể hiện đúng luồng đăng nhập và search case hiện đại.

---

## 4. Deep Modules Map

| File / Module | Hành động | Mục đích |
|---|---|---|
| `.claude/skills/qualcomm-case-agent/scripts/run_case.mjs` | **MODIFY** | Loại bỏ các hàm legacy CLI fallback (`landOnCase`, `findCaseLink`), tối ưu hoá luồng gọi `fastLandOnCase`. |
| `.claude/skills/qualcomm-case-agent/references/login-flow.md` | **MODIFY** | Chuẩn hóa tài liệu đăng nhập: Okta + OTP + Persistent Chrome Profile. |
| `.claude/skills/qualcomm-case-agent/references/manual-flow.md` | **MODIFY** | Tinh gọn từ ~482 dòng thành cẩm nang troubleshooting ngắn gọn, bỏ các lệnh `agent-browser` và DPAPI cũ. |
| `.claude/skills/qualcomm-case-agent/SKILL.md` | **MODIFY** | Cập nhật cấu hình, luồng login và search landing tinh gọn. |
| `tests/run_case.test.mjs` | **MODIFY** | Cập nhật mock & assertions tương ứng với code đã dọn dẹp. |

---

## 5. Testing & Verification Decisions

1. **Unit & Integration Tests**: Chạy `npm test` (sử dụng Node test runner với module mocks) kiểm tra toàn bộ các file:
   - `tests/fast_landing.test.mjs`
   - `tests/run_case.test.mjs`
   - `tests/cdp_client.test.mjs`
   - `tests/scrape_case.test.mjs`
   - `tests/pipeline.test.mjs`
2. **Documentation Check**: Đảm bảo không còn tham chiếu sai lệch hoặc file rác trong `.claude/skills/qualcomm-case-agent/`.
