'use strict';

// Run in the runtime-only stage of scripts/musl.Dockerfile, never on the host.
// The binaries are compiled once in a separate stage and loaded without a
// compiler, network, or writable source tree in the runtime container.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const loader = require('../packages/loader/lib/index.js');

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed (${result.signal || result.status})`);
}

assert.equal(process.platform, 'linux');
const interpreters = {
  arm64: '/lib/ld-musl-aarch64.so.1',
  x64: '/lib/ld-musl-x86_64.so.1',
};
assert.ok(Object.hasOwn(interpreters, process.arch), `unsupported architecture: ${process.arch}`);
assert.equal(process.arch, fs.readFileSync('NODE_ARCH', 'utf8').trim());
if (process.env.NARB_EXPECTED_ARCH) {
  assert.equal(process.arch, process.env.NARB_EXPECTED_ARCH);
}
assert.equal(process.versions.node.split('.')[0], '24');
assert.equal(process.versions.node, fs.readFileSync('NODE_VERSION', 'utf8').trim());
assert.equal(loader.libcFromExecutable(process.execPath), 'musl');
assert.equal(loader.elfInterpreter(process.execPath), interpreters[process.arch]);
assert.equal(loader.platformPackageSuffix(), `linux-${process.arch}-musl`);
assert.doesNotMatch(fs.readFileSync('/proc/self/maps', 'utf8'), /\/libc\.so\.6|\/libgcompat\.so/);
assert.doesNotMatch(fs.readFileSync('ADDON_ELF.txt', 'utf8'), /\bGLIBC_[0-9]|\[libc\.so\.6\]/);
for (const command of ['cc', 'c++', 'gcc', 'g++', 'clang', 'npm', 'pnpm']) {
  assert.equal(spawnSync(command, ['--version']).error?.code, 'ENOENT', `${command} must not be installed`);
}

console.log(JSON.stringify({
  alpine: fs.readFileSync('/etc/alpine-release', 'utf8').trim(),
  arch: process.arch,
  node: process.versions.node,
  v8: process.versions.v8,
  interpreter: loader.elfInterpreter(process.execPath),
}, null, 2));
run('apk', ['list', '--installed', 'musl', 'nodejs', 'libstdc++']);
run('sha256sum', ['-c', 'SHA256SUMS']);
run(process.execPath, ['test/libc.test.js']);

for (const product of ['require-builtin', 'internal-loader']) {
  for (const backend of ['napi', 'nodeabi']) {
    console.log(`musl validation: ${product}/${backend}`);
    const env = {
      NARB_PRODUCT: product,
      NARB_EXPECTED_PRODUCT: product,
      NARB_BACKEND: backend,
      NARB_EXPECTED_BACKEND: backend,
      NARB_DISABLE_OPTIONAL_PACKAGE: backend === 'napi' ? '0' : '1',
      NARB_DISABLE_LOCAL_BUILD: backend === 'napi' ? '1' : '0',
    };
    run(process.execPath, ['test/backend.test.js'], env);
    run(process.execPath, ['--expose-internals', 'test/require-parity.test.js'], env);
  }
}

run('sha256sum', ['-c', 'SHA256SUMS']);
console.log('musl validation passed: both products, both backends, unchanged binaries');
