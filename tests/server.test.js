'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createGas, fixtures} = require('./harness');

const HAN = 'HAN';
const row = (gas, hub, label) => gas.call('catalog', hub, 'LCL', '').routes.find(r => r[1] === label)[0];

test('parseVehicleKey_: phân biệt xe tải và container', () => {
  const gas = createGas({sheets: fixtures()});
  const k = h => gas.run('parseVehicleKey_')(h);
  assert.equal(k('1.25 tấn'), '1.25');
  assert.equal(k('1,25'), '1.25');
  assert.equal(k('5T'), '5');
  assert.equal(k('20 tấn'), '20');
  assert.equal(k('20'), 'C20');
  assert.equal(k("20'DC"), 'C20');
  assert.equal(k("40'HC"), 'C40');
  assert.equal(k('Cont 40'), 'C40');
  assert.equal(k('Ghi chú'), '');
  // Tiêu đề thật trong sheet: container kèm giới hạn tải, xe tải dạng "xe 1.25T".
  assert.equal(k('20’ <20 t'), 'C20');
  assert.equal(k('40’ <25 t'), 'C40');
  assert.equal(k('20’ <17 t'), 'C20');
  assert.equal(k('xe 1.25T'), '1.25');
  assert.equal(k('Xe 2,5T'), '2.5');
  assert.equal(k('1 T'), '1');
  assert.equal(k('10T'), '10');
});

test('catalog: LCL chỉ lấy tuyến có giá xe tải, FCL theo container', () => {
  const gas = createGas({sheets: fixtures()});
  const lcl = gas.call('catalog', HAN, 'LCL', '').routes.map(r => r[1]);
  assert.deepEqual(lcl, ['TP Hà Nội · Long Biên', 'TP Hà Nội · Gia Lâm', 'Hưng Yên · KCN Phố Nối A, Yên Mỹ', 'Bắc Ninh · KCN Quế Võ']);
  const c40 = gas.call('catalog', HAN, 'FCL', 'C40').routes.map(r => r[1]);
  assert.ok(!c40.includes('Hưng Yên · KCN Phố Nối A, Yên Mỹ'));
  assert.ok(c40.includes('Hưng Yên · Văn Lâm'));
});

test('FCL: giá × số cont × (1+FSC), có chi tiết', () => {
  const gas = createGas({sheets: fixtures()});
  const q = gas.call('quoteCargo', HAN, 5, 'C20', 2, 10, '', 0);
  assert.equal(q.base, 8000000);
  assert.equal(q.fsc, 10);
  assert.equal(q.fscAmount, 800000);
  assert.equal(q.total, 8800000);
  assert.equal(q.route, 'TP Hà Nội · Long Biên');
  assert.deepEqual(q.lines.map(l => [l.key, l.qty, l.rate]), [['C20', 2, 4000000]]);
});

test('Làm tròn: mặc định làm tròn LÊN 100.000 đ', () => {
  const gas = createGas({sheets: fixtures()});
  // 940.000 × 1 × (1 + 10%) = 1.034.000 → 1.100.000
  const q = gas.call('quoteCargo', HAN, row(gas, HAN, 'Bắc Ninh · KCN Quế Võ'), 'C20', 1, 0, '', 0);
  assert.equal(q.total, 3900000);
  const r = gas.call('quoteCargo', HAN, 9, 'LCL', 1, 10, '100x100x100', 100);
  assert.equal(r.subtotal, 1034000);
  assert.equal(r.total, 1100000);
  assert.equal(r.rounding.mode, 'lên');
});

test('Làm tròn: cấu hình được qua sheet "Cấu hình"', () => {
  const sheets = fixtures();
  sheets['Cấu hình'] = [['Kiểu làm tròn', 'gần nhất'], ['Bước làm tròn (đ)', 100000], ['FSC mặc định (%)', 12], ['Ghi chú báo giá', 'Chưa gồm VAT']];
  const gas = createGas({sheets});
  const r = gas.call('quoteCargo', HAN, 9, 'LCL', 1, 10, '100x100x100', 100);
  assert.equal(r.total, 1000000);
  assert.equal(r.note, 'Chưa gồm VAT');
  assert.equal(gas.call('appInfo').defaultFsc, 12);
});

