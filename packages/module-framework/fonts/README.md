# Fonts for PDF documents of record

Noto Sans (Latin) and Noto Sans for nine Indian scripts (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam), Regular and Bold, static unhinted TrueType, unmodified. They are licensed under the SIL Open Font License 1.1 (`OFL.txt`). They live in the module-framework core archive and are found by plugins through `globalThis.__campusosFontDir`, which the host sets, so no plugin archive carries a copy of them (P0-09, decision D10). `@campusos/module-framework/pdf` reads them.

Source: `https://github.com/notofonts/notofonts.github.io/raw/c1d3718e2a0eb25c2567a694ee017061fdaa5f51/fonts/<Family>/unhinted/ttf/<Family>-<Weight>.ttf`; `OFL.txt` from `https://github.com/notofonts/devanagari/raw/main/OFL.txt`.

sha256 (check with `sha256sum -c` over this list):

```
f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8  NotoSans-Regular.ttf
87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9  NotoSans-Bold.ttf
9c7d935139ea6a1e6ad9dbac4f6d27ece1e04bca8123c8888d00a0f9df4724cd  NotoSansDevanagari-Regular.ttf
ff2f76a23aad41e0608c2d7dbc4bacd247ff3bec78f0ec2a8fb106b561636e58  NotoSansDevanagari-Bold.ttf
5dceda02816fece18ea6796f474f5d3170f1d862f21b1e809cdc94b1caa4b6ec  NotoSansBengali-Regular.ttf
2fe8d779e0f19576d1fc11e39f9154b4326a17b693215017dd1f5a8898c3f2c3  NotoSansBengali-Bold.ttf
2454c944fda799d2861f11c03e492c453e33083dd1e8d99bd6baac8de71ad0f0  NotoSansGurmukhi-Regular.ttf
d16804da302ecb2a7defe0502e65136870445fd88f9fddaef60b68d5f1ee7386  NotoSansGurmukhi-Bold.ttf
18727143b8eadade0a59dca80959ef784bf8d55e07285d1b4096594dbf829f0a  NotoSansGujarati-Regular.ttf
3ce0cf6e1d0bfe2ef5823772eeb2f25da28ec0c2c1d99c0fce529025723e61a1  NotoSansGujarati-Bold.ttf
a16645d056017927406546aa78e4ce15e782fd8783467267b75450453d007415  NotoSansOriya-Regular.ttf
1c575e8aba40d6baf200e8abac534e9517f431d38cc8131715643037eec149da  NotoSansOriya-Bold.ttf
6634d9cc97a726e670df41281dd32b167a6b9b71f2036e19671ff08fdde0c292  NotoSansTamil-Regular.ttf
04a472e49fa83b387976756554fe179de631a950d79f652ebba14a39a44f5d71  NotoSansTamil-Bold.ttf
dcb86a5da09365a2d73d725e429403dca988e6d50c1b1d564579a25dbc18bd29  NotoSansTelugu-Regular.ttf
44393b05a863057cc2cbfe86623fc20b906b00cf19a2ae9304cdd0f3608889db  NotoSansTelugu-Bold.ttf
2870274619c2a4abe5d6b11fcb7c4a372eba765b6b7881d459b0eb0a609a68eb  NotoSansKannada-Regular.ttf
e989c72f6fec5a0b3366af5f90e3ce8b2b8a350fc5286c6374f0353937e513f5  NotoSansKannada-Bold.ttf
cc39bb1f7d63b582a2aec1abf2469a43b805a3523a27e0a0eee8cd32702541d5  NotoSansMalayalam-Regular.ttf
165d635d82b0eb0a04275b92b9334c1ece679b99f263727c24c7c92ebcab51e9  NotoSansMalayalam-Bold.ttf
a216f6f8d85c7228093e0ee5e258d9d377e6671f68acb4db1930b29583d0f331  OFL.txt
```
