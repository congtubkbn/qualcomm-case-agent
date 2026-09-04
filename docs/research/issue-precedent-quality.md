# Static review: `qualcomm-issue-precedent` — chất lượng search/report độc lập với #181

Nghiên cứu tĩnh (static code audit) cho issue #194, không chạy code, không thay đổi hành vi.
Phạm vi: `.claude/skills/qualcomm-issue-precedent/scripts/precedent_search.mjs`,
`precedent_store.mjs` (nơi thực sự chứa logic search/extraction mà `precedent_search.mjs` chỉ
bọc CLI xung quanh), `precedent_report.mjs`, `precedent_verdict.mjs`, `log_query_client.mjs`, và
`SKILL.md`. Mọi nhận định đều có trích dẫn `file:line`; đường dẫn tương đối tới gốc repo, gốc là
`.claude/skills/qualcomm-issue-precedent/`.

## 0. Trước tiên: #181 thực sự đang chờ gì

Đọc trực tiếp issue #181 (`mcp__github__issue_read`, đã đóng, `state_reason: completed`, có 3
sub-issue #182/#183/#184 đều đã hoàn thành). Phần "Further Notes" của #181 nói rõ:

> "The `log_query.py` invocation contract is pending; implementation of the `log_query` client
> module's real (non-placeholder) behavior is blocked until the user supplies it. **Everything
> else in this spec can be built and tested now, independent of that contract.**"

Và trong "Implementation Decisions": chỉ có **một** module bị chặn — "`log_query` client module"
(tức `scripts/log_query_client.mjs`) — "ships as an explicitly-labeled placeholder; every other
module depends only on this module's exported interface, never on `log_query.py` directly, so
only this one file needs rewriting once the real contract lands."

→ Kết luận sớm: #181 **chỉ** chặn hành vi thật của `log_query_client.mjs` (và do đó, chặn việc
`precedent_verdict.mjs` thực sự trả về `matched`/`does not match` thay vì luôn
`insufficient technical data to check`). Search (`precedent_store.mjs`), signature extraction
(cũng trong `precedent_store.mjs`), và định dạng report (`precedent_report.mjs`) **không** phụ
thuộc vào `log_query_client.mjs` — xem chi tiết ở mục 4.

Xác nhận trong code: `log_query_client.mjs:1-7` tự mô tả là "PLACEHOLDER MODULE" và
`log_query_client.mjs:31` luôn trả `{ unavailable: true, reason: 'log_query.py contract not yet
available (see issue #181)' }` sau khi validate tham số ở dòng 21-29. `SKILL.md:56` xác nhận lại:
"until the real `log_query.py` contract is supplied (see #181), every check resolves as
`unavailable`, so verdicts land on `insufficient technical data to check` today."

## 1. Matching free-text query ↔ case — có đủ robust để không bỏ sót case liên quan?

`precedent_search.mjs` (CLI) không tự làm matching — nó chỉ parse argv rồi gọi thẳng
`searchPrecedents()` từ `precedent_store.mjs` (`precedent_search.mjs:5,56`). Toàn bộ logic
matching nằm ở `precedent_store.mjs`:

- **Tokenize**: lowercase, tách theo `[a-z0-9]+`, loại từ ngắn hơn 2 ký tự và stopword
  (`precedent_store.mjs:37-41`). Danh sách stopword (`precedent_store.mjs:17-21`) chỉ có ~25 từ
  tiếng Anh phổ thông (a/an/the/is/...), không có domain stopword nào cho miền viễn thông.
- **Overlap**: đếm giao nhau thuần túy giữa hai tập token, không trọng số theo độ hiếm/tần suất
  (không phải TF-IDF) (`precedent_store.mjs:49-55`).
- **Scoring**: tổng có trọng số của overlap trên `title` (×3), `rootCause` (×3), `flow` (×1), và
  `product` như một "soft boost" (×2) — không bao giờ là bộ lọc cứng (`precedent_store.mjs:172-179`,
  weight constants tại `12-15`).
- **Ranking**: sort giảm dần theo score, tie-break tăng dần theo `caseNumber`, cắt còn `limit`
  (mặc định 10, `precedent_search.mjs:15`) (`precedent_store.mjs:189-195`).

**Điểm yếu rõ ràng, ảnh hưởng trực tiếp tới rủi ro "bỏ sót case liên quan thật":**

