#!/usr/bin/env python3
"""Resize the generated calligraphic 食 source; iOS applies its own mask.

Run with /opt/menu/venv/bin/python (Pillow 11.3.0), or the project's .venv.
The source image and generated PNGs are committed; no system font is needed.
"""
from pathlib import Path
from PIL import Image, ImageChops

root = Path(__file__).resolve().parents[1]
destination = root / 'frontend/public/icons'
destination.mkdir(parents=True, exist_ok=True)
source = root / 'assets/app-icon/calligraphy-source.png'
with Image.open(source) as original:
    original = original.convert('RGB')
    red, green, blue = original.split()
    # Export the generated brush strokes in the exact two brand colors.
    # The ivory ink is bright in all channels; the red backdrop is dark in blue.
    ink = ImageChops.darker(ImageChops.darker(red, green), blue)
    mask = ink.point(lambda value: max(0, min(255, round((value - 120) * 255 / 103))))
    canvas = Image.composite(Image.new('RGB', original.size, '#fff6df'),
                             Image.new('RGB', original.size, '#ab4b32'), mask)
for size, name in [(180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(destination / name, optimize=True)
print('Resized calligraphic 食 to opaque 180/192/512 px icons in frontend/public/icons/')
