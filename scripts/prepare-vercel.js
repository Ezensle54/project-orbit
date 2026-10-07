'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
const assets = ['index.html', 'script.js', 'styles.css'];
const rootAssetsExist = assets.every((asset) => fs.existsSync(path.join(root, asset)));
const source = rootAssetsExist ? root : output;

for (const asset of assets) {
  const sourcePath = path.join(source, asset);
  const outputPath = path.join(output, asset);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Cannot build Vercel site: missing ${path.relative(root, sourcePath)}.`);
  }
  fs.mkdirSync(output, { recursive: true });
  if (sourcePath !== outputPath) fs.copyFileSync(sourcePath, outputPath);
}
