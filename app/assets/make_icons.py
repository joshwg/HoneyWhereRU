"""Render the app icon set: a street map with a blue "you are here" dot.

The design lives in a 1024x1024 frame. Android adaptive-icon layers use the
larger viewBox (-256..1280) because launchers only show the middle 72/108 of
each layer, so the visible crop matches the iOS icon exactly.
"""
import io
import sys

import resvg_py
from PIL import Image

OUT = sys.argv[1]

FULL = "0 0 1024 1024"
ADAPTIVE = "-256 -256 1536 1536"

MAP = """
<g transform="rotate(-14 512 512)">
  <rect x="-1200" y="-1200" width="3424" height="3424" fill="#F2EFE6"/>
  <!-- parks -->
  <rect x="-900" y="-900" width="1110" height="1150" rx="70" fill="#C8E6BE"/>
  <rect x="150" y="820" width="250" height="210" rx="36" fill="#C8E6BE"/>
  <!-- lake -->
  <path d="M 690 -900 L 690 40 C 700 170, 820 250, 980 260 C 1140 270, 1300 330, 1900 330 L 1900 -900 Z" fill="#A9D2F3"/>
  <!-- minor streets: outline then fill -->
  <g stroke="#DCD7C9" stroke-width="40" fill="none">
    <path d="M -900 330 H 1900"/><path d="M -900 690 H 1900"/>
    <path d="M 310 -900 V 1900"/><path d="M 600 330 V 1900"/>
    <path d="M -900 1010 H 1900"/><path d="M 900 330 V 1900"/>
  </g>
  <g stroke="#FFFFFF" stroke-width="28" fill="none">
    <path d="M -900 330 H 1900"/><path d="M -900 690 H 1900"/>
    <path d="M 310 -900 V 1900"/><path d="M 600 330 V 1900"/>
    <path d="M -900 1010 H 1900"/><path d="M 900 330 V 1900"/>
  </g>
  <!-- main road -->
  <path d="M -900 1500 C -100 1050, 250 560, 520 500 S 1100 470, 1900 -200" stroke="#E6B54A" stroke-width="78" fill="none"/>
  <path d="M -900 1500 C -100 1050, 250 560, 520 500 S 1100 470, 1900 -200" stroke="#FFD677" stroke-width="60" fill="none"/>
</g>
"""

DOT = """
<defs>
  <radialGradient id="dotfill" cx="0.4" cy="0.35" r="0.75">
    <stop offset="0" stop-color="#4F8DF7"/>
    <stop offset="1" stop-color="#1D4ED8"/>
  </radialGradient>
  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="10"/>
  </filter>
</defs>
<circle cx="512" cy="512" r="225" fill="#2563EB" fill-opacity="0.18" stroke="#2563EB" stroke-opacity="0.45" stroke-width="7"/>
<circle cx="512" cy="530" r="116" fill="#000" fill-opacity="0.28" filter="url(#shadow)"/>
<circle cx="512" cy="512" r="116" fill="#FFFFFF"/>
<circle cx="512" cy="512" r="88" fill="url(#dotfill)"/>
"""

# Android themed-icon layer: one colour, only the alpha channel matters.
MONO = """
<circle cx="512" cy="512" r="225" fill="none" stroke="#000" stroke-width="22"/>
<circle cx="512" cy="512" r="116" fill="#000"/>
"""


def svg(view_box: str, body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" width="1024" height="1024">{body}</svg>'


def render(markup: str, size: int, path: str, opaque: bool = False) -> None:
    png = bytes(resvg_py.svg_to_bytes(svg_string=markup, width=size, height=size))
    img = Image.open(io.BytesIO(png))
    img = img.convert("RGB") if opaque else img.convert("RGBA")
    img.save(f"{OUT}/{path}", optimize=True)


icon = svg(FULL, MAP + DOT)
render(icon, 1024, "icon.png", opaque=True)  # iOS rejects icons with alpha
render(icon, 48, "favicon.png")
render(svg(ADAPTIVE, MAP), 1024, "android-icon-background.png", opaque=True)
render(svg(ADAPTIVE, DOT), 1024, "android-icon-foreground.png")
render(svg(ADAPTIVE, MONO), 1024, "android-icon-monochrome.png")

with open(f"{OUT}/icon.svg", "w") as f:
    f.write(icon)
