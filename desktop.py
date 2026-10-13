import os
import sys
import threading
from pathlib import Path


def get_data_directory():
    if sys.platform == "win32":
        base_directory = os.getenv("LOCALAPPDATA")
        if not base_directory:
            base_directory = Path.home() / "AppData" / "Local"
        return Path(base_directory) / "StockNSales"

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "StockNSales"

    base_directory = os.getenv("XDG_DATA_HOME")
    if base_directory:
        return Path(base_directory) / "stock-n-sales"
    return Path.home() / ".local" / "share" / "stock-n-sales"


def main():
    data_directory = get_data_directory()
    data_directory.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault(
        "STOCK_N_SALES_DB_PATH",
        str(data_directory / "stock_n_sales.db"),
    )
    os.environ.setdefault("STOCK_N_SALES_CONFIG_DIR", str(data_directory))

    from webview import create_window, start
    from werkzeug.serving import make_server

    from backend.app import app

    server = make_server("127.0.0.1", 0, app, threaded=True)
    server_thread = threading.Thread(
        target=server.serve_forever,
        daemon=True,
    )
    server_thread.start()

    try:
        create_window(
            "Stock N Sales",
            f"http://127.0.0.1:{server.server_port}/",
            width=1280,
            height=820,
            min_size=(960, 640),
        )
        start(debug=False)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
