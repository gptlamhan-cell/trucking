# Tính cước trucking

Ứng dụng web chạy trên Google Apps Script để tính cước vận chuyển trucking (SUN REIGN).

## Cấu trúc

- `Code.gs`: toàn bộ mã của dự án Apps Script (hàm `doGet` trả về giao diện HTML, kèm các hàm tra cứu địa chỉ, xếp hạng tuyến, báo giá hàng). Dữ liệu cước đọc từ một Google Sheet qua hằng số `DB` ở dòng đầu file.

## Nguồn gốc

- Mã được sao chép từ dự án Apps Script "Dự án không có tiêu đề" (ID dự án: `1ZdqAx9p66q7Jnh2qzGUeYcC_iOnmYsR-BVwD-uCcV5xlUwE6bfmX2ktu`) ngày 2026-11-18.
- File manifest `appsscript.json` chưa được xuất kèm.

## Cập nhật

Bản chạy thật nằm trên Apps Script. Sau khi sửa mã trên Apps Script, chép lại nội dung vào `Code.gs` rồi commit, hoặc dùng `clasp` để đồng bộ hai chiều.
