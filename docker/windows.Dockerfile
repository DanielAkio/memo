# Ambiente para gerar o instalador do Windows (NSIS) a partir do Linux, sem
# instalar Rust, Node ou o Visual Studio na máquina. Segue o guia do Tauri
# "Build Windows apps on Linux": cargo-xwin + LLVM + NSIS. O .msi não sai
# daqui (o WiX só roda no Windows); para ele, use a CI.
FROM node:22-trixie-slim AS node

FROM rust:1-trixie

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# libayatana-appindicator3-dev não entra no .exe: a CLI do Tauri, rodando no
# Linux, procura essa biblioteca por causa do ícone de bandeja e aborta o
# empacotamento se não achar, mesmo com alvo Windows.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nsis lld llvm clang libayatana-appindicator3-dev \
 && rm -rf /var/lib/apt/lists/*

# O cargo-xwin chama as ferramentas pelos nomes do MSVC; no Debian elas só
# existem com os nomes do LLVM. Os binários escolhem o modo pelo nome.
RUN for par in clang-cl:clang llvm-lib:llvm-ar lld-link:lld; do \
      nome="${par%%:*}"; alvo="${par#*:}"; \
      command -v "$nome" >/dev/null || ln -s "$(command -v "$alvo")" "/usr/local/bin/$nome"; \
    done

RUN rustup target add x86_64-pc-windows-msvc \
 && cargo install --locked cargo-xwin

# CRT do MSVC e SDK do Windows baixados pelo cargo-xwin no primeiro build.
ENV XWIN_CACHE_DIR=/xwin-cache