test('Hải Phòng: FSC áp dụng = FSC × 1,75', () => {
  const gas = createGas({sheets: fixtures()});
  const q = gas.call('quoteCargo', 'HPH', 4, 'C20', 1, 12, '', 0);
  assert.equal(q.fsc, 21);
  assert.equal(q.fscMultiplier, 1.75);
  assert.equal(q.fscAmount, 735000);           // 3.500.000 × 21%
  assert.equal(q.total, 4300000);              // 4.235.000 → lên 4.300.000
  const p = gas.call('price', 'HPH', 4, 'C20', 1, 10.3);
  assert.equal(p.fsc, 18.025);
});

test('LCL: ghép nhiều loại xe khi rẻ hơn', () => {
  const gas = createGas({sheets: fixtures()});
  // Kiện 100×100×100, 200 kg. Số kiện/xe: 1.25T = 3 (1,0tr), 2.5T = 4 (1,5tr), 5T = 5 (2,5tr), 8T = 12 (3,5tr).
  // 14 kiện: cách cũ (một loại xe) rẻ nhất là 2 xe 8T = 7,0tr hoặc 4 xe 2.5T = 6,0tr hoặc 5 xe 1.25T = 5,0tr.
  // Ghép: 1 xe 8T + 1 xe 1.25T = 4,5tr.
  const q = gas.call('quoteCargo', HAN, 5, 'LCL', 14, 0, '100x100x100', 200);
  assert.equal(q.base, 4500000);
  assert.deepEqual(q.lines.map(l => [l.key, l.qty, l.perTruck]), [['8', 1, 12], ['1.25', 1, 3]]);
  assert.match(q.vehicle, /1 xe 8 tấn \+ 1 xe 1.25 tấn/);
  // 12 kiện vừa 1 xe 8T
  assert.deepEqual(gas.call('quoteCargo', HAN, 5, 'LCL', 12, 0, '100x100x100', 200).lines.map(l => [l.key, l.qty]), [['8', 1]]);
});

test('LCL: xếp chồng tăng số kiện mỗi xe; tải trọng vẫn giới hạn', () => {
  const gas = createGas({sheets: fixtures()});
  const flat = gas.call('quoteCargo', HAN, 5, 'LCL', 24, 0, '100x100x100', 200);
  const stacked = gas.call('quoteCargo', HAN, 5, 'LCL', 24, 0, '100x100x100', 200, {stack: true});
  assert.ok(stacked.base < flat.base);
  assert.deepEqual(stacked.lines.map(l => [l.key, l.qty, l.perTruck]), [['8', 1, 24]]);
  const heavy = gas.call('quoteCargo', HAN, 5, 'LCL', 24, 0, '100x100x100', 1000, {stack: true});
  assert.equal(heavy.lines.find(l => l.key === '8')?.perTruck ?? 7, 7);   // 7500 kg / 1000 kg
});

test('LCL: lật kiện cho phép kiện cao hơn thùng xe', () => {
  const gas = createGas({sheets: fixtures()});
  assert.throws(() => gas.call('quoteCargo', HAN, 5, 'LCL', 1, 0, '100x100x240', 100), /vượt/);
  const q = gas.call('quoteCargo', HAN, 5, 'LCL', 1, 0, '100x100x240', 100, {tilt: true});
  assert.equal(q.lines[0].qty, 1);
});

test('Kiểm tra đầu vào', () => {
  const gas = createGas({sheets: fixtures()});
  assert.throws(() => gas.call('quoteCargo', HAN, 5, 'C20', 0, 10, '', 0), /Số lượng/);
  assert.throws(() => gas.call('quoteCargo', HAN, 5, 'C20', 1, -1, '', 0), /FSC/);
  assert.throws(() => gas.call('quoteCargo', HAN, 2, 'C20', 1, 0, '', 0), /Chọn tuyến/);
  assert.throws(() => gas.call('quoteCargo', HAN, 5, 'LCL', 1, 0, '100x100', 10), /D×R×C/);
  assert.throws(() => gas.call('quoteCargo', HAN, 7, 'C40', 1, 0, '', 0), /hỏi giá/);
  assert.throws(() => gas.call('quoteCargo', 'XYZ', 5, 'C20', 1, 0, '', 0), /Đầu tuyến/);
});

test('Thiếu SHEET_ID: báo lỗi rõ ràng', () => {
  const gas = createGas({sheets: fixtures(), props: {SHEET_ID: null}});
  assert.throws(() => gas.call('catalog', HAN, 'LCL', ''), /SHEET_ID/);
});

