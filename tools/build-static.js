#!/usr/bin/env node
/**
 * Tạo trang tĩnh (đăng lên GitHub Pages) từ giao diện Apps Script trong src/.
 * Trang tĩnh gọi web app qua fetch không kèm cookie (doPost trong WebApp.gs),
 * nên người đăng nhập nhiều tài khoản Google vẫn dùng được.
 *
 * Cách dùng: node tools/build-static.js <URL web app /exec> <file đầu ra>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [execUrl, outFile] = process.argv.slice(2);
if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(execUrl || '') || !outFile) {
  console.error('Cách dùng: node tools/build-static.js https://script.google.com/macros/s/<ID>/exec <file đầu ra>');
  process.exit(1);
}

const src = name => fs.readFileSync(path.join(__dirname, '..', 'src', name + '.html'), 'utf8').replace(/\r\n/g, '\n');

/** Thay đúng một chỗ; báo lỗi nếu Index.html đổi khiến không tìm thấy. */
function replaceOnce(text, find, replacement) {
  const index = text.indexOf(find);
  if (index < 0 || text.indexOf(find, index + 1) >= 0) throw Error('Không tìm thấy đúng một chỗ: ' + find);
  return text.slice(0, index) + replacement + text.slice(index + find.length);
}

// Lấy phần JS bên trong <script>…</script> của Script.html để nạp sau khi có INFO.
const appScript = src('Script').trim().replace(/^<script>\s*/, '').replace(/\s*<\/script>$/, '');

const bootstrap = `<script>
(() => {
  'use strict';
  const EXEC_URL = ${JSON.stringify(execUrl)};
  // credentials: 'omit' → không gửi cookie Google, tránh lỗi authuser khi có nhiều tài khoản.
  // Content-Type text/plain để là "simple request", không cần CORS preflight.
  window.API_CALL = (fn, ...args) => fetch(EXEC_URL, {
    method: 'POST', credentials: 'omit', redirect: 'follow',
    headers: {'Content-Type': 'text/plain;charset=utf-8'},
    body: JSON.stringify({fn, args}),
  }).then(r => {
    if (!r.ok) throw Error('Máy chủ lỗi (HTTP ' + r.status + ').');
    return r.json();
  }).then(x => {
    if (!x.ok) throw Error(x.error);
    return x.result;
  });

  const el = id => document.getElementById(id);
  const fallback = {hubs: [], defaultFsc: null, hphMultiplier: 1, note: '', places: false};
  window.API_CALL('appInfo').catch(e => {
    const alert = Object.assign(document.createElement('p'), {className: 'alert', textContent: e.message});
    alert.setAttribute('role', 'alert');
    el('f').prepend(alert);
    return fallback;
  }).then(info => {
    window.INFO = info;
    el('h').replaceChildren(...info.hubs.map(hub => new Option(hub.label, hub.id)));
    if (info.defaultFsc !== null) el('p').value = info.defaultFsc;
    const app = document.createElement('script');
    app.textContent = ${JSON.stringify('const INFO = window.INFO;\n' + appScript)};
    document.body.append(app);
  });
})();
</script>`;

let html = src('Index');
html = replaceOnce(html, '  <base target="_top">\n', '  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Tính cước trucking</title>\n');
html = replaceOnce(html, "<?!= include('Styles') ?>", src('Styles').trim());
html = replaceOnce(html, "<?!= include('Logo') ?>", src('Logo').trim());
html = html.replace(/[ \t]*<\? if \(error\) \{ \?>.*?<\? \} \?>\n\n?/, '');
html = html.replace(/<\? for \(const hub of info\.hubs\) \{ \?>.*?<\? \} \?>/, '');
html = html.replace(/value="<\?= info\.defaultFsc[^"]*\?>"/, 'value=""');
html = replaceOnce(html, '  <script>const INFO = <?!= infoJson ?>;</script>\n', '');
html = replaceOnce(html, "<?!= include('Script') ?>", bootstrap);
if (/<\?/.test(html)) throw Error('Còn scriptlet Apps Script chưa xử lý trong Index.html.');

fs.writeFileSync(outFile, html);
console.log('Đã tạo ' + outFile + ' (' + Math.round(html.length / 1024) + ' KB)');
