/**
 * Hàm quản trị, chạy tay trong trình soạn Apps Script.
 * Các hàm này không có dấu _ nên giao diện web cũng gọi được qua google.script.run,
 * vì vậy mỗi hàm đều gọi adminOnly_() để chặn người dùng web app.
 */

/** Chỉ cho phép chủ script (người chạy trong trình soạn thảo) gọi hàm quản trị. */
function adminOnly_() {
  const active = Session.getActiveUser().getEmail();
  const owner = Session.getEffectiveUser().getEmail();
  if (!active || active !== owner) throw Error('Chỉ chủ script được chạy hàm này.');
}

/**
 * Định vị (geocode) các dòng "Chờ định vị" trong sheet "Điểm tham chiếu".
 * Cột: A đầu tuyến, B tên tuyến, C địa chỉ bản đồ, D vĩ độ, E kinh độ, F trạng thái,
 *      G địa chỉ Google trả về, H tỉnh trong bảng cước, I điểm tách, J mã phương tiện.
 * Chạy tối đa ~4 phút mỗi lần; chạy lại nếu còn dòng chờ.
 */
function dinhViToanBo() {
  adminOnly_();
  const sheet = openDb_().getSheetByName(SHEETS.POINTS);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const n = sheet.getLastRow();
    if (n < 2) return;
    const rows = sheet.getRange(2, 1, n - 1, 10).getValues();
    const known = new Map();
    for (const row of rows) if (row[5] === 'Có tọa độ') known.set(row[2], row.slice(3, 7));
    const geo = Maps.newGeocoder().setRegion('vn').setLanguage('vi');
    const deadline = Date.now() + 240000;
    for (const [i, row] of rows.entries()) {
      if (Date.now() > deadline) break;
      if (row[5] !== 'Chờ định vị') continue;
      let value = known.get(row[2]);
      if (!value) {
        Utilities.sleep(1100);
        const r = geo.geocode(String(row[2]));
        if (!['OK', 'ZERO_RESULTS'].includes(r.status)) { console.log(r.status); break; }
        const m = r.results?.[0];
        const p = m?.geometry?.location;
        const valid = p && inVietnam_(m);
        value = valid
          ? [p.lat, p.lng, (m.partial_match || r.results.length > 1) ? 'Cần rà tọa độ' : 'Có tọa độ', m.formatted_address]
          : ['', '', 'Cần xác định điểm', ''];
        known.set(row[2], value);
      }
      sheet.getRange(i + 2, 4, 1, 4).setValues([value]);
    }
    SpreadsheetApp.flush();
    const summary = sheet.getRange(2, 6, n - 1, 1).getValues().flat()
      .reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {});
    console.log(JSON.stringify(summary));
  } finally {
    lock.releaseLock();
    clearCache_();
  }
}

/**
 * Kiểm tra cấu hình: SHEET_ID, các sheet, bố cục bảng cước, MAPS_API_KEY.
 * Chạy tay sau khi cài đặt hoặc khi sửa bảng cước.
 */
function kiemTraCauHinh() {
  adminOnly_();
  clearCache_();
  const report = [];
  const db = openDb_();
  for (const hub of Object.keys(HUBS)) {
    try {
      const {keys} = data_(hub);
      const routes = catalog(hub, 'LCL', '').routes.length;
      report.push(hub + ': phương tiện [' + keys.filter(Boolean).join(', ') + '], ' + routes + ' tuyến LCL');
    } catch (e) {
      report.push(hub + ': LỖI ' + e.message);
    }
  }
  for (const name of Object.values(SHEETS)) report.push('Sheet "' + name + '": ' + (db.getSheetByName(name) ? 'có' : 'không có'));
  report.push('Điểm tham chiếu có tọa độ: ' + referencePoints_().length);
  report.push('MAPS_API_KEY: ' + (mapsApiKey_() ? 'đã cấu hình (Places + Routes API)' : 'chưa có (dùng Geocoder có sẵn)'));
  report.push('Cấu hình: ' + JSON.stringify(appConfig_()));
  console.log(report.join('\n'));
  return report;
}
