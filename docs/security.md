# Bảo mật và đạo đức AI (tiêu chí 6)

Tài liệu này mô tả các biện pháp bảo mật đã áp dụng, cách kiểm chứng từng biện pháp, và các rủi ro còn lại. Mục 7 liệt kê rủi ro chưa được xử lý hết, kèm hướng khắc phục nếu hệ thống được triển khai thật.

## 1. Bảo vệ tài khoản

| Biện pháp | Cách thực hiện | Kiểm chứng |
|-----------|----------------|------------|
| Băm mật khẩu | bcrypt, 10 vòng. Mật khẩu không bao giờ lưu dạng rõ | Kiểm tra bảng `users`: cột `password_hash` không chứa mật khẩu gốc |
| Phiên đăng nhập | JWT, hết hạn sau 7 ngày | Test API: token sai hoặc thiếu bị từ chối với mã 401 |
| Chống dò mật khẩu | Tối đa 30 lần đăng nhập mỗi 15 phút cho mỗi IP | Quy định trong `server.js` (`loginLimiter`) |
| Chống tạo tài khoản hàng loạt | Tối đa 100 lần đăng ký mỗi giờ cho mỗi IP | Quy định trong `server.js` (`registerLimiter`) |
| Bắt buộc khóa bí mật khi production | Server không khởi động nếu `NODE_ENV=production` mà thiếu `JWT_SECRET` | Quy định trong `server.js` |
| Kiểm tra định dạng đầu vào | Email hợp lệ, mật khẩu tối thiểu 6 ký tự, tên không rỗng | Test API và test F11 |

## 2. Phân quyền dữ liệu

Hệ thống có hai vai trò trong từng dự án: quản lý và thành viên. Quyền được kiểm tra ở backend, không chỉ ẩn nút trên giao diện.

| Thao tác | Quản lý | Thành viên | Người ngoài dự án |
|----------|---------|------------|-------------------|
| Xem dự án, nhiệm vụ, thống kê | Có | Có | Không (403) |
| Tạo, sửa, xóa nhiệm vụ | Có | Không (403) | Không (403) |
| Đổi trạng thái nhiệm vụ | Có | Chỉ việc được giao cho mình | Không (403) |
| Thêm, xóa thành viên, sửa dự án, xóa dự án | Có | Không (403) | Không (403) |
| Gọi phân tích và hỏi đáp AI | Có | Có | Không (403) |

Các ràng buộc ở tầng CSDL bổ sung thêm: trigger chặn gán người phụ trách không thuộc dự án, và khi xóa thành viên thì nhiệm vụ của họ được bỏ gán tự động.

Kiểm chứng: test F6, F7, F12 trong `test/functional.test.js`, các test phân quyền trong `test/api.test.js`, và nhóm D7, D8 trong `test/db.test.js`.

## 3. Không lộ API key

- API key chỉ được đọc từ biến môi trường ở phía server. Không có route nào trả key về trình duyệt.
- Nhật ký AI (`ai_logs`) chỉ ghi câu hỏi, nội dung trả lời và chế độ chạy. Không ghi key, header hay địa chỉ đầy đủ của dịch vụ.
- File `.env` nằm trong `.gitignore`, không đưa lên kho mã. Kiểm tra bằng `git check-ignore -v backend\.env`.
- Thông báo lỗi từ dịch vụ AI chỉ ghi mã trạng thái, không ghi nội dung yêu cầu có chứa key.

**Tình trạng key trong dự án này:** key Gemini đã xuất hiện trong nhiều ảnh chụp màn hình trong quá trình làm đồ án. Vì vậy key đó được coi là đã lộ và phải được thu hồi. Key mới được tạo và chỉ lưu trong `backend\.env` trên máy cá nhân. Trước khi nộp, cần xác nhận lại việc này.

## 4. Dữ liệu nhạy cảm khi gọi AI

Hệ thống chỉ gửi cho AI những gì cần để phân tích. Danh sách cụ thể:

| Dữ liệu | Có gửi cho AI | Ghi chú |
|---------|---------------|---------|
| Tên dự án, mô tả dự án, ngày bắt đầu và kết thúc | Có | Không nên ghi thông tin cá nhân trong mô tả dự án |
| Tiêu đề, trạng thái, ưu tiên, hạn của nhiệm vụ | Có | Cần thiết cho phân tích |
| Tên người phụ trách nhiệm vụ | Có, hoặc "Thành viên 1, 2..." khi bật `AI_ANONYMIZE=true` | Kiểm chứng: B3, B5 |
| Danh sách thành viên và vai trò | Có, hoặc alias khi bật ẩn danh | Không có email |
| Hoạt động gần đây (tối đa 10 mục) | Có, tên người được thay bằng alias khi bật ẩn danh | Kiểm chứng: B3 |
| Email, mật khẩu, token, mã người dùng | Không | Kiểm chứng: test "prepareData không đưa email hay mật khẩu" |

