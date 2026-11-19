/** Web app: trả về giao diện tính cước. */
function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  let info, error = '';
  try {
    info = appInfo();
  } catch (e) {
    error = e.message;
    info = {hubs: Object.keys(HUBS).map(id => ({id, label: HUBS[id].label})), defaultFsc: null,
      hphMultiplier: HPH_FSC_MULTIPLIER, note: '', places: false};
  }
  template.info = info;
  template.infoJson = JSON.stringify(info).replace(/</g, '\\u003c');
  template.error = error;
  return template.evaluate()
    .setTitle('Tính cước trucking')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // Cho phép nhúng vào trang vỏ bọc (GitHub Pages) để tránh lỗi đăng nhập nhiều tài khoản Google.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * API JSON cho trang tĩnh (GitHub Pages). Trang gọi bằng fetch không kèm cookie,
 * nên người đăng nhập nhiều tài khoản Google vẫn dùng được.
 * Body: {"fn": "<tên hàm>", "args": [...]}. Chỉ cho gọi các hàm trong API_FUNCTIONS_.
 */
const API_FUNCTIONS_ = {appInfo, catalog, lookupAddress, suggestAddresses, resolvePlace, nearbyRoutes, quoteCargo};

function doPost(e) {
  let body;
  try {
    const request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = Object.prototype.hasOwnProperty.call(API_FUNCTIONS_, request.fn) && API_FUNCTIONS_[request.fn];
    if (!fn) throw Error('Hàm không hợp lệ: ' + request.fn);
    body = {ok: true, result: fn.apply(null, Array.isArray(request.args) ? request.args : [])};
  } catch (err) {
    body = {ok: false, error: err && err.message ? err.message : String(err)};
  }
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/** Chèn nội dung một file HTML khác vào template: <?!= include('Styles') ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
