# PRD: Qualcomm Case Extraction & Local Storage Pipeline

## 1. Problem Statement
Sau khi đăng nhập thành công vào cổng hỗ trợ Qualcomm Support (Salesforce Lightning), các kỹ sư cần một phương thức tự động và tin cậy thông qua skill `qualcomm-case-agent` để:
1. Tra cứu và truy cập vào bất kỳ Case nào (kể cả case của đồng nghiệp hoặc dự án khác).
2. Lấy đầy đủ thông tin chi tiết: Tiêu đề (Subject/Title), Mô tả ban đầu (Description), Trạng thái (Status), Mức độ ưu tiên (Priority/Severity), Sản phẩm/Chipset, Account/Customer Name.
3. Bóc tách 100% luồng thảo luận/phân tích kỹ thuật (Chatter Feed) không bị cắt xén (tự động bung các bình luận bị ẩn/thu gọn, ghi nhận người gửi, vai trò Qualcomm vs Khách hàng, mốc thời gian, nội dung, danh sách file đính kèm).
4. Lưu trữ toàn bộ dữ liệu này một cách an toàn, có cấu trúc tại máy cục bộ (Local Storage) để phục vụ cho các bước phân tích sâu tiếp theo (AI/Downstream Analysis), đồng thời hỗ trợ cập nhật thay đổi (Diff & Sync) thông minh khi quét lại case cũ.

---

## 2. Solution Overview
- **Giao diện kích hoạt:** Thực thi thông qua skill `qualcomm-case-agent <CASE_CODE>`.
- **Cơ chế bóc tách (Data Extraction Pipeline):**
  - Sử dụng browser automation (CDP / Agent Browser) đã đăng nhập phiên làm việc để điều hướng tới trang Case.
  - Tự động lấy Metadata từ tab Details / Header / Search Row.
  - Quét tab Feed, tự động thực hiện chuỗi thao tác bung toàn bộ bình luận (Click "Expand Post", "Show more comments / View all Chatter items").
  - Trích xuất cấu trúc dữ liệu theo dòng thời gian chuẩn hóa.
- **Cấu trúc lưu trữ cục bộ (Local Storage):**
  - Thư mục lưu trữ: `data/cases/<CASE_CODE>/` (được đưa vào `.gitignore` để đảm bảo bảo mật dữ liệu NDA).
  - `case.raw.json`: Chứa bản snapshot dữ liệu trích xuất thô từ DOM.
  - `case.json`: Chứa dữ liệu đã chuẩn hóa (Metadata + Timeline comments + `analysisLog`/`enrichment` field).
  - `case.md`: Báo cáo Markdown tổng hợp dễ đọc cho kỹ sư và làm đầu vào chất lượng cao cho LLM phân tích ở phase sau.
- **Cơ chế Smart Diff & Preserve Notes:**
  - Khi cào lại một case đã tồn tại, hệ thống so sánh sự thay đổi về Status, thêm các comments/updates mới vào timeline mà vẫn giữ nguyên các ghi chú/analysisLog đã tạo trước đó.

---

## 3. Scope Boundaries & Non-Goals

### In Scope
- Đăng nhập/xác thực phiên và điều hướng tới case theo Case Code.
- Bóc tách đầy đủ Metadata (Subject, Description, Status, Priority, Severity, Chipset, Account).
- Tự động bung nở và cào 100% Chatter Feed items và replies.
- Phân loại author role (Qualcomm vs Customer/OEM vs System).
- Lưu trữ cục bộ chuẩn hóa: `case.raw.json`, `case.json`, `case.md`.
- Thay đổi phát hiện (Diff) và bảo toàn các trường enrichment / analysis log khi re-sync.

