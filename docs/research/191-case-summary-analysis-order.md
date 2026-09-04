# Issue #191 — Static review: case-summary — rủi ro thiếu/sai thứ tự trong phân tích

Wayfinder research ticket, con của map issue #188, chạy song song với #189 (audit tầng capture).
**Phạm vi: chỉ audit tĩnh mã nguồn** `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs`
(và các điểm chạm bắt buộc ở tầng capture để trả lời câu hỏi 1/4) — không có dữ liệu case thật, không
chạy pipeline. Mọi khẳng định đều kèm `file:line`.

Vocabulary dùng đúng theo `CONTEXT.md`: **Delta** (diff theo comment-id, không theo vị trí/số lượng —
`CONTEXT.md:55-57`), **Comment Summary** (digest theo comment, khác body verbatim — `CONTEXT.md:43-46`),
**Case Flow** (narrative cấp case, cập nhật tăng dần — `CONTEXT.md:48-53`), **Reply** (comment có
`parentId`, được nhóm ngay sau parent, newest-first — `CONTEXT.md:36-41`).

---

## Câu hỏi 1 — Có kịch bản nào khiến một comment bị loại khỏi delta vĩnh viễn (không bao giờ được
tóm tắt) không?

### 1a. Bản thân `computeDelta` là an toàn, nhưng mù hoàn toàn với nguồn gốc của `id`

```js
// run_summary.mjs:42-45
export function computeDelta(caseComments, summarizedIds) {
  const seen = new Set(summarizedIds);
  return caseComments.filter((c) => !seen.has(c.id));
}
```

Đây là set-diff thuần theo `c.id`, đúng như `CONTEXT.md:55-57` mô tả ("computed by comment-id
difference"). Bản thân hàm này không có bug logic. Vấn đề nằm ở **nguồn của `summarizedIds`** (tầng
summary tự quản) và **nguồn của `c.id`** (tầng capture cấp phát, summary layer chỉ tiêu thụ).

### 1b. `summarizedCommentIds` không được validate ngược lại với `deltaComments` đã phát ra —
đây là lỗ hổng có thật ở tầng summary

`prepare()` phát `deltaComments` cho agent (run_summary.mjs:164-171). Agent xử lý ở Step 2 (ngoài
code, trong context model — SKILL.md:35-75) rồi ghi một file JSON tạm `{ comments, flow, executive }`.
`finalize()` nhận file này qua `--input` và tin tưởng **hoàn toàn không kiểm tra**:

```js
// run_summary.mjs:174-188
export function finalize(code, { comments: newComments, flow, executive }, options = {}) {
  const { casePath, summaryPath, mdPath } = paths(code);
  const caseJson = readJson(casePath);
  const prior = readJson(summaryPath);
  const merged = mergeSummary(prior, {
    caseNumber: caseJson.caseNumber,
    ...
    newComments,
    flow,
    executive,
  });
  ...
}
```

và `mergeSummary`:

```js
// run_summary.mjs:79-80
summarizedCommentIds: [...priorIds, ...newComments.map((c) => c.id)],
comments: [...newComments, ...priorComments],
```

Không có bước nào đối chiếu `newComments[].id` với `deltaComments` mà `prepare()` đã trả ra
trước đó, và cũng không đối chiếu với `caseJson.comments` hiện tại. Hệ quả: nếu payload Step-2
(do agent/model tạo, hoặc file scratch cũ bị tái sử dụng nhầm — SKILL.md:66 gợi ý lưu ở
`.scratch/summary_<CODE>.json`, không có cơ chế khóa tên theo run) chứa một `id` **hợp lệ trong
case.json nhưng chưa từng thực sự được tóm tắt** (ví dụ agent bỏ sót một comment khi soạn digest
nhưng vẫn liệt kê id của nó vào mảng, hoặc một file scratch của lần chạy trước bị finalize nhầm lần
sau), thì:

- `summarizedCommentIds` sẽ chứa id đó **vĩnh viễn** (mảng chỉ được nối thêm, không bao giờ bị bớt
  đi — không có logic xoá/rollback ở bất kỳ đâu trong `run_summary.mjs`).
