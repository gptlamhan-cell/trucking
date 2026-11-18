/**
 * Đọc dữ liệu từ Google Sheet, có cache để giảm số lần mở sheet.
 * Sau khi sửa bảng cước/bảng xã, chạy xoaCache() để áp dụng ngay
 * (nếu không, cache tự hết hạn sau CACHE_TTL.sheet giây).
 */

const CACHE_CHUNK = 30000;   // ký tự / mảnh (giới hạn 100KB / giá trị)
const CACHE_MAX_CHUNKS = 60;
const memo_ = new Map();

/** Lấy giá trị từ cache (bộ nhớ → CacheService), nếu không có thì tính bằng compute(). */
function cached_(key, ttl, compute) {
  if (memo_.has(key)) return memo_.get(key);
  const cache = CacheService.getScriptCache();
  let value = cacheGet_(cache, key);
  if (value === undefined) {
    value = compute();
    cachePut_(cache, key, value, ttl);
  }
  memo_.set(key, value);
  return value;
}

function cacheGet_(cache, key) {
  try {
    const head = cache.get(key);
    if (head === null) return undefined;
    if (!head.startsWith('#')) return JSON.parse(head);
    const count = Number(head.slice(1));
    const keys = Array.from({length: count}, (_, i) => key + '#' + i);
    const parts = cache.getAll(keys);
    if (keys.some(k => typeof parts[k] !== 'string')) return undefined;
    return JSON.parse(keys.map(k => parts[k]).join(''));
  } catch (e) {
    return undefined;
  }
}

function cachePut_(cache, key, value, ttl) {
  try {
    const text = JSON.stringify(value);
    if (text.length <= CACHE_CHUNK) return cache.put(key, text, ttl);
    const count = Math.ceil(text.length / CACHE_CHUNK);
    if (count > CACHE_MAX_CHUNKS) return;
    const parts = {};
    for (let i = 0; i < count; i++) parts[key + '#' + i] = text.slice(i * CACHE_CHUNK, (i + 1) * CACHE_CHUNK);
    cache.putAll(parts, ttl);
    cache.put(key, '#' + count, ttl);
  } catch (e) {
    console.warn('Không ghi được cache ' + key + ': ' + e.message);
  }
}

/** Xóa cache dữ liệu sheet. Chạy tay sau khi sửa bảng cước, bảng xã, cấu hình. */
function xoaCache() {
  adminOnly_();
  clearCache_();
}

function clearCache_() {
  const cache = CacheService.getScriptCache();
  const keys = [];
  for (const key of ['config', 'vehicles', 'wards', 'points', ...Object.keys(HUBS).map(h => 'rates:' + h)]) {
    keys.push(key);
    for (let i = 0; i < CACHE_MAX_CHUNKS; i++) keys.push(key + '#' + i);
  }
  cache.removeAll(keys);
  memo_.clear();
}

/**
 * Chuyển tiêu đề cột phương tiện thành mã:
 *   "1.25 tấn" → "1.25", "20'DC" / "Cont 40" → "C20" / "C40".
 * Số 20/40 không kèm chữ "tấn"/"T" được hiểu là container (giữ như cũ).
 */
function parseVehicleKey_(header) {
  const text = String(header === null || header === undefined ? '' : header).trim();
  const match = text.match(/\d+(?:[.,]\d+)?/);
  if (!match) return '';
  const number = match[0].replace(',', '.');
  const isTon = /t[aấ]n\b|\d\s*t\b/i.test(text);
  const isContainer = /cont|['’′]|\bft\b|feet|\d\s*(dc|hc|gp|rf)\b|\b(dc|hc|gp|rf)\b/i.test(text) ||
    (!isTon && (Number(number) === 20 || Number(number) === 40));
  return (isContainer && !isTon ? 'C' : '') + number;
}

/** Bảng cước của một đầu tuyến: {rows, keys, first}. */
function data_(hub) {
  const layout = HUBS[hub];
  if (!layout) throw Error('Đầu tuyến không hợp lệ');
  return cached_('rates:' + hub, CACHE_TTL.sheet, () => {
    const sheet = openDb_().getSheetByName(hub);
    if (!sheet) throw Error('Không tìm thấy sheet ' + hub);
    const rows = sheet.getRange(1, 1, sheet.getLastRow(), layout.columns).getValues();
    const keys = (rows[1] || []).slice(2).map(parseVehicleKey_);
    if (rows.length < layout.firstRow || !keys.some(Boolean)) {
      throw Error('Bố cục sheet ' + hub + ' đã thay đổi: kiểm tra HUBS trong Config.gs (dòng tiêu đề phương tiện phải là dòng 2).');
    }
    return {rows, keys, first: layout.firstRow};
  });
}

/** Danh sách tuyến có giá cho chế độ (LCL/FCL) và loại container đang chọn. */
function catalog(hub, mode, container) {
  const {rows, keys, first} = data_(hub);
  const routes = [];
  let province = '';
  rows.forEach((r, i) => {
    if (i + 1 < first) return;
    province = r[0] || province;
    const priced = keys.some((k, j) =>
      (mode === 'FCL' ? k === container : k && !k.startsWith('C')) && typeof r[j + 2] === 'number' && r[j + 2] > 0);
    if (r[1] && priced) routes.push([i + 1, province + ' · ' + r[1]]);
  });
  return {routes, types: keys.filter(k => k && !k.startsWith('C'))};
}
