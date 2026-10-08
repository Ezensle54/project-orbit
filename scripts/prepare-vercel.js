'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
const assets = ['index.html', 'script.js', 'styles.css'];

for (const asset of assets) {
  const sourcePath = path.join(root, asset);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Cannot build Vercel site: missing ${path.relative(root, sourcePath)}.`);
  }
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(sourcePath, path.join(output, asset));
}