- Từ lần `prepare()` kế tiếp trở đi, `computeDelta` (run_summary.mjs:42-45) sẽ loại comment đó ra
  khỏi mọi delta tương lai, **nhưng `summary.json.comments` lại không có digest thực sự cho nó**
  (vì `newComments` ở lần finalize gây lỗi không chứa digest đúng cho id này, hoặc chứa digest sai/
  rỗng cho id đó, hoặc — trong trường hợp file scratch cũ — không hề chứa nó nhưng `summarizedIds`
  vẫn bị đánh dấu qua một lần merge khác). Kết quả: **comment bị coi là "đã tóm tắt" trong khi thực
  tế bị bỏ sót — im lặng, không cảnh báo, không có cách nào tự phục hồi** vì `computeDelta` không có
  khái niệm "id đã đánh dấu nhưng thiếu digest tương ứng".

Test hiện có (`tests/qualcomm_case_summary_merge.test.mjs`, `tests/qualcomm_case_summary_delta.test.mjs`)
chỉ kiểm chứng hành vi "đường vui" (happy path: `newComments` luôn khớp đúng `deltaComments`) — không
có test nào dựng kịch bản `newComments[].id` lệch khỏi `deltaComments` để bắt lỗi này.

**Kết luận 1b:** đây là một khoảng trống thiết kế thật ở tầng summary: `finalize()` tin payload của
agent một cách vô điều kiện, không có round-trip check với `deltaComments`/`caseJson.comments`. Đây
là candidate khả dĩ nhất cho "comment bị thiếu trong analysis" mà người dùng nghi ngờ — nó chỉ cần
Step 2 (model) sai một lần, không cần capture layer có lỗi gì.

### 1c. Câu hỏi gốc còn hỏi về "id-migration" hoặc "case.json bị ghi đè/generate lại thay đổi id" —
đây thực chất là rủi ro của **tầng capture**, không phải tầng summary, nhưng ảnh hưởng trực tiếp lên
delta nên cần nêu rõ để trả lời câu hỏi 4

- Comment id là **content-derived**: `commentId(c) = hash(author + body.slice(0,120))`
  (`finalize_case.mjs:158-168`). Đây là quyết định thiết kế hiện tại — thay thế id vị trí kiểu
  `c1, c2, …` trước đây, và mọi cache cũ được `migrateIds()` re-key một lần khi đọc lại
  (`finalize_case.mjs:192-201`).
- `migrateIds()` chỉ chạy ở **tầng capture**, trên `cached` đọc từ `case.json`
  (`finalize_case.mjs:748`), **trước khi** case.json mới được ghi. Tức là khi `run_summary.mjs`
  đọc `case.json` (run_summary.mjs:156 `readJson(casePath)`), id trong đó **đã** là content-id ổn
  định — `run_summary.mjs` không tự làm migration nào và cũng không cần, vì việc đó đã xảy ra ở lần
  capture gần nhất.
- **Nhưng** nếu một case được tóm tắt lần đầu **trước khi** cơ chế content-id này tồn tại (tức
  `summary.json.summarizedCommentIds` còn lưu id kiểu cũ `c1, c2, …`), rồi sau đó case được capture
  lại và `migrateIds()` re-key toàn bộ `case.json.comments[].id` sang content-id mới
  (`finalize_case.mjs:192-201`) — thì ở lần `prepare()` kế tiếp, `computeDelta` so `id` mới (content
  hash) với `summarizedIds` cũ (positional) và **không có id nào khớp** → toàn bộ comment cũ bị coi
  là "mới" → **không phải loại trừ, mà là tóm tắt lại (duplicate)**, ảnh hưởng tới câu hỏi 2 (thứ tự/
  trùng lặp) nhiều hơn là câu hỏi 1 (thiếu). Không tìm thấy kịch bản migration nào gây **loại trừ**
  (id cũ bỗng trùng với id mới của một comment khác) trong luồng `migrateIds`→`assignIds` — vì
  `assignIds` xử lý va chạm trong cùng một lần gọi bằng suffix `-N` và báo cáo qua `collisions`
  (`finalize_case.mjs:174-185`).
- Một kịch bản loại-trừ-do-va-chạm-id **có thật nhưng nằm hoàn toàn ở tầng capture**, không chạm
  `run_summary.mjs` dòng nào: `mergeComments()` (`finalize_case.mjs:680-701`) dedupe theo
  `have.has(c.id)` (dòng 686) giữa comment **đã cache** và comment **mới trích xuất**. Vì
  `assignIds()` chỉ tự-dedupe **trong nội bộ lô đang xử lý** (không biết gì về id đã tồn tại trong
  cache — `finalize_case.mjs:174-185`), nếu một comment thực sự mới (tác giả A, 120 ký tự đầu trùng
  tình cờ với một comment cũ khác của cùng tác giả A đã có trong cache) nhận đúng content-id đã tồn
  tại trong cache, `mergeComments` sẽ coi nó là "đã có" và **âm thầm bỏ qua nó ngay tại tầng capture
  — nó không bao giờ tới được `case.json`, nên `run_summary.mjs` không có cơ hội nhìn thấy nó**. Đây
  là ứng viên gốc rễ khả dĩ cho "comment thiếu" nhưng thuộc phạm vi #189, được nêu ở đây chỉ để trả
  lời câu hỏi 4 một cách trọn vẹn.
