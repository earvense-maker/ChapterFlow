import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, 'release', 'electron');
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
);
const version = packageJson.version;
// NOTE: exe名はelectron-builderが build.productName から決めるため、同じ値を参照する。
const productName = packageJson.build?.productName;

if (typeof version !== 'string' || !version.trim()) {
  throw new Error('package.json の version を取得できませんでした');
}
if (typeof productName !== 'string' || !productName.trim()) {
  throw new Error('package.json の build.productName を取得できませんでした');
}

await mkdir(outputDir, { recursive: true });
await Promise.all([
  copyFile(path.join(projectRoot, 'LICENSE'), path.join(outputDir, 'LICENSE')),
  copyFile(
    path.join(projectRoot, 'docs', '利用ガイド.md'),
    path.join(outputDir, '利用ガイド.md')
  ),
]);

const artifactNames = [
  `${productName} ${version}.exe`,
  `${productName} Setup ${version}.exe`,
];
const outputEntries = await readdir(outputDir);
const missingArtifacts = artifactNames.filter((name) => !outputEntries.includes(name));

if (missingArtifacts.length > 0) {
  throw new Error(`配布用exeが見つかりません: ${missingArtifacts.join(', ')}`);
}

const staleArtifacts = outputEntries.filter(
  (name) => name.toLowerCase().endsWith('.exe') && !artifactNames.includes(name)
);
if (staleArtifacts.length > 0) {
  console.warn(`古い可能性があるexeが残っています: ${staleArtifacts.join(', ')}`);
}

const checksumLines = await Promise.all(
  artifactNames.map(async (name) => `${await sha256(path.join(outputDir, name))}  ${name}`)
);
await writeFile(
  path.join(outputDir, 'SHA256SUMS.txt'),
  `${checksumLines.join('\n')}\n`,
  'utf8'
);

console.log(`配布文書とSHA-256を作成しました: ${outputDir}`);

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
