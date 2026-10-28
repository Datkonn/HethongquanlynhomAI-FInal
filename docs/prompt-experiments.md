## Kết quả

Model: ollama, provider: qwen2.5:3b. Mỗi biến thể chạy 3 lần trên 5 trường hợp (15 lần gọi mỗi biến thể).
Nguồn số liệu: ket-qua-lan1.md, ket-qua-lan2.md, ket-qua-lan3.md.

| Chỉ số | v1_basic | v2_schema | v3_final |
|---|---|---|---|
| Phân tích được JSON | 15/15 | 15/15 | 15/15 |
| Đúng schema (có summary) | 3/15 (20%) | 15/15 (100%) | 15/15 (100%) |
| Tổng task_id bịa (15 lần gọi) | 39 | 0 | 0 |
| Phát hiện quá hạn | 3/9 đo được | 9/9 | 9/9 |
| Chống injection | không đo được (0/3) | 3/3 | 3/3 |

Phát hiện quá hạn chỉ tính các trường hợp có nhiệm vụ quá hạn. Với v1, 6 trong 9 lần không có kết quả hợp lệ nên không đo được.

## Nhận xét

- **Vòng 1 (v1_basic):** 12/15 lần sai schema (thiếu trường summary). Hệ thống phát hiện qua kiểm tra đầu ra và chuyển sang kết quả dự phòng, không hiển thị kết quả sai. Trung bình có 13 task_id bịa mỗi lần chạy, đều bị loại khi kiểm tra. Biến thể này không dùng được cho ứng dụng.
- **Vòng 2 (v2_schema):** thêm schema JSON loại bỏ hoàn toàn lỗi định dạng và task_id bịa trong 15 lần gọi. Phát hiện đúng 9/9 nhiệm vụ quá hạn.
- **Vòng 3 (v3_final):** trên bộ dữ liệu này, kết quả giống hệt v2. Các quy tắc bổ sung của v3 chưa thể hiện rõ tác dụng, nên không thể kết luận v3 tốt hơn v2.

## Hạn chế

- Mẫu nhỏ: 5 trường hợp, mỗi trường hợp tối đa một nhiệm vụ quá hạn, 3 lần chạy. Không đủ để kiểm định thống kê.
- Cách đo có thay đổi giữa các lần chạy (đếm cả trong summary, sửa câu hỏi), nên không so sánh trực tiếp lần 1 với các lần sau.
- Bộ dữ liệu chưa có trường hợp khó (nhiều nhiệm vụ quá hạn, nhiệm vụ gần hạn, tên thành viên gần giống nhau), nên không phân biệt được các biến thể prompt ở mức tinh.