- Liên quan: tín hiệu `possibleEdits` mà `finalize_case.mjs` tự phát hiện (sửa nội dung 120 ký tự
  đầu của một comment cũ → id mới, "silently" trở thành comment "mới" — comment ở
  `finalize_case.mjs:231-236`, phát ra ở `finalize_case.mjs:989-990`) **bị rơi mất khi đi qua
  `run_case.mjs`**: verdict cuối cùng của `run_case.mjs` (dòng 581-600) chỉ forward
  `v.idCollisions` (dòng 592), **không forward `v.possibleEdits`**. Do đó `captureCase()` trong
  `run_summary.mjs` (dòng 48-60) — vốn chỉ parse dòng JSON cuối cùng của `run_case.mjs` — không bao
  giờ nhận được tín hiệu này, và `prepare()` cũng không có cách nào cảnh báo người dùng rằng một
  "comment mới" trong delta thực chất có thể là bản chỉnh sửa của một comment cũ đã tóm tắt trước đó
  (dẫn tới digest trùng lặp nội dung dưới hai id khác nhau).

---

## Câu hỏi 2 — Mảng digest trong `summary.json` có giữ đúng thứ tự của `case.json` (newest-first,
reply nhóm dưới parent) không? Việc merge có thể làm lệch thứ tự không?

**Có — merge có thể làm lệch thứ tự, và đây là bug rõ ràng nhất tìm được trong tầng summary.**

`case.json.comments` được tầng capture sắp xếp lần cuối bởi `orderCommentsForPresentation`
(`finalize_case.mjs:650-674`): duyệt các post cấp cao nhất theo thứ tự mới→cũ, và với mỗi post,
chèn ngay các reply của nó (cũng mới→cũ) — nghĩa là vị trí của một reply trong mảng phụ thuộc vào độ
mới của **parent** của nó, không phải độ mới tuyệt đối của chính nó so với toàn bộ thread.

`deltaComments` = `caseJson.comments.filter(...)` (`run_summary.mjs:158`, dùng `computeDelta` ở
dòng 42-45) — `.filter()` giữ nguyên thứ tự tương đối gốc, nên **trong phạm vi một lần `prepare()`**,
tập con `deltaComments` vẫn giữ đúng thứ tự newest-first/reply-grouped của `case.json`. Đây là điểm
đúng.

Vấn đề nằm ở bước **merge giữa các lần chạy khác nhau**, trong `mergeSummary`:

```js
// run_summary.mjs:79-80
summarizedCommentIds: [...priorIds, ...newComments.map((c) => c.id)],
comments: [...newComments, ...priorComments],
```

`comments` luôn được ghép bằng cách **prepend nguyên khối `newComments` vào trước `priorComments`**,
bất kể vị trí thực sự của từng comment mới trong hệ thống newest-first/reply-grouped của
`case.json`. Điều này chỉ đúng nếu **mọi** comment trong `newComments` thực sự mới hơn **mọi**
comment trong `priorComments` — giả định này sai trong một trường hợp rất phổ biến trong vòng đời
một case: **một reply mới được gửi vào một post cũ đã được tóm tắt từ trước.**

Ví dụ cụ thể (dựng từ chính logic `orderCommentsForPresentation`):
- Case có post `A` (post cũ, đã tóm tắt ở lần chạy trước) và post `B` (post mới nhất, cũng đã tóm
  tắt). `case.json` trình bày `[B, A, …]`. `summary.json.comments` sau lần chạy trước = `[B, A, …]`.
- Khách hàng gửi thêm reply `C` cho post `A` (không phải cho `B`), timestamp của `C` cũ hơn `B`
  nhưng mới hơn `A`.
