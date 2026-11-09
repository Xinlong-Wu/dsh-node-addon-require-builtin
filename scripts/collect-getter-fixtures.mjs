// Collects real getter machine code from the local toolchain under many
// hardening flag combinations, so the decoder self-test can be driven by bytes a
// compiler actually emitted rather than bytes we hand-assembled from what we
// expected it to emit. Hand-written cases can only cover shapes we already
// thought of; this covers whatever the toolchain does.
//
// Run once per toolchain/architecture and archive the output. Fixtures are
// checked in (test/getter_fixtures.inc), so the test itself never needs a
// compiler or these flags to be available:
//
//   node ./scripts/collect-getter-fixtures.mjs > /tmp/fixtures-<tag>.json
//   node ./scripts/collect-getter-fixtures.mjs --emit-inc f1.json f2.json ...
//
// The probe mirrors the real accessor: a const member function returning a
// single-pointer struct (v8::Local<T>) loaded from a fixed offset in `this`.
// Field index 64 means byte offset 512, which is what Fedora's Node actually
// uses, and the offset is asserted on every fixture.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const FIELD_INDEX = 64;
const EXPECTED_OFFSET = FIELD_INDEX * 8;
const CAPTURE_BYTES = 48;

const PROBE_SOURCE = `#include <cstdio>
#include <cstring>
struct Local { void* val; };
struct Realm { void* f[70]; Local get() const; };
Local Realm::get() const { return Local{f[${FIELD_INDEX}]}; }
int main() {
  auto m = &Realm::get;
  void* addr = nullptr;
  std::memcpy(&addr, &m, sizeof(addr));
  unsigned char buf[${CAPTURE_BYTES}];
  std::memcpy(buf, addr, sizeof(buf));
  for (size_t i = 0; i < sizeof(buf); i++) std::printf("%02x", buf[i]);
  std::printf("\\n");
  return 0;
}
`;

// Flag sets worth probing. Anything the local compiler rejects is skipped, so
// the same list runs unchanged on Apple clang, GCC, and clang on Linux.
const OPT_LEVELS = ['-O0', '-O1', '-O2', '-O3', '-Os'];

const ARM64_HARDENING = [
  [],
  ['-mbranch-protection=standard'],
  ['-mbranch-protection=pac-ret'],
  ['-mbranch-protection=bti'],
  ['-mbranch-protection=pac-ret+leaf'],
  ['-mbranch-protection=standard+leaf'],
  ['-mbranch-protection=pac-ret+b-key'],
  ['-fno-omit-frame-pointer'],
  // -fno-omit-frame-pointer alone does not give a leaf function a frame; this is
  // the flag that does, and it is why Fedora's getter carries a frame record.
  ['-mno-omit-leaf-frame-pointer'],
  ['-mbranch-protection=standard', '-fno-omit-frame-pointer'],
  ['-mbranch-protection=standard', '-mno-omit-leaf-frame-pointer'],
  ['-fstack-protector-strong'],
  ['-fstack-clash-protection'],
  // Fedora's actual package build flags, taken verbatim from
  // `rpm --eval %{build_cflags}` on Fedora 44 aarch64.
  [
    '-mbranch-protection=standard',
    '-fstack-protector-strong',
    '-fstack-clash-protection',
    '-fno-omit-frame-pointer',
    '-mno-omit-leaf-frame-pointer',
  ],
];

const X64_HARDENING = [
  [],
  ['-fcf-protection=full'],
  ['-fcf-protection=branch'],
  ['-fno-omit-frame-pointer'],
  ['-mno-omit-leaf-frame-pointer'],
  ['-fcf-protection=full', '-fno-omit-frame-pointer'],
  ['-fcf-protection=full', '-mno-omit-leaf-frame-pointer'],
  ['-fstack-protector-strong'],
  ['-fstack-clash-protection'],
  // Approximates Fedora's actual package build flags on x86_64.
  [
    '-fcf-protection=full',
    '-fstack-protector-strong',
    '-fstack-clash-protection',
    '-fno-omit-frame-pointer',
    '-mno-omit-leaf-frame-pointer',
  ],
];

