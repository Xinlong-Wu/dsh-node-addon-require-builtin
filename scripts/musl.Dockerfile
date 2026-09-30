# Shared CI/release builder for the musl optional packages.
# The maintained Alpine release floats within 3.23 so distro rebuilds are tested;
# exact Node/APK versions, getter instructions and binary hashes are recorded.
ARG ALPINE_IMAGE=public.ecr.aws/docker/library/alpine:3.23
FROM ${ALPINE_IMAGE} AS build
ARG TARGETARCH
RUN case "$TARGETARCH/$(uname -m)" in arm64/aarch64|amd64/x86_64) ;; *) exit 1 ;; esac \
    && apk add --no-cache nodejs nodejs-dev npm g++ curl binutils \
    && npm install --global pnpm@9.15.9
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/ ./packages/
COPY scripts/ ./scripts/
COPY test/ ./test/
RUN pnpm install --ignore-scripts --frozen-lockfile && pnpm build:ts
RUN set -eu; \
    test "$(node -p 'process.versions.node.split(".")[0]')" = 24; \
    eval "$(node --import tsx scripts/prepare-nodeabi-headers.ts)"; \
    export NODE_INCLUDE_DIR="$NODE_JS_PUBLIC_INCLUDE_DIRS"; \
    for product in require-builtin internal-loader; do \
      for backend in napi nodeabi; do \
        output=build; \
        if [ "$backend" = napi ]; then output=prebuild; fi; \
        NARB_PRODUCT="$product" NARB_BACKEND="$backend" NARB_BUILD_OUTPUT="$output" \
          node --import tsx scripts/build.ts; \
      done; \
    done; \
    pnpm test:decoder

# Assemble only the JS entrypoints, native binaries and test harness. No native
# sources, headers, package manager, build scripts or compiler enter this output.
RUN set -eu; \
    for package in loader require-builtin/entry internal-loader/entry; do \
      mkdir -p "/artifacts/packages/$package"; \
      cp "packages/$package/package.json" "/artifacts/packages/$package/"; \
      cp -R "packages/$package/lib" "/artifacts/packages/$package/"; \
    done; \
    arch=$(node -p 'process.arch'); \
    for product in require-builtin internal-loader; do \
      cp -R "packages/$product/entry/build" "/artifacts/packages/$product/entry/"; \
      cp -R "packages/$product/linux-$arch-musl" "/artifacts/packages/$product/"; \
    done; \
    mkdir -p /artifacts/node_modules /artifacts/test; \
    ln -s ../packages/loader /artifacts/node_modules/node-addon-native-custom-loader; \
    cp test/product.js test/backend.test.js test/require-parity.test.js \
      test/libc.test.js test/musl.test.js /artifacts/test/; \
    cd /artifacts; \
    node -p 'process.versions.node' > NODE_VERSION; \
    node -p 'process.arch' > NODE_ARCH; \
    apk list --installed musl nodejs libstdc++ > BUILD_ENVIRONMENT.txt; \
    readelf -l /usr/bin/node > NODE_ELF.txt; \
    objdump -d --disassemble=_ZNK4node14PrincipalRealm22builtin_module_requireEv \
      /usr/bin/node > GETTER_DISASSEMBLY.txt; \
    for binary in packages/*/entry/build/*/*/*.node packages/*/linux-*-musl/prebuilt/*.node; do \
      readelf -d "$binary"; \
      readelf --version-info "$binary"; \
    done > ADDON_ELF.txt; \
    sha256sum packages/*/entry/build/*/*/*.node packages/*/linux-*-musl/prebuilt/*.node > SHA256SUMS

FROM ${ALPINE_IMAGE} AS runtime
RUN apk add --no-cache nodejs libstdc++
WORKDIR /workspace
COPY --from=build /artifacts/ ./
ENV NARB_TRACE=1
CMD ["node", "test/musl.test.js"]
