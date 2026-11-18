# Tính cước trucking

Ứng dụng web chạy trên Google Apps Script để tính cước vận chuyển trucking (SUN REIGN).

## Tính năng

- **Gợi ý địa chỉ Google Maps khi gõ.** Gõ có dấu hay không dấu đều được, ví dụ `kcn pho noi yen my`. Chọn một gợi ý thì hệ thống lấy tọa độ và tự tìm tuyến gần nhất theo đường bộ (trong phạm vi 30 km). Có thể dán thẳng tọa độ `20.93, 106.05`.
- **Đối chiếu địa danh mới với địa danh cũ** (sau sáp nhập), dựa trên sheet "Xã cũ - mới".
- **FCL:** cước = giá container × số container × (1 + FSC).
- **LCL:** tự chọn tổ hợp xe rẻ nhất, được ghép nhiều loại xe (ví dụ 1 xe 8 tấn + 1 xe 1.25 tấn). Có thể bật tùy chọn *xếp chồng* và *lật kiện*.
- **Hải Phòng:** FSC áp dụng = FSC nhập × 1,75.
- **Làm tròn:** mặc định làm tròn **lên** bội số 100.000 đ. Đổi được trong sheet "Cấu hình".
- **Chi tiết báo giá:** cước gốc, FSC, tạm tính, tổng tiền, kèm nút "Sao chép báo giá".

## Cấu trúc

```
src/                 ← mã Apps Script (clasp đẩy thư mục này)
  appsscript.json    manifest
  Config.gs          cấu hình: bố cục bảng cước, hệ số Hải Phòng, thông số xe mặc định
  Data.gs            đọc sheet và cache (CacheService)
  Pricing.gs         tính cước FCL/LCL, làm tròn
  Address.gs         chuẩn hóa không dấu, thêm lại dấu, đối chiếu xã cũ – mới
  Maps.gs            gợi ý địa chỉ, tọa độ, khoảng cách đường bộ
  Admin.gs           hàm quản trị: dinhViToanBo, kiemTraCauHinh
  WebApp.gs          doGet
  Index.html, Styles.html, Script.html, Logo.html   giao diện
tests/               test Node (giả lập Apps Script) + test giao diện bằng Playwright
```

## Cài đặt

### 1. Script properties

Vào Apps Script → **Project Settings → Script properties** và thêm:

| Thuộc tính | Bắt buộc | Ý nghĩa |
|---|---|---|
| `SHEET_ID` | có | ID của Google Sheet chứa bảng cước. ID không còn ghi trong code. |
| `MAPS_API_KEY` | không | API key Google Maps Platform. Có key thì dùng Places Autocomplete (gợi ý như ô tìm kiếm Google Maps) và Routes API (đo nhiều điểm trong 1 lần gọi). Không có key thì dùng Geocoder/DirectionFinder có sẵn của Apps Script. |

**Tạo `MAPS_API_KEY`:**

1. Vào Google Cloud Console và bật **Places API (New)** cùng **Routes API**. Dự án Cloud phải có thanh toán.
2. Tạo API key và giới hạn key chỉ dùng cho 2 API trên.
3. Đặt hạn mức theo ngày (quota) để tránh phát sinh chi phí ngoài dự kiến.

Mỗi lần chọn địa chỉ chỉ tính 1 phiên Autocomplete, nhờ session token. Kết quả gợi ý, tọa độ và khoảng cách đều được cache 6 giờ.

### 2. Các sheet

Các sheet đang dùng (giữ nguyên như hiện tại):
- `HAN`, `HPH`, `HCM`: bảng cước. Dòng 2 là tiêu đề phương tiện. Dòng bắt đầu dữ liệu khai báo trong `HUBS` ở `src/Config.gs`.
- `Xã cũ - mới`
- `Điểm tham chiếu`

Các sheet không bắt buộc:
- **`Cấu hình`**: cột A là tên, cột B là giá trị.

  | A | B |
  |---|---|
  | FSC mặc định (%) | 12 |
  | Bước làm tròn (đ) | 100000 |
  | Kiểu làm tròn | lên *(hoặc: gần nhất, xuống)* |
  | Ghi chú báo giá | Giá chưa gồm VAT. |

- **`Thông số xe`**: dòng 1 là tiêu đề. Các cột: A = mã xe (ví dụ `1.25`), B = dài, C = rộng, D = cao (cm), E = tải trọng (kg). Sheet này ghi đè `DEFAULT_VEHICLE_SPECS`.

Sau khi sửa sheet, chạy `xoaCache()` trong trình soạn Apps Script để áp dụng ngay. Nếu không chạy, cache tự hết hạn sau 30 phút. Chạy `kiemTraCauHinh()` để kiểm tra bố cục và cấu hình; kết quả xem ở Execution log.

### 3. Đồng bộ bằng clasp

Chạy các lệnh sau:

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

```bash
cp .clasp.json.example .clasp.json
```

Sau đó sửa scriptId trong `.clasp.json`, rồi chạy:

```bash
clasp push
```

Sau khi push: mở **Deploy → Manage deployments**, sửa deployment đang có và chọn **New version**. URL web app sẽ giữ nguyên.

> Kiểm tra mục `webapp` trong `src/appsscript.json` (mặc định `executeAs: USER_DEPLOYING`, `access: ANYONE`) cho khớp với deployment hiện tại trước khi push.

## Test

Yêu cầu Node 18 trở lên. Test giao diện cần Playwright và Chromium; nếu máy không có thì test này được bỏ qua.

```bash
npm test
```

## Bảo mật

- Các hàm quản trị (`dinhViToanBo`, `kiemTraCauHinh`, `xoaCache`) chỉ chạy được bởi chủ script. Người dùng web app gọi sẽ bị chặn.
- Commit đầu tiên của repo có chứa ID Google Sheet. Nên chuyển repo sang private, hoặc kiểm tra lại quyền chia sẻ của Sheet.
