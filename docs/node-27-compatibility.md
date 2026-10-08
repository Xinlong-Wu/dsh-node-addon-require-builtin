# Node 27 nightly 兼容修复

## 现状与问题

Node `v27.0.0-nightly202610086d5e309871` 升级到 V8
`15.5.35.20-node.14` 后，macOS arm64 的 N-API 预构建在读取 Realm 时失败。
当前代码只查找接受 `EmbedderDataTypeTag` 的 slow getter，该导出已经消失。
插件按预期返回 `Unsupported/no-realm`，没有继续访问未经验证的指针。

同一次 CI 中，其他平台拿到的是较早的 Node 27 nightly，V8 版本不同，
旧入口仍然存在。因此不能仅按 Node major 切换入口。

## 可行路线与取舍

- 根据 Node 或 V8 版本判断入口：nightly 的日期、平台和 V8 版本并不一致，
  已知导出符号比版本阈值更直接。
- 调用新的 slow getter：它接受 `CppHeapPointerTag`，不再接受原始
  `EmbedderDataTypeTag`。仅替换符号名会绕过 V8 的 tag 转换和 wrapper 解包，不能采用。
- 解析接受原始 tag 的公开 C++ getter：V8 15.5 将此入口移出 inline，
  符号为 `_ZN2v87Context33GetAlignedPointerFromEmbedderDataEit`。
  优先使用它；不存在时解析旧 slow getter 的精确签名。采用此路线。

## 职责与改动

| 对象或层次 | 职责与改动 |
|---|---|
| `NapiRuntimeProfile` | 保留现有 tag 约定：Node 26+ 为 2，已支持的 Electron 为 0 |
| `NapiEmbedderDataReader` | 封装入口解析与调用；tagged 和 untagged 路径互不回退 |
| Windows 符号表 | 增加公开 getter 的 MSVC 名称映射 |
| Runtime context / shared probe | 保留指针对齐、镜像、机器码、handle 和 smoke 校验 |
| Runtime profile 自测 | 覆盖入口优先级、tag/slot/context 传递、缺失导出与错误 ABI |
| CI | 恢复六个平台、两套产品的 Node 27 nightly 行为和 require-parity 测试 |

成功找到入口后只调用一次；空指针交给既有指针校验拒绝，不尝试其他入口。
后续 V8 如果再次改变签名，应在 reader 中增加有源码依据的入口，并配套自测。

## 推进与验收

- 使用官方 macOS arm64 nightly 复现原错误，再验证同一预构建能通过 Node 27。
- 执行 Node 20/22/24/26 回归、两套产品与 optional package 检查。
- CI 使用 `check-latest`，记录实际 Node/V8/架构；其他平台以原生 runner 验证。
- Node 27 仅恢复 nightly 兼容覆盖，不增加发布包、musl 或 nodeabi 的支持承诺。

源码依据：Node nightly [V8 context 声明](https://github.com/nodejs/node/blob/6d5e30987117e072bb4638c0535946464a314b7e/deps/v8/include/v8-context.h#L319-L329)、
[V8 API 实现](https://github.com/nodejs/node/blob/6d5e30987117e072bb4638c0535946464a314b7e/deps/v8/src/api/api.cc#L1038-L1066)
与 [Node Realm 读取](https://github.com/nodejs/node/blob/6d5e30987117e072bb4638c0535946464a314b7e/src/node_realm-inl.h#L20-L25)。
