# Environment to build the Windows installer (NSIS) from Linux, without
# installing Rust, Node or Visual Studio on the machine. Follows Tauri's
# "Build Windows apps on Linux" guide: cargo-xwin + LLVM + NSIS.
FROM node:22-trixie-slim AS node

FROM rust:1-trixie

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# libayatana-appindicator3-dev doesn't end up in the .exe: the Tauri CLI,
# running on Linux, looks for this library because of the tray icon and
# aborts bundling if it's missing, even when targeting Windows.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nsis lld llvm clang libayatana-appindicator3-dev \
 && rm -rf /var/lib/apt/lists/*

# cargo-xwin calls the tools by their MSVC names; on Debian they only exist
# under their LLVM names. The binaries pick their mode from the name.
RUN for pair in clang-cl:clang llvm-lib:llvm-ar lld-link:lld; do \
      name="${pair%%:*}"; target="${pair#*:}"; \
      command -v "$name" >/dev/null || ln -s "$(command -v "$target")" "/usr/local/bin/$name"; \
    done

RUN rustup target add x86_64-pc-windows-msvc \
 && cargo install --locked cargo-xwin

# MSVC CRT and Windows SDK, downloaded by cargo-xwin on the first build.
ENV XWIN_CACHE_DIR=/xwin-cache