- Lần capture kế tiếp: `orderCommentsForPresentation` nhóm `C` ngay sau parent của nó là `A`
  → `case.json` mới = `[B, A, C, …]` (đúng theo `CONTEXT.md:36-41`: "ordered so every Reply
  immediately follows its parent Post").
- `prepare()` phát `deltaComments = [C]` (đúng, vì chỉ `C` là comment mới).
- Sau Step 2 + `finalize()`, `mergeSummary` thực hiện `comments: [C, B, A, …]` (dòng 80) —
  **`C` bị đẩy lên đầu, đứng trước cả `B`, và không còn đứng ngay sau `A` (parent của nó) nữa.**

Kết quả: `summary.json.comments`/`summary.md` (render trực tiếp từ `summary.comments` không sắp xếp
lại — xem dưới) hiển thị thứ tự `[C, B, A]`, trong khi `case.json` (nguồn sự thật) thể hiện
`[B, A, C]`. Đây chính là kiểu "sai thứ tự trong phân tích" mà ticket mô tả — reply không còn nằm
cạnh parent của nó trong bản tóm tắt, và một comment cũ hơn (`C`) lại xuất hiện phía trên một comment
mới hơn (`B`).

`renderSummaryMd` không có logic sắp xếp/độc lập nào để tự sửa việc này — nó tin tưởng hoàn toàn thứ
tự đã có sẵn trong `summary.comments`:

```js
// run_summary.mjs:128-136
export function renderSummaryMd(summary) {
  const newestFirst = summary.comments;
  ...
  blocks.push(['## Comments (newest first)', '', newestFirst.map(renderComment).join('\n\n'), ''].join('\n'));
  ...
}
```

nên lỗi lan thẳng từ `summary.json` sang `summary.md` không qua bước kiểm tra nào.

Test hiện có xác nhận đây đúng là hành vi **được thiết kế** (không phải side-effect ngẫu nhiên):
`tests/qualcomm_case_summary_merge.test.mjs:27` mô tả case test là *"update merge: prior summaries
preserved unchanged, new ones prepended (newest-first)"* — tức là code coi "mới được thêm vào" đồng
nghĩa với "mới nhất", và không có test nào dựng kịch bản reply-vào-post-cũ để kiểm chứng việc nhóm
reply-dưới-parent có được bảo toàn hay không. `references/workflow.md:107` cũng chỉ khẳng định
*"`summary.md` mirrors that newest-first order"* mà không đặc tả rõ việc nhóm reply dưới parent có
được bảo toàn qua các lần merge hay không — đặc tả (ADR 0002) có khoảng trống đúng ở điểm này.

**Kết luận 2:** Có — `mergeSummary` có thể (và trong trường hợp reply-vào-post-cũ, sẽ luôn) làm lệch
thứ tự digest so với `case.json`, phá vỡ bất biến "reply nhóm ngay dưới parent" mà tầng capture đảm
bảo. Đây không phải race condition hiếm gặp — nó xảy ra bất cứ khi nào một case đang hoạt động nhận
reply cho một post cũ, tức là gần như mọi case dài hơi, nhiều lượt trao đổi.

---

## Câu hỏi 3 — `priorFlow` có thể khiến flow narrative dựa trên context cũ/sai nếu các lần chạy
summary không theo đúng thứ tự với các lần cập nhật case không?

**Có.** `run_summary.mjs` hoàn toàn không có cơ chế khóa hay kiểm tra tính mới (staleness check) cho
riêng nó — khác biệt rõ với tầng capture, nơi `run_case.mjs` dùng
`acquireLockOrWaitForSameCode`/`releaseLock` (`run_case.mjs:35`, gọi ở dòng 648/673) để đảm bảo chỉ
một lần capture chạy cho một case tại một thời điểm. Không có import `lock.mjs` nào trong
`run_summary.mjs`.

Luồng dữ liệu của `flow`:

1. `prepare()` đọc `priorFlow` **tại thời điểm prepare** trực tiếp từ đĩa:
   ```js
   // run_summary.mjs:170
   priorFlow: prior?.flow ?? '',
   ```
2. Agent (Step 2, ngoài code) soạn `flow` mới dựa trên `priorFlow` này (SKILL.md:54: *"Incrementally
   update the 1-2 paragraph `flow` narrative using `priorFlow` as context"*).
3. `finalize()` đọc lại `prior` **tại thời điểm finalize**, tức là có thể khác với `prior` mà
   `prepare()` đã đọc trước đó, nếu có một lần `finalize()` khác của **cùng case** xen giữa:
   ```js
   // run_summary.mjs:176-177
   const caseJson = readJson(casePath);
   const prior = readJson(summaryPath);
   ```
4. `mergeSummary` ghi `flow` **thay thế hoàn toàn**, không hợp nhất, không kiểm tra staleness:
   ```js
   // run_summary.mjs:81
   flow,
   ```
   (so sánh với `comments`/`summarizedCommentIds`, vốn được nối thêm dựa trên `prior` **mới nhất**
   đọc lại tại chính `finalize()` — dòng 79-80 — nên phần `comments` luôn nhất quán với đĩa tại thời
   điểm ghi, nhưng `flow` thì không, vì nó là **văn bản đã được soạn sẵn từ trước, ngoài code**,
   không được tính lại tại `finalize()`).

Kịch bản cụ thể: Lần chạy A `prepare()` case X → đọc `priorFlow = P0`. Trước khi A `finalize()`,
lần chạy B (một agent/phiên khác, hoặc người dùng chạy lại do lần trước bị gián đoạn) cũng
`prepare()` case X → cũng đọc `priorFlow = P0` (vì A chưa ghi gì). A `finalize()` trước: `comments`/
`summarizedCommentIds` được merge từ `prior=P0`, ghi `flow = flow_A` (soạn dựa trên `P0`) →
`summary.json` giờ có `flow = flow_A` và `comments` đã bao gồm cả batch của A. B `finalize()` sau:
đọc lại `prior` **mới nhất** (đã có batch A) để merge `comments`/`summarizedCommentIds` — phần này
đúng, không mất dữ liệu comment nào. Nhưng `flow_B` mà B ghi đè lên (dòng 81) **được soạn từ
`priorFlow = P0`**, tức là hoàn toàn không biết gì về các comment/diễn biến mà batch A vừa thêm vào.
Kết quả cuối: `summary.json.comments` chứa đầy đủ cả batch A lẫn batch B (đúng), nhưng
`summary.json.flow` chỉ phản ánh context tính đến trước A — **flow narrative bị lệch khỏi chính danh
sách comments mà nó đứng cạnh**, mà không có cảnh báo/lỗi nào được phát ra.

Điều này không đòi hỏi hai tiến trình chạy đồng thời theo nghĩa hệ điều hành — chỉ cần hai lần
`prepare()`→…→`finalize()` **xen kẽ** theo thời gian thực tế sử dụng (ví dụ: người dùng mở Step 1,
đi làm việc khác, một phiên khác/chính người dùng chạy trọn vẹn một chu kỳ prepare→finalize cho cùng
case, rồi quay lại hoàn tất Step 2/3 của phiên đầu) là đủ để tái hiện.

**Kết luận 3:** Có — không có cơ chế lock hay staleness check nào ở tầng summary bảo vệ `flow`
khỏi bị ghi đè bởi một payload được soạn trên context cũ hơn context thực tế đã có trên đĩa tại thời
điểm ghi. Đây là rủi ro thật, tách biệt hoàn toàn với câu hỏi 2 (thứ tự comments) — kể cả khi
`comments` được merge đúng 100%, `flow` vẫn có thể sai.

---

## Câu hỏi 4 — So với #189 (audit tầng capture), root cause "thiếu/sai thứ tự" nhiều khả năng nằm ở
tầng nào?

**Nhận định: nhiều khả năng nằm ở tầng summary (#191) hơn là tầng capture (#189), và nên nêu rõ
trong wayfinder map (#188).**

Lý do:

1. **Tần suất kích hoạt khác nhau rất nhiều.** Bug thứ tự ở câu hỏi 2 (`run_summary.mjs:79-80`,
   `[...newComments, ...priorComments]`) kích hoạt bất cứ khi nào một case đang mở nhận được **reply
   cho một post cũ đã tóm tắt** — đây là hình thái trao đổi rất phổ biến trong một case hỗ trợ nhiều
   lượt (khách hàng trả lời vào post cũ để bổ sung log, Qualcomm trả lời vào câu hỏi cũ, v.v.), không
   cần điều kiện hiếm. Ngược lại, ứng viên tương ứng ở tầng capture — va chạm content-id giữa comment
   mới và comment đã cache trong `mergeComments` (`finalize_case.mjs:686`) — đòi hỏi 120 ký tự đầu
   (đã chuẩn hoá whitespace) của **cùng một tác giả** trùng khớp tình cờ giữa hai comment khác nhau,
   một điều kiện hiếm hơn nhiều trong dữ liệu case thật.
2. **Bug ở tầng summary không cần capture layer có lỗi gì cả.** `case.json` có thể hoàn toàn đúng,
   đầy đủ, đúng thứ tự (đúng như capture layer cam kết ở `CONTEXT.md:21-26`) — và `summary.json`/
   `summary.md` vẫn sẽ sai thứ tự, chỉ vì cách `mergeSummary` prepend nguyên khối. Điều này khớp
   chính xác với cách người dùng mô tả nghi ngờ: họ nghi ngờ chất lượng của **digest/phân tích**
   (tầng summary), không phải chất lượng của **dữ liệu thô** (tầng capture).
3. **Không có test nào bắt được lỗi này ở tầng summary** (`tests/qualcomm_case_summary_merge.test.mjs`
   chỉ test đường vui, dòng 27 mô tả hành vi hiện tại như một tính năng "prepended (newest-first)"
   thay vì kiểm chứng nó đúng với ngữ nghĩa reply-nhóm-dưới-parent) — nghĩa là nếu lỗi này đang xảy ra
   trên case thật, sẽ không có cảnh báo nào từ CI hay từ chính pipeline.
4. Đồng thời, câu hỏi 3 cho thấy tầng summary còn thiếu hẳn cơ chế khoá/staleness-check mà tầng
   capture đã có sẵn (`lock.mjs`, dùng trong `run_case.mjs:35,648,673`) — một khoảng trống kiến trúc
   rõ ràng, càng củng cố khả năng tầng summary là nguồn phát sinh nếu người dùng từng chạy summary
   nhiều lần/nhiều phiên xen kẽ cho cùng một case (một thao tác hoàn toàn hợp lý khi theo dõi một case
   đang mở).
5. Điều này **không loại trừ** rủi ro ở tầng capture — mục 1c ở trên nêu rõ một kịch bản loại-trừ-do-
   va-chạm-id có thật trong `finalize_case.mjs`, và tín hiệu `possibleEdits` bị rơi mất qua
   `run_case.mjs` — cả hai đáng để #189 điều tra sâu hơn. Nhưng về mặt **khả năng xảy ra trên dữ liệu
   case thực tế** và **mức độ khớp với triệu chứng người dùng mô tả** ("thiếu/sai thứ tự trong phân
   tích"), tầng summary là ứng viên có cơ sở vững chắc hơn.

---

## Tổng hợp file:line trọng yếu

| Chủ đề | File:line |
|---|---|
| `computeDelta` (set-diff theo id) | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:42-45` |
| `finalize()` không validate `newComments` với `deltaComments`/`caseJson.comments` | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:174-188` |
| `mergeSummary`: `summarizedCommentIds` chỉ nối thêm, không dedupe/rollback | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:79` |
| `mergeSummary`: `comments: [...newComments, ...priorComments]` — nguồn gốc lệch thứ tự | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:80` |
| `mergeSummary`: `flow` bị ghi đè hoàn toàn, không hợp nhất | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:81` |
| `prepare()` đọc `priorFlow` tại thời điểm prepare | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:170` |
| `finalize()` đọc lại `prior`/`caseJson` tại thời điểm finalize (không đồng bộ với `flow`) | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:176-177` |
| `renderSummaryMd` tin tưởng thứ tự `summary.comments`, không tự sắp xếp | `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs:128-136` |
| Test chỉ phủ đường vui cho merge/delta | `tests/qualcomm_case_summary_merge.test.mjs:27-54`, `tests/qualcomm_case_summary_delta.test.mjs:25-43` |
| `orderCommentsForPresentation` (newest-first, reply nhóm dưới parent) — nguồn thứ tự chuẩn của `case.json` | `.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs:650-674` |
| `commentId`/`assignIds` (content-derived id) | `.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs:158-185` |
| `migrateIds` (re-key id cũ → content-id, chạy ở tầng capture, trước khi `run_summary.mjs` đọc) | `.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs:192-201` |
| `mergeComments`: dedupe theo id đã cache — điểm loại-trừ-do-va-chạm-id (thuộc #189) | `.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs:680-701` (đặc biệt dòng 686) |
| `possibleEdits` bị rơi mất khi `run_case.mjs` build verdict cuối | phát ra: `finalize_case.mjs:989-990`; không forward: `.claude/skills/qualcomm-case-agent/scripts/run_case.mjs:581-600` (chỉ forward `idCollisions` ở dòng 592) |
| `run_case.mjs` có lock, `run_summary.mjs` không có | `.claude/skills/qualcomm-case-agent/scripts/run_case.mjs:35,648,673` (không có tương đương trong `run_summary.mjs`) |
| Định nghĩa Delta/Comment Summary/Case Flow/Reply | `CONTEXT.md:36-57` |