// GCC maps -fcf-protection onto Zicfilp/Zicfiss on riscv64 (GCC 14+); the
// march-less entries only compile on toolchains that auto-enable the
// extensions, and anything the compiler rejects is skipped like every other
// unsupported flag combination here.
const RISCV64_HARDENING = [
  [],
  ['-fcf-protection=branch'],
  ['-fcf-protection=full'],
  ['-march=rv64gc_zicfilp', '-fcf-protection=full'],
  ['-fno-omit-frame-pointer'],
  // The flag that gives even a leaf function a frame record, mirroring the
  // AArch64 and x86-64 matrices; whether the riscv64 backend accepts it is
  // exactly what this fixture matrix is here to find out.
  ['-mno-omit-leaf-frame-pointer'],
  ['-fno-omit-frame-pointer', '-mno-omit-leaf-frame-pointer'],
  ['-fstack-protector-strong'],
  ['-fstack-clash-protection'],
  // Approximates Fedora's package build flags on riscv64, minus the
  // -mbranch-protection set that is AArch64-only.
  [
    '-fcf-protection=full',
    '-fstack-protector-strong',
    '-fstack-clash-protection',
    '-fno-omit-frame-pointer',
    '-mno-omit-leaf-frame-pointer',
  ],
];

const ARM64_RET = 0xd65f03c0;
// `retaa`/`retab` fuse the pointer-authentication check into the return, so a
// getter built with `-mbranch-protection=pac-ret+leaf` terminates on one of
// these instead of a plain `ret`.
const ARM64_RETAA = 0xd65f0bff;
const ARM64_RETAB = 0xd65f0fff;

// Trims the captured window to just past the getter's return. Everything after it
// belongs to whatever the linker placed next and would make the fixture depend
// on unrelated code.
function trimArm64(bytes) {
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    const word =
      (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    if (word === ARM64_RET || word === ARM64_RETAA || word === ARM64_RETAB) {
      return bytes.slice(0, i + 4);
    }
  }
  return null;
}

// Minimal length decoder covering exactly the instruction forms a field getter
// can contain — the same set the C++ decoder recognizes. Returns null if it hits
// anything else, which means the shape is one we should look at by hand rather
// than archive silently.
function trimX64(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0xf3 && bytes[i + 1] === 0x0f && bytes[i + 2] === 0x1e && bytes[i + 3] === 0xfa) {
      i += 4;
      continue;
    }
    if (b === 0x55 || b === 0x5d) {
      i += 1;
      continue;
    }
    if (b === 0xc3) return bytes.slice(0, i + 1);
    if (b === 0x48 && (bytes[i + 1] === 0x89 || bytes[i + 1] === 0x8b)) {
      const modrm = bytes[i + 2];
      const mod = modrm >> 6;
      const rm = modrm & 0x7;
      let len = 3;
      if (rm === 0x4) return null; // SIB byte: not a shape we archive
      if (mod === 0x1) len += 1;
      else if (mod === 0x2) len += 4;
      else if (mod === 0x0 && rm === 0x5) return null; // RIP-relative
      i += len;
      continue;
    }
    return null;
  }
  return null;
}

