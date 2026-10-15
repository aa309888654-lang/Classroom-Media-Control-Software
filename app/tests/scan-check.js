/* 手工验证课件库扫描 kind 字段（需 electron）: npx electron tests/scan-check.js */
const { app } = require('electron');
const lib = require('../src/main/library');
app.whenReady().then(async () => {
  const ppts = await lib.scanPpts();
  console.log('scanPpts:');
  ppts.forEach((p) => console.log('  kind=' + p.kind + '  ' + p.name));
  console.log('isPptExt(.pptx)=', lib.isPptExt('.pptx'), 'isPptExt(.jpg)=', lib.isPptExt('.jpg'), 'isPptExt(.pdf)=', lib.isPptExt('.pdf'));
  console.log('COURSEWARE_EXT_ARR 含 pdf/jpg/docx/xlsx:', ['pdf', 'jpg', 'docx', 'xlsx'].every((e) => lib.COURSEWARE_EXT_ARR.includes(e)));
  app.exit(0);
});
