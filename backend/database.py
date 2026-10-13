import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime

from flask import has_request_context, session


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE_PATH = os.getenv(
    "STOCK_N_SALES_DB_PATH",
    os.path.join(BASE_DIR, "stock_n_sales.db"),
)
DATABASE_NAME, DATABASE_EXTENSION = os.path.splitext(DATABASE_PATH)
WORKSPACE_REGISTRY_PATH = (
    f"{DATABASE_NAME}_workspaces{DATABASE_EXTENSION or '.db'}"
)
_initialized_databases = set()
_initialization_lock = threading.Lock()


def get_database_path(user_id=None):
    if user_id is None and has_request_context():
        user_id = session.get("cloud_user_id") or session.get("local_workspace_id")

    if not user_id:
        return DATABASE_PATH

    safe_user_id = re.sub(r"[^A-Za-z0-9_-]", "", str(user_id))
    if not safe_user_id:
        raise ValueError("Invalid cloud account ID.")

    database_name, extension = os.path.splitext(DATABASE_PATH)
    return f"{database_name}_{safe_user_id}{extension or '.db'}"


def get_workspace_registry_connection():
    connection = sqlite3.connect(WORKSPACE_REGISTRY_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("""
        CREATE TABLE IF NOT EXISTS local_workspaces (
            id TEXT PRIMARY KEY,
            userName TEXT NOT NULL,
            businessName TEXT NOT NULL,
            createdAt TEXT NOT NULL
        )
    """)
    connection.commit()
    return connection


def list_local_workspaces():
    connection = get_workspace_registry_connection()
    try:
        return [
            dict(row)
            for row in connection.execute(
                """
                SELECT id, userName, businessName, createdAt
                FROM local_workspaces
                ORDER BY createdAt ASC, businessName COLLATE NOCASE ASC
                """
            ).fetchall()
        ]
    finally:
        connection.close()


def create_local_workspace(user_name, business_name):
    workspace_id = f"local-{uuid.uuid4()}"
    created_at = get_current_timestamp()
    registry = get_workspace_registry_connection()
    try:
        registry.execute(
            """
            INSERT INTO local_workspaces (id, userName, businessName, createdAt)
            VALUES (?, ?, ?, ?)
            """,
            (workspace_id, user_name, business_name, created_at),
        )
        registry.commit()
    finally:
        registry.close()

    initialize_database(get_database_path(workspace_id))
    connection = sqlite3.connect(get_database_path(workspace_id))
    try:
        connection.execute(
            """
            INSERT INTO user_profile
                (id, userName, businessName, createdAt, updatedAt)
            VALUES (1, ?, ?, ?, ?)
            """,
            (user_name, business_name, created_at, created_at),
        )
        connection.commit()
    finally:
        connection.close()

    return {
        "id": workspace_id,
        "userName": user_name,
        "businessName": business_name,
        "createdAt": created_at,
    }


def local_workspace_exists(workspace_id):
    registry = get_workspace_registry_connection()
    try:
        return registry.execute(
            "SELECT 1 FROM local_workspaces WHERE id = ?",
            (workspace_id,),
        ).fetchone() is not None
    finally:
        registry.close()


def get_db_connection(user_id=None):
    database_path = get_database_path(user_id)
    if database_path not in _initialized_databases:
        initialize_database(database_path)

    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    return connection


def get_current_timestamp():
    return datetime.now().isoformat(timespec="seconds")


def add_column_if_missing(cursor, table_name, column_name, column_definition):
    cursor.execute(f"PRAGMA table_info({table_name})")
    existing_columns = {
        column["name"] for column in cursor.fetchall()
    }

    if column_name not in existing_columns:
        cursor.execute(
            f"ALTER TABLE {table_name} "
            f"ADD COLUMN {column_name} {column_definition}"
        )


def initialize_database(database_path=None):
    database_path = database_path or DATABASE_PATH
    with _initialization_lock:
        if database_path in _initialized_databases:
            return
        _initialize_database_file(database_path)
        _initialized_databases.add(database_path)


def _initialize_database_file(database_path):
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            price REAL NOT NULL,
            stock INTEGER NOT NULL,
            minimumStock INTEGER NOT NULL,
            createdAt TEXT,
            updatedAt TEXT,
            syncStatus TEXT DEFAULT 'pending',
            cloudId TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            createdAt TEXT,
            updatedAt TEXT,
            syncStatus TEXT DEFAULT 'pending',
            cloudId TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            productId INTEGER NOT NULL,
            productName TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            price REAL NOT NULL,
            total REAL NOT NULL,
            date TEXT NOT NULL,
            createdAt TEXT,
            updatedAt TEXT,
            syncStatus TEXT DEFAULT 'pending',
            cloudId TEXT,
            productCloudId TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sync_deletions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tableName TEXT NOT NULL,
            recordId INTEGER NOT NULL,
            deletedAt TEXT NOT NULL,
            syncStatus TEXT DEFAULT 'pending',
            cloudId TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            userName TEXT NOT NULL,
            businessName TEXT NOT NULL,
            passwordHash TEXT,
            createdAt TEXT,
            updatedAt TEXT
        )
    """)

    add_column_if_missing(cursor, "user_profile", "passwordHash", "TEXT")

    for table_name in ("products", "categories", "sales"):
        add_column_if_missing(cursor, table_name, "cloudId", "TEXT")
        add_column_if_missing(cursor, table_name, "createdAt", "TEXT")
        add_column_if_missing(cursor, table_name, "updatedAt", "TEXT")
        add_column_if_missing(
            cursor,
            table_name,
            "syncStatus",
            "TEXT DEFAULT 'pending'",
        )

    add_column_if_missing(cursor, "sales", "productCloudId", "TEXT")
    add_column_if_missing(cursor, "sync_deletions", "cloudId", "TEXT")

    current_time = get_current_timestamp()
    for table_name in ("products", "categories", "sales"):
        cursor.execute(
            f"""
            UPDATE {table_name}
            SET createdAt = COALESCE(createdAt, ?),
                updatedAt = COALESCE(updatedAt, ?),
                syncStatus = COALESCE(syncStatus, 'pending')
            WHERE createdAt IS NULL
               OR updatedAt IS NULL
               OR syncStatus IS NULL
            """,
            (current_time, current_time),
        )
        cursor.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS "
            f"idx_{table_name}_cloud_id ON {table_name}(cloudId) "
            "WHERE cloudId IS NOT NULL"
        )

    connection.commit()
    connection.close()


def copy_local_workspace(user_id, user_name, business_name):
    target_path = get_database_path(user_id)
    if os.path.exists(target_path):
        return False

    source = sqlite3.connect(get_database_path())
    target = sqlite3.connect(target_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()

    _initialized_databases.discard(target_path)
    initialize_database(target_path)

    connection = sqlite3.connect(target_path)
    timestamp = get_current_timestamp()
    try:
        connection.execute(
            """
            INSERT INTO user_profile
                (id, userName, businessName, passwordHash, createdAt, updatedAt)
            VALUES (1, ?, ?, NULL, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                userName = excluded.userName,
                businessName = excluded.businessName,
                passwordHash = NULL,
                updatedAt = excluded.updatedAt
            """,
            (user_name, business_name, timestamp, timestamp),
        )
        connection.commit()
    finally:
        connection.close()

    return True


def test_database():
    connection = None
    try:
        connection = get_db_connection()
        connection.execute("SELECT 1")
        print("SQLite database connection successful!")
        return True
    except Exception as error:
        print("SQLite database connection failed:")
        print(error)
        return False
    finally:
        if connection:
            connection.close()


initialize_database()
