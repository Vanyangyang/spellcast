# 字体来源

本目录字体随 Spellcast 前端资源分发，不安装到系统，也不从网络加载。唯一的 `@font-face` 声明在 `src/fonts.css`，主窗口、气泡和完成通知三个窗口共用。

## 文件

全部取自 [Fontsource](https://fontsource.org/) 5.2.5 版 npm 包（经 jsDelivr 下载：`https://cdn.jsdelivr.net/npm/<包>@5.2.5/files/<文件>`）。其中 400/500、衬线 500 与斜体 500 与此前入库的文件逐字节相同（SHA-256 已核对）；600 与直立 Cormorant 为本次补入。

| 文件 | 字体 · 字重 | 覆盖 | 字节 | SHA-256 | 来源文件 |
| --- | --- | --- | ---: | --- | --- |
| `noto-sans-sc-latin-400.woff2` | Noto Sans SC 400 | 拉丁 | 13432 | `969fb5ecdb8edcfccd615e87b16b8e053228fa20cff22eaa6cadfd1243bde8dd` | `@fontsource/noto-sans-sc` · `noto-sans-sc-latin-400-normal.woff2` |
| `noto-sans-sc-latin-500.woff2` | Noto Sans SC 500 | 拉丁 | 13496 | `7f78a6027d47999f3ecc952340c3723b20d7b797904c937b5b8da2893ac2ef00` | `@fontsource/noto-sans-sc` · `noto-sans-sc-latin-500-normal.woff2` |
| `noto-sans-sc-latin-600.woff2` | Noto Sans SC 600 | 拉丁 | 13496 | `9e818f42f31795af65c9059da5c18868a4784d0b171bbb6fdec1197497f439f8` | `@fontsource/noto-sans-sc` · `noto-sans-sc-latin-600-normal.woff2` |
| `noto-sans-sc-400.woff2` | Noto Sans SC 400 | 简体中文子集 | 1142704 | `58bd23de339ac01fae909f65abe1cddc8f982a19399357c7158c14d4d1f501c7` | `@fontsource/noto-sans-sc` · `noto-sans-sc-chinese-simplified-400-normal.woff2` |
| `noto-sans-sc-500.woff2` | Noto Sans SC 500 | 简体中文子集 | 1159068 | `3acc5fd069ae9f29f0f40b7cb23c51a9f5e341f3d7a0b3fd7e329f0bdb55e666` | `@fontsource/noto-sans-sc` · `noto-sans-sc-chinese-simplified-500-normal.woff2` |
| `noto-sans-sc-600.woff2` | Noto Sans SC 600 | 简体中文子集 | 1163544 | `48e800a41c978a3ed16f03e14f8da8619bb85d789c7703e7eee2405da6143511` | `@fontsource/noto-sans-sc` · `noto-sans-sc-chinese-simplified-600-normal.woff2` |
| `noto-serif-sc-500.woff2` | Noto Serif SC 500 | 简体中文子集 | 1526732 | `02c35dd59d123dfa691a697f409a9a1bda3d488d9b2fc6d41c31fd92822a3f56` | `@fontsource/noto-serif-sc` · `noto-serif-sc-chinese-simplified-500-normal.woff2` |
| `cormorant-600.woff2` | Cormorant Garamond 600 直立 | 拉丁 | 21012 | `066ec1ac2852906b7e7253ee3c129e0efd2343d8671712db064502f03228ccb0` | `@fontsource/cormorant-garamond` · `cormorant-garamond-latin-600-normal.woff2` |
| `cormorant-500-italic.woff2` | Cormorant Garamond 500 斜体 | 拉丁 | 21956 | `66b937da1d31b12fa88c8ca30027b668961bc40421451700fc182f745a3f7a6e` | `@fontsource/cormorant-garamond` · `cormorant-garamond-latin-500-italic.woff2` |

核对：`sha256sum public/fonts/*.woff2`。简体中文子集约含 7,300 个汉字、CJK 标点、假名（189/192）与全角字符；子集外的字（含日文专用汉字）按字体栈回退到系统字体，不会显示为方框。

## 用法

- 界面无衬线（`--font`）：Noto Sans SC，真实的 400、500、600；请求 700（加粗）时用 600，不再由浏览器合成。
- 标题衬线（`--display`）：中文用 Noto Serif SC 500；拉丁字母用 Cormorant Garamond 直立 600（请求 400/500 时也取它，与此前联网时的 Google Fonts 组合 `ital,wght@0,600;1,500` 一致）；字标 “Spellcast” 用 Cormorant Garamond 斜体 500。
- 气泡标题固定 500：中文衬线只有 500，要 600 会被合成加粗。
- 若本地文件未加载，界面回退到 Microsoft YaHei UI，不回退到宋体。

## 许可

三款字体均为 SIL Open Font License 1.1（Fontsource 包的 `license` 字段同为 `OFL-1.1`）。完整许可证与版权声明一并保留：`LICENSE-notosanssc.txt`、`LICENSE-notoserifsc.txt`、`LICENSE-cormorantgaramond.txt`，对应 Google Fonts 仓库各字体目录中的 `OFL.txt`；同一许可覆盖该字体的全部字重与样式。