**Chế độ ẩn danh (`AI_ANONYMIZE=true`)** thay tên thành viên bằng "Thành viên 1", "Thành viên 2" và tương tự. Sau khi AI trả lời, hệ thống đổi alias trở lại tên thật trong các trường `workload_warnings` và `suggested_actions` (kiểm chứng: B4). Chế độ này không xử lý tên người xuất hiện tự do trong tiêu đề hoặc mô tả nhiệm vụ. Phần đó được nêu ở mục 7.

**Ba lựa chọn cho dữ liệu nhạy cảm:**
1. Bật `AI_ANONYMIZE=true` khi dùng dịch vụ đám mây.
2. Dùng Ollama chạy trên máy, khi đó dữ liệu không rời khỏi máy.
3. Không đưa thông tin cá nhân vào tên và mô tả nhiệm vụ.

## 5. Đạo đức sử dụng AI

- **AI chỉ đề xuất.** Mọi thay đổi chỉ có hiệu lực khi người quản lý mở form và bấm Lưu. Nút "Mở để xác nhận" không tự lưu.
- **Nhãn nguồn rõ ràng.** Mỗi kết quả hiển thị là "AI · nhà cung cấp · phiên bản prompt" hoặc "Chế độ dự phòng". Người dùng luôn biết kết quả đến từ đâu.
- **Chống bịa dữ liệu.** Mọi `task_id` do AI trả về phải khớp với danh sách nhiệm vụ đã gửi đi. ID không hợp lệ bị loại và được đếm trong cột "Mục bị loại" của bảng so sánh.
- **Chống chỉ dẫn giấu trong dữ liệu (prompt injection).** Dữ liệu dự án được bọc trong khối `<<<DATA ... DATA>>>`, và prompt yêu cầu AI coi nội dung trong khối là dữ liệu tham khảo, không phải chỉ dẫn. Kiểm chứng: trường hợp `chống_injection` trong bộ đánh giá prompt (`npm run evaluate`).
- **Hiển thị phạm vi dữ liệu.** Tab Trợ lý AI có đoạn mô tả liệt kê các loại dữ liệu được gửi cho AI.
- **Không tự động hóa quyết định.** Hệ thống không tự đổi trạng thái, deadline hay người phụ trách mà không có người quản lý xác nhận.

## 6. Bảo mật HTTP

- **Content-Security-Policy:** giới hạn script và style chỉ từ cùng nguồn, không cho khung nhúng từ nơi khác (`frame-ancestors 'none'`).
- **Chống đoán kiểu MIME:** `X-Content-Type-Options: nosniff`.
- **Chống nhúng khung (clickjacking):** `X-Frame-Options: DENY`.
- **Không gửi referrer:** `Referrer-Policy: no-referrer`.
- **Đóng CORS:** `cors({ origin: false })`. Trang web khác không thể gọi API từ trình duyệt của người dùng.
- **Ẩn phiên bản server:** `x-powered-by` bị tắt.
- **Thoát dữ liệu khi hiển thị:** các giá trị từ người dùng và từ AI được đưa qua hàm `esc` trước khi chèn vào giao diện. Kết quả AI hiển thị bằng `textContent` hoặc qua `esc`.

Kiểm chứng: test B1 (header), B2 (không có CORS). Kiểm tra thủ công: mở F12, tab Console, không có lỗi CSP khi dùng các tính năng chính.

## 7. Rủi ro còn lại

Bảng dưới liệt kê các rủi ro chưa được xử lý hết, mức độ đánh giá theo khả năng xảy ra và tác động trong bối cảnh đồ án, kèm biện pháp hiện có và hướng khắc phục nếu triển khai thật.

