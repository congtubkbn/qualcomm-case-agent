# Static Audit: Tính đầy đủ & thứ tự comment trong `qualcomm-case-agent` (Issue #189)

**Loại tài liệu:** Research ticket tĩnh (chỉ đọc mã nguồn, không chạy capture thật — không có
Chrome/Windows trong môi trường này). Ghi chú: `docs/research/` **chưa tồn tại** trước ticket này;
thư mục được tạo bởi audit này.

**Phạm vi:** Đọc mã nguồn của `finalize_case.mjs`, `extract_case.js`, `run_case.mjs`,
`dom_helpers.js`, `expand_step.js`, `references/extraction.md`, và các file test liên quan. Mọi
khẳng định đều kèm `file:line`. Không có ví dụ case thật — người dùng nghi ngờ nhưng chưa có case
code cụ thể.

---

## Câu 1 — `sortCommentsChronological` / `orderCommentsForPresentation` có edge case sắp sai thứ tự không?

Có ba edge case đáng chú ý, mức độ nghiêm trọng thấp/trung bình (khác với phát hiện chính ở Câu 2):

### 1a. Tie-break dùng `displayPosition` — hoạt động đúng nhưng có lỗ hổng khi so sánh "lệch pha"

`sortCommentsChronological` (`finalize_case.mjs:546-642`) khi hai comment có `effectiveTime` bằng
nhau, ưu tiên `displayPosition` (`finalize_case.mjs:633-637`), rồi mới rơi về `originalIndex`
(`finalize_case.mjs:638`). Điều này được test đầy đủ ở `tests/finalize_case.test.mjs:60-84`
(kể cả case "một bên có `displayPosition`, một bên không" — rơi về `originalIndex`, dòng 79-84).

Tuy nhiên **`displayPosition` chỉ tồn tại trên comment vừa trích xuất trong lần chạy này** (bị xoá
khỏi cache trước khi ghi — `finalize_case.mjs:893-897`, `901-905`). Ở một lần chạy `--merge`,
`mergeComments` gộp `cache` (không có `displayPosition`) với `freshChronological` (có
`displayPosition`) rồi gọi lại `sortCommentsChronological` trên toàn bộ danh sách
(`finalize_case.mjs:699`). Nếu một comment cache và một comment mới trùng `effectiveTime` — tie-break
rơi về `originalIndex`, tức thứ tự nối mảng `[...cache, ...freshChronological]`
(`finalize_case.mjs:699`), **không phản ánh thứ tự thật trên trang**. Đây là hành vi *đã được thiết
kế có chủ đích* (comment dòng 75-78 trong test) chứ không phải bug, nhưng vẫn là nguồn sai lệch thứ
tự tiềm ẩn khi tie xảy ra giữa comment cũ/mới.

### 1b. Comment mô tả case (synthesized) không có `displayPosition`, có thể tie với comment thật

`synthesizeDescriptionComment` (`finalize_case.mjs:332-351`) tạo comment tổng hợp từ
`raw.description`, được `push` vào **cuối** `rawComments` (`finalize_case.mjs:772-774`) — tức luôn
đứng sau mọi comment thật về mặt `originalIndex` tại thời điểm `assignIds`. Comment này không có
`displayPosition` (không đến từ DOM — `finalize_case.mjs:345-350`). Nếu `openedAt` của case trùng
đúng epoch với timestamp của comment mở đầu thật (rất có thể xảy ra vì đây thường chính là bài đăng
đầu tiên), tie-break sẽ dùng `originalIndex`, và vì comment tổng hợp luôn được thêm sau cùng trong
mảng, nó sẽ được xếp là "mới hơn" so với mọi comment tie với nó — có thể sai thứ tự hiển thị đối với
comment mở đầu thật. Không có test nào phủ trường hợp cụ thể này trong
`tests/chronological_sort.test.mjs` hay `tests/finalize_case.test.mjs`.

### 1c. Reply-to-reply (lồng 2 cấp) bị "làm phẳng" về cùng một parent

