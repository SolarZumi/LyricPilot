'use strict';
const {readdirSync,readFileSync,existsSync} = require('node:fs');
const {join} = require('node:path');
const {execFileSync} = require('node:child_process');
for (const directory of ['extension']) {
  for (const name of readdirSync(directory).filter(name => name.endsWith('.js'))) {
    execFileSync(process.execPath,['--check',join(directory,name)],{stdio:'inherit'});
  }
}
console.log('JavaScript syntax checks passed');
execFileSync(process.execPath,['scripts/build-ui.cjs','--check'],{stdio:'inherit'});
const manifest=JSON.parse(readFileSync('extension/manifest.json','utf8'));
const pkg=JSON.parse(readFileSync('package.json','utf8'));
if (manifest.version !== pkg.version) throw new Error('Package and extension versions differ');
for (const [size,file] of Object.entries(manifest.icons)) {
  const data=readFileSync(join('extension',file));
  if (data.toString('hex',0,8)!=='89504e470d0a1a0a' || data.readUInt32BE(16)!==Number(size) || data.readUInt32BE(20)!==Number(size)) throw new Error('Invalid icon: '+file);
}
for (const file of Object.values(manifest.action.default_icon)) if (!existsSync(join('extension',file))) throw new Error('Missing action icon');
console.log('UI build, versions and icon dimensions passed');