| # | Rủi ro | Mức độ | Biện pháp hiện có | Hướng khắc phục khi triển khai thật |
|---|--------|--------|-------------------|-------------------------------------|
| R1 | Token JWT lưu trong `localStorage`. Nếu có lỗ hổng XSS, kẻ tấn công có thể đọc token | Trung bình | CSP chặn script ngoài, mọi dữ liệu được thoát khi hiển thị | Chuyển sang cookie `HttpOnly` và `SameSite`, thêm CSRF token |
| R2 | Không thu hồi được token khi đăng xuất. Token còn hiệu lực đến khi hết hạn (7 ngày) | Trung bình | Thời hạn ngắn hơn có thể cấu hình, đăng xuất xóa token phía trình duyệt | Lưu danh sách token bị thu hồi, hoặc dùng access token ngắn hạn kèm refresh token |
| R3 | Tài khoản demo có mật khẩu công khai (`123456`) | Cao nếu triển khai thật, thấp với đồ án | Tài khoản demo chỉ tạo khi CSDL trống | Xóa tài khoản demo trước khi triển khai thật, bắt buộc đổi mật khẩu ban đầu |
| R4 | Chính sách mật khẩu yếu (tối thiểu 6 ký tự, không kiểm tra độ mạnh) | Trung bình | Băm bcrypt, giới hạn số lần đăng nhập | Tối thiểu 8 ký tự, kiểm tra mật khẩu phổ biến, thêm xác thực hai lớp |
| R5 | Giới hạn tốc độ lưu trong bộ nhớ. Mất khi khởi động lại, và không chia sẻ giữa nhiều tiến trình | Trung bình | Áp dụng cho đăng nhập, đăng ký và AI | Dùng Redis hoặc kho chung khi chạy nhiều bản sao |
| R6 | Chưa khóa tài khoản tạm thời sau nhiều lần đăng nhập sai. Chỉ giới hạn theo IP, nên kẻ tấn công có thể đổi IP | Trung bình | Giới hạn 30 lần mỗi 15 phút cho mỗi IP | Khóa tài khoản tạm thời sau N lần sai, gửi thông báo cho chủ tài khoản |
| R7 | Nhật ký AI (`ai_logs`) lưu nội dung câu hỏi và kết quả trả lời, và kết quả đã đổi lại tên thật. Vì vậy nhật ký có thể chứa tên thành viên | Trung bình | Nhật ký không có route API đọc, chỉ truy cập được qua file CSDL. Tự xóa sau 30 ngày | Mã hóa cột nội dung, hoặc chỉ lưu alias khi bật ẩn danh |
| R8 | Chế độ ẩn danh không xử lý tên người xuất hiện trong tiêu đề và mô tả nhiệm vụ | Trung bình | Chế độ chỉ thay tên thành viên trong danh sách và hoạt động. Phần còn lại được nêu cho người dùng | Quét và thay tên trong tiêu đề, hoặc cảnh báo người dùng không ghi tên người trong nhiệm vụ |
| R9 | Dữ liệu gửi cho nhà cung cấp AI đám mây (Gemini, OpenAI, Claude) rời khỏi hệ thống. Chính sách lưu trữ và huấn luyện của nhà cung cấp nằm ngoài tầm kiểm soát | Cao với dữ liệu thật | Ẩn danh tùy chọn. Ollama chạy cục bộ là lựa chọn không gửi dữ liệu ra ngoài | Chỉ dùng nhà cung cấp có điều khoản không huấn luyện trên dữ liệu khách hàng. Ghi rõ điều này trong chính sách bảo mật |
| R10 | CSDL SQLite không mã hóa khi lưu trên đĩa. Ai có quyền đọc file đều xem được dữ liệu | Trung bình | File CSDL nằm trong `backend\data`, không đưa lên kho mã. Có sao lưu | Mã hóa ổ đĩa (BitLocker), hoặc dùng SQLCipher, hoặc chuyển sang máy chủ CSDL có xác thực |
| R11 | Sao lưu không mã hóa. File sao lưu có đủ dữ liệu như CSDL gốc | Trung bình | Thư mục `backups` nằm trong `.gitignore` | Mã hóa file sao lưu và lưu ở nơi có kiểm soát truy cập |
| R12 | Không có nhật ký truy cập và cảnh báo đăng nhập bất thường | Thấp đến trung bình | Nhật ký hoạt động dự án ghi các thay đổi nghiệp vụ | Ghi nhật ký đăng nhập (thành công và thất bại), gửi cảnh báo khi có IP lạ |
| R13 | Triển khai trên Render (gói Free) dùng HTTP phía sau proxy. Nếu không cấu hình `TRUST_PROXY=1`, mọi người dùng chung một IP trong giới hạn tốc độ. Nếu cấu hình sai, người dùng có thể giả mạo IP | Trung bình | Cấu hình `TRUST_PROXY` qua biến môi trường, mặc định tắt | Đặt `TRUST_PROXY=1` đúng khi có proxy tin cậy. Render cung cấp HTTPS |
| R14 | Chưa có kiểm tra độ mạnh của `JWT_SECRET` trong môi trường phát triển. Giá trị mặc định công khai trong mã nguồn | Cao nếu dùng cho production | Server không khởi động nếu thiếu `JWT_SECRET` khi `NODE_ENV=production` | Bắt buộc chuỗi ngẫu nhiên từ 32 ký tự trở lên, kiểm tra khi khởi động |
| R15 | Không có bảo vệ chống CSRF cho các yêu cầu thay đổi dữ liệu. Hiện dựa vào header `Authorization` nên không bị CSRF thông thường, nhưng sẽ thành rủi ro nếu chuyển sang cookie | Thấp hiện tại | Đóng CORS, token không tự gửi kèm như cookie | Thêm CSRF token nếu chuyển sang cookie (xem R1) |
| R16 | Phụ thuộc thư viện bên thứ ba có thể có lỗ hổng. Chưa có quy trình quét định kỳ | Trung bình | Phiên bản thư viện được ghi trong `package.json` | Chạy `npm audit` định kỳ, cập nhật thư viện có lỗ hổng |