`extract_case.js:398-403` gán `parentIndex = lastTopLevelIndex` cho **mọi** comment được đánh dấu
`isReply` — không phân biệt "reply của post" và "reply của reply". Giả định kiến trúc này được ghi
rõ tại `references/extraction.md:307-308`: *"The hierarchy is strictly Post → Reply only (no
reply-to-reply nesting)"*. Nếu Salesforce Chatter từng render reply lồng 2 cấp (reply của một reply),
`extract_case.js` sẽ gán parent sai (luôn trỏ về top-level post gần nhất thay vì reply cha thật sự).
`orderCommentsForPresentation` (`finalize_case.mjs:650-674`) sau đó nhóm tất cả các "cháu" này chung
một danh sách con của post, sắp theo thời gian (đã đúng thứ tự tuyệt đối) nhưng **không phản ánh
đúng quan hệ cha-con thật** — không mất dữ liệu, nhưng thứ tự phân cấp hiển thị có thể trông "sai"
với người đọc case.md khi thread có reply lồng sâu.

**Kết luận Câu 1:** Không phát hiện trường hợp làm mất thứ tự nghiêm trọng trong logic sort chính
(được test khá kỹ). Rủi ro thực sự nằm ở các *giả định biên* (comment tổng hợp, reply lồng sâu) chưa
được test.

---

## Câu 2 — Có kịch bản nào comment bị rớt (drop) âm thầm mà vẫn qua được gate hoàn chỉnh không?

Có. Tìm được **một cơ chế nghiêm trọng** khiến toàn bộ vòng completeness-gate **không bao giờ được
gọi tới**, và **một cơ chế khác** khiến comment bị rớt trong khi `countAssert` vẫn pass.

### 2a. [NGHIÊM TRỌNG] `isNoUpdate` có thể trả `true` giả do đụng độ tiền tố 40 ký tự, bỏ qua hoàn toàn tác giả

Đây là phát hiện quan trọng nhất của audit này, vì nó **né hoàn toàn** gate `countAssert` (không chỉ
"qua" gate — gate không bao giờ chạy):

- `anchorOf(cached)` (`run_case.mjs:64-67`) tạo "mỏ neo" từ comment mới nhất đã cache (`cached.comments[0]`
  — index 0 vì `case.json` lưu theo thứ tự newest-first, xem `CONTEXT.md:23-26`):
  `{ author: c.author, bodyStart: norm(c.body).slice(0, 80) }`.
- `findAnchorIdx(articles, anchor)` (`dom_helpers.js:100-109`) tìm vị trí mỏ neo trong DOM hiện tại
  **chỉ bằng cách so khớp 40 ký tự đầu của `bodyStart`** (`dom_helpers.js:103`,
  `needle = ...slice(0, 40)`), dùng `indexOf(needle) === 0` (khớp tiền tố) và `break` ở lần khớp đầu
  tiên. **Trường `anchor.author` được tạo ra ở `anchorOf` nhưng KHÔNG BAO GIỜ được đọc lại** — không ở
  `findAnchorIdx`, không ở bất kỳ nơi nào khác trong `dom_helpers.js` hay `run_case.mjs` (đã grep toàn
  bộ `run_case.mjs`/`check_collapsed.js`, `author` chỉ xuất hiện đúng 1 lần: chỗ khởi tạo,
  `run_case.mjs:66`).
- `isNoUpdate(probe, cached)` (`run_case.mjs:120-126`) chỉ kiểm tra `probe.anchorIdx !== 0` và
  `pendingExpand === 0 && pendingMoreComments === 0` — **không tự so lại `probe.top.author` với tác
  giả đã cache** (biến `probe.top` chỉ được kiểm tra truthy ở dòng 121, nội dung của nó chưa bao giờ
  được đối chiếu).