### Out of Scope
- Tuyệt đối không tương tác ghi/post/comment ngược lại cổng Qualcomm Support (chế độ Read-Only 100%).
- Không tự động tải xuống các file nhị phân dung lượng lớn (QXDM logs/crash dumps GB) — chỉ ghi nhận metadata & tên file đính kèm.
- Không gửi dữ liệu case ra bất kỳ dịch vụ đám mây công cộng nào (bảo vệ tuyệt đối NDA dữ liệu cục bộ).

---

## 4. User Stories & Definition of Done (DoD)

### User Story 1: Trích xuất Case mới từ Qualcomm Support
- **Là một** kỹ sư phần mềm / hệ thống,
- **Tôi muốn** chạy skill `qualcomm-case-agent <CASE_CODE>` cho một case bất kỳ,
- **Để** tự động thu thập toàn bộ tiêu đề, mô tả, metadata và toàn bộ luồng trao đổi kỹ thuật về máy.
- **DoD:**
  - Skill tự động mở trang case và bung hết các comment bị ẩn.
  - Tạo thư mục `data/cases/<CASE_CODE>/` chứa đủ 3 file: `case.raw.json`, `case.json`, `case.md`.
  - Hiển thị tóm tắt ngắn gọn lên console (Title, Status, Tổng số comments cào được, đường dẫn file).

### User Story 2: Cập nhật (Sync/Diff) Case đã tồn tại
- **Là một** kỹ sư,
- **Tôi muốn** chạy lại skill cho một case đã được cào trước đó,
- **Để** cập nhật các phản hồi mới nhất từ Qualcomm mà không mất các phân tích cũ.
- **DoD:**
  - Hệ thống phát hiện các comment mới và append vào timeline.
  - Cập nhật Status mới nếu có thay đổi.
  - Giữ nguyên các ghi chú trong `analysisLog` hoặc trường `enrichment` đã có trong `case.json`.
  - Cập nhật lại `case.md` phản ánh nội dung mới nhất kèm thông báo số lượng update mới.

---

## 5. Deep Modules Map

| File / Module | Responsibility | Public Interface |
|---|---|---|
| `.claude/skills/qualcomm-case-agent/scripts/extract_case.js` | Trích xuất DOM sạch từ Salesforce Lightning (Metadata + Expanded Chatter comments + Attachments list). | IIFE trả về JavaScript Object thô |
| `.claude/skills/qualcomm-case-agent/scripts/expand_step.js` | Tự động lặp qua DOM click tất cả các nút "Expand Post" và "Show more comments" cho đến khi hết. | IIFE trả về `{ expandedCount, remainingCollapsed }` |
| `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs` | Điều phối quá trình cào: kiểm tra URL, gọi expand, gọi extract, validate dữ liệu, hỗ trợ Smart Diff và lưu `case.raw.json` + `case.json`. | CLI / Module: `scrapeCase(caseCode, options)` |
| `.claude/skills/qualcomm-case-agent/scripts/render_case.mjs` | Render dữ liệu từ `case.json` ra bản Markdown (`case.md`) cấu trúc trực quan, rõ ràng cho kỹ sư. | CLI / Module: `renderCase(caseCode)` |
| `.claude/skills/qualcomm-case-agent/SKILL.md` | Tài liệu hướng dẫn định nghĩa workflow cho Agent để kích hoạt và tương tác liền mạch. | Skill Prompt & Execution Guide |

---

## 6. Testing Strategy & Decisions
- **Unit Tests:**
  - Test parser trích xuất dữ liệu DOM với các mock HTML fixture (kiểm tra làm sạch ký tự mojibake, bóc tách tên tác giả, role, timestamp, attachment).
  - Test merge logic & Smart Diff: Đảm bảo khi merge bản mới với bản cũ, không bị mất `analysisLog` và các comment mới được nối chính xác theo thời gian.
- **Integration Tests:**
  - Test luồng end-to-end `scrape_case.mjs` -> `render_case.mjs` trên mock CDP/DOM responses.
  - Chạy `npm test` để xác nhận toàn bộ test suite pass 100%.
