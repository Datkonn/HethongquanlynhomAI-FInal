# Thiết kế cơ sở dữ liệu

## Các bảng

| Bảng | Vai trò | Khóa |
|------|---------|------|
| users | Tài khoản người dùng | id (PK), email (UNIQUE) |
| projects | Dự án | id (PK) |
| project_members | Quan hệ người dùng - dự án, kèm vai trò | (project_id, user_id) |
| tasks | Nhiệm vụ | id (PK), project_id (FK), assignee_id (FK) |
| activity | Nhật ký hoạt động | id (PK), project_id (FK) |
| ai_logs | Nhật ký gọi AI (prompt, phản hồi, chế độ) | id (PK), project_id (FK) |

## Quan hệ

- Một người dùng tham gia nhiều dự án, một dự án có nhiều người dùng (quan hệ nhiều-nhiều qua project_members).
- Một dự án có nhiều nhiệm vụ. Xóa dự án thì xóa nhiệm vụ (ON DELETE CASCADE).
- Một nhiệm vụ có tối đa một người phụ trách. Xóa người dùng thì nhiệm vụ được bỏ gán (ON DELETE SET NULL).

## Ràng buộc

| Loại | Nội dung |
|------|----------|
| NOT NULL, CHECK | Tên, tiêu đề không được rỗng |
| CHECK | Vai trò, ưu tiên, trạng thái chỉ nhận giá trị cho phép |
| CHECK | Ngày có định dạng YYYY-MM-DD, ngày kết thúc không trước ngày bắt đầu |
| CHECK | Email viết thường và có ký tự @ |
| FOREIGN KEY | Mọi tham chiếu đến dự án, người dùng đều hợp lệ |
| TRIGGER | Người phụ trách phải là thành viên của dự án (khi thêm hoặc sửa nhiệm vụ) |
| TRIGGER | Xóa thành viên thì bỏ gán họ khỏi nhiệm vụ của dự án đó |
| INDEX | Chỉ mục trên project_id, assignee_id, user_id để truy vấn nhanh |

## Dữ liệu mẫu

Khi CSDL trống, hệ thống tạo 1 dự án, 3 tài khoản (quản lý và 2 thành viên) và 7 nhiệm vụ ở các trạng thái khác nhau.

## Sao lưu và khôi phục

- Sao lưu: `npm run backup`. File lưu trong `backend\backups\`, tên có ngày giờ.
- Kiểm tra: `npm run check-db` báo số dòng mỗi bảng và phát hiện dữ liệu sai.
- Khôi phục: tắt server, chạy `npm run restore -- backups\ten-file.db`, rồi chạy lại `npm start`. Hệ thống tự lưu bản hiện tại trước khi ghi đè.