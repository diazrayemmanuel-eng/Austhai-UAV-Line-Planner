const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist-electron');

const mappings = [
  ['main.js', 'main.cjs'],
  ['preload.js', 'preload.cjs'],
];

for (const [sourceName, targetName] of mappings) {
  const sourcePath = path.join(distDir, sourceName);
  const targetPath = path.join(distDir, targetName);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Expected compiled file not found: ${sourcePath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);
}
