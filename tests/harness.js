/**
 * Giả lập môi trường Google Apps Script để chạy src/*.gs bằng Node.
 * Chỉ dùng cho test, không đẩy lên Apps Script (clasp chỉ đẩy thư mục src/).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');

function makeSheet(name, rows) {
  const width = Math.max(1, ...rows.map(r => r.length));
  const data = rows.map(r => Array.from({length: width}, (_, i) => (r[i] === undefined ? '' : r[i])));
  const sheet = {
    name, data, reads: 0,
    getName: () => name,
    getLastRow: () => data.length,
    getRange(row, col, numRows = 1, numCols = 1) {
      if (typeof row === 'string') throw Error('A1 notation not mocked');
      const slice = () => Array.from({length: numRows}, (_, i) =>
        Array.from({length: numCols}, (_, j) => (data[row - 1 + i] || [])[col - 1 + j] ?? ''));
      return {
        getValues: () => { sheet.reads++; return slice(); },
        getDisplayValues: () => { sheet.reads++; return slice().map(r => r.map(v => String(v))); },
        setValues(values) {
          values.forEach((r, i) => r.forEach((v, j) => {
            while (data.length < row + i) data.push(Array(width).fill(''));
            data[row - 1 + i][col - 1 + j] = v;
          }));
        },
      };
    },
  };
  return sheet;
}

function makeCache(log) {
  const store = new Map();
  const check = (k, v) => {
    if (k.length > 250) throw Error('cache key too long: ' + k.length);
    if (Buffer.byteLength(v, 'utf8') > 100 * 1024) throw Error('Argument too large: value');
  };
  return {
    store,
    get: k => (store.has(k) ? store.get(k) : null),
    getAll: keys => Object.fromEntries(keys.filter(k => store.has(k)).map(k => [k, store.get(k)])),
    put: (k, v) => { check(k, v); store.set(k, v); log.cachePuts++; },
    putAll: obj => { for (const [k, v] of Object.entries(obj)) { check(k, v); store.set(k, v); } log.cachePuts++; },
    removeAll: keys => keys.forEach(k => store.delete(k)),
  };
}

/**
 * Tạo môi trường GAS giả lập.
 * opts.sheets: {tên: rows}, opts.props: script properties,
 * opts.geocode(query) → {status, results}, opts.directions(origin, dest) → meters,
 * opts.fetch(url, options) → {code, body}.
 */
function createGas(opts = {}) {
  const log = {openById: 0, geocode: [], directions: [], fetch: [], cachePuts: 0};
  const sheets = Object.fromEntries(Object.entries(opts.sheets || {}).map(([n, rows]) => [n, makeSheet(n, rows)]));
  const cache = makeCache(log);
  const props = Object.assign({SHEET_ID: 'test-sheet'}, opts.props || {});
  const session = Object.assign({active: 'owner@example.com', owner: 'owner@example.com'}, opts.session || {});

  const geocoder = () => {
    const g = {
      setRegion: () => g, setLanguage: () => g,
      geocode: q => { log.geocode.push(q); return (opts.geocode || (() => ({status: 'ZERO_RESULTS', results: []})))(q); },
    };
    return g;
  };
  const directionFinder = () => {
    const d = {o: null, dest: null,
      setOrigin: (lat, lng) => { d.o = {lat, lng}; return d; },
      setDestination: (lat, lng) => { d.dest = typeof lat === 'number' ? {lat, lng} : lat; return d; },
      setRegion: () => d, setMode: () => d,
      getDirections: () => {
        log.directions.push(d.dest);
        const meters = (opts.directions || (() => null))(d.o, d.dest);
        return {routes: meters === null ? [] : [{legs: [{distance: {value: meters}}]}]};
      },
    };
    return d;
  };

  const context = {
    console: {log: () => {}, warn: () => {}, error: console.error},
    JSON, Math, Date, Number, String, Boolean, Array, Object, Map, Set, Error, RegExp, Promise, Symbol, Infinity, NaN,
    encodeURIComponent, isFinite, parseFloat, parseInt,
    SpreadsheetApp: {
      openById: id => {
        log.openById++;
        if (id !== props.SHEET_ID) throw Error('wrong sheet id');
        return {getSheetByName: n => sheets[n] || null};
      },
      flush: () => {},
    },
    CacheService: {getScriptCache: () => cache},
    PropertiesService: {getScriptProperties: () => ({getProperty: k => (k in props ? props[k] : null)})},
    Maps: {newGeocoder: geocoder, newDirectionFinder: directionFinder, DirectionFinder: {Mode: {DRIVING: 'driving'}}},
    UrlFetchApp: {
      fetch: (url, options) => {
        log.fetch.push({url, options});
        const res = (opts.fetch || (() => ({code: 500, body: 'no mock'})))(url, options);
        return {getResponseCode: () => res.code, getContentText: () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body))};
      },
    },
    Utilities: {
      DigestAlgorithm: {MD5: 'md5'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (alg, text) => [...crypto.createHash('md5').update(text, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => (b + 256) % 256)).toString('base64url'),
      sleep: () => {},
    },
    Session: {
      getActiveUser: () => ({getEmail: () => session.active}),
      getEffectiveUser: () => ({getEmail: () => session.owner}),
    },
    LockService: {getScriptLock: () => ({waitLock: () => {}, releaseLock: () => {}})},
    HtmlService: {},
  };
  vm.createContext(context);
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, {filename: file});
  }
  const run = code => vm.runInContext(code, context);
  return {
    run, log, sheets, cache, props,
    /** Mô phỏng một lần thực thi mới (xóa bộ nhớ trong, giữ CacheService). */
    newExecution: () => run('memo_.clear(); db_ = undefined;'),
    /** Gọi hàm server như google.script.run (đối số đi qua JSON). */
    call: (fn, ...args) => JSON.parse(JSON.stringify(run(fn)(...JSON.parse(JSON.stringify(args))) ?? null)),
  };
}