### Rủi ro đã được chấp nhận

Với phạm vi đồ án, các rủi ro R2, R3, R4, R5, R6, R10, R11, R12 được chấp nhận và không khắc phục trong phiên bản này. Lý do: hệ thống chạy trên máy cục bộ hoặc môi trường demo, không có dữ liệu thật của khách hàng. Nếu hệ thống được đưa vào sử dụng thật, các rủi ro này phải được xử lý theo cột "Hướng khắc phục".

### Rủi ro có thể kiểm chứng ngay

- **R14:** thử khởi động với `NODE_ENV=production` mà không đặt `JWT_SECRET`. Server phải từ chối khởi động.
- **R7:** mở file `backend\data\app.db` bằng công cụ SQLite và xem bảng `ai_logs`. Đây là cách xác nhận nhật ký có chứa tên người hay không.
- **R9:** chạy phân tích với `AI_PROVIDER=ollama` và với nhà cung cấp đám mây, so sánh phạm vi dữ liệu trong `prepareData`.

## 8. Cách kiểm chứng

| Biện pháp | Lệnh hoặc thao tác | Kết quả mong đợi |
|-----------|--------------------|------------------|
| Toàn bộ test bảo mật | `npm test` | Nhóm B1 đến B6 pass, tổng `fail 0` |
| Header bảo mật | Test B1 | Có CSP, nosniff, DENY, no-referrer, không có x-powered-by |
| Đóng CORS | Test B2 | Không có `access-control-allow-origin` cho origin lạ |
| Ẩn danh dữ liệu gửi AI | Test B3, B5 | Không có tên thật trong dữ liệu gửi đi, người dùng vẫn thấy tên thật |
| Đổi lại tên thật | Test B4 | Tên alias được đổi về tên thật trong kết quả |
| Xóa nhật ký cũ | Test B6 | Nhật ký quá hạn bị xóa, nhật ký mới được giữ |
| Phân quyền | Test F6, F12 và các test API 403 | Người ngoài và thành viên bị chặn đúng |
| Ràng buộc CSDL | Test D1 đến D10 | Dữ liệu không hợp lệ bị từ chối ở tầng CSDL |
| Không có lỗi CSP trên giao diện | F12, tab Console, dùng các tính năng chính | Không có dòng màu đỏ liên quan đến Content Security Policy |
| Không lộ key trong kho mã | `git check-ignore -v backend\.env` | Có kết quả, nghĩa là file bị bỏ qua |
| Không lộ key trong nhật ký | Tìm chuỗi key trong `ai_logs` | Không tìm thấy |

## 9. Checklist trước khi nộp

- [ ] Đã thu hồi key Gemini đã lộ và thay key mới trong `backend\.env`.
- [ ] `git check-ignore -v backend\.env` có kết quả.
- [ ] `npm test` báo `pass 53`, `fail 0`, hoặc số ca mới nếu đã thêm.
- [ ] Đã kiểm tra tab Console không có lỗi CSP.
- [ ] Đã kiểm tra người ngoài nhận 403 khi truy cập dự án.
- [ ] Đã thử bật `AI_ANONYMIZE=true` và xác nhận phân tích vẫn hiển thị tên thật trong đề xuất.
- [ ] Đã đọc mục 7 và chuẩn bị giải thích từng rủi ro khi được hỏi.