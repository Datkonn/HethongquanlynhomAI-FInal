# Hệ thống quản lý dự án nhóm có tích hợp AI

Ứng dụng web demo gồm backend Node.js + Express + SQLite và frontend HTML/CSS/JS thuần.

## Tính năng

- **Đăng nhập, đăng ký, phân quyền**: mật khẩu băm bằng bcrypt, phiên làm việc bằng JWT. Vai trò trong từng dự án: Quản lý hoặc Thành viên.
- **Quản lý dự án**: tạo, sửa, xóa, đóng/mở dự án.
- **Quản lý thành viên**: thêm theo email, đổi vai trò, xóa thành viên.
- **CRUD nhiệm vụ**: tên, mô tả, người phụ trách, ưu tiên, hạn, trạng thái. Thành viên chỉ đổi trạng thái nhiệm vụ của mình.
- **Tìm kiếm và lọc**: theo từ khóa, trạng thái, ưu tiên, người phụ trách; sắp xếp theo hạn, ưu tiên hoặc mới nhất.
- **Thống kê**: tổng số, hoàn thành, tiến độ %, quá hạn, khối lượng theo từng thành viên.
- **Nhật ký hoạt động**: ghi lại các thay đổi quan trọng trong dự án.
- **Trợ lý AI**: phân tích tiến độ, phát hiện nhiệm vụ có nguy cơ trễ hạn, hỏi đáp dữ liệu dự án bằng tiếng Việt. AI chỉ đọc dữ liệu, không tự thay đổi nhiệm vụ.
- **Xử lý lỗi**: kiểm tra đầu vào, trả về mã lỗi rõ ràng (400, 401, 403, 404, 409), không để ứng dụng bị sập khi AI lỗi.

## Cài đặt và chạy trên máy

Yêu cầu: Node.js 18 trở lên.

```bash
cd backend
npm install
cp .env.example .env        # Windows PowerShell: copy .env.example .env
npm start
```

Mở trình duyệt tại `http://localhost:3000`.

Tài khoản demo (được tạo tự động ở lần chạy đầu tiên):

| Email | Mật khẩu | Vai trò |
|-------|----------|---------|
| manager@demo.com | 123456 | Quản lý |
| a@demo.com | 123456 | Thành viên |
| b@demo.com | 123456 | Thành viên |

Dữ liệu mẫu: một dự án với 7 nhiệm vụ ở các trạng thái khác nhau, có nhiệm vụ quá hạn để demo cảnh báo.

## Bật AI thật

Điền `ANTHROPIC_API_KEY` vào file `backend/.env`. Nếu để trống, trợ lý AI chạy ở chế độ dự phòng: kết quả được tạo theo quy tắc từ dữ liệu, không cần API key. Chế độ này vẫn cho thấy luồng xử lý và giao diện hoạt động đầy đủ.

## Triển khai lên Render

- Root Directory: `backend`
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables: `JWT_SECRET`, `ANTHROPIC_API_KEY` (tùy chọn), `AI_MODEL` (tùy chọn)

Lưu ý: gói Free của Render dùng ổ đĩa tạm nên dữ liệu SQLite có thể mất khi dịch vụ khởi động lại. Nếu cần giữ dữ liệu, dùng Persistent Disk và đặt `DB_FILE` trỏ vào thư mục đó.

## Cấu trúc thư mục

```
project-management-ai/
├── backend/
│   ├── src/
│   │   ├── server.js     # Route API, xác thực, phân quyền, xử lý lỗi
│   │   ├── db.js         # Schema SQLite và dữ liệu mẫu
│   │   └── ai.js         # Tích hợp AI, prompt, chế độ dự phòng
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── docs/
│   └── prompt-log.md     # Nhật ký sử dụng AI
└── README.md
```

## API chính

| Phương thức | Đường dẫn | Mô tả | Quyền |
|-------------|-----------|-------|-------|
| POST | /api/auth/register | Đăng ký | Công khai |
| POST | /api/auth/login | Đăng nhập | Công khai |
| GET | /api/projects | Danh sách dự án của tôi | Đăng nhập |
| POST | /api/projects | Tạo dự án | Đăng nhập |
| GET/PUT/DELETE | /api/projects/:id | Xem, sửa, xóa dự án | Thành viên / Quản lý |
| POST/DELETE | /api/projects/:id/members | Thêm, xóa thành viên | Quản lý |
| GET | /api/projects/:id/tasks?q&status&priority&assignee&sort | Tìm kiếm, lọc nhiệm vụ | Thành viên |
| POST | /api/projects/:id/tasks | Tạo nhiệm vụ | Quản lý |
| PUT/DELETE | /api/tasks/:id | Sửa, xóa nhiệm vụ | Quản lý (thành viên chỉ đổi trạng thái của mình) |
| GET | /api/projects/:id/stats | Thống kê | Thành viên |
| GET | /api/projects/:id/activity | Nhật ký hoạt động | Thành viên |
| POST | /api/projects/:id/ai/analyze | AI phân tích tiến độ | Thành viên |
| POST | /api/projects/:id/ai/ask | AI hỏi đáp | Thành viên |

## Hướng phát triển

- Quản lý Sprint và Product Backlog theo Scrum.
- Thông báo khi nhiệm vụ sắp đến hạn.
- AI đề xuất phân công công việc, người quản lý xác nhận trước khi áp dụng.
- Xuất báo cáo tiến độ dạng PDF hoặc Excel.
