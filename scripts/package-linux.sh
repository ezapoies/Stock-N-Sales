#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python -m PyInstaller --noconfirm --clean packaging/StockNSales.spec
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p \
  "$STAGING/DEBIAN" \
  "$STAGING/opt/stock-n-sales" \
  "$STAGING/usr/bin" \
  "$STAGING/usr/share/applications" \
  "$STAGING/usr/share/icons/hicolor/256x256/apps" \
  installer-output
cp -a dist/StockNSales/. "$STAGING/opt/stock-n-sales/"
cp Logo.png "$STAGING/usr/share/icons/hicolor/256x256/apps/stock-n-sales.png"
cat > "$STAGING/DEBIAN/control" <<'CONTROL'
Package: stock-n-sales
Version: 1.0.0
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Stock N Sales
Depends: libgtk-3-0, libwebkit2gtk-4.1-0
Description: Inventory and sales management for small businesses
CONTROL
cat > "$STAGING/usr/bin/stock-n-sales" <<'LAUNCHER'
#!/bin/sh
exec /opt/stock-n-sales/StockNSales "$@"
LAUNCHER
chmod 755 "$STAGING/usr/bin/stock-n-sales"
cat > "$STAGING/usr/share/applications/stock-n-sales.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Stock N Sales
Exec=stock-n-sales
Icon=stock-n-sales
Categories=Office;Finance;
Terminal=false
DESKTOP
dpkg-deb --build --root-owner-group \
  "$STAGING" \
  "installer-output/Stock-N-Sales-Setup-1.0.0-Linux-amd64.deb"
