#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { allPublishDirs, entryDirFor, FAMILIES, platformDirsFor, readJson, root } from './packages.mjs';

const tarballDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'npm'));
if (process.env.NARB_EXPECTED_NODE_MAJOR) {
  assert.equal(process.versions.node.split('.')[0], process.env.NARB_EXPECTED_NODE_MAJOR);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// Serve the exact release tarballs on loopback, so npm resolves the entry's
// transitive optionalDependencies itself without reading the public registry.
class PackedRegistry {
  packages = new Map();
  tarballs = new Map();
  server;
  url;

  constructor() {
    for (const dir of allPublishDirs()) {
      const source = readJson(path.join(root, dir, 'package.json'));
      const filename = `${source.name.replace(/^@/, '').replace('/', '-')}-${source.version}.tgz`;
      const file = path.join(tarballDir, filename);
      const manifest = JSON.parse(capture('tar', ['-xOf', file, 'package/package.json']));
      assert.equal(manifest.name, source.name);
      assert.equal(manifest.version, source.version);
      for (const field of ['os', 'cpu', 'libc']) {
        assert.deepEqual(manifest[field], source[field], `${manifest.name}: packed ${field}`);
      }
      const data = fs.readFileSync(file);
      this.packages.set(manifest.name, { manifest, filename,
        integrity: `sha512-${crypto.createHash('sha512').update(data).digest('base64')}` });
      this.tarballs.set(filename, data);
    }
    for (const family of FAMILIES) {
      const entry = this.packages.get(`node-addon-${family}`).manifest;
      const expected = platformDirsFor(family).map((dir) => readJson(path.join(root, dir, 'package.json')).name).sort();
      assert.deepEqual(Object.keys(entry.optionalDependencies || {}).sort(), expected);
      assert.ok(Object.values(entry.optionalDependencies).every((version) => version === entry.version));
      assert.equal(entry.scripts?.install, undefined);
    }
  }

  async start() {
    this.server = http.createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url, this.url).pathname.slice(1));
      if (name.startsWith('tarballs/') && this.tarballs.has(name.slice(9))) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end(this.tarballs.get(name.slice(9)));
        return;
      }
      const entry = this.packages.get(name);
      if (!entry) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'package not in packed release' }));
        return;
      }
      const { manifest, filename, integrity } = entry;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        name, 'dist-tags': { latest: manifest.version },
        versions: { [manifest.version]: { ...manifest,
          dist: { tarball: `${this.url}/tarballs/${filename}`, integrity } } },
      }));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  async close() {
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
  }
}

function platformSuffix() {
  if (process.platform === 'win32') return `win32-${process.arch}-msvc`;
  if (process.platform !== 'linux') return `${process.platform}-${process.arch}`;
  const libc = process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl';
  if (process.env.NARB_EXPECTED_LIBC) assert.equal(libc, process.env.NARB_EXPECTED_LIBC);
  return `linux-${process.arch}-${libc}`;
}

