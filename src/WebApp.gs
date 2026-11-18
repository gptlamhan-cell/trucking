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
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Chèn nội dung một file HTML khác vào template: <?!= include('Styles') ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
