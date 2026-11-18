/**
 * Tính cước.
 *   FCL: giá container × số container × (1 + FSC).
 *   LCL: chọn tổ hợp xe rẻ nhất chở hết số kiện, rồi × (1 + FSC).
 *   Hải Phòng: FSC áp dụng = FSC nhập × HPH_FSC_MULTIPLIER.
 *   Tổng tiền làm tròn theo sheet "Cấu hình" (mặc định: lên 100.000 đ).
 */

const MAX_COUNT = 500;

function appliedFsc_(hub, fsc) {
  const value = hub === 'HPH' ? fsc * HPH_FSC_MULTIPLIER : fsc;
  return Math.round(value * 10000) / 10000;
}

function roundTotal_(amount) {
  const config = appConfig_();
  const step = Number(config['Bước làm tròn (đ)']) > 0 ? Number(config['Bước làm tròn (đ)']) : 1;
  const mode = normalizeText_(config['Kiểu làm tròn']);
  const fn = mode.startsWith('xuong') ? Math.floor : mode.startsWith('gan') ? Math.round : Math.ceil;
  return {total: fn(amount / step) * step, step, mode: fn === Math.floor ? 'xuống' : fn === Math.round ? 'gần nhất' : 'lên'};
}

function vehicleLabel_(key) {
  return key.startsWith('C') ? "Cont " + key.slice(1) + "'" : 'Xe ' + key + ' tấn';
}

function checkRow_(row, rows, first) {
  if (!Number.isInteger(row) || row < first || row > rows.length) throw Error('Chọn tuyến đối chiếu.');
}

function checkFsc_(fsc) {
  if (!Number.isFinite(fsc) || fsc < 0 || fsc > 200) throw Error('Nhập FSC (%) từ 0 đến 200.');
}

/**
 * Báo giá từ danh sách dòng [{key, qty}] trên một tuyến.
 * Trả về chi tiết: từng dòng, cước gốc, FSC, tổng trước/sau làm tròn.
 */
function quoteLines_(hub, row, lines, fsc) {
  const {rows, keys, first} = data_(hub);
  checkRow_(row, rows, first);
  checkFsc_(fsc);
  const detail = lines.map(({key, qty, perTruck}) => {
    const col = keys.indexOf(key);
    const rate = col < 0 ? null : rows[row - 1][col + 2];
    if (typeof rate !== 'number' || rate <= 0) throw Error('Cần hỏi giá cho tuyến và phương tiện này.');
    return {key, label: vehicleLabel_(key), qty, rate, amount: rate * qty, perTruck};
  });
  const base = detail.reduce((sum, line) => sum + line.amount, 0);
  const applied = appliedFsc_(hub, fsc);
  const fscAmount = Math.round(base * applied / 100);
  const subtotal = Math.round(base) + fscAmount;
  const rounded = roundTotal_(subtotal);
  let province = '';
  for (let i = first - 1; i < row; i++) province = rows[i][0] || province;
  return {
    route: province + ' · ' + rows[row - 1][1],
    hub,
    lines: detail,
    base: Math.round(base),
    fscInput: fsc,
    fsc: applied,
    fscMultiplier: hub === 'HPH' ? HPH_FSC_MULTIPLIER : 1,
    fscAmount,
    subtotal,
    total: rounded.total,
    rounding: {step: rounded.step, mode: rounded.mode},
    note: String(appConfig_()['Ghi chú báo giá'] || ''),
  };
}

/** Giữ lại để tương thích: báo giá một loại phương tiện × số lượng (chưa làm tròn bước). */
function price(hub, row, key, count, fsc) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) throw Error('Kiểm tra thông tin báo giá');
  const quote = quoteLines_(hub, row, [{key, qty: count}], fsc);
  return {total: quote.subtotal, fsc: quote.fsc};
}

