'use strict';
// Optional asset build: npm ci, then npm run build:icons.
const fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const root = path.join(__dirname,'..');
(async () => {
  const source = fs.readFileSync(path.join(root,'assets/icon.svg'));
  for (const size of [16,32,48,128]) {
    await sharp(source,{density:384}).resize(size,size).png().toFile(path.join(root,`extension/icons/${size}.png`));
  }
})();
