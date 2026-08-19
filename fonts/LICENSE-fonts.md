# Bundled fonts

Both families are licensed under the **SIL Open Font License 1.1** (OFL), which
permits bundling and redistribution with the reserved-name and license-retention
conditions. The full license text of each is carried next to the files, as the
OFL requires: `OFL-space-grotesk.txt`, `OFL-jetbrains-mono.txt`.

`build.mjs` copies `fonts/*.woff2` and both `OFL-*.txt` files into `dist/fonts/`.
Nothing is fetched from a third-party host at page load — the page requests only
its own origin, and it renders correctly on the system font stack if these files
fail to load.

## Space Grotesk — headings and prose

| | |
| --- | --- |
| Version | 5.3.0 (Fontsource package; upstream Space Grotesk 2.0) |
| Authors | The Space Grotesk Project Authors, © 2020 |
| Upstream | https://github.com/floriankarsten/space-grotesk |
| Obtained from | https://registry.npmjs.org/@fontsource/space-grotesk/-/space-grotesk-5.3.0.tgz |
| License | SIL Open Font License 1.1 — `OFL-space-grotesk.txt` |
| Subset | latin only, as shipped by Fontsource |

| File | SHA-256 |
| --- | --- |
| `space-grotesk-latin-400-normal.woff2` | `65fd17fcbd2e2f522940b5f67ead3d23329e02891aa5495e74d11a499c0b0673` |
| `space-grotesk-latin-500-normal.woff2` | `1b1a8131d9edf975d9decee81e2f2bf504812f7a4f498e5500f28a613e22e64c` |
| `space-grotesk-latin-700-normal.woff2` | `35f8aec56cfd5cbfdb03cc68733a54a0b05bb3617ffcd5fd332badc0b045ca55` |

## JetBrains Mono — code, data and badges

| | |
| --- | --- |
| Version | 5.3.0 (Fontsource package; upstream JetBrains Mono 2.304) |
| Authors | The JetBrains Mono Project Authors, © 2020 |
| Upstream | https://github.com/JetBrains/JetBrainsMono |
| Obtained from | https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz |
| License | SIL Open Font License 1.1 — `OFL-jetbrains-mono.txt` |
| Subset | latin only, as shipped by Fontsource |

| File | SHA-256 |
| --- | --- |
| `jetbrains-mono-latin-400-normal.woff2` | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `jetbrains-mono-latin-700-normal.woff2` | `d0d4e818808f2a0ba39b2b09d1989366f63494e295f003c7ef436697378507e8` |

## Weight budget

96 KB across five woff2 files, all latin-subset. Only the weights the page
actually uses are shipped: text 400/500/700, mono 400/700. Glyphs outside the
latin subset (the `→` and `✓` the page uses) fall through to the system stack by
design, via the `unicode-range` descriptor.