// Minimal RISC-V (RV64) walker covering exactly the instruction forms the C++
// decoder recognizes, in the same halfword-then-quadrant order. This is the
// deliberate second implementation: { end, offset } where `end` is the byte
// index past the terminating `ret`/`c.ret` and `offset` is the field offset the
// body loads — null when the body is not a plain accessor (stack traffic) but
// still ends at a recognizable terminator, so the shape is archived for the
// self-test to assert the rejection on. Returns null when no terminator is
// found in the captured window at all.
function riscv64Walk(bytes) {
  let i = 0;
  let offset = null;
  while (i + 2 <= bytes.length) {
    const half = bytes[i] | (bytes[i + 1] << 8);
    if ((half & 3) !== 3) {
      // c.ret (c.jr ra).
      if (half === 0x8082) return { end: i + 2, offset };
      // c.ld a0, uimm(a0).
      if ((half & 0xe39f) === 0x6108) {
        if (offset !== null) return { end: i + 2, offset: null };
        offset = (((half >>> 10) & 7) << 3) | (((half >>> 5) & 3) << 6);
        i += 2;
        continue;
      }
      const ci = half & 0xef83;
      const css = half & 0xe07f;
      // c.addi16sp / c.addi sp / c.ldsp ra,s0 / c.sdsp ra,s0 / c.add s0,sp /
      // c.addi4spn s0 (the all-zero halfword is the illegal instruction, not a
      // zero-offset frame setup).
      if (
        ci === 0x6101 ||
        ci === 0x0101 ||
        ci === 0x6082 ||
        ci === 0x6402 ||
        css === 0xe006 ||
        css === 0xe022 ||
        half === 0x940a ||
        (half !== 0 && (half & 0xe01f) === 0)
      ) {
        i += 2;
        continue;
      }
      return { end: i + 2, offset: null };
    }
    if (i + 4 > bytes.length) return null;
    const word =
      (bytes[i] |
        (bytes[i + 1] << 8) |
        (bytes[i + 2] << 16) |
        (bytes[i + 3] << 24)) >>>
      0;
    // ret (jalr zero, 0(ra)).
    if (word === 0x00008067) return { end: i + 4, offset };
    // lpad (auipc zero): 20-bit landing-pad label is free.
    if ((word & 0xfff) === 0x17) {
      i += 4;
      continue;
    }
    // ld a0, imm(a0): plain signed byte offset.
    if ((word & 0xfffff) === 0x53503) {
      if (offset !== null) return { end: i + 4, offset: null };
      let imm = (word >>> 20) & 0xfff;
      if (imm & 0x800) imm -= 0x1000;
      offset = imm < 0 ? null : imm;
      i += 4;
      continue;
    }
    const masked = word & 0xfffff;
    const store = word & 0x01fff07f;
    // addi sp,s0(sp) frame adjusts / sd,ld ra,s0(sp) frame record.
    if (
      masked === 0x10113 ||
      masked === 0x10413 ||
      store === 0x113023 ||
      store === 0x813023 ||
      masked === 0x13083 ||
      masked === 0x13403
    ) {
      i += 4;
      continue;
    }
    return { end: i + 4, offset: null };
  }
  return null;
}

function detectArch() {
  // NARB_FIXTURE_ARCH collects fixtures for a non-host architecture through a
  // cross toolchain (CXX=riscv64-linux-gnu-g++); the probe binary runs under
  // the matching qemu-user emulator instead of natively.
  const override = process.env.NARB_FIXTURE_ARCH;
  if (override) {
    if (override !== 'arm64' && override !== 'x64' && override !== 'riscv64') {
      throw new Error(`unsupported NARB_FIXTURE_ARCH: ${override}`);
    }
    return override;
  }
  const machine = os.arch();
  if (machine === 'arm64') return 'arm64';
  if (machine === 'x64') return 'x64';
  throw new Error(`unsupported host architecture: ${machine}`);
}

// Per-target qemu-user emulator used when the fixture architecture is not the
// host architecture. NARB_FIXTURE_EMULATOR overrides the full command (e.g.
// "qemu-riscv64 -L /path/to/sysroot" for a cross sysroot).
const RISCV64_EMULATOR = process.env.NARB_FIXTURE_EMULATOR || 'qemu-riscv64';

function toolchainId(compiler) {
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
  const first = (probe.stdout || '').split('\n')[0] || compiler;
  // e.g. "Apple clang version 17.0.0 ..." -> "apple-clang-17",
  //      "g++ (GCC) 16.1.1 ..."           -> "gcc-16"
  const version = first.match(/(\d+)\.\d+\.\d+/);
  const major = version ? version[1] : 'unknown';
  if (/Apple clang/i.test(first)) return `apple-clang-${major}`;
  if (/clang/i.test(first)) return `clang-${major}`;
  if (/\bg\+\+|\bGCC\b/i.test(first)) return `gcc-${major}`;
  return `${path.basename(compiler)}-${major}`;
}

