
> project-management-ai@1.0.0 benchmark
> node scripts/benchmark.js

Đã tạo dữ liệu mẫu. Tài khoản demo: manager@demo.com / 123456
| Thao tác | Số lần | Trung bình (ms) | P50 (ms) | P95 (ms) | Lớn nhất (ms) |
|---|---|---|---|---|---|
| Thêm nhiệm vụ | 30 | 2.4 | 2.3 | 3.5 | 4.8 |
| Danh sách 500 nhiệm vụ | 30 | 4.8 | 4.5 | 6.7 | 7.6 |
| Thống kê 500 nhiệm vụ | 30 | 1.8 | 1.7 | 2.1 | 4.0 |
| AI dự phòng (xử lý nội bộ) | 10 | 4.1 | 3.0 | 13.6 | 13.6 |
