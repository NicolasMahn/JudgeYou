#!/usr/bin/env python3
"""Prepare webfonts without changing the site's glyphs or design settings.

Run with the isolated, pinned FontTools environment documented in fonts/README.md.
Original WOFF2 files remain the inputs; generated files are committed.
"""

from importlib.metadata import version
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


FONTS = Path(__file__).resolve().parents[1] / "fonts"


def save_instance(font: TTFont, limits: dict, output: Path) -> None:
    result = instantiateVariableFont(font, limits, inplace=False)
    if result.getBestCmap() != font.getBestCmap():
        raise SystemExit(f"Character coverage changed for {output.name}")
    if result.getGlyphOrder() != font.getGlyphOrder():
        raise SystemExit(f"Glyph coverage changed for {output.name}")
    result.save(output)
    print(f"{output.name}: {output.stat().st_size:,} bytes")


def main() -> None:
    for package, expected in (("fonttools", "4.67.0"), ("brotli", "1.2.1")):
        if version(package) != expected:
            raise SystemExit(f"Use {package}=={expected}; see fonts/README.md")

    for style in ("normal", "italic"):
        for subset in ("latin", "latin-ext"):
            source = FONTS / f"Fraunces-{style}-400-900-{subset}.woff2"
            with TTFont(source, recalcTimestamp=False) as font:
                axes = {axis.axisTag: axis for axis in font["fvar"].axes}
                if axes["SOFT"].defaultValue != 0 or axes["opsz"].maxValue != 144:
                    raise SystemExit(f"Unexpected design coordinates in {source.name}")

                # Pin only a default or an endpoint. Intermediate coordinates and
                # narrower weight ranges round outlines and can change pixels.
                for role, limits in (("body", {"SOFT": 0}), ("hero", {"opsz": 144})):
                    output = FONTS / f"Fraunces-{role}-{style}-400-900-{subset}.woff2"
                    save_instance(font, limits, output)

    for subset in ("latin", "latin-ext"):
        source = FONTS / f"IBMPlexSans-normal-400-{subset}.woff2"
        with TTFont(source, recalcTimestamp=False) as font:
            weight = next(axis for axis in font["fvar"].axes if axis.axisTag == "wght")
            if weight.defaultValue != 400 or weight.maxValue != 700:
                raise SystemExit(f"Unexpected weight coordinates in {source.name}")
            # Remove only the region below the default; interpolation at every
            # weight the site uses (400–600) remains unchanged.
            output = FONTS / f"IBMPlexSans-normal-400-700-{subset}.woff2"
            save_instance(font, {"wght": (400, 700)}, output)


if __name__ == "__main__":
    main()