/** Bộ dữ liệu mẫu. */
function fixtures() {
  const header = ['Tỉnh', 'Tuyến', '1.25 tấn', '2.5 tấn', '5 tấn', '8 tấn', "20'DC", "40'HC", 'Ghi chú', ''];
  return {
    HAN: [
      ['BẢNG CƯỚC HAN'], header, [], [],
      ['TP Hà Nội', 'Long Biên', 1000000, 1500000, 2500000, 3500000, 4000000, 5000000],
      ['', 'Gia Lâm', 1100000, 1600000, 2600000, 3600000, 4100000, 5100000],
      ['Hưng Yên', 'KCN Phố Nối A, Yên Mỹ', 1300000, 1800000, 2800000, 3800000, 4300000, '', 'chỉ cont 20'],
      ['', 'Văn Lâm', '', '', '', '', 4500000, 5500000],
      ['Bắc Ninh', 'KCN Quế Võ', 940000, 1400000, 2400000, 3400000, 3900000, 4900000],
    ],
    HPH: [
      ['BẢNG CƯỚC HPH'], ['Tỉnh', 'Tuyến', '1.25', '2.5', '5', '8', '10', '15', '20', '40', '', ''], [],
      ['Hải Phòng', 'Kim Thành, Phú Thái', 900000, 1200000, 2000000, 3000000, 3300000, 4000000, 3500000, 4500000],
    ],
    HCM: [
      ['BẢNG CƯỚC HCM'], ['Tỉnh', 'Tuyến', '1', '2', '5', "Cont 20", "Cont 40"], [],
      ['Bình Dương', 'KCN Nam Tân Uyên mở rộng', 1000000, 1500000, 2500000, 3000000, 4000000],
    ],
    'Xã cũ - mới': [
      ['STT', 'Tỉnh cũ', 'x', 'Huyện cũ', 'x', 'Xã cũ', 'x', 'Tỉnh mới', 'x', 'Xã mới'],
      [1, 'Tỉnh Hưng Yên', '', 'Huyện Yên Mỹ', '', 'Thị trấn Phố Nối', '', 'Tỉnh Hưng Yên', '', 'Phường Mỹ Hào'],
      [2, 'Tỉnh Hưng Yên', '', 'Huyện Yên Mỹ', '', 'Xã Yên Mỹ', '', 'Tỉnh Hưng Yên', '', 'Xã Yên Mỹ'],
      [3, 'Tỉnh Bắc Ninh', '', 'Huyện Quế Võ', '', 'Xã Phương Liễu', '', 'Tỉnh Bắc Ninh', '', 'Phường Quế Võ'],
      [4, 'Tỉnh Bình Dương', '', 'Thị xã Tân Uyên', '', 'Xã Vĩnh Tân', '', 'Thành phố Hồ Chí Minh', '', 'Phường Vĩnh Tân'],
    ],
    'Điểm tham chiếu': [
      ['Đầu tuyến', 'Tên tuyến', 'Địa chỉ bản đồ', 'Vĩ độ', 'Kinh độ', 'Trạng thái', 'Google', 'Tỉnh', 'Điểm tách', 'Mã'],
      ['HAN', 'Long Biên', 'Long Biên, Hà Nội', 21.0365, 105.8890, 'Có tọa độ', '', 'TP Hà Nội', '', ''],
      ['HAN', 'Gia Lâm', 'Gia Lâm, Hà Nội', 21.0150, 105.9400, 'Có tọa độ', '', 'TP Hà Nội', '', ''],
      ['HAN', 'Gia Lâm', 'Trâu Quỳ, Gia Lâm', 21.0050, 105.9350, 'Có tọa độ', '', 'TP Hà Nội', '', ''],
      ['HAN', 'KCN Phố Nối A, Yên Mỹ', 'KCN Phố Nối A', 20.9300, 106.0500, 'Có tọa độ', '', 'Hưng Yên', '', ''],
      ['HAN', 'KCN Quế Võ', 'KCN Quế Võ', 21.1500, 106.1500, 'Cần rà tọa độ', '', 'Bắc Ninh', '', ''],
      ['HPH', 'Kim Thành, Phú Thái', 'Phú Thái', 20.9700, 106.5100, 'Có tọa độ', '', 'Hải Phòng', '', ''],
    ],
  };
}

module.exports = {createGas, fixtures, SRC};