test('Cache: lần thực thi sau không đọc lại sheet', () => {
  const gas = createGas({sheets: fixtures()});
  gas.call('catalog', HAN, 'LCL', '');
  gas.call('lookupAddress', HAN, 'LCL', '', 'Phường Mỹ Hào, Tỉnh Hưng Yên');
  const reads = gas.sheets.HAN.reads + gas.sheets['Xã cũ - mới'].reads;
  gas.newExecution();
  gas.call('catalog', HAN, 'LCL', '');
  gas.call('lookupAddress', HAN, 'LCL', '', 'Phường Mỹ Hào, Tỉnh Hưng Yên');
  assert.equal(gas.sheets.HAN.reads + gas.sheets['Xã cũ - mới'].reads, reads);
  gas.run('clearCache_')();
  gas.newExecution();
  gas.call('catalog', HAN, 'LCL', '');
  assert.ok(gas.sheets.HAN.reads > 1);
});

test('Cache: dữ liệu lớn được chia mảnh', () => {
  const sheets = fixtures();
  for (let i = 0; i < 4000; i++) sheets['Xã cũ - mới'].push([i, 'Tỉnh Thử Nghiệm Dài Tên', '', 'Huyện Số ' + i, '', 'Xã Thử Số ' + i, '', 'Tỉnh Thử Nghiệm Dài Tên', '', 'Phường Mới Số ' + i]);
  const gas = createGas({sheets});
  const first = gas.call('lookupAddress', HAN, 'LCL', '', 'Phường Mỹ Hào, Hưng Yên');
  gas.newExecution();
  const reads = gas.sheets['Xã cũ - mới'].reads;
  const second = gas.call('lookupAddress', HAN, 'LCL', '', 'Phường Mỹ Hào, Hưng Yên');
  assert.deepEqual(second, first);
  assert.equal(gas.sheets['Xã cũ - mới'].reads, reads);
  assert.ok([...gas.cache.store.keys()].some(k => k.startsWith('wards#')));
});

test('lookupAddress: đối chiếu xã mới → tuyến cũ, có dấu hoặc không dấu', () => {
  const gas = createGas({sheets: fixtures()});
  const label = r => r.map(x => x[1]);
  assert.deepEqual(label(gas.call('lookupAddress', HAN, 'LCL', '', 'Phường Mỹ Hào, tỉnh Hưng Yên')), ['Hưng Yên · KCN Phố Nối A, Yên Mỹ']);
  assert.deepEqual(label(gas.call('lookupAddress', HAN, 'LCL', '', 'phuong my hao hung yen')), ['Hưng Yên · KCN Phố Nối A, Yên Mỹ']);
  assert.deepEqual(label(gas.call('lookupAddress', 'HCM', 'LCL', '', 'Phường Vĩnh Tân, TP Hồ Chí Minh')), ['Bình Dương · KCN Nam Tân Uyên mở rộng']);
});

test('restoreDiacritics_: thêm dấu cho địa chỉ gõ không dấu', () => {
  const gas = createGas({sheets: fixtures()});
  const r = gas.run('restoreDiacritics_');
  assert.equal(r('kcn pho noi, yen my, hung yen'), 'KCN Phố Nối, Yên Mỹ, Hưng Yên');
  assert.equal(r('phuong vinh tan, tp hcm'), 'Phường Vĩnh Tân, Hồ Chí Minh');
  assert.equal(r('Phố Nối, Hưng Yên'), 'Phố Nối, Hưng Yên');   // đã có dấu → giữ nguyên
  assert.equal(r('so 12 abc xyz'), 'Số 12 abc xyz');
});

const geoResult = (address, lat, lng, type = 'ROOFTOP') => ({
  place_id: 'pid-' + address.length + '-' + lat, formatted_address: address,
  geometry: {location: {lat, lng}, location_type: type}, address_components: [{types: ['country'], short_name: 'VN'}],
});

