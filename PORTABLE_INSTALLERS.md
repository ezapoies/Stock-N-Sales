# Desktop installers

Stock N Sales can be packaged as a desktop application for Windows, macOS, and
Debian/Ubuntu Linux. Each installer must be built on its target operating
system; a Windows build cannot produce a working macOS or Linux application.

The desktop build hosts the existing Flask interface locally and opens it in a
native webview. It does not bundle the development virtual environment or the
project's `.env` file.

## Build requirements

Use Python 3.11 and install the app plus packaging dependencies:

```text
python -m pip install -r requirements-packaging.txt
```

On Windows, install Inno Setup 6 and ensure `ISCC.exe` is on `PATH`, then run:

```powershell
.\scripts\build-installer.ps1
```

On macOS, run `bash scripts/package-macos.sh` on the architecture you want to
support. On Debian 12 or Ubuntu 24.04 Linux, install the PyWebView GTK/WebKit
build prerequisites and `dpkg-deb`, then run `bash scripts/package-linux.sh`.
The Linux installer currently targets 64-bit Intel/AMD systems.

Installers are written to `installer-output`. macOS packages are unsigned;
public distribution will require an Apple Developer signing and notarization
setup. Windows distribution should also be code-signed before broad public
release.

## User data and cloud sync

Database and workspace files are stored outside the installation directory:

- Windows: `%LOCALAPPDATA%\StockNSales`
- macOS: `~/Library/Application Support/StockNSales`
- Linux: `$XDG_DATA_HOME/stock-n-sales` or `~/.local/share/stock-n-sales`

Cloud sync configuration is optional and is read from `.env` in that same
directory. To enable it, create that file with your own Atlas connection string:

```dotenv
MONGO_URI=<your MongoDB Atlas connection string>
```

Do not put private Atlas credentials in the installer or source control.
Existing databases in a development project folder are not copied
automatically; back them up and move them into the platform's data directory
before switching to an installed build.