1. **Không có stemming/lemmatization, không đồng nghĩa.** Tokenize chỉ lowercase +
   tách chuỗi (`precedent_store.mjs:39`), không rút gọn về gốc từ. "drop" trong query và
   "dropped"/"dropping" trong `rootCause` của case cũ là hai token khác nhau → overlap = 0 cho
   cặp đó dù cùng nghĩa. Không có bảng đồng nghĩa domain nào (vd. "HO" ↔ "handover", "call drop"
   ↔ "call release", "eSRVCC" ↔ "SRVCC") — hai cách diễn đạt cùng một hiện tượng kỹ thuật bằng
   từ khác nhau sẽ không được ghép.
2. **Không có ngưỡng điểm tối thiểu (no relevance threshold).** `searchPrecedents` luôn trả về
   tối đa `limit` candidate — kể cả khi score = 0 cho tất cả (`precedent_store.mjs:192-194`
   không lọc `score > 0` trước khi `slice`). Khi corpus có "hàng trăm tới hàng nghìn" case (theo
   user story #12 trong #181), và limit mặc định chỉ là 10 (`precedent_search.mjs:15`), một case
   thực sự liên quan nhưng dùng từ vựng khác vẫn có thể bị các case *không liên quan* nhưng tình
   cờ trùng nhiều từ (title dài, rootCause dài) xếp hạng cao hơn và đẩy ra ngoài top 10 — đây là
   nguyên nhân chính khiến case liên quan thật có thể bị bỏ sót, không phải lỗi hiển thị.
3. Case-sensitivity **không** phải là điểm yếu ở bước matching: `tokenize()` lowercase toàn bộ
   trước khi so khớp (`precedent_store.mjs:39`), nên matching bản thân nó case-insensitive.

Tóm lại: đây là keyword-overlap thuần túy, có trọng số theo field nhưng không có
stemming/synonym/ngưỡng lọc — đủ dùng cho truy vấn gần giống nguyên văn case cũ, nhưng **không**
đảm bảo không bỏ sót một precedent thật sự liên quan khi cách diễn đạt khác đi hoặc corpus lớn.

## 2. Signature extraction — có nguy cơ sai/thiếu ngữ cảnh không?

Extraction cũng nằm hoàn toàn trong `precedent_store.mjs`, không phải trong
`precedent_search.mjs`:

- 3 regex pattern (`precedent_store.mjs:23-30`):
  - ALL_CAPS_WITH_UNDERSCORES: `/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g` (dòng 25) — **bắt buộc có
    ít nhất một dấu `_`**.
  - Cause code: `/\bcause\s*(?:code)?\s*[:#=]?\s*\d{1,4}\b/gi` (dòng 27) — tối đa 4 chữ số.
  - Hex literal: `/\b0x[0-9A-Fa-f]+\b/g` (dòng 29).
- `extractSignaturesFromText()` lấy đúng `match[0]` (dòng 69) — không cắt, không diễn giải →
  đúng nghĩa "verbatim", khớp với "Hard rule: never invent, paraphrase, or guess a signature" ở
  `SKILL.md:43`.
- `collectSignatures()` gắn provenance (`source`: `'rootCause'` / `'resolution'` /
  `'comment:<id>'`) cho từng signature, dedupe theo thứ tự xuất hiện đầu tiên
  (`precedent_store.mjs:87-104`).
- `buildReferenceCase()` gọi `collectSignatures({ rootCause, resolution }, comments)` với
  `comments` đọc từ `case.json` gốc (không phải `summary.json` đã digest) — đúng như spec #181
  yêu cầu ("verbatim comment bodies... since summary.json comments are pre-digested, not
  verbatim") (`precedent_store.mjs:129,139`).

**Không có tình huống "trích sai" (extraction không bao giờ tự bịa hay diễn giải) — nhưng có 3
tình huống trích *thiếu*, tức bỏ sót signature có thật:**

1. **Cause code >4 chữ số bị bỏ hoàn toàn, không phải bị cắt cụt.** Regex
   `\d{1,4}\b` (`precedent_store.mjs:27`) với `\b` ngay sau. Với input "cause 12345", engine thử
   khớp 4 chữ số "1234" rồi kiểm tra `\b` — ký tự kế tiếp là "5", vẫn là word-char nên không có
   boundary, backtrack dần xuống 3, 2, 1 chữ số, luôn thất bại vì luôn có digit theo sau → toàn
   bộ match thất bại tại vị trí đó, không có signature nào được trích ra cho cause code 5+ chữ số
   (khác với "bị cắt cụt còn 4 số" — nó biến mất hoàn toàn).
2. **Identifier ALL-CAPS không có `_` bị bỏ qua hoàn toàn.** Pattern dòng 25 yêu cầu
   `(?:_[A-Z0-9]+)+` — ít nhất một nhóm sau dấu `_`. Nhiều tên message/thủ tục 3GPP/Qualcomm là
   một từ đơn không có gạch dưới (vd. "PAGING", "ATTACH", "DETACH", "RRC", "ESM" đứng một mình)
   — các token này **không bao giờ** được coi là signature dù xuất hiện rõ ràng trong
   `rootCause`/`resolution`. Hệ quả: một Reference Case có root cause mô tả rõ ràng bằng thuật
   ngữ kỹ thuật nhưng toàn từ đơn (không `_`) sẽ có `signatures: []`
   → thẳng tới nhánh "no extractable technical signature" ở
   `precedent_report.mjs:69-70`, dù nội dung kỹ thuật thực chất tồn tại.
3. **Mất ngữ cảnh khi chỉ nhìn danh sách signature riêng lẻ (không phải lỗi trích, mà là lỗi
   trình bày ở bước sau).** `collectSignatures` chỉ lưu `{signature, source}` — `source` là tên
   field/`comment:<id>`, **không phải câu chứa nó** (`precedent_store.mjs:87-104`). Ở
   `precedent_report.mjs:76`, mục "Other extracted signatures (not checked)" chỉ liệt kê các
   chuỗi signature trần trụi, tách rời khỏi câu gốc. Ngữ cảnh vẫn được cứu vãn một phần vì toàn
   bộ `rootCause`/`resolution`/`flow` được in đầy đủ ngay phía trên trong cùng candidate block
   (`precedent_report.mjs:63-67`) — nhưng bản thân object signature (dùng làm input cho Step 2
   "Select Signatures" ở `SKILL.md:40-43`) không tự mang câu gốc, nên nếu agent chỉ xử lý JSON
   signatures mà không đọc lại rootCause/resolution gốc, dễ chọn nhầm signature không còn ngữ
   cảnh phù hợp.

## 3. `precedent_report.mjs` — format Markdown có đủ chuyên nghiệp?

Cấu trúc tổng thể (`renderPrecedentReportMd`, `precedent_report.mjs:90-105`): heading
`# Precedent Check — <issueTitle>`, bullet metadata (Generated/Query/Repro), rồi `## Candidates`,
mỗi candidate cách nhau bằng `---` (dòng 101). Từng candidate (`renderCandidate`,
`precedent_report.mjs:56-83`): heading `### [<caseNumber>] <title> — <verdict>` (dòng 62), bullet
Product/Portal/Root Cause/Resolution/Flow (dòng 63-67), rồi một trong 3 nhánh signature.

**Điểm tốt**: heading phân cấp rõ ràng, bullet list có nhãn field, tách candidate bằng `---` dễ
đọc trong Markdown viewer — không phải raw JSON dump.

**Điểm còn thô, chưa "chuyên nghiệp" cho kỹ sư dùng tham khảo:**

1. **`score` (điểm xếp hạng) bị âm thầm loại bỏ khỏi report.** `searchPrecedents` trả về mỗi
   candidate kèm `score` (`precedent_store.mjs:192: { ...candidate, score: scoreCandidate(...) }`),
   nhưng `renderCandidate` destructure các field nó cần và **không lấy `score`**
   (`precedent_report.mjs:57-60` chỉ liệt kê `caseNumber, title, url, product, rootCause,
   resolution, flow, signatures, checks, verdict` — không có `score`). Kỹ sư đọc report cuối cùng
   không có cách nào biết candidate #1 mạnh hơn candidate #5 bao nhiêu, chỉ biết thứ tự — làm
   giảm độ tin cậy khi phải tự quyết định "case này có đáng xem không".
2. **Bằng chứng ("evidence") bị bỏ khi verdict là "not matched".** `renderCheckLine`
   (`precedent_report.mjs:39-54`) chỉ in `evidence` khi `result.matched === true` (dòng 42-43:
   `matched (evidence: ...)`); nhánh `result.matched === false` (dòng 44-45) chỉ in chuỗi cứng
   `'not matched'`, bỏ qua hoàn toàn `result.evidence` dù theo docstring của
   `log_query_client.mjs:18` shape trả về luôn có `evidence: string[]` bất kể `matched` là gì.
   Ngay cả sau khi #181 được giải quyết và `queryLogSignature` trả kết quả thật, report vẫn sẽ
   không cho kỹ sư thấy *tại sao* một signature "not matched" (vd. "đã tìm trong bảng signalling,
   không thấy") — đây là lỗi định dạng độc lập với #181, nằm hoàn toàn trong
   `precedent_report.mjs`.
3. **Không có bảng tổng quan (summary table) ở đầu report.** Với corpus lớn và tối đa 10
   candidate mỗi lần chạy, report hiện tại đi thẳng vào chi tiết từng candidate theo thứ tự
   `## Candidates` (`precedent_report.mjs:96-102`) mà không có một bảng ngắn liệt kê
   case/verdict/score trước — kỹ sư phải đọc hết từng block chi tiết mới nắm được bức tranh
   tổng thể.
4. Dòng check-list (`- \`<signature>\` (table: ..., source: ...) → <outcome>`,
   `precedent_report.mjs:53`) có phong cách log kỹ thuật (backtick + ngoặc đơn + mũi tên) hơn là
   văn bản báo cáo — chấp nhận được cho một checklist kỹ thuật, nhưng không phải văn phong
   "professional report" mượt mà.

## 4. Kết luận: phần nào bị chặn bởi #181, phần nào độc lập và có thể sửa ngay

**Bị chặn bởi #181 (đúng như #181 nêu, đã xác nhận trong code):**

- Hành vi thật của `queryLogSignature()` trong `log_query_client.mjs` — hiện tại luôn trả về
  `{ unavailable: true, ... }` sau khi validate tham số (`log_query_client.mjs:21-31`), vì "the
  real `log_query.py` contract is pending" (đúng như #181's Further Notes, và tự chú thích module
  `log_query_client.mjs:1-7`).
- Do đó, `synthesizeVerdict()` trong `precedent_verdict.mjs` (`precedent_verdict.mjs:36-69`)
  không bao giờ thực sự trả `VERDICT_MATCHED`/`VERDICT_NO_MATCH` trong thực tế — logic
  `classifyResult`/tổng hợp verdict (`precedent_verdict.mjs:19-24,58-66`) đã viết xong và có thể
  test độc lập (mock module), nhưng luôn nhận input `indeterminate` từ client placeholder nên
  luôn rơi về `VERDICT_INSUFFICIENT` (dòng 65).
- Do đó, hai nhánh "matched"/"not matched" của `renderCheckLine`
  (`precedent_report.mjs:42-45`) hiện không thể được kích hoạt trong thực tế chạy thật — chỉ
  nhánh "unavailable" (dòng 46-47) từng chạy tới.

**Độc lập với #181 — có thể sửa ngay, không cần chờ contract `log_query.py`:**

- Toàn bộ điểm yếu matching ở mục 1: không stemming/synonym, không ngưỡng điểm tối thiểu —
  100% nằm trong `precedent_store.mjs` (`tokenize`, `scoreCandidate`, `searchPrecedents`,
  dòng 37-41, 172-179, 189-195), không đụng tới `log_query_client.mjs` ở bất kỳ đâu.
- Toàn bộ điểm yếu extraction ở mục 2 (cause code >4 chữ số bị bỏ, ALL-CAPS không `_` bị bỏ,
  signature object thiếu câu ngữ cảnh gốc) — nằm trong `SIGNATURE_PATTERNS`, `extractSignaturesFromText`,
  `collectSignatures` (`precedent_store.mjs:23-30,63-77,87-104`) — thuần regex tĩnh, không liên
  quan `log_query`.
- Toàn bộ điểm yếu report ở mục 3 (`score` bị bỏ, `evidence` bị bỏ ở nhánh not-matched, thiếu
  summary table) — nằm trong `precedent_report.mjs` (`renderCandidate`, `renderCheckLine`, dòng
  39-83) — đây là vấn đề định dạng dữ liệu đã có sẵn trong candidate object, độc lập hoàn toàn
  với việc `log_query.py` đã sẵn sàng hay chưa. Việc report chưa "chuyên nghiệp" không phải do
  thiếu dữ liệu từ #181 — dữ liệu (`score`, `result.evidence`) đã tồn tại trong object nhưng
  chỉ đơn giản chưa được render.

Nói cách khác: mọi lỗ hổng về **chất lượng search và report** (câu hỏi 1-3) đều là vấn đề của
`precedent_store.mjs` và `precedent_report.mjs`, hai module hoàn toàn không phụ thuộc
`log_query_client.mjs` — đúng như thiết kế cô lập trong #181 ("only this one file needs
rewriting once the real contract lands"). Chỉ riêng khả năng verdict thật sự
matched/does-not-match (không phải chất lượng search/report) mới bị #181 chặn.