test('suggestAddresses (không key): Geocoder + thêm dấu, cache theo câu tra', () => {
  const gas = createGas({
    sheets: fixtures(),
    geocode: q => (q.startsWith('KCN Phố Nối')
      ? {status: 'OK', results: [geoResult('KCN Phố Nối A, Yên Mỹ, Hưng Yên, Việt Nam', 20.93, 106.05, 'APPROXIMATE')]}
      : {status: 'ZERO_RESULTS', results: []}),
  });
  const s = gas.call('suggestAddresses', 'kcn pho noi, yen my, hung yen', HAN, 't1');
  assert.equal(s.source, 'geocoder');
  assert.equal(s.query, 'KCN Phố Nối, Yên Mỹ, Hưng Yên');
  assert.equal(s.suggestions.length, 1);
  assert.equal(s.suggestions[0].main, 'KCN Phố Nối A');
  assert.equal(s.suggestions[0].precise, false);
  assert.deepEqual(gas.log.geocode, ['KCN Phố Nối, Yên Mỹ, Hưng Yên, Việt Nam', 'kcn pho noi, yen my, hung yen, Việt Nam']);
  gas.call('suggestAddresses', 'kcn pho noi, yen my, hung yen', HAN, 't1');
  assert.equal(gas.log.geocode.length, 2);
});

test('suggestAddresses: nhập tọa độ trả về đúng điểm, không gọi Google', () => {
  const gas = createGas({sheets: fixtures()});
  const s = gas.call('suggestAddresses', '20.93, 106.05', HAN, '');
  assert.equal(s.source, 'coords');
  assert.equal(s.suggestions[0].lat, 20.93);
  assert.equal(gas.log.geocode.length + gas.log.fetch.length, 0);
  assert.throws(() => gas.call('suggestAddresses', '200, 106', HAN, ''), /Tọa độ/);
});

function placesMock(url, options) {
  if (url.endsWith('places:autocomplete')) {
    const body = JSON.parse(options.payload);
    if (!body.input.toLowerCase().includes('pho noi') && !body.input.includes('Phố Nối')) return {code: 200, body: {}};
    return {code: 200, body: {suggestions: [
      {placePrediction: {placeId: 'ChIJ_phonoi_A', text: {text: 'KCN Phố Nối A, Yên Mỹ, Hưng Yên, Việt Nam'},
        structuredFormat: {mainText: {text: 'KCN Phố Nối A'}, secondaryText: {text: 'Yên Mỹ, Hưng Yên, Việt Nam'}}}},
      {placePrediction: {placeId: 'ChIJ_phonoi_B', text: {text: 'KCN Phố Nối B, Mỹ Hào, Hưng Yên, Việt Nam'},
        structuredFormat: {mainText: {text: 'KCN Phố Nối B'}, secondaryText: {text: 'Mỹ Hào, Hưng Yên, Việt Nam'}}}},
      {queryPrediction: {text: {text: 'pho noi'}}},
    ]}};
  }
  if (url.startsWith('https://places.googleapis.com/v1/places/ChIJ_phonoi_A')) {
    return {code: 200, body: {id: 'ChIJ_phonoi_A', formattedAddress: 'KCN Phố Nối A, Yên Mỹ, Hưng Yên', location: {latitude: 20.9301, longitude: 106.0499}}};
  }
  if (url.includes('computeRouteMatrix')) {
    const body = JSON.parse(options.payload);
    return {code: 200, body: body.destinations.map((d, i) => {
      const {latitude, longitude} = d.waypoint.location.latLng;
      const o = body.origins[0].waypoint.location.latLng;
      const meters = Math.round(Math.hypot(latitude - o.latitude, longitude - o.longitude) * 111000 * 1.3);
      return {originIndex: 0, destinationIndex: i, distanceMeters: meters, condition: 'ROUTE_EXISTS'};
    })};
  }
  return {code: 404, body: 'not found'};
}

