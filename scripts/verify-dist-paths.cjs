const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'dist', 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('Missing dist/index.html');
  process.exit(1);
}

const html = fs.readFileSync(indexPath, 'utf8');
const hasAbsoluteAssetUrl = /(src|href)=['\"]\/(assets|manifest\.webmanifest)/.test(html);

if (hasAbsoluteAssetUrl) {
  console.error('Found absolute asset/manifest URLs in dist/index.html');
  process.exit(1);
}

console.log('dist/index.html URLs look file-protocol safe');
