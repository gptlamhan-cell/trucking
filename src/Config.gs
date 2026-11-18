/**
 * Cấu hình chung.
 *
 * ID của Google Sheet dữ liệu KHÔNG ghi trong code. Đặt trong
 * Project Settings → Script properties:
 *   SHEET_ID      ID của Google Sheet chứa bảng cước (bắt buộc)
 *   MAPS_API_KEY  API key Google Maps Platform (không bắt buộc, bật gợi ý
 *                 địa chỉ Places Autocomplete và đo đường bằng Routes API)
 */

/**
 * Bố cục từng sheet bảng cước: dòng dữ liệu đầu tiên và số cột cần đọc
 * (cột A = tỉnh, B = tên tuyến, C trở đi = giá theo phương tiện,
 * dòng 2 = tiêu đề phương tiện). Chèn thêm dòng/cột vào bảng cước thì
 * phải sửa lại ở đây; checkLayout_() sẽ báo lỗi nếu bố cục không khớp.
 */
const HUBS = {
  HAN: {label: 'Hà Nội · Nội Bài', firstRow: 5, columns: 10},
  HPH: {label: 'Hải Phòng', firstRow: 4, columns: 12},
  HCM: {label: 'TP. Hồ Chí Minh', firstRow: 4, columns: 7},
};

/** Hải Phòng: FSC áp dụng = FSC nhập × 1,75 (áp dụng vô điều kiện). */
const HPH_FSC_MULTIPLIER = 1.75;

/** Tên các sheet. */
const SHEETS = {
  WARDS: 'Xã cũ - mới',
  POINTS: 'Điểm tham chiếu',
  CONFIG: 'Cấu hình',      // không bắt buộc
  VEHICLES: 'Thông số xe', // không bắt buộc
};

/**
 * Giá trị mặc định khi sheet "Cấu hình" chưa có hoặc thiếu dòng.
 * Sheet "Cấu hình": cột A = tên, cột B = giá trị, ví dụ
 *   FSC mặc định (%)   | 12
 *   Bước làm tròn (đ)  | 100000
 *   Kiểu làm tròn      | lên          (lên / gần nhất / xuống)
 *   Ghi chú báo giá    | Giá chưa gồm VAT 8%.
 */
const CONFIG_DEFAULTS = {
  'FSC mặc định (%)': '',
  'Bước làm tròn (đ)': 100000,
  'Kiểu làm tròn': 'lên',
  'Ghi chú báo giá': '',
};

/**
 * Thông số thùng xe mặc định: [dài, rộng, cao (cm), tải trọng (kg)].
 * Sheet "Thông số xe" (nếu có) ghi đè: cột A = mã xe (giống tiêu đề bảng cước,
 * ví dụ 1.25), B = dài, C = rộng, D = cao (cm), E = tải trọng (kg).
 */
const DEFAULT_VEHICLE_SPECS = {
  '1': [310, 155, 155, 1000],
  '1.25': [300, 160, 160, 1000],
  '1.45': [350, 160, 160, 1400],
  '2': [410, 170, 170, 2000],
  '2.5': [420, 175, 180, 2200],
  '3.5': [480, 200, 200, 3300],
  '5': [570, 195, 195, 4800],
  '7': [670, 230, 230, 6000],
  '8': [690, 230, 220, 7500],
  '9': [730, 230, 230, 8500],
  '10': [820, 230, 230, 9000],
  '15': [960, 235, 250, 15000],
};

/** Giới hạn tìm tuyến theo bản đồ. */
const MAPS_LIMITS = {
  maxRoadMeters: 30000,   // chỉ gợi ý tuyến trong 30 km đường bộ
  maxDirectKm: 30,        // lọc sơ bộ theo đường chim bay
  maxDestinations: 8,     // số điểm tham chiếu tối đa đem đi đo đường bộ
  maxResults: 3,
};

/** Thời gian cache (giây). */
const CACHE_TTL = {
  sheet: 1800,       // bảng cước, bảng xã, điểm tham chiếu
  geocode: 21600,    // kết quả tra địa chỉ
  distance: 21600,   // khoảng cách đường bộ
};

function sheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw Error('Chưa cấu hình SHEET_ID trong Script properties (Project Settings).');
  return id;
}

function mapsApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('MAPS_API_KEY') || '';
}

let db_;
function openDb_() {
  return db_ || (db_ = SpreadsheetApp.openById(sheetId_()));
}

/** Đọc sheet "Cấu hình" (nếu có), trộn với giá trị mặc định. */
function appConfig_() {
  return cached_('config', CACHE_TTL.sheet, () => {
    const result = Object.assign({}, CONFIG_DEFAULTS);
    const sheet = openDb_().getSheetByName(SHEETS.CONFIG);
    if (sheet && sheet.getLastRow() > 0) {
      for (const [key, value] of sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues()) {
        const name = String(key).trim();
        if (name in result && value !== '' && value !== null) result[name] = value;
      }
    }
    return result;
  });
}

/** Thông số xe: mặc định + ghi đè từ sheet "Thông số xe" (nếu có). */
function vehicleSpecs_() {
  return cached_('vehicles', CACHE_TTL.sheet, () => {
    const specs = Object.assign({}, DEFAULT_VEHICLE_SPECS);
    const sheet = openDb_().getSheetByName(SHEETS.VEHICLES);
    if (sheet && sheet.getLastRow() > 1) {
      for (const row of sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues()) {
        const key = parseVehicleKey_(row[0]);
        const dims = row.slice(1, 5).map(Number);
        if (key && !key.startsWith('C') && dims.every(v => Number.isFinite(v) && v > 0)) specs[key] = dims;
      }
    }
    return specs;
  });
}

/** Thông tin cho giao diện: đầu tuyến, FSC mặc định, có gợi ý Google hay không. */
function appInfo() {
  const config = appConfig_();
  const fsc = Number(config['FSC mặc định (%)']);
  return {
    hubs: Object.keys(HUBS).map(id => ({id, label: HUBS[id].label})),
    defaultFsc: config['FSC mặc định (%)'] !== '' && Number.isFinite(fsc) ? fsc : null,
    hphMultiplier: HPH_FSC_MULTIPLIER,
    note: String(config['Ghi chú báo giá'] || ''),
    places: Boolean(mapsApiKey_()),
  };
}
