#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python -m PyInstaller --noconfirm --clean packaging/StockNSales.spec
mkdir -p installer-output
productbuild \
  --component "dist/Stock N Sales.app" \
  /Applications \
  "installer-output/Stock-N-Sales-Setup-1.0.0-macOS.pkg"
