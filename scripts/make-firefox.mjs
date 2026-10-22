/**
 * Build distributable Chrome and Firefox extension packages.
 *
 * Usage:
 *   node scripts/make-firefox.mjs
 *   node scripts/make-firefox.mjs --chrome
 *   node scripts/make-firefox.mjs --firefox
 *   node scripts/make-firefox.mjs --all
 *
 * Output:
 *   dist/chrome-unpacked/
 *   dist/firefox/
 *   dist/BuildMintZ-Shield-chrome-v<VERSION>.zip
 *   dist/BuildMintZ-Shield-firefox-v<VERSION>.zip
 *   dist/SHA256SUMS
 *
 * Uses Node.js built-ins only.
 *
 * Note: producing a Firefox package does not itself guarantee runtime
 * compatibility. Test the extension against the target Firefox release
 * and its supported Manifest V3 APIs before distribution.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const validArgs = new Set(['--chrome', '--firefox', '--all']);

for (const arg of args) {
  if (!validArgs.has(arg)) {
    console.error(`Unknown argument: ${arg}`);
    console.error('Usage: node scripts/make-firefox.mjs [--chrome] [--firefox] [--all]');
    process.exit(1);
  }
}

const buildAll = args.length === 0 || args.includes('--all');
const buildChrome = buildAll || args.includes('--chrome');
const buildFirefox = buildAll || args.includes('--firefox');

const RUNTIME_FILES = [
  'background.js',
  'content',
  'popup',
  'options',
  'rules',
  'icons',
  'docs',
  'LICENSE',
  'NOTICE.md',
  'README.md'
];

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function assertInsideRoot(target) {
  const relative = path.relative(ROOT, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access a path outside the project: ${target}`);
  }
}

function copyRuntime(target) {
  removePath(target);
  fs.mkdirSync(target, { recursive: true });

  for (const entry of RUNTIME_FILES) {
    const source = path.join(ROOT, entry);
    const destination = path.join(target, entry);

    assertInsideRoot(source);
    assertInsideRoot(destination);

    if (!fs.existsSync(source)) {
      throw new Error(`Required distribution file is missing: ${entry}`);
    }

    fs.cpSync(source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false
    });
  }
}

function writeJSON(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* ---------- ZIP writer ---------- */

const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01

function crc32(buffer) {
  let table = crc32.table;

  if (!table) {
    table = crc32.table = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
      let value = i;

      for (let bit = 0; bit < 8; bit++) {
        value = value & 1
          ? (value >>> 1) ^ 0xEDB88320
          : value >>> 1;
      }

      table[i] = value >>> 0;
    }
  }

  let crc = 0xFFFFFFFF;

  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function collectFiles(directory) {
  const files = [];

  function walk(currentDirectory, prefix = '') {
    const entries = fs.readdirSync(currentDirectory, {
      withFileTypes: true
    }).sort((a, b) => a.name.localeCompare(b.name, 'en'));

    for (const entry of entries) {
      const absolute = path.join(currentDirectory, entry.name);
      const archiveName = `${prefix}${entry.name}`;

      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in packages: ${absolute}`);
      }

      if (entry.isDirectory()) {
        walk(absolute, `${archiveName}/`);
        continue;
      }

      if (!entry.isFile()) {
        throw new Error(`Unsupported file type in package: ${absolute}`);
      }

      files.push({
        name: archiveName.split(path.sep).join('/'),
        data: fs.readFileSync(absolute)
      });
    }
  }

  walk(directory);
  return files;
}

function zipDirectory(directory, outputFile) {
  const files = collectFiles(directory);

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  if (files.length > 0xFFFF) {
    throw new Error('Too many files for the ZIP format supported by this builder.');
  }

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const original = file.data;

    if (name.length > 0xFFFF) {
      throw new Error(`ZIP filename is too long: ${file.name}`);
    }

    const compressed = zlib.deflateRawSync(original, {
      level: 9
    });

    const checksum = crc32(original);

    if (
      original.length > 0xFFFFFFFF ||
      compressed.length > 0xFFFFFFFF ||
      offset > 0xFFFFFFFF
    ) {
      throw new Error('ZIP64 is not supported by this builder.');
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034B50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(original.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014B50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(original.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const centralOffset = offset;

  if (centralDirectory.length > 0xFFFFFFFF) {
    throw new Error('ZIP central directory exceeds the supported size.');
  }

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054B50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  fs.writeFileSync(
    outputFile,
    Buffer.concat([...localChunks, centralDirectory, endRecord])
  );
}

/* ---------- target manifests ---------- */

function createFirefoxManifest(sourceManifest) {
  const manifest = structuredClone(sourceManifest);

  delete manifest.minimum_chrome_version;
  delete manifest.background?.service_worker;

  manifest.background = {
    scripts: ['background.js']
  };

  manifest.browser_specific_settings = {
    ...manifest.browser_specific_settings,
    gecko: {
      ...manifest.browser_specific_settings?.gecko,
      id: 'shield@buildmintz.example',
      strict_min_version: '128.0',
      // NEW: Required by Mozilla to pass validation for no data collection
      data_collection_permissions: {
        required: ['none']
      }
    }
  };

  return manifest;
}

/* ---------- build targets ---------- */

function buildTarget({ name, directoryName, manifest, version }) {
  const targetDirectory = path.join(DIST, directoryName);

  copyRuntime(targetDirectory);
  writeJSON(path.join(targetDirectory, 'manifest.json'), manifest);

  const archiveName = `BuildMintZ-Shield-${name}-v${version}.zip`;
  const archivePath = path.join(DIST, archiveName);

  fs.rmSync(archivePath, { force: true });
  zipDirectory(targetDirectory, archivePath);

  const archiveHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archivePath))
    .digest('hex');

  console.log(`✓ ${name}: ${path.relative(ROOT, targetDirectory)}`);
  console.log(`✓ ${name}: ${path.relative(ROOT, archivePath)}`);

  return {
    archiveName,
    archiveHash
  };
}

/* ---------- main ---------- */

function main() {
  const manifestPath = path.join(ROOT, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json was not found in the project root.');
  }

  const sourceManifest = readJSON(manifestPath);
  const version = sourceManifest.version;

  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('manifest.json must contain a valid x.y.z version.');
  }

  fs.mkdirSync(DIST, { recursive: true });

  const artifacts = [];

  if (buildChrome) {
    artifacts.push(buildTarget({
      name: 'chrome',
      directoryName: 'chrome-unpacked',
      manifest: sourceManifest,
      version
    }));
  }

  if (buildFirefox) {
    artifacts.push(buildTarget({
      name: 'firefox',
      directoryName: 'firefox',
      manifest: createFirefoxManifest(sourceManifest),
      version
    }));
  }

  const checksumLines = artifacts
    .sort((a, b) => a.archiveName.localeCompare(b.archiveName))
    .map(artifact => `${artifact.archiveHash}  ${artifact.archiveName}`);

  fs.writeFileSync(
    path.join(DIST, 'SHA256SUMS'),
    `${checksumLines.join('\n')}\n`,
    'utf8'
  );

  console.log('✓ SHA256SUMS');
  console.log('\nBuild completed.');

  if (buildChrome) {
    console.log(
      'Chrome: open chrome://extensions, enable Developer mode, and load dist/chrome-unpacked/.'
    );
  }

  if (buildFirefox) {
    console.log(
      'Firefox: test the generated package in the intended Firefox version before distribution.'
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`\n✗ Build failed: ${error.message}`);
  process.exitCode = 1;
}