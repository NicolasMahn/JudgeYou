The original Fraunces and IBM Plex Sans WOFF2 files are retained as local inputs.
The browser loads the generated `Fraunces-body-*`, `Fraunces-hero-*`, and
`IBMPlexSans-normal-400-700-*` files referenced by `css/fonts.css`.
There is no font generation step during the application build or at runtime.

To regenerate the committed outputs from the repository root:

```sh
python3 -m venv /tmp/judgeyou-fonttools
/tmp/judgeyou-fonttools/bin/pip install 'fonttools==4.67.0' 'brotli==1.2.1'
/tmp/judgeyou-fonttools/bin/python scripts/prepare-fonts.py
```

The script uses the official FontTools instancer, preserves the source timestamp
for deterministic WOFF2 output, and checks that every original character mapping
and glyph remains. It does not fetch fonts or require an application dependency.
The original Fraunces files already omit `WONK`. Their weight range remains
100–900 internally, with the existing CSS range of 400–900 unchanged.

Fraunces body text pins the existing default `SOFT=0` and retains variable optical
sizing. The hero pins `opsz=144`; its existing CSS `SOFT=30`, weights, and italics
remain unchanged. Its softness and weight axes are retained. Fully pinning the
hero or restricting Fraunces's weight range saved more bytes but changed pixels
and metrics, so those variants were rejected. Plex Sans removes only the weight
region below its default of 400 and retains 400–700; the site uses 400–600.

Measured on 2026-10-26 in local headless Chrome, with fonts loaded and animations
disabled: full-page PNGs and text bounds were identical in English, German,
French, and Spanish at 1440×1100 and 390×844 viewports. Broader body-font character
specimens also matched. Plex Sans matched 3,941 glyph/location outline and advance
comparisons across both subsets at weights 400, 450, 500, 550, 600, 650, and 700.

This is an appearance check for the current copy and tested browser, not a claim
of universal outline equality. FontTools can round inferred deltas when pinning
the hero's optical-size endpoint; unused hero characters showed small raster
differences in a broader specimen. **Rerun pixel comparisons after changing hero
copy**, including translations: compare the same page against the retained
original fonts at desktop and mobile sizes, wait for `document.fonts.ready`,
disable animation, and check text bounds and decoded PNG pixels. Other browser
engines and device pixel ratios were not checked.

Observed first-page font response bodies were the same in all four languages:

| Font bodies | Before | After |
| --- | ---: | ---: |
| Fraunces | 269,996 B | 228,940 B |
| Plex Sans | 45,712 B | 35,912 B |
| Plex Mono | 29,596 B | 29,596 B |
| Total | 345,304 B | 294,448 B |

The saving is 50,856 B (14.73%); font requests increase from five to six. The
Fraunces split loads hero normal, hero italic, and body italic initially. Body
normal and Latin Extended faces remain available for later content. The complete
generated font set is larger than the original set because the two Fraunces
roles overlap; a conservative benchmark that requests every CSS font URL must
not be described as the actual browser's initial waterfall. These byte counts
do not establish a latency or p95 improvement.

FontTools reference: <https://fonttools.readthedocs.io/en/latest/varLib/instancer.html>.
