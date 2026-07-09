#!/bin/bash
# Generate PNG favicons from SVG logo
# Requires: rsvg-convert (brew install librsvg) or inkscape

SOURCE="public/logo/veros-icon.svg"
DEST="public/logo"

if command -v rsvg-convert &> /dev/null; then
  rsvg-convert -w 16 -h 16 "$SOURCE" -o "$DEST/favicon-16.png"
  rsvg-convert -w 32 -h 32 "$SOURCE" -o "$DEST/favicon-32.png"
  rsvg-convert -w 180 -h 180 "$SOURCE" -o "$DEST/apple-touch-icon.png"
  rsvg-convert -w 192 -h 192 "$SOURCE" -o "$DEST/icon-192.png"
  rsvg-convert -w 512 -h 512 "$SOURCE" -o "$DEST/icon-512.png"
  echo "Generated PNG icons in $DEST"
elif command -v inkscape &> /dev/null; then
  inkscape "$SOURCE" -w 16 -h 16 -o "$DEST/favicon-16.png"
  inkscape "$SOURCE" -w 32 -h 32 -o "$DEST/favicon-32.png"
  inkscape "$SOURCE" -w 180 -h 180 -o "$DEST/apple-touch-icon.png"
  inkscape "$SOURCE" -w 192 -h 192 -o "$DEST/icon-192.png"
  inkscape "$SOURCE" -w 512 -h 512 -o "$DEST/icon-512.png"
  echo "Generated PNG icons in $DEST"
else
  echo "Install librsvg (brew install librsvg) or inkscape to generate PNGs"
  echo "SVGs work directly for favicons in modern browsers"
fi