function collect() {
  const arch = detectArch();
  const compiler = process.env.CXX || 'c++';
  const toolchain = toolchainId(compiler);
  const hardening =
    arch === 'arm64'
      ? ARM64_HARDENING
      : arch === 'riscv64'
        ? RISCV64_HARDENING
        : X64_HARDENING;
  const cross = arch !== os.arch();
  const emulatorArgv = cross && arch === 'riscv64'
    ? RISCV64_EMULATOR.trim().split(/\s+/)
    : null;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narb-fixtures-'));
  const src = path.join(dir, 'probe.cc');
  fs.writeFileSync(src, PROBE_SOURCE);

  const results = [];
  const skipped = [];
  for (const opt of OPT_LEVELS) {
    for (const flags of hardening) {
      const argv = [opt, ...flags];
      const bin = path.join(dir, 'probe');
      const build = spawnSync(compiler, [...argv, src, '-o', bin], {
        encoding: 'utf8',
      });
      if (build.status !== 0) {
        skipped.push({ flags: argv.join(' '), reason: 'compile rejected' });
        continue;
      }
      let hex;
      try {
        hex = (
          emulatorArgv
            ? execFileSync(emulatorArgv[0], [...emulatorArgv.slice(1), bin])
            : execFileSync(bin, [])
        )
          .toString()
          .trim();
      } catch {
        skipped.push({
          flags: argv.join(' '),
          reason: emulatorArgv
            ? `probe run failed under ${emulatorArgv.join(' ')}`
            : 'probe run failed',
        });
        continue;
      }
      const raw = Buffer.from(hex, 'hex');
      let trimmed;
      if (arch === 'arm64') trimmed = trimArm64(raw);
      else if (arch === 'riscv64') {
        const walk = riscv64Walk(raw);
        trimmed = walk ? raw.subarray(0, walk.end) : null;
      } else trimmed = trimX64(raw);
      if (!trimmed) {
        skipped.push({
          flags: argv.join(' '),
          reason: 'no recognizable ret in window',
          bytes: hex,
        });
        continue;
      }
      results.push({
        arch,
        toolchain,
        flags: argv.join(' '),
        bytes: Buffer.from(trimmed).toString('hex'),
      });
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });

  // Collapse identical byte sequences: many flag combinations produce the same
  // code, and what the decoder needs is one case per distinct shape.
  const byShape = new Map();
  for (const r of results) {
    const key = `${r.arch}|${r.toolchain}|${r.bytes}`;
    if (!byShape.has(key)) byShape.set(key, { ...r, flags: [r.flags] });
    else byShape.get(key).flags.push(r.flags);
  }

  return {
    arch,
    toolchain,
    expected_offset: EXPECTED_OFFSET,
    shapes: [...byShape.values()],
    skipped,
  };
}

// Independently derives the field offset from the captured bytes. This is a
// deliberate second implementation: the C++ decoder must agree with it on every
// fixture, so a mistake in either one shows up as a disagreement rather than as
// two implementations being confidently wrong together.
function offsetFromBytes(bytes, arch) {
  if (arch === 'arm64') {
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
      const word =
        (bytes[i] |
          (bytes[i + 1] << 8) |
          (bytes[i + 2] << 16) |
          (bytes[i + 3] << 24)) >>>
        0;
      // ldr x0, [x0, #imm12*8]
      if ((word & 0xffc003ff) >>> 0 === 0xf9400000) {
        return ((word >>> 10) & 0xfff) * 8;
      }
    }
    return null;
  }
  if (arch === 'riscv64') {
    return riscv64Walk(bytes)?.offset ?? null;
  }
  for (let i = 0; i < bytes.length; i++) {
    // REX.W mov rax, [rdi + disp]
    if (bytes[i] !== 0x48 || bytes[i + 1] !== 0x8b) continue;
    const modrm = bytes[i + 2];
    const mod = modrm >> 6;
    const reg = (modrm >> 3) & 0x7;
    const rm = modrm & 0x7;
    if (reg !== 0 || rm !== 7) continue; // rax <- [rdi]
    if (mod === 0x1) return bytes[i + 3];
    if (mod === 0x2) return bytes.readUInt32LE(i + 3);
    if (mod === 0x0) return 0;
  }
  return null;
}

