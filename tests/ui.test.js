'use strict';
/**
 * Chạy giao diện trong Chromium (Playwright), google.script.run được nối vào code server
 * chạy trong harness. Bỏ qua nếu máy không có Playwright.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {createGas, fixtures, SRC} = require('./harness');

let chromium;
try { ({chromium} = require('playwright')); } catch (e) { /* không có playwright */ }

/** Đánh giá template HtmlService (<? ?>, <?= ?>, <?!= ?>) đủ dùng cho test. */
function renderTemplate(name, vars) {
  const read = n => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  let code = 'let out = "";\n';
  const src = read(name);
  const re = /<\?(!?=)?([\s\S]*?)\?>/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    code += 'out += ' + JSON.stringify(src.slice(last, m.index)) + ';\n';
    if (m[1] === '=') code += 'out += esc(' + m[2] + ');\n';
    else if (m[1] === '!=') code += 'out += (' + m[2] + ');\n';
    else code += m[2] + '\n';
    last = re.lastIndex;
  }
  code += 'out += ' + JSON.stringify(src.slice(last)) + '; return out;';
  const include = n => read(n);
  return new Function('esc', 'include', ...Object.keys(vars), code)(esc, include, ...Object.values(vars));
}

const BRIDGE = `
window.google = {script: {get run() {
  let ok = () => {}, fail = () => {};
  const runner = new Proxy({}, {get(_, prop) {
    if (prop === 'withSuccessHandler') return f => { ok = f; return runner; };
    if (prop === 'withFailureHandler') return f => { fail = f; return runner; };
    return (...args) => { window.__gas(prop, JSON.stringify(args)).then(r => {
      const x = JSON.parse(r); setTimeout(() => x.error ? fail(new Error(x.error)) : ok(x.value), 20);
    }); };
  }});
  return runner;
}}};`;

async function openApp(gas) {
  const info = gas.call('appInfo');
  const html = renderTemplate('Index', {info, infoJson: JSON.stringify(info).replace(/</g, '\\u003c'), error: ''});
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 420, height: 900}});
  const errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => process.env.UI_DEBUG && console.log('[page]', m.text()));
  await page.exposeFunction('__gas', (fn, args) => {
    try { return JSON.stringify({value: gas.call(fn, ...JSON.parse(args))}); } catch (e) { return JSON.stringify({error: e.message}); }
  });
  try {
    await page.setContent(html.replace('<head>', '<head><script>' + BRIDGE + '</script>'));
    await page.waitForFunction(() => document.getElementById('o').textContent === '');
  } catch (e) {
    const state = await page.evaluate(() => document.getElementById('o').textContent).catch(() => '?');
    await browser.close();
    throw Error(e.message + ' | #o=' + state + ' | errors=' + errors.join('; '));
  }
  return {browser, page, errors};
}

