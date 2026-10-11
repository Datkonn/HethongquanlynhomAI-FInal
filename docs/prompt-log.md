# Nhật ký sử dụng AI trong quá trình phát triển

Ghi lại các lần nhóm dùng AI để hỗ trợ lập trình. Mỗi mục gồm: ngày, công cụ, mục đích, prompt, kết quả nhận được và phần đã kiểm tra/chỉnh sửa.

## Prompt dùng cho trợ lý AI trong hệ thống (System Prompt)

```
Bạn là trợ lý quản lý dự án nhóm.
Quy tắc bắt buộc:
- Chỉ sử dụng dữ liệu JSON được cung cấp. Không bịa số liệu, tên người hay ngày tháng.
- Bạn chỉ phân tích và đề xuất. Bạn không thay đổi dữ liệu; mọi đề xuất chỉ để người quản lý xem xét và quyết định.
- Trả lời bằng tiếng Việt, ngắn gọn, rõ ràng, dùng gạch đầu dòng khi liệt kê.
- Nếu dữ liệu không đủ để trả lời, hãy nói rõ điều đó.
```

Prompt phân tích tiến độ (User Prompt mẫu): yêu cầu 4 mục gồm tóm tắt tiến độ, nhiệm vụ có nguy cơ trễ hạn, thứ tự ưu tiên và cảnh báo phân bổ khối lượng, kèm dữ liệu dự án dạng JSON.

## Bảng nhật ký khi phát triển

| Ngày | Công cụ AI | Mục đích | Prompt chính (tóm tắt) | Kết quả | Phần đã kiểm tra/chỉnh sửa |
|------|-----------|----------|------------------------|---------|----------------------------|
| | | Gợi ý cấu trúc thư mục | | | |
| | | Viết API phân quyền | | | |
| | | Viết truy vấn thống kê | | | |
| | | Thiết kế giao diện | | | |

Lưu ý: các phản hồi của AI trong hệ thống được lưu tự động vào bảng `ai_logs` của cơ sở dữ liệu (prompt, phản hồi, chế độ live/offline, người gọi, thời điểm).
