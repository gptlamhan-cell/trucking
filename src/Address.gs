/**
 * Tra địa chỉ:
 *   - normalizeText_: bỏ dấu, chữ thường, để so khớp có dấu / không dấu.
 *   - lookupAddress: đối chiếu địa danh mới (sau sáp nhập) với tuyến trong bảng cước
 *     qua sheet "Xã cũ - mới".
 *   - restoreDiacritics_: thêm lại dấu cho địa danh gõ không dấu (dùng từ điển từ
 *     sheet "Xã cũ - mới") để Google Maps nhận diện tốt hơn.
 */

function normalizeText_(s) {
  return String(s === null || s === undefined ? '' : s).toLowerCase()
    .replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\btp\b/g, 'thanh pho').trim();
}

const ADMIN_PREFIX_ = /^(thanh pho|tinh|quan|huyen|thi xa|thi tran|phuong|xa|dac khu) /;
function bareName_(s) {
  return s.replace(ADMIN_PREFIX_, '');
}

function hasWords_(text, part) {
  return Boolean(part) && (' ' + text + ' ').includes(' ' + part + ' ');
}

function hasDiacritics_(s) {
  return /[đĐ]/.test(s) || /[̀-ͯ]/.test(String(s).normalize('NFD'));
}

/** Từ thông dụng trong địa chỉ (bổ sung cho từ điển địa danh). */
const COMMON_WORDS_ = {
  'thanh pho': 'Thành phố', 'tinh': 'Tỉnh', 'quan': 'Quận', 'huyen': 'Huyện', 'thi xa': 'Thị xã',
  'thi tran': 'Thị trấn', 'phuong': 'Phường', 'xa': 'Xã', 'dac khu': 'Đặc khu', 'duong': 'Đường',
  'khu cong nghiep': 'Khu công nghiệp', 'kcn': 'KCN', 'cum cong nghiep': 'Cụm công nghiệp', 'ccn': 'CCN',
  'thon': 'Thôn', 'ap': 'Ấp', 'khu pho': 'Khu phố', 'to dan pho': 'Tổ dân phố', 'ngo': 'Ngõ', 'hem': 'Hẻm',
  'so': 'Số', 'viet nam': 'Việt Nam', 'ha noi': 'Hà Nội', 'hai phong': 'Hải Phòng', 'ho chi minh': 'Hồ Chí Minh',
};

/**
 * Bảng "Xã cũ - mới" đã chuẩn hóa (cache):
 *   entries: [tỉnh cũ, huyện, xã cũ, tỉnh mới, xã mới] (không dấu, bỏ tiền tố hành chính trừ xã mới/tỉnh mới)
 *   names:   từ điển không dấu → có dấu (để thêm dấu cho câu tra)
 */
function wardTable_() {
  return cached_('wards', CACHE_TTL.sheet, () => {
    const sheet = openDb_().getSheetByName(SHEETS.WARDS);
    if (!sheet || sheet.getLastRow() < 2) return {entries: [], names: {}};
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getDisplayValues();
    const entries = [];
    const votes = {};
    for (const row of rows) {
      const raw = [1, 3, 5, 7, 9].map(i => String(row[i] || '').trim());
      const norm = raw.map(normalizeText_);
      entries.push([bareName_(norm[0]), bareName_(norm[1]), bareName_(norm[2]), norm[3], norm[4]]);
      for (const name of raw) {
        if (!name || !hasDiacritics_(name)) continue;
        const bare = name.replace(/^(Thành phố|Tỉnh|Quận|Huyện|Thị xã|Thị trấn|Phường|Xã|Đặc khu)\s+/i, '');
        const key = normalizeText_(bare);
        if (!key || /^\d+$/.test(key)) continue;
        const bucket = votes[key] || (votes[key] = {});
        bucket[bare] = (bucket[bare] || 0) + 1;
      }
    }
    const names = {};
    for (const key in votes) {
      names[key] = Object.keys(votes[key]).sort((a, b) => votes[key][b] - votes[key][a])[0];
    }
    return {entries, names};
  });
}

/**
 * Thêm dấu cho câu tra không dấu bằng từ điển địa danh, ví dụ
 * "kcn pho noi, yen my, hung yen" → "KCN Phố Nối, Yên Mỹ, Hưng Yên".
 * Câu đã có dấu được giữ nguyên.
 */
function restoreDiacritics_(query) {
  const text = String(query || '');
  if (!text.trim() || hasDiacritics_(text)) return text;
  const names = wardTable_().names;
  const lookup = key => COMMON_WORDS_[key] || names[key];
  return text.split(',').map(segment => {
    const words = normalizeText_(segment.replace(/\btp\.?\s*hcm\b/ig, 'ho chi minh')).split(' ').filter(Boolean);
    const out = [];
    for (let i = 0; i < words.length;) {
      let matched = 0;
      for (let len = Math.min(5, words.length - i); len >= 1; len--) {
        const found = lookup(words.slice(i, i + len).join(' '));
        if (found) { out.push(found); matched = len; break; }
      }
      if (!matched) { out.push(words[i]); matched = 1; }
      i += matched;
    }
    return out.join(' ');
  }).filter(Boolean).join(', ');
}

/**
 * Đối chiếu địa danh mới (sau sáp nhập) trong câu tra với tên tuyến cũ trong bảng cước.
 * Trả về tối đa 8 tuyến [dòng, nhãn] xếp theo độ khớp.
 */
function lookupAddress(hub, mode, container, query) {
  const q = normalizeText_(String(query).slice(0, 500));
  if (q.length < 3) return [];
  const routes = catalog(hub, mode, container).routes.map(row => [row, normalizeText_(row[1])]);
  const scores = new Map();
  const rank = (predicate, score) => {
    for (const [row, name] of routes) if (predicate(name)) scores.set(row, Math.max(score, scores.get(row) || 0));
  };
  if (hub === 'HCM' && hasWords_(q, 'phuong vinh tan') && hasWords_(q, 'ho chi minh')) {
    rank(name => hasWords_(name, 'nam tan uyen') && hasWords_(name, 'binh duong'), 100);
  }
  for (const [p, d, w, newProvince, newWard] of wardTable_().entries) {
    if (!hasWords_(q, newWard) || !hasWords_(q, bareName_(newProvince))) continue;
    if (w.length > 3) rank(name => hasWords_(name, p) && hasWords_(name, w), 80);
    if (d.length > 3) rank(name => hasWords_(name, p) && hasWords_(name, d), 55);
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([row]) => row);
}