/** Số kiện tối đa một xe chở được (theo kích thước và tải trọng). */
function truckCapacity_(spec, box, kg, options) {
  const [L, W, H, K] = spec;
  const [l, w, h] = box;
  const orientations = options.tilt
    ? [[l, w, h], [w, l, h], [l, h, w], [h, l, w], [w, h, l], [h, w, l]]
    : [[l, w, h], [w, l, h]];
  let best = 0;
  for (const [a, b, c] of orientations) {
    if (c > H) continue;
    const layers = options.stack ? Math.floor(H / c) : 1;
    best = Math.max(best, Math.floor(L / a) * Math.floor(W / b) * layers);
  }
  return Math.min(best, Math.floor(K / kg));
}

/**
 * Chọn tổ hợp xe rẻ nhất chở đủ `count` kiện (quy hoạch động, cho phép trộn loại xe).
 * candidates: [{key, rate, per}] — per = số kiện tối đa mỗi xe.
 * Hòa giá thì ưu tiên ít xe hơn.
 */
function planTrucks_(count, candidates) {
  const best = [{cost: 0, trucks: 0}];
  for (let n = 1; n <= count; n++) {
    let choice = null;
    for (const c of candidates) {
      const prev = best[Math.max(0, n - c.per)];
      const cost = prev.cost + c.rate, trucks = prev.trucks + 1;
      if (!choice || cost < choice.cost || (cost === choice.cost && trucks < choice.trucks)) {
        choice = {cost, trucks, key: c.key, from: Math.max(0, n - c.per)};
      }
    }
    best[n] = choice;
  }
  const counts = new Map();
  for (let n = count; n > 0; n = best[n].from) counts.set(best[n].key, (counts.get(best[n].key) || 0) + 1);
  return candidates
    .filter(c => counts.has(c.key))
    .map(c => ({key: c.key, qty: counts.get(c.key), perTruck: c.per}))
    .sort((a, b) => Number(b.key) - Number(a.key));
}

function parseDimensions_(dimensions) {
  const match = String(dimensions || '').trim()
    .match(/^(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)$/i);
  if (!match) return null;
  const box = match.slice(1).map(v => Number(v.replace(',', '.')));
  return Math.min(...box) > 0 ? box : null;
}

/**
 * Báo giá từ giao diện.
 * key: 'LCL' hoặc mã container ('C20', 'C40').
 * options (LCL): {stack: cho phép xếp chồng, tilt: cho phép lật kiện}.
 */
function quoteCargo(hub, row, key, count, fsc, dimensions, kg, options) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) {
    throw Error('Số lượng phải là số nguyên từ 1 đến ' + MAX_COUNT + '.');
  }
  checkFsc_(fsc);
  if (key !== 'LCL') return quoteLines_(hub, row, [{key, qty: count}], fsc);

  const box = parseDimensions_(dimensions);
  if (!box || !Number.isFinite(kg) || kg <= 0) throw Error('Nhập kích thước D×R×C (cm) và trọng lượng mỗi kiện (kg).');
  const opts = {stack: Boolean(options && options.stack), tilt: Boolean(options && options.tilt)};
  const {rows, keys, first} = data_(hub);
  checkRow_(row, rows, first);
  const specs = vehicleSpecs_();
  const candidates = [];
  keys.forEach((type, i) => {
    const spec = specs[type], rate = rows[row - 1][i + 2];
    if (!spec || typeof rate !== 'number' || rate <= 0) return;
    const per = truckCapacity_(spec, box, kg, opts);
    if (per >= 1) candidates.push({key: type, rate, per});
  });
  if (!candidates.length) throw Error('Kiện vượt tải hoặc vượt kích thước các xe có giá trên tuyến này.');
  const quote = quoteLines_(hub, row, planTrucks_(count, candidates), fsc);
  quote.vehicle = quote.lines.map(l => l.qty + ' xe ' + l.key + ' tấn').join(' + ') +
    (opts.stack ? ' (cho phép xếp chồng)' : ' (xếp một lớp)');
  quote.cargo = {count, box, kg, stack: opts.stack, tilt: opts.tilt};
  return quote;
}