function cName(s) {
  return s.replace(/[^A-Za-z0-9]+/g, '_');
}

// Extracts the real getter bytes out of a shipped libnode. The synthetic matrix
// above does reproduce the shipped shapes once the right flags are in it (Fedora's
// frame record comes from `-mno-omit-leaf-frame-pointer`, not from LTO as first
// assumed), but the shipped binaries stay the authoritative source: they pin the
// field offset each Node version actually uses, which no probe can tell us.
function fromElf(soPath, symbol, label) {
  const nm = execFileSync('nm', ['-D', '--defined-only', soPath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const symLine = nm
    .split('\n')
    .find((line) => line.endsWith(` ${symbol}`) || line.includes(` ${symbol}`));
  if (!symLine) throw new Error(`symbol not found in ${soPath}: ${symbol}`);
  const vaddr = BigInt(`0x${symLine.trim().split(/\s+/)[0]}`);

  // Map the symbol's virtual address to a file offset via its section header.
  const sections = execFileSync('readelf', ['-S', '--wide', soPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let fileOffset = null;
  for (const line of sections.split('\n')) {
    const m = line.match(
      /^\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)/,
    );
    if (!m) continue;
    const addr = BigInt(`0x${m[2]}`);
    const off = BigInt(`0x${m[3]}`);
    const size = BigInt(`0x${m[4]}`);
    if (addr !== 0n && vaddr >= addr && vaddr < addr + size) {
      fileOffset = vaddr - addr + off;
      break;
    }
  }
  if (fileOffset === null) {
    throw new Error(`could not map ${symbol} vaddr to a file offset`);
  }

  const fd = fs.openSync(soPath, 'r');
  const raw = Buffer.alloc(CAPTURE_BYTES);
  fs.readSync(fd, raw, 0, CAPTURE_BYTES, Number(fileOffset));
  fs.closeSync(fd);

  const header = execFileSync('readelf', ['-h', soPath], { encoding: 'utf8' });
  const elfArch = /aarch64|ARM64/i.test(header)
    ? 'arm64'
    : /RISC-V/i.test(header)
      ? 'riscv64'
      : 'x64';
  let trimmed;
  if (elfArch === 'arm64') trimmed = trimArm64(raw);
  else if (elfArch === 'riscv64') {
    const walk = riscv64Walk(raw);
    trimmed = walk ? raw.subarray(0, walk.end) : null;
  } else trimmed = trimX64(raw);
  if (!trimmed) {
    return {
      arch: elfArch,
      toolchain: label,
      flags: 'real binary',
      bytes: raw.toString('hex'),
      untrimmed: true,
    };
  }
  return {
    arch: elfArch,
    toolchain: label,
    flags: 'real binary',
    bytes: Buffer.from(trimmed).toString('hex'),
  };
}

function emitInc(files) {
  const groups = [];
  for (const file of files) {
    groups.push(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  const lines = [];
  lines.push('// Generated by scripts/collect-getter-fixtures.mjs -- do not edit by hand.');
  lines.push('//');
  lines.push('// Real getter machine code, archived so the decoder self-test covers shapes');
  lines.push('// that toolchains and shipped binaries actually produce rather than only the');
  lines.push('// ones we thought to hand-assemble. Two sources:');
  lines.push('//');
  lines.push('//   * synthetic  - a probe with the same shape as the real accessor, compiled');
  lines.push('//                  under a matrix of optimization and hardening flags. The');
  lines.push('//                  Fedora entry uses that distribution\'s verbatim');
  lines.push('//                  `rpm --eval %{build_cflags}`, and reproduces its shipped');
  lines.push('//                  getter byte for byte.');
  lines.push('//   * real binary - bytes read straight out of a shipped libnode/node. These');
  lines.push('//                  are authoritative for the field offset, which moves between');
  lines.push('//                  Node versions (0x1f8 on 24, 0x208 on 26) and which no probe');
  lines.push('//                  can predict.');
  lines.push('//');
  lines.push('// expected_offset is computed by an independent decoder in the generator, so a');
  lines.push('// disagreement with the C++ decoder is a real signal, not a shared assumption.');
  lines.push('//');
  for (const g of groups) {
    const flagCount = g.shapes.reduce((n, s) => n + s.flags.length, 0);
    lines.push(
      `// ${g.arch} / ${g.toolchain}: ${g.shapes.length} distinct shapes from ${flagCount} configurations`,
    );
  }
  lines.push('');
  lines.push('struct GetterFixture {');
  lines.push('  const char* arch;');
  lines.push('  const char* source;');
  lines.push('  const char* config;');
  lines.push('  const unsigned char* bytes;');
  lines.push('  size_t size;');
  lines.push('  size_t expected_offset;');
  lines.push('  bool decodable;  // false => decoder is expected to reject this shape');
  lines.push('};');
  lines.push('');

  const entries = [];
  for (const g of groups) {
    for (const [index, shape] of g.shapes.entries()) {
      const sym = `kFx_${cName(g.arch)}_${cName(g.toolchain)}_${index}`;
      const bytes = Buffer.from(shape.bytes, 'hex');
      const offset = offsetFromBytes(bytes, shape.arch);
      // -O0 spills `this` through the stack before loading the field, so the
      // body is not a plain accessor and the decoder is expected to reject it.
      // Shipped Node is never built that way; the fixture records the shape so
      // the rejection stays deliberate instead of accidental.
      const decodable = shape.flags.every((f) => !/(^|\s)-O0(\s|$)/.test(f));
      const hex = [...bytes].map((b) => `0x${b.toString(16).padStart(2, '0')}`);
      const wrapped = [];
      for (let i = 0; i < hex.length; i += 8) {
        wrapped.push(`    ${hex.slice(i, i + 8).join(', ')},`);
      }
      lines.push(`// ${shape.flags.join('\n// ')}`);
      lines.push(`const unsigned char ${sym}[] = {`);
      lines.push(...wrapped);
      lines.push('};');
      entries.push({
        sym,
        arch: shape.arch,
        source: g.toolchain,
        config: shape.flags[0],
        size: bytes.length,
        offset: offset === null ? 0 : offset,
        decodable,
        count: shape.flags.length,
      });
    }
  }
  lines.push('');
  lines.push('const GetterFixture kGetterFixtures[] = {');
  for (const e of entries) {
    const note = e.count > 1 ? ` (+${e.count - 1} more)` : '';
    lines.push(
      `    {"${e.arch}", "${e.source}", "${e.config}${note}", ${e.sym}, ${e.size}, ` +
        `${e.offset}, ${e.decodable ? 'true' : 'false'}},`,
    );
  }
  lines.push('};');
  lines.push('');

  return `${lines.join('\n')}`;
}

const args = process.argv.slice(2);
if (args[0] === '--emit-inc') {
  process.stdout.write(emitInc(args.slice(1)));
} else if (args[0] === '--from-elf') {
  // --from-elf <label> <libnode.so> [<libnode.so> ...]
  const label = args[1];
  const symbol = '_ZNK4node14PrincipalRealm22builtin_module_requireEv';
  const shapes = args.slice(2).map((so) => fromElf(so, symbol, label));
  process.stdout.write(
    `${JSON.stringify(
      {
        arch: shapes[0].arch,
        toolchain: label,
        // Real binaries carry whatever offset their own layout uses, so the
        // expected offset is per-fixture rather than global.
        expected_offset: null,
        shapes: shapes.map((s) => ({ ...s, flags: [s.flags] })),
        skipped: [],
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`${JSON.stringify(collect(), null, 2)}\n`);
}