function runNode(cwd, script, exposeInternals = false) {
  const result = spawnSync(process.execPath, [
    ...(exposeInternals ? ['--expose-internals'] : []), '-e', script,
  ], { cwd, stdio: 'inherit', env: { ...process.env,
    NARB_BACKEND: 'napi', NARB_DISABLE_LOCAL_BUILD: '1', NARB_DISABLE_OPTIONAL_PACKAGE: '0',
    NARB_DISABLE_NATIVE_CACHE: '1', NODE_PATH: '',
  } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'installed-package check failed');
}

function verifyFamily(tempRoot, family, suffix) {
  const name = readJson(path.join(root, entryDirFor(family), 'package.json')).name;
  const optionalName = `${name}-${suffix}`;
  const optionalDir = path.join(tempRoot, 'node_modules', optionalName);
  assert.ok(fs.existsSync(optionalDir), `npm did not install ${optionalName}`);

  const script = `
    const assert = require('node:assert/strict');
    const addon = require(${JSON.stringify(name)});
    const info = addon.getBindingInfo();
    assert.equal(info.bindingSource, 'optional-package');
    assert.equal(info.platformPackageSuffix, ${JSON.stringify(suffix)});
    assert.equal(info.optionalPackageName, ${JSON.stringify(optionalName)});
    assert.equal(info.product, ${JSON.stringify(family)});
    assert.equal(info.backend, 'napi');
    assert.equal(info.abi, 'napi-v9');
    const exposed = process.execArgv.includes('--expose-internals');
    if (!exposed) assert.throws(() => require('internal/modules/esm/loader'));
    for (const id of ['internal/modules/cjs/loader', 'internal/modules/esm/loader']) {
      const value = addon.requireBuiltin(id);
      assert.equal(typeof value, 'object');
      if (exposed) assert.strictEqual(value, require(id));
    }
    if (${JSON.stringify(family)} === 'internal-loader') {
      assert.throws(() => addon.requireBuiltin('internal/bootstrap/realm'),
        (error) => error.code === 'Unsupported/disallowed-target');
    } else {
      assert.equal(typeof addon.requireBuiltin('internal/bootstrap/realm'), 'object');
    }
    console.log(JSON.stringify({ package: ${JSON.stringify(name)}, node: process.version,
      source: info.bindingSource, product: info.product, backend: info.backend,
      abi: info.abi, parity: exposed }));
  `;
  runNode(tempRoot, script);
  runNode(tempRoot, script, true);

  function expectFailure(message) {
    runNode(tempRoot, `
      const assert = require('node:assert/strict');
      assert.throws(() => require(${JSON.stringify(name)}), (error) =>
        (error.message + JSON.stringify(error.attempts)).includes(${JSON.stringify(message)}));
    `);
  }

  fs.renameSync(optionalDir, `${optionalDir}.disabled`);
  try { expectFailure('No usable native binding found'); }
  finally { fs.renameSync(`${optionalDir}.disabled`, optionalDir); }

  const otherFamily = FAMILIES.find((candidate) => candidate !== family);
  const binaryName = `prebuilt/${suffix}-napi-v9.node`;
  const binary = path.join(optionalDir, binaryName);
  const original = fs.readFileSync(binary);
  try {
    fs.copyFileSync(path.join(tempRoot, 'node_modules', `node-addon-${otherFamily}-${suffix}`, binaryName), binary);
    expectFailure('product mismatch');
  } finally {
    fs.writeFileSync(binary, original);
  }
  console.log(`Packed install checks passed: ${name} (including missing/wrong product rejection)`);
}

const registry = new PackedRegistry();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'narb-packed-install-'));
try {
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ private: true }));
  fs.writeFileSync(path.join(tempRoot, 'user.npmrc'), '');
  fs.writeFileSync(path.join(tempRoot, 'global.npmrc'), '');
  await registry.start();
  const packages = FAMILIES.map((family) => {
    const manifest = registry.packages.get(`node-addon-${family}`).manifest;
    return `${manifest.name}@${manifest.version}`;
  });
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', ...packages, '--ignore-scripts', '--no-audit', '--no-fund',
      '--fetch-retries=0', `--registry=${registry.url}`, `--cache=${path.join(tempRoot, 'cache')}`], {
      cwd: tempRoot, stdio: 'inherit', shell: process.platform === 'win32',
      env: { ...process.env, npm_config_userconfig: path.join(tempRoot, 'user.npmrc'),
        npm_config_globalconfig: path.join(tempRoot, 'global.npmrc') },
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm install exited ${code}`)));
  });
  await registry.close();
  const suffix = platformSuffix();
  if (process.env.NARB_EXPECTED_ARCH) assert.equal(process.arch, process.env.NARB_EXPECTED_ARCH);
  for (const family of FAMILIES) verifyFamily(tempRoot, family, suffix);
  console.log('Packed npm install verification passed.');
} finally {
  await registry.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