- Kết quả: nếu một comment **mới, khác tác giả**, tình cờ mở đầu bằng đúng 40 ký tự giống comment neo
  đã cache (rất dễ xảy ra với các câu trả lời mẫu/soạn sẵn của Qualcomm support — ví dụ "Thank you for
  providing the requested logs..." hoặc "Please find the attached...") và nó nằm ở vị trí DOM đầu tiên
  (top, tức mới nhất), `findAnchorIdx` khớp `anchorIdx = 0` cho nó ngay từ vòng probe. Nếu vòng probe
  ban đầu không thấy control "Expand"/"More comments" nào đang chờ (`pendingExpand`,
  `pendingMoreComments` đều 0 — hoàn toàn có thể nếu comment mới ngắn), `isNoUpdate` trả `true`.
- `probeFeed()` + kiểm tra `isNoUpdate` nằm ở `run_case.mjs:328-373`; khi `true`, hàm **return ngay
  `status: 'no-update'` ở dòng 364-372** — trước khi `extract_case.js` (PHASE 2, dòng 489-496) hay
  `finalize_case.mjs` (và do đó `countAssert`) từng được gọi. Không có JSON nào được ghi, không có
  cảnh báo nào phát ra; toàn bộ comment mới (và mọi comment mới hơn nó nếu nó không thực sự là top)
  biến mất khỏi kết quả một cách hoàn toàn im lặng.

Đây khớp chính xác với nghi ngờ của người dùng ("comments seem to be missing") và là ứng viên số 1.

### 2b. Đụng độ `commentId` xuyên suốt hai lần chạy có thể khiến `mergeComments` thay một comment mới bằng bản sao của comment cũ

`commentKey` (`finalize_case.mjs:158-161`) = `author + 120 ký tự đầu của body` (đã tự ghi nhận giới
hạn ở dòng 156-157: *"an edit inside the first 120 chars of an old comment makes it look new"*).
`assignIds` (`finalize_case.mjs:174-185`) gán id dựa trên **thứ tự xuất hiện trong mảng được truyền
vào ở lần gọi đó** — nếu 2 phần tử trùng `commentKey`, phần tử xuất hiện trước được id gốc (không hậu
tố), phần tử sau bị hậu tố `-2`.

Trong `finalize()`, `assignIds` được gọi trên **toàn bộ `rawComments` của lần chạy hiện tại** (bao
gồm cả bài cũ được re-extract lẫn bài mới — `finalize_case.mjs:771-777`), **trước khi** so với cache.
Nếu một comment **mới** và một comment **cũ đã cache** trùng `commentKey` (cùng tác giả dùng lại đúng
câu mở đầu ≥120 ký tự — hoàn toàn có thể với các mẫu trả lời chuẩn), và comment mới xuất hiện **trước**
comment cũ trong DOM của lần chạy này (DOM Chatter luôn hiển thị mới nhất ở trên —
`finalize_case.mjs:601-604` ghi rõ giả định "DOM order where newest is at top"), thì:

1. Comment mới nhận `id = base` (không hậu tố).
2. Comment cũ (re-extract) nhận `id = base-2`.
3. `mergeComments` (`finalize_case.mjs:680-701`) khởi tạo `have = new Set(cache.map(c => c.id))`
   (dòng 682) — chứa `base` (id gốc của comment cũ từ lần capture đầu tiên, khi chưa có đụng độ).
4. Duyệt `rawComments`: comment mới có `id = base` → `have.has(base)` = `true` → bị `continue`
   (dòng 686) — **bị coi là "đã có", không được thêm vào `fresh`, tức bị rớt hoàn toàn**.
5. Comment cũ (re-extract, `id = base-2`) → không có trong `have` → được thêm vào như thể là "comment
   mới" — nhân bản nội dung cũ.

Hệ quả: `out.comments` vẫn có đúng số lượng dự kiến (một bản ghi bị thay bằng một bản sao), nên
`countAssert(genuineCommentCount(...), displayedCommentCount)` (`finalize_case.mjs:857-861`,
`countAssert` tại dòng 99-115) **vẫn pass bình thường** — comment thật đã biến mất nhưng đếm số lượng
không phát hiện được vì bị thay bằng bản trùng lặp có vẻ hợp lệ. Đây chính là kịch bản "hai comment
khác nhau đụng `commentKey`" được nêu trong đề bài Câu 2 — không có test nào phủ kịch bản xuyên-hai-
lần-chạy này (test đụng độ hiện có, `tests/finalize_case.test.mjs:739-746`, chỉ kiểm tra đụng độ
**trong cùng một lần chạy**, không kiểm tra đụng độ giữa id đã cache và id mới gán ở lần chạy sau).

### 2c. Virtualized list — có tài liệu hướng dẫn, nhưng KHÔNG có cài đặt tự động trong pipeline hiện tại

`references/extraction.md:350-355` (mục "Virtualized Lists") mô tả một quy trình fallback thủ công:
cuộn dần (`window.scrollBy(0, 600)`), trích xuất lại, gộp theo `author|first40(body)`, lặp tới khi
"scroll height ceases growing". Đây là hướng dẫn cho **agent/người bảo trì**, không phải mã đã lập
trình sẵn.

Trong pipeline tự động hiện tại (`run_case.mjs` PHASE 1.5, dòng 328-487 và `expand_step.js`), cơ chế
duy nhất tương tác với việc "mount" nội dung ẩn là:
- `expand_step.js:29-31`: `scrollIntoView` cho từng phần tử **đã có trong `qsa('article')`** — chỉ
  kích hoạt `IntersectionObserver` cho các node **đã tồn tại trong DOM** (Chatter lazy-*mount* con,
  không phải lazy-*render* toàn bộ danh sách cha).
- Nút "View More Posts" (`expand_step.js:136-139`) — cơ chế phân trang bằng click, khác hoàn toàn với
  windowing/virtualization thật (nơi các post ở xa bị **unmount** khỏi DOM khi cuộn qua).

Nếu Chatter Feed cấp cao nhất (danh sách post, không phải reply) từng dùng virtualization thật (DOM
node bị gỡ bỏ hoàn toàn khi cuộn xa), `qsa('article')` trong `expand_step.js:24` và `extract_case.js`
sẽ **không bao giờ thấy** các post đó, và không có bước `window.scrollBy` nào trong code để buộc
chúng mount lại. Không tìm thấy bằng chứng nào cho thấy Chatter cấp cao nhất thực sự bị virtualize
(theo tài liệu, chỉ "nested components" như "More comments" bị lazy-mount — `expand_step.js:26-27`),
nên đây là rủi ro **giả thuyết chưa xác nhận**, nhưng đáng lưu ý vì tài liệu vận hành
(`extraction.md`) và mã thực thi đã **không đồng bộ** với nhau (xem thêm Câu 4, mục 6).

---

## Câu 3 — Test hiện có phủ được các edge case trên chưa? Thiếu gì?

| Khu vực | Test hiện có | Thiếu |
|---|---|---|
| `sortCommentsChronological` tie-break bằng `displayPosition`/`originalIndex` | Có, khá kỹ: `tests/finalize_case.test.mjs:55-85`, `tests/chronological_sort.test.mjs:161-227` | Không có test cho tie giữa comment mô tả tổng hợp (`synthesizeDescriptionComment`, không có `displayPosition`) và một comment thật cùng epoch (mục 1b) |
| `orderCommentsForPresentation` — reply lồng 1 cấp | Có: `tests/finalize_case.test.mjs:339-391` | Không có test cho reply lồng 2 cấp (reply-to-reply) — khớp với giả định kiến trúc ở `extraction.md:307-308`, nhưng giả định đó chưa có test xác nhận hành vi khi bị vi phạm |
| `countAssert` / `genuineCommentCount` | Có, đầy đủ các nhánh: `tests/finalize_case.test.mjs:104-143` | Đúng như thiết kế — các test này chỉ kiểm tra hàm thuần, không kiểm tra được kịch bản 2a/2b vì hai kịch bản đó xảy ra **trước** khi `countAssert` được gọi (2a) hoặc **né được** phép đếm bằng cách hoán đổi 1-đổi-1 (2b) |
| `assignIds` đụng độ trong cùng 1 lần chạy | Có: `tests/finalize_case.test.mjs:189-198`, `739-746` | **Không có test đụng độ id xuyên hai lần chạy** (cache vs. fresh) — chính là mục 2b. `mergeComments` chỉ được test với id KHÔNG đụng độ (`tests/finalize_case.test.mjs:407-470`) |
| `findAnchorIdx` | Có: `tests/dom_helpers.test.mjs:141-156` | Chỉ test khớp/không khớp theo `bodyStart`; **không có test nào truyền `author` khác nhau với cùng `bodyStart`** để xác nhận (hoặc phủ nhận) rằng tác giả bị bỏ qua |
| `isNoUpdate` | Có: `tests/pipeline.test.mjs:81-98`, `tests/run_case.test.mjs:109-123` | Test `movedProbe` (`tests/run_case.test.mjs:115-116`) đổi cả `author` lẫn `anchorIdx` cùng lúc (đổi thành `anchorIdx: 1`) — **không cô lập được** trường hợp "tác giả khác nhưng `anchorIdx` vẫn = 0" (chính là cơ chế của mục 2a). Không có test nào mô phỏng toàn bộ chuỗi `anchorOf` → `findAnchorIdx` → `isNoUpdate` end-to-end với hai tác giả khác nhau cùng tiền tố 40 ký tự |
| Virtualized list (mục 2c) | Không có test nào (không có ở `tests/extract_case.test.mjs`, không có ở `tests/*run_case*`) | Không có cách nào test được vì hành vi này chưa được lập trình — chỉ tồn tại dưới dạng ghi chú vận hành trong `extraction.md:350-355` |

**Kết luận Câu 3:** Bộ test khá mạnh ở tầng hàm thuần (`sortCommentsChronological`,
`orderCommentsForPresentation`, `countAssert`, `assignIds` nội-run). Khoảng trống lớn nhất là ở
**ranh giới giữa hai lần chạy** (cache vs. fresh) — chính là nơi các bug nghiêm trọng nhất (2a, 2b)
xảy ra, và ở tầng tích hợp `anchorOf`/`findAnchorIdx`/`isNoUpdate` nơi `author` được tạo ra nhưng
không có test nào buộc nó phải được dùng.

---

## Câu 4 — Danh sách nguyên nhân gốc khả dĩ, xếp theo khả năng xảy ra (chỉ dựa trên đọc mã)

1. **(Cao nhất) False "no-update" do đụng độ tiền tố 40 ký tự trong `findAnchorIdx`, bỏ qua
   `author`** — `dom_helpers.js:100-109`, `run_case.mjs:64-67,120-126,363-373`. Nghiêm trọng nhất vì
   nó khiến pipeline dừng **trước khi** `extract_case.js`/`finalize_case.mjs` chạy — không hề có
   completeness gate nào được thực thi. Rất dễ xảy ra trong bối cảnh case hỗ trợ kỹ thuật, nơi kỹ sư
   Qualcomm thường dùng câu mở đầu mẫu/soạn sẵn.
2. **Đụng độ `commentId` xuyên hai lần chạy khiến `mergeComments` hoán đổi 1 comment mới thành 1 bản
   sao comment cũ** — `finalize_case.mjs:158-185, 680-701, 776-777`. Vẫn qua được `countAssert` vì số
   lượng không đổi.
3. **Virtualization thật ở cấp top-level feed** (nếu có) — không có cơ chế tự động xử lý trong code,
   chỉ có ghi chú vận hành thủ công đã lỗi thời so với cách `expand_step.js` hiện hoạt động
   (`extraction.md:350-355` vs. `expand_step.js:16-150`). Xác suất tùy thuộc portal Salesforce có thật
   sự virtualize post cấp cao hay không — chưa có bằng chứng trong repo, chỉ là khoảng trống phòng thủ.
4. **Reply lồng 2 cấp bị làm phẳng** — `extract_case.js:398-403`, giả định ghi rõ ở
   `extraction.md:307-308`. Không làm mất comment nhưng có thể khiến phân cấp hiển thị "trông sai".
5. **Tie-break thứ tự khi comment mô tả tổng hợp (không có `displayPosition`) trùng epoch với comment
   thật** — `finalize_case.mjs:332-351, 772-774, 633-638`. Ảnh hưởng nhỏ, chỉ là thứ tự hiển thị của
   một comment tổng hợp, không phải dữ liệu thật bị mất.
6. **Tài liệu (`finalize_case.mjs` header comment) không khớp hành vi thực tế của pipeline** —
   `finalize_case.mjs:3-9` mô tả capture là "AGENT-DRIVEN" (agent tự click qua snapshot), nhưng
   `run_case.mjs:328-487` cho thấy toàn bộ vòng lặp mở rộng/phân trang đã được code hoá tất định
   (PHASE 1.5), khớp với mô tả trong `CLAUDE.md` ("capture is code, no model in the loop"). Đây không
   trực tiếp gây mất dữ liệu, nhưng tài liệu lỗi thời này có thể khiến người chẩn đoán sau này (kể cả
   ticket #195) hiểu sai luồng thực thi và tìm sai chỗ.

---

## Ghi chú phạm vi

Đây là audit tĩnh — không có case thật nào được dùng để tái hiện lỗi (không có Chrome/Windows trong
môi trường chạy audit này). Các cơ chế ở mục 2a và 2b được suy ra chặt chẽ từ mã nguồn và trích dẫn
chính xác từng dòng, nhưng **chưa được xác nhận bằng một lần chạy thực tế** trên case Qualcomm cụ
thể. Ticket chẩn đoán tiếp theo (#195) nên ưu tiên tái hiện mục 2a trước (dễ tái hiện nhất bằng cách
tạo case giả có 2 comment khác tác giả cùng 40 ký tự mở đầu, hoặc thêm test end-to-end cho chuỗi
`anchorOf → findAnchorIdx → isNoUpdate`).
