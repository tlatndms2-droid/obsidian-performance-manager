const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const names = ['profile', 'recorder', 'main'];
const modules = names.map(name => `${JSON.stringify('./'+name+'.cjs')}: function(module,exports,require){\n${fs.readFileSync(path.join(root,'src',name+'.cjs'),'utf8')}\n}`).join(',\n');
const output = `/* Performance Manager ${JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version} */\n(function(nativeRequire){\nconst factories={${modules}};\nconst cache={};\nfunction localRequire(id){if(!factories[id])return nativeRequire(id);if(!cache[id]){const m={exports:{}};cache[id]=m;factories[id](m,m.exports,localRequire);}return cache[id].exports;}\nmodule.exports=localRequire('./main.cjs');\n})(require);\n`;
fs.writeFileSync(path.join(root,'main.js'), output);
console.log('Built main.js ('+Buffer.byteLength(output)+' bytes)');