test('Có MAPS_API_KEY: gợi ý Places Autocomplete → tọa độ → tuyến gần nhất (1 lần gọi Routes)', () => {
  const gas = createGas({sheets: fixtures(), props: {MAPS_API_KEY: 'k'}, fetch: placesMock});
  const s = gas.call('suggestAddresses', 'kcn pho noi', HAN, 'session-1');
  assert.equal(s.source, 'places');
  assert.deepEqual(s.suggestions.map(x => x.main), ['KCN Phố Nối A', 'KCN Phố Nối B']);
  const ac = JSON.parse(gas.log.fetch[0].options.payload);
  assert.equal(ac.sessionToken, 'session-1');
  assert.deepEqual(ac.includedRegionCodes, ['vn']);
  assert.equal(gas.log.fetch[0].options.headers['X-Goog-Api-Key'], 'k');

  const place = gas.call('resolvePlace', 'ChIJ_phonoi_A', 'session-1');
  assert.equal(place.lat, 20.9301);
  assert.match(gas.log.fetch.at(-1).url, /sessionToken=session-1/);

  const before = gas.log.fetch.length;
  const near = gas.call('nearbyRoutes', HAN, 'LCL', '', place);
  assert.equal(gas.log.fetch.length - before, 1);          // một lần computeRouteMatrix
  assert.equal(gas.log.directions.length, 0);
  assert.equal(near.routes[0].name, 'Hưng Yên · KCN Phố Nối A, Yên Mỹ');
  assert.ok(near.routes[0].km < 1);
  // KCN Quế Võ chưa "Có tọa độ" nên không được dùng; Long Biên ~24 km chim bay vẫn được đo.
  assert.ok(!near.routes.some(r => r.name.includes('Quế Võ')));

  gas.call('nearbyRoutes', HAN, 'LCL', '', place);
  assert.equal(gas.log.fetch.length - before, 1);          // lần 2 lấy từ cache
});

test('nearbyRoutes (không key): DirectionFinder, mỗi tuyến chỉ đo điểm gần nhất', () => {
  const gas = createGas({
    sheets: fixtures(),
    directions: (o, d) => Math.round(Math.hypot(d.lat - o.lat, d.lng - o.lng) * 111000 * 1.3),
    geocode: () => ({status: 'OK', results: [geoResult('Trâu Quỳ, Gia Lâm, Hà Nội, Việt Nam', 21.006, 105.936)]}),
  });
  const near = gas.call('nearbyRoutes', HAN, 'LCL', '', 'trau quy, gia lam');
  assert.equal(near.routes[0].name, 'TP Hà Nội · Gia Lâm');
  // Gia Lâm có 2 điểm tham chiếu nhưng chỉ đo 1; Long Biên + Gia Lâm + Phố Nối (≈ 12 km chim bay)
  assert.equal(gas.log.directions.length, 3);
  assert.ok(!near.message.includes('ước tính'));
});

test('nearbyRoutes: báo khi không có tuyến gần, không gọi đo đường', () => {
  const gas = createGas({sheets: fixtures()});
  const near = gas.call('nearbyRoutes', HAN, 'LCL', '', {lat: 10.77, lng: 106.70, text: 'Quận 1'});
  assert.equal(near.routes.length, 0);
  assert.match(near.message, /hỏi giá/);
  assert.equal(gas.log.directions.length, 0);
});

test('Routes API lỗi → tự chuyển sang DirectionFinder', () => {
  const gas = createGas({
    sheets: fixtures(), props: {MAPS_API_KEY: 'k'},
    fetch: () => ({code: 403, body: 'API not enabled'}),
    directions: () => 5000,
  });
  const near = gas.call('nearbyRoutes', HAN, 'LCL', '', {lat: 21.02, lng: 105.93, text: 'x'});
  assert.ok(near.routes.length > 0);
  assert.ok(gas.log.directions.length > 0);
});

test('Hàm quản trị chặn người dùng web app', () => {
  const gas = createGas({sheets: fixtures(), session: {active: ''}});
  assert.throws(() => gas.call('xoaCache'), /chủ script/);
  assert.throws(() => gas.call('dinhViToanBo'), /chủ script/);
  assert.throws(() => gas.call('kiemTraCauHinh'), /chủ script/);
  const owner = createGas({sheets: fixtures()});
  const report = owner.call('kiemTraCauHinh');
  assert.ok(report.some(l => l.startsWith('HAN: phương tiện [1.25, 2.5, 5, 8, C20, C40]')));
});

test('dinhViToanBo: định vị các dòng "Chờ định vị"', () => {
  const sheets = fixtures();
  sheets['Điểm tham chiếu'].push(['HAN', 'Văn Lâm', 'Văn Lâm, Hưng Yên', '', '', 'Chờ định vị', '', 'Hưng Yên', '', '']);
  const gas = createGas({sheets, geocode: () => ({status: 'OK', results: [geoResult('Văn Lâm, Hưng Yên, Việt Nam', 20.98, 106.03)]})});
  gas.call('dinhViToanBo');
  const last = gas.sheets['Điểm tham chiếu'].data.at(-1);
  assert.deepEqual(last.slice(3, 7), [20.98, 106.03, 'Có tọa độ', 'Văn Lâm, Hưng Yên, Việt Nam']);
});