test('Giao diện: gõ không dấu → gợi ý Google → tuyến gần nhất → báo giá LCL', {skip: !chromium}, async () => {
  const sheets = fixtures();
  sheets['Cấu hình'] = [['FSC mặc định (%)', 12], ['Ghi chú báo giá', 'Giá chưa gồm VAT.']];
  const {placesMockForUi} = module.exports;
  const gas = createGas({sheets, props: {MAPS_API_KEY: 'k'}, fetch: placesMockForUi});
  const {browser, page, errors} = await openApp(gas);
  try {
    assert.equal(await page.inputValue('#p'), '12');
    await page.fill('#a', 'kcn pho noi');
    await page.waitForSelector('#sug li[role=option]');
    const items = await page.locator('#sug li[role=option] b').allTextContents();
    assert.deepEqual(items, ['KCN Phố Nối A', 'KCN Phố Nối B']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#r optgroup[label^="Gần nhất"]'));
    assert.equal(await page.inputValue('#a'), 'KCN Phố Nối A, Yên Mỹ, Hưng Yên, Việt Nam');
    const groups = await page.$$eval('#r optgroup', g => g.map(x => [x.label, [...x.children].map(o => o.textContent)]));
    assert.match(groups[0][1][0], /^Hưng Yên · KCN Phố Nối A, Yên Mỹ · 0(,\d)? km đường bộ$/);
    assert.match(await page.textContent('#hint'), /Chọn tuyến tham khảo/);

    await page.selectOption('#r', {index: 1});
    await page.fill('#dim', '100x100x100');
    await page.fill('#kg', '200');
    await page.fill('#n', '14');
    await page.click('#go');
    await page.waitForSelector('#o table');
    const text = await page.textContent('#o');
    assert.match(text, /1 xe 8 tấn \+ 1 xe 1.25 tấn/);
    assert.match(text, /Tổng cộng/);
    assert.match(text, /Giá chưa gồm VAT/);
    // 3.800.000 + 1.300.000 = 5.100.000; FSC 12% = 612.000 → 5.712.000 → lên 5.800.000
    assert.match(await page.textContent('#o .total'), /5\.800\.000 đ/);
    await page.screenshot({path: path.join(__dirname, 'ui-lcl.png'), fullPage: true});
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Giao diện: FCL Hải Phòng hiện FSC × 1,75 và lỗi rõ ràng', {skip: !chromium}, async () => {
  const gas = createGas({sheets: fixtures()});
  const {browser, page, errors} = await openApp(gas);
  try {
    assert.equal(await page.inputValue('#p'), '');
    await page.selectOption('#h', 'HPH');
    await page.selectOption('#m', 'FCL');
    await page.waitForFunction(() => document.getElementById('o').textContent === '');
    assert.match(await page.textContent('#fscHint'), /× 1,75/);
    await page.fill('#a', 'kim thanh');
    await page.waitForFunction(() => document.querySelectorAll('#r option').length > 1);
    await page.selectOption('#r', {index: 1});
    await page.click('#go');
    assert.match(await page.textContent('#o'), /Nhập FSC/);
    await page.fill('#p', '12');
    await page.click('#go');
    await page.waitForSelector('#o table');
    const text = await page.textContent('#o');
    assert.match(text, /FSC 12% × 1,75 = 21%/);
    assert.match(text, /4\.300\.000 đ/);
    await page.screenshot({path: path.join(__dirname, 'ui-fcl.png'), fullPage: true});
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

module.exports.placesMockForUi = (url, options) => {
  if (url.endsWith('places:autocomplete')) {
    return {code: 200, body: {suggestions: [
      {placePrediction: {placeId: 'ChIJ_phonoi_A', text: {text: 'KCN Phố Nối A, Yên Mỹ, Hưng Yên, Việt Nam'},
        structuredFormat: {mainText: {text: 'KCN Phố Nối A'}, secondaryText: {text: 'Yên Mỹ, Hưng Yên, Việt Nam'}}}},
      {placePrediction: {placeId: 'ChIJ_phonoi_B', text: {text: 'KCN Phố Nối B, Mỹ Hào, Hưng Yên, Việt Nam'},
        structuredFormat: {mainText: {text: 'KCN Phố Nối B'}, secondaryText: {text: 'Mỹ Hào, Hưng Yên, Việt Nam'}}}},
    ]}};
  }
  if (url.includes('/places/ChIJ_phonoi_A')) {
    return {code: 200, body: {formattedAddress: 'KCN Phố Nối A, Yên Mỹ, Hưng Yên', location: {latitude: 20.9301, longitude: 106.0499}}};
  }
  if (url.includes('computeRouteMatrix')) {
    const body = JSON.parse(options.payload);
    const o = body.origins[0].waypoint.location.latLng;
    return {code: 200, body: body.destinations.map((d, i) => {
      const p = d.waypoint.location.latLng;
      return {originIndex: 0, destinationIndex: i, condition: 'ROUTE_EXISTS',
        distanceMeters: Math.round(Math.hypot(p.latitude - o.latitude, p.longitude - o.longitude) * 111000 * 1.3)};
    })};
  }
  return {code: 404, body: 'not found'};
};
