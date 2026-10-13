#!/usr/bin/env python3
"""Render a seal-style 食 icon; iOS applies its own rounded mask.

Run with /opt/menu/venv/bin/python (Pillow 11.3.0), or the project's .venv.
Requires the system fonts-noto-cjk package; generated PNGs are committed.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
destination = root / 'frontend/public/icons'
destination.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', 700, index=2)
canvas = Image.new('RGB', (1024, 1024), '#ab4b32')
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((66, 66, 958, 958), radius=44, outline='#d59170', width=9)
bounds = draw.textbbox((0, 0), '食', font=font)
left = 512 - (bounds[2] - bounds[0]) / 2 - bounds[0]
top = 496 - (bounds[3] - bounds[1]) / 2 - bounds[1]
draw.text((left, top), '食', font=font, fill='#fff6df')
# A short off-center brush flourish gives the seal a hand-made rhythm.
draw.line([(372, 887), (495, 876), (661, 880)], fill='#fff6df', width=15)
for size, name in [(180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(destination / name, optimize=True)
print('Generated opaque 180/192/512 px 食 icons in frontend/public/icons/')
