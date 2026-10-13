from flask import Flask, jsonify, request, send_from_directory, session
from flask_cors import CORS
from datetime import datetime
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash
from pymongo.errors import DuplicateKeyError

import sys
import os
import secrets
import uuid
import math
import re
import threading


# ==========================================
# PROJECT PATH
# ==========================================

sys.path.append(
    os.path.dirname(
        os.path.dirname(
            os.path.abspath(__file__)
        )
    )
)


from ai.predict import predict_demand, predict_demand_range
from backend.database import (
    copy_local_workspace,
    create_local_workspace,
    get_db_connection,
    list_local_workspaces,
    local_workspace_exists,
    test_database
)

from backend.sync import (
    get_mongo_database,
    run_sync,
    trigger_sync,
    get_sync_state
)


PROJECT_ROOT = getattr(
    sys,
    "_MEIPASS",
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
)

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY") or secrets.token_hex(32)
CLOUD_ACCOUNT_REGISTRATION_LOCK = threading.Lock()
MOBILE_TOKEN_MAX_AGE = 60 * 60 * 24 * 30
MOBILE_TOKEN_SALT = "stock-n-sales-mobile-api-v1"
MOBILE_SYNC_COLLECTIONS = ("products", "categories", "sales")

mobile_app_origins = [
    origin.strip()
    for origin in os.getenv(
        "MOBILE_APP_ORIGINS",
        "https://localhost,capacitor://localhost",
    ).split(",")
    if origin.strip()
]
CORS(app, supports_credentials=True, origins=[
    r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    *mobile_app_origins,
], allow_headers=["Content-Type", "Authorization"])

PUBLIC_API_PATHS = {
    "/api/test",
    "/api/workspaces",
    "/api/workspaces/select",
    "/api/workspaces/leave",
    "/api/cloud/register",
    "/api/cloud/login",
    "/api/auth/logout",
    "/api/account",
    "/api/account/password",
    "/api/account/delete",
    "/api/mobile/auth/login",
    "/api/mobile/auth/register",
    "/api/mobile/sync",
}


def account_payload(user):
    return {
        "userId": user.get("userId"),
        "email": user.get("email"),
        "userName": user.get("userName") or "",
        "businessName": user.get("businessName") or "",
        "createdAt": user.get("createdAt"),
    }


def update_account(cloud_db, user_id, data):
    changes = {}
    for field, label in (("userName", "Your name"), ("businessName", "Business name")):
        if field in data:
            value = data[field]
            if not isinstance(value, str) or not value.strip():
                return None, (jsonify({"error": f"{label} is required."}), 400)
            changes[field] = value.strip()
    if "email" in data:
        email = data["email"]
        if not isinstance(email, str) or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email.strip()):
            return None, (jsonify({"error": "Enter a valid email address."}), 400)
        changes["email"] = email.strip().casefold()
        if cloud_db.users.find_one({"email": changes["email"], "userId": {"$ne": user_id}}):
            return None, (jsonify({"error": "An account already uses that email."}), 409)
    if not changes:
        return None, (jsonify({"error": "Enter account details to update."}), 400)
    cloud_db.users.update_one({"userId": user_id}, {"$set": changes})
    user = cloud_db.users.find_one({"userId": user_id})
    if "userName" in changes or "businessName" in changes:
        connection = get_db_connection(user_id)
        try:
            connection.execute(
                "UPDATE user_profile SET userName = ?, businessName = ?, updatedAt = ? WHERE id = 1",
                (user.get("userName") or "", user.get("businessName") or "", get_current_timestamp()),
            )
            connection.commit()
        finally:
            connection.close()
    return account_payload(user), None


def change_account_password(cloud_db, user_id, data):
    current = data.get("currentPassword")
    new = data.get("newPassword")
    user = cloud_db.users.find_one({"userId": user_id})
    if not isinstance(current, str) or not user or not check_password_hash(user.get("passwordHash", ""), current):
        return jsonify({"error": "Your current password is incorrect."}), 401
    if not isinstance(new, str) or len(new) < 8:
        return jsonify({"error": "New password must be at least 8 characters."}), 400
    cloud_db.users.update_one({"userId": user_id}, {"$set": {"passwordHash": generate_password_hash(new)}})
    return jsonify({"message": "Password updated. Your other devices may remain signed in until their sessions expire."}), 200


def delete_cloud_account(cloud_db, user_id, data):
    password = data.get("password")
    user = cloud_db.users.find_one({"userId": user_id})
    if not isinstance(password, str) or not user or not check_password_hash(user.get("passwordHash", ""), password):
        return jsonify({"error": "Enter your current password to delete the account."}), 401
    for collection in ("products", "categories", "sales", "sync_deletions"):
        cloud_db[collection].delete_many({"ownerId": user_id})
    cloud_db.users.delete_one({"userId": user_id})
    session.clear()
    return jsonify({"message": "Cloud account and its synced data were deleted."}), 200


@app.before_request
def require_selected_workspace():
    if request.method == "OPTIONS" or not request.path.startswith("/api/"):
        return None
    if request.path in PUBLIC_API_PATHS:
        return None

    if session.get("cloud_user_id"):
        return None

    workspace_id = session.get("local_workspace_id")
    if workspace_id and local_workspace_exists(workspace_id):
        return None

    session.pop("local_workspace_id", None)
    return jsonify({"error": "Choose or create a local workspace first."}), 409


# ==========================================
# API ERROR HANDLERS
# ==========================================
# Without these, any unexpected exception inside an /api/ route would
# return Flask's default HTML error page, which the frontend cannot parse
# and which surfaces as an unexplained crash. These handlers keep the API
# contract intact (always JSON) and make failures recoverable.

@app.errorhandler(404)
def handle_not_found(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "The requested resource was not found."}), 404
    return error


@app.errorhandler(405)
def handle_method_not_allowed(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "That request method is not allowed."}), 405
    return error


@app.errorhandler(500)
def handle_internal_error(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Unexpected server error."}), 500
    return error


def sync_current_cloud_user():
    user_id = session.get("cloud_user_id")
    if user_id:
        trigger_sync(user_id)


def create_mobile_token(user):
    serializer = URLSafeTimedSerializer(
        app.secret_key,
        salt=MOBILE_TOKEN_SALT,
    )
    return serializer.dumps({
        "userId": user["userId"],
        "email": user["email"],
    })


def get_mobile_user():
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.casefold() != "bearer" or not token:
        return None, (jsonify({"error": "A mobile account token is required."}), 401)

    serializer = URLSafeTimedSerializer(
        app.secret_key,
        salt=MOBILE_TOKEN_SALT,
    )
    try:
        payload = serializer.loads(token, max_age=MOBILE_TOKEN_MAX_AGE)
    except SignatureExpired:
        return None, (jsonify({"error": "Your cloud sign-in has expired. Sign in again."}), 401)
    except BadSignature:
        return None, (jsonify({"error": "Invalid cloud sign-in token."}), 401)

    user_id = payload.get("userId")
    email = payload.get("email")
    if not isinstance(user_id, str) or not user_id or not isinstance(email, str):
        return None, (jsonify({"error": "Invalid cloud sign-in token."}), 401)
    return {
        "userId": user_id,
        "email": email,
    }, None


def mobile_owner_required(handler):
    def wrapped(*args, **kwargs):
        user, error_response = get_mobile_user()
        if error_response:
            return error_response
        cloud_db = None
        client = None
        try:
            cloud_db, client = get_mongo_database()
            if not cloud_db.users.find_one({"userId": user["userId"]}):
                return jsonify({"error": "This cloud account is no longer available. Sign in again."}), 401
        except Exception:
            return jsonify({"error": "Cloud account service is unavailable."}), 503
        finally:
            if client:
                client.close()
        request.mobile_user = user
        return handler(*args, **kwargs)

    wrapped.__name__ = handler.__name__
    return wrapped


def mobile_account_response(user, status_code=200):
    return jsonify({
        "accessToken": create_mobile_token(user),
        "tokenType": "Bearer",
        "expiresIn": MOBILE_TOKEN_MAX_AGE,
        "profile": {
            "userId": user["userId"],
            "email": user["email"],
            "userName": user.get("userName"),
            "businessName": user.get("businessName") or "My Business",
        },
    }), status_code


def initialize_mobile_cloud_workspace(user):
    user_id = user["userId"]
    connection = get_db_connection(user_id)
    try:
        profile = connection.execute(
            "SELECT id FROM user_profile WHERE id = 1"
        ).fetchone()
        if not profile:
            timestamp = get_current_timestamp()
            connection.execute(
                """
                INSERT INTO user_profile
                    (id, userName, businessName, createdAt, updatedAt)
                VALUES (1, ?, ?, ?, ?)
                """,
                (
                    user.get("userName") or user["email"].split("@")[0],
                    user.get("businessName") or "My Business",
                    timestamp,
                    timestamp,
                ),
            )
            connection.commit()
    finally:
        connection.close()


def _valid_mobile_timestamp(value):
    if not isinstance(value, str) or not value or len(value) > 40:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat(
            timespec="seconds"
        )
    except ValueError:
        return None


def _mobile_cloud_id(record):
    cloud_id = record.get("cloudId")
    return cloud_id if isinstance(cloud_id, str) and 0 < len(cloud_id) <= 200 else None


def _apply_mobile_changes(connection, changes):
    cursor = connection.cursor()
    changed_at = get_current_timestamp()
    for table_name in MOBILE_SYNC_COLLECTIONS:
        records = changes.get(table_name, [])
        if not isinstance(records, list) or len(records) > 10000:
            raise ValueError(f"Invalid {table_name} sync data.")

        seen_cloud_ids = set()
        for record in records:
            if not isinstance(record, dict):
                raise ValueError(f"Invalid {table_name} record.")
            cloud_id = _mobile_cloud_id(record)
            if not cloud_id:
                raise ValueError(f"Invalid {table_name} cloud identity.")
            if cloud_id in seen_cloud_ids:
                raise ValueError(f"Duplicate {table_name} cloud identity.")
            seen_cloud_ids.add(cloud_id)
            updated_at = _valid_mobile_timestamp(record.get("updatedAt")) or changed_at
            created_at = _valid_mobile_timestamp(record.get("createdAt")) or updated_at

            if table_name == "products":
                name = record.get("name")
                category = record.get("category")
                raw_price = record.get("price")
                raw_stock = record.get("stock")
                raw_minimum_stock = record.get("minimumStock", 0)
                if (
                    isinstance(raw_price, bool)
                    or not isinstance(raw_price, (int, float))
                    or isinstance(raw_stock, bool)
                    or not isinstance(raw_stock, int)
                    or isinstance(raw_minimum_stock, bool)
                    or not isinstance(raw_minimum_stock, int)
                ):
                    raise ValueError("Invalid product values in cloud sync.")
                try:
                    price = float(raw_price)
                    stock = raw_stock
                    minimum_stock = raw_minimum_stock
                except (TypeError, ValueError, OverflowError) as error:
                    raise ValueError("Invalid product values in cloud sync.") from error
                if (
                    not isinstance(name, str) or not name.strip()
                    or not isinstance(category, str) or not category.strip()
                    or not math.isfinite(price) or price < 0
                    or stock < 0 or minimum_stock < 0
                ):
                    raise ValueError("Invalid product values in cloud sync.")
                values = (
                    name.strip(), category.strip(), price, stock, minimum_stock,
                    created_at, updated_at,
                )
                fields = (
                    "name", "category", "price", "stock", "minimumStock",
                    "createdAt", "updatedAt",
                )
            elif table_name == "categories":
                name = record.get("name")
                if not isinstance(name, str) or not name.strip():
                    raise ValueError("Invalid category name in cloud sync.")
                values = (name.strip(), created_at, updated_at)
                fields = ("name", "createdAt", "updatedAt")
                existing_name = connection.execute(
                    "SELECT id, cloudId FROM categories "
                    "WHERE name = ? COLLATE NOCASE",
                    (name.strip(),),
                ).fetchone()
                if existing_name and existing_name["cloudId"] not in (None, cloud_id):
                    cursor.execute(
                        "UPDATE categories SET cloudId = ?, syncStatus = 'pending', "
                        "createdAt = ?, updatedAt = ? WHERE id = ?",
                        (cloud_id, created_at, updated_at, existing_name["id"]),
                    )
                    continue
            else:
                product_name = record.get("productName")
                if not isinstance(product_name, str) or not product_name.strip():
                    raise ValueError("Invalid sales record in cloud sync.")
                raw_quantity = record.get("quantity")
                raw_price = record.get("price")
                raw_total = record.get("total", 0)
                if (
                    isinstance(raw_quantity, bool)
                    or not isinstance(raw_quantity, int)
                    or isinstance(raw_price, bool)
                    or not isinstance(raw_price, (int, float))
                    or isinstance(raw_total, bool)
                    or not isinstance(raw_total, (int, float))
                ):
                    raise ValueError("Invalid sales values in cloud sync.")
                try:
                    quantity = raw_quantity
                    price = float(raw_price)
                    total = float(
                        quantity * price if "total" not in record else raw_total
                    )
                except (TypeError, ValueError, OverflowError) as error:
                    raise ValueError("Invalid sales values in cloud sync.") from error
                if (
                    quantity <= 0 or not math.isfinite(price) or price < 0
                    or not math.isfinite(total) or total < 0
                ):
                    raise ValueError("Invalid sales values in cloud sync.")
                product_cloud_id = record.get("productCloudId")
                product = connection.execute(
                    "SELECT id FROM products WHERE cloudId = ?",
                    (product_cloud_id,),
                ).fetchone() if isinstance(product_cloud_id, str) else None
                if not product:
                    product = connection.execute(
                        "SELECT id FROM products WHERE name = ? COLLATE NOCASE",
                        (product_name.strip(),),
                    ).fetchone()
                sale_date = _valid_mobile_timestamp(record.get("date")) or updated_at
                fields = (
                    "productId", "productName", "quantity", "price", "total",
                    "date", "createdAt", "updatedAt", "productCloudId",
                )
                values = (
                    product["id"] if product else 0,
                    product_name.strip(), quantity, price, total,
                    sale_date, created_at, updated_at,
                    product_cloud_id if isinstance(product_cloud_id, str) else None,
                )

            existing = connection.execute(
                f"SELECT id, updatedAt FROM {table_name} WHERE cloudId = ?",
                (cloud_id,),
            ).fetchone()
            if existing:
                if (existing["updatedAt"] or "") > updated_at:
                    continue
                assignments = ", ".join(f"{field} = ?" for field in fields)
                cursor.execute(
                    f"UPDATE {table_name} SET {assignments}, "
                    "syncStatus = 'pending' WHERE id = ?",
                    (*values, existing["id"]),
                )
            else:
                columns = [*fields, "cloudId", "syncStatus"]
                cursor.execute(
                    f"INSERT INTO {table_name} "
                    f"({', '.join(columns)}) VALUES "
                    f"({', '.join('?' for _ in columns)})",
                    (*values, cloud_id, "pending"),
                )

    deletions = changes.get("deletions", [])
    if not isinstance(deletions, list) or len(deletions) > 10000:
        raise ValueError("Invalid deletion sync data.")
    for deletion in deletions:
        if not isinstance(deletion, dict):
            raise ValueError("Invalid cloud deletion.")
        table_name = deletion.get("tableName")
        cloud_id = _mobile_cloud_id(deletion)
        if table_name not in ("products", "categories") or not cloud_id:
            raise ValueError("Invalid cloud deletion identity.")
        already_deleted = connection.execute(
            """
            SELECT id FROM sync_deletions
            WHERE tableName = ? AND cloudId = ?
            """,
            (table_name, cloud_id),
        ).fetchone()
        if already_deleted:
            continue
        existing = connection.execute(
            f"SELECT id FROM {table_name} WHERE cloudId = ?",
            (cloud_id,),
        ).fetchone()
        connection.execute(
            """
            INSERT INTO sync_deletions
                (tableName, recordId, deletedAt, syncStatus, cloudId)
            VALUES (?, ?, ?, 'pending', ?)
            """,
            (
                table_name,
                existing["id"] if existing else 0,
                _valid_mobile_timestamp(deletion.get("deletedAt")) or changed_at,
                cloud_id,
            ),
        )
        if existing:
            connection.execute(
                f"DELETE FROM {table_name} WHERE id = ?",
                (existing["id"],),
            )


def mobile_cloud_snapshot(connection):
    result = {}
    for table_name in MOBILE_SYNC_COLLECTIONS:
        result[table_name] = [
            dict(row)
            for row in connection.execute(
                f"SELECT * FROM {table_name} ORDER BY id ASC"
            ).fetchall()
        ]
    result["deletions"] = [
        {
            "tableName": row["tableName"],
            "cloudId": row["cloudId"],
            "deletedAt": row["deletedAt"],
        }
        for row in connection.execute(
            """
            SELECT tableName, cloudId, deletedAt
            FROM sync_deletions
            WHERE cloudId IS NOT NULL
            """
        ).fetchall()
    ]
    return result


# ==========================================
# HELPER FUNCTIONS
# ==========================================

def get_current_timestamp():

    return datetime.now().isoformat(
        timespec="seconds"
    )


def row_to_dict(row):

    if row is None:
        return None

    return dict(row)


def rows_to_dict(rows):

    return [
        dict(row)
        for row in rows
    ]


# ==========================================
# HOME
# ==========================================

@app.route("/")
def home():

    return send_from_directory(PROJECT_ROOT, "index.html")


@app.route("/manifest.json")
def pwa_manifest():
    return send_from_directory(
        PROJECT_ROOT,
        "manifest.json",
        mimetype="application/manifest+json",
    )


@app.route("/service-worker.js")
def pwa_service_worker():
    response = send_from_directory(PROJECT_ROOT, "service-worker.js")
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/icons/<path:filename>")
def pwa_icons(filename):
    return send_from_directory(os.path.join(PROJECT_ROOT, "icons"), filename)


@app.route("/css/<path:filename>")
def frontend_css(filename):
    return send_from_directory(os.path.join(PROJECT_ROOT, "css"), filename)


@app.route("/js/<path:filename>")
def frontend_js(filename):
    return send_from_directory(os.path.join(PROJECT_ROOT, "js"), filename)


@app.route("/Logo.png")
def frontend_logo():
    return send_from_directory(PROJECT_ROOT, "Logo.png")


# ==========================================
# DATABASE TEST
# ==========================================

@app.route("/api/test")
def test():

    database_status = test_database()

    return jsonify({

        "backend": "working",

        "database": (
            "connected"
            if database_status
            else "connection failed"
        )

    })


# ==========================================
# USER / BUSINESS PROFILE
# ==========================================

@app.route("/api/workspaces", methods=["GET"])
def get_workspaces():
    return jsonify({
        "workspaces": list_local_workspaces(),
        "activeWorkspaceId": session.get("local_workspace_id"),
        "cloudConnected": bool(session.get("cloud_user_id")),
    }), 200


@app.route("/api/workspaces", methods=["POST"])
def add_local_workspace():
    data = request.get_json(silent=True) or {}
    user_name = data.get("userName")
    business_name = data.get("businessName")

    if not isinstance(user_name, str) or not user_name.strip():
        return jsonify({"error": "Your name is required."}), 400
    if not isinstance(business_name, str) or not business_name.strip():
        return jsonify({"error": "Business name is required."}), 400

    workspace = create_local_workspace(
        user_name.strip(),
        business_name.strip(),
    )
    session.clear()
    session["local_workspace_id"] = workspace["id"]
    return jsonify({
        "message": "Local workspace created.",
        "workspace": workspace,
    }), 201


@app.route("/api/workspaces/select", methods=["POST"])
def select_local_workspace():
    data = request.get_json(silent=True) or {}
    workspace_id = data.get("workspaceId")
    if not isinstance(workspace_id, str) or not local_workspace_exists(workspace_id):
        return jsonify({"error": "That local workspace was not found."}), 404

    session.clear()
    session["local_workspace_id"] = workspace_id
    return jsonify({"message": "Local workspace opened."}), 200


@app.route("/api/workspaces/leave", methods=["POST"])
def leave_workspace():
    session.clear()
    return jsonify({"message": "Workspace closed."}), 200


# ------------------------------------------
# GET PROFILE
# ------------------------------------------

@app.route(
    "/api/profile",
    methods=["GET"]
)
def get_profile():
    connection = get_db_connection()
    try:
        profile = connection.execute("""
            SELECT id, userName, businessName, createdAt, updatedAt
            FROM user_profile
            WHERE id = 1
        """).fetchone()
    finally:
        connection.close()

    if not profile:
        return jsonify({
            "configured": False,
            "cloudConnected": bool(session.get("cloud_user_id")),
        }), 200

    profile_data = dict(profile)
    profile_data["configured"] = True
    profile_data["cloudConnected"] = bool(session.get("cloud_user_id"))
    profile_data["email"] = session.get("cloud_email")
    return jsonify(profile_data), 200


# ------------------------------------------
# SAVE PROFILE
# ------------------------------------------

@app.route(
    "/api/profile",
    methods=["POST"]
)
def save_profile():

    data = request.get_json()


    if not data:

        return jsonify({
            "error":
                "No profile data provided."
        }), 400


    user_name = data.get(
        "userName",
        ""
    )

    business_name = data.get(
        "businessName",
        ""
    )
    if not isinstance(user_name, str) or not user_name.strip():
        return jsonify({"error": "Your username is required."}), 400

    if not isinstance(business_name, str) or not business_name.strip():
        return jsonify({"error": "Business name is required."}), 400

    user_name = user_name.strip()
    business_name = business_name.strip()
    connection = None
    try:
        connection = get_db_connection()
        timestamp = get_current_timestamp()
        connection.execute("""
            INSERT INTO user_profile
                (id, userName, businessName, passwordHash, createdAt, updatedAt)
            VALUES (1, ?, ?, NULL, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                userName = excluded.userName,
                businessName = excluded.businessName,
                passwordHash = NULL,
                updatedAt = excluded.updatedAt
        """, (user_name, business_name, timestamp, timestamp))
        connection.commit()
        saved_profile = connection.execute("""
            SELECT id, userName, businessName, createdAt, updatedAt
            FROM user_profile
            WHERE id = 1
        """).fetchone()
        profile_data = dict(saved_profile)
        profile_data["configured"] = True
        profile_data["cloudConnected"] = bool(session.get("cloud_user_id"))
        profile_data["email"] = session.get("cloud_email")
        return jsonify({
            "message": "Local business profile saved.",
            "profile": profile_data
        }), 200
    except Exception as error:
        if connection:
            connection.rollback()
            connection.close()
        print("Error saving business profile:", error)
        return jsonify({"error": "Failed to save business profile."}), 500
    finally:
        if connection:
            connection.close()


def _initialize_cloud_workspace(user):
    user_id = user["userId"]
    connection = get_db_connection(user_id)
    try:
        profile = connection.execute(
            "SELECT id FROM user_profile WHERE id = 1"
        ).fetchone()
        if not profile:
            timestamp = get_current_timestamp()
            connection.execute(
                """
                INSERT INTO user_profile
                    (id, userName, businessName, createdAt, updatedAt)
                VALUES (1, ?, ?, ?, ?)
                """,
                (
                    user.get("userName") or user["email"].split("@")[0],
                    user.get("businessName") or "My Business",
                    timestamp,
                    timestamp,
                ),
            )
            connection.commit()
    finally:
        connection.close()


@app.route("/api/cloud/register", methods=["POST"])
def register_cloud_account():
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    password = data.get("password")
    user_name = data.get("userName")
    business_name = data.get("businessName")

    if not isinstance(email, str) or not re.fullmatch(
        r"[^@\s]+@[^@\s]+\.[^@\s]+", email.strip()
    ):
        return jsonify({"error": "Enter a valid email address."}), 400
    if not isinstance(password, str) or len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if not isinstance(user_name, str) or not user_name.strip():
        return jsonify({"error": "Your name is required."}), 400
    if not isinstance(business_name, str) or not business_name.strip():
        return jsonify({"error": "Business name is required."}), 400

    email = email.strip().casefold()
    user_name = user_name.strip()
    business_name = business_name.strip()
    user_id = str(uuid.uuid4())
    client = None

    with CLOUD_ACCOUNT_REGISTRATION_LOCK:
        try:
            return_local_id = session.get("local_workspace_id")
            cloud_db, client = get_mongo_database()
            users = cloud_db["users"]
            users.create_index("email", unique=True)
            users.create_index("userId", unique=True, sparse=True)
            if users.find_one({"email": email}):
                return jsonify({
                    "error": "An account already uses that email."
                }), 409
            existing_users = users.count_documents({})
            user = {
                "userId": user_id,
                "email": email,
                "passwordHash": generate_password_hash(password),
                "userName": user_name,
                "businessName": business_name,
                "createdAt": get_current_timestamp(),
            }

            if return_local_id:
                copy_local_workspace(user_id, user_name, business_name)
            users.insert_one(user)

            if existing_users == 0:
                for collection_name in (
                    "products",
                    "categories",
                    "sales",
                    "sync_deletions",
                ):
                    cloud_db[collection_name].update_many(
                        {"ownerId": {"$exists": False}},
                        {"$set": {"ownerId": user_id}},
                    )

            _initialize_cloud_workspace(user)
            session.clear()
            session["cloud_user_id"] = user_id
            session["cloud_email"] = email
            if return_local_id:
                session["cloud_return_local_id"] = return_local_id
            trigger_sync(user_id)
            return jsonify({
                "message": "Cloud account created. Sync is starting.",
                "userId": user_id,
                "email": email,
                "userName": user_name,
                "businessName": business_name,
                "cloudConnected": True,
            }), 201
        except DuplicateKeyError:
            return jsonify({"error": "An account already uses that email."}), 409
        except Exception as error:
            print("Cloud account registration failed:", error)
            return jsonify({
                "error": "Could not create the cloud account. Please try again."
            }), 503
        finally:
            if client:
                client.close()


@app.route("/api/cloud/login", methods=["POST"])
def login_cloud_account():
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    password = data.get("password")
    if not isinstance(email, str) or not email.strip():
        return jsonify({"error": "Enter your email address."}), 400
    if not isinstance(password, str) or not password:
        return jsonify({"error": "Enter your password."}), 400

    client = None
    try:
        return_local_id = session.get("local_workspace_id")
        cloud_db, client = get_mongo_database()
        user = cloud_db["users"].find_one({
            "email": email.strip().casefold()
        })
        if (
            not user
            or not user.get("passwordHash")
            or not check_password_hash(user["passwordHash"], password)
        ):
            return jsonify({"error": "Incorrect email or password."}), 401

        user_id = user.get("userId")
        if not user_id:
            user_id = str(uuid.uuid4())
            cloud_db["users"].update_one(
                {"_id": user["_id"]},
                {"$set": {"userId": user_id}},
            )
            user["userId"] = user_id

        _initialize_cloud_workspace(user)
        session.clear()
        session["cloud_user_id"] = user_id
        session["cloud_email"] = user["email"]
        if return_local_id:
            session["cloud_return_local_id"] = return_local_id
        trigger_sync(user_id)
        return jsonify({
            "message": "Signed in. Cloud sync is starting.",
            "userId": user_id,
            "email": user["email"],
            "userName": user.get("userName"),
            "businessName": user.get("businessName"),
            "cloudConnected": True,
        }), 200
    except Exception as error:
        print("Cloud account sign-in failed:", error)
        return jsonify({
            "error": "Cloud sign-in is unavailable. Please try again."
        }), 503
    finally:
        if client:
            client.close()


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    local_workspace_id = session.get(
        "local_workspace_id"
    ) or session.get("cloud_return_local_id")
    session.clear()
    if local_workspace_id and local_workspace_exists(local_workspace_id):
        session["local_workspace_id"] = local_workspace_id
    return jsonify({
        "message": "Cloud account disconnected.",
        "localWorkspaceSelected": bool(session.get("local_workspace_id")),
    }), 200


@app.route("/api/account", methods=["GET", "PATCH"])
def cloud_account():
    user_id = session.get("cloud_user_id")
    if not user_id:
        return jsonify({"error": "Sign in to manage your cloud account."}), 401
    client = None
    try:
        cloud_db, client = get_mongo_database()
        if request.method == "PATCH":
            result, error = update_account(cloud_db, user_id, request.get_json(silent=True) or {})
            if error:
                return error
            session["cloud_email"] = result["email"]
            return jsonify({"account": result}), 200
        user = cloud_db.users.find_one({"userId": user_id})
        if not user:
            return jsonify({"error": "Cloud account not found."}), 404
        return jsonify({"account": account_payload(user)}), 200
    except Exception as error:
        print("Cloud account details failed:", error)
        return jsonify({"error": "Cloud account service is unavailable."}), 503
    finally:
        if client:
            client.close()


@app.route("/api/account/password", methods=["POST"])
def cloud_account_password():
    user_id = session.get("cloud_user_id")
    if not user_id:
        return jsonify({"error": "Sign in to manage your cloud account."}), 401
    client = None
    try:
        cloud_db, client = get_mongo_database()
        return change_account_password(cloud_db, user_id, request.get_json(silent=True) or {})
    except Exception as error:
        print("Cloud password update failed:", error)
        return jsonify({"error": "Cloud account service is unavailable."}), 503
    finally:
        if client:
            client.close()


@app.route("/api/account/delete", methods=["POST"])
def cloud_account_delete():
    user_id = session.get("cloud_user_id")
    if not user_id:
        return jsonify({"error": "Sign in to manage your cloud account."}), 401
    client = None
    try:
        cloud_db, client = get_mongo_database()
        return delete_cloud_account(cloud_db, user_id, request.get_json(silent=True) or {})
    except Exception as error:
        print("Cloud account deletion failed:", error)
        return jsonify({"error": "Cloud account service is unavailable."}), 503
    finally:
        if client:
            client.close()



# ==========================================
# PRODUCTS - GET
# ==========================================

@app.route(
    "/api/products",
    methods=["GET"]
)
def get_products():

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()

        cursor.execute("""
            SELECT
                id,
                name,
                category,
                price,
                stock,
                minimumStock

            FROM products

            ORDER BY id ASC
        """)

        products = rows_to_dict(
            cursor.fetchall()
        )

        return jsonify(products)

    except Exception as error:

        print(
            "Error loading products:",
            error
        )

        return jsonify({
            "error":
                "Failed to load products."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# ADD PRODUCT
# ==========================================

@app.route(
    "/api/products",
    methods=["POST"]
)
def add_product():

    connection = None

    data = request.get_json()


    if not data:

        return jsonify({
            "error":
                "No product data provided."
        }), 400


    required_fields = [
        "name",
        "category",
        "price",
        "stock",
        "minimumStock"
    ]


    for field in required_fields:

        if field not in data:

            return jsonify({
                "error":
                    f"Missing field: {field}"
            }), 400


    try:

        name = data["name"].strip()

        category = data["category"].strip()

        price = float(
            data["price"]
        )

        stock = int(
            data["stock"]
        )

        minimum_stock = int(
            data["minimumStock"]
        )


        if not name:

            return jsonify({
                "error":
                    "Product name is required."
            }), 400


        if not category:

            return jsonify({
                "error":
                    "Category is required."
            }), 400


        if not math.isfinite(price) or price < 0:

            return jsonify({
                "error":
                    "Price must be a finite, non-negative number."
            }), 400


        if stock < 0:

            return jsonify({
                "error":
                    "Stock cannot be negative."
            }), 400


        if minimum_stock < 0:

            return jsonify({
                "error":
                    "Minimum stock cannot be negative."
            }), 400


        connection = get_db_connection()

        cursor = connection.cursor()

        timestamp = get_current_timestamp()


        cursor.execute("""
            INSERT INTO products
            (
                name,
                category,
                price,
                stock,
                minimumStock,
                createdAt,
                updatedAt,
                syncStatus,
                cloudId
            )

            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            name,
            category,
            price,
            stock,
            minimum_stock,
            timestamp,
            timestamp,
            "pending",
            str(uuid.uuid4())
        ))


        new_id = cursor.lastrowid

        connection.commit()

        sync_current_cloud_user()


        return jsonify({

            "message":
                "Product added successfully.",

            "product": {

                "id":
                    new_id,

                "name":
                    name,

                "category":
                    category,

                "price":
                    price,

                "stock":
                    stock,

                "minimumStock":
                    minimum_stock

            }

        }), 201


    except (
        ValueError,
        TypeError,
        AttributeError
    ):

        return jsonify({
            "error":
                "Invalid product data."
        }), 400


    except Exception as error:

        if connection:

            connection.rollback()

        print(
            "Error adding product:",
            error
        )

        return jsonify({
            "error":
                "Failed to add product."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# UPDATE PRODUCT
# ==========================================

@app.route(
    "/api/products/<int:product_id>",
    methods=["PUT"]
)
def update_product(product_id):

    connection = None

    data = request.get_json()


    if not data:

        return jsonify({
            "error":
                "No product data provided."
        }), 400


    required_fields = [
        "name",
        "category",
        "price",
        "stock",
        "minimumStock"
    ]


    for field in required_fields:

        if field not in data:

            return jsonify({
                "error":
                    f"Missing field: {field}"
            }), 400


    try:

        name = data["name"].strip()

        category = data["category"].strip()

        price = float(
            data["price"]
        )

        stock = int(
            data["stock"]
        )

        minimum_stock = int(
            data["minimumStock"]
        )


        if not name:

            return jsonify({
                "error":
                    "Product name is required."
            }), 400


        if not category:

            return jsonify({
                "error":
                    "Category is required."
            }), 400


        if not math.isfinite(price) or price < 0:

            return jsonify({
                "error":
                    "Price must be a finite, non-negative number."
            }), 400


        if stock < 0:

            return jsonify({
                "error":
                    "Stock cannot be negative."
            }), 400


        if minimum_stock < 0:

            return jsonify({
                "error":
                    "Minimum stock cannot be negative."
            }), 400


        connection = get_db_connection()

        cursor = connection.cursor()

        timestamp = get_current_timestamp()


        cursor.execute("""
            UPDATE products

            SET
                name = ?,
                category = ?,
                price = ?,
                stock = ?,
                minimumStock = ?,
                updatedAt = ?,
                syncStatus = ?

            WHERE id = ?
        """, (
            name,
            category,
            price,
            stock,
            minimum_stock,
            timestamp,
            "pending",
            product_id
        ))


        if cursor.rowcount == 0:

            connection.close()

            return jsonify({
                "error":
                    "Product not found."
            }), 404


        connection.commit()

        sync_current_cloud_user()


        return jsonify({

            "message":
                "Product updated successfully.",

            "product": {

                "id":
                    product_id,

                "name":
                    name,

                "category":
                    category,

                "price":
                    price,

                "stock":
                    stock,

                "minimumStock":
                    minimum_stock

            }

        }), 200


    except (
        ValueError,
        TypeError,
        AttributeError
    ):

        return jsonify({
            "error":
                "Invalid product data."
        }), 400


    except Exception as error:

        if connection:

            connection.rollback()

        print(
            "Error updating product:",
            error
        )

        return jsonify({
            "error":
                "Failed to update product."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# DELETE PRODUCT
# ==========================================

@app.route(
    "/api/products/<int:product_id>",
    methods=["DELETE"]
)
def delete_product(product_id):

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT id, cloudId, syncStatus

            FROM products

            WHERE id = ?
        """, (
            product_id,
        ))


        product = cursor.fetchone()


        if not product:

            return jsonify({
                "error":
                    "Product not found."
            }), 404


        timestamp = get_current_timestamp()


        cursor.execute("""
            INSERT INTO sync_deletions
            (
                tableName,
                recordId,
                deletedAt,
                syncStatus,
                cloudId
            )

            VALUES (?, ?, ?, ?, ?)
        """, (
            "products",
            product_id,
            timestamp,
            "pending",
            product["cloudId"] or (
                f"legacy:products:{product_id}"
                if product["syncStatus"] == "synced"
                else str(uuid.uuid4())
            )
        ))


        cursor.execute("""
            DELETE FROM products

            WHERE id = ?
        """, (
            product_id,
        ))


        connection.commit()

        sync_current_cloud_user()


        return jsonify({

            "message":
                "Product deleted successfully."

        }), 200


    except Exception as error:

        if connection:

            connection.rollback()

        print(
            "Error deleting product:",
            error
        )

        return jsonify({

            "error":
                "Failed to delete product."

        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# SALES - GET
# ==========================================

@app.route(
    "/api/sales",
    methods=["GET"]
)
def get_sales():

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT
                id,
                productId,
                productName,
                quantity,
                price,
                total,
                date

            FROM sales

            ORDER BY date DESC
        """)


        sales = rows_to_dict(
            cursor.fetchall()
        )


        return jsonify(sales)

    except Exception as error:

        print(
            "Error loading sales:",
            error
        )

        return jsonify({
            "error":
                "Failed to load sales."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# CATEGORIES - GET
# ==========================================

@app.route(
    "/api/categories",
    methods=["GET"]
)
def get_categories():

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT
                id,
                name

            FROM categories

            ORDER BY name ASC
        """)


        categories = rows_to_dict(
            cursor.fetchall()
        )


        return jsonify(categories)

    except Exception as error:

        print(
            "Error loading categories:",
            error
        )

        return jsonify({
            "error":
                "Failed to load categories."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# ADD CATEGORY
# ==========================================

@app.route(
    "/api/categories",
    methods=["POST"]
)
def add_category():

    connection = None

    data = request.get_json()


    if not data:

        return jsonify({
            "error":
                "No category data provided."
        }), 400


    raw_category_name = data.get(
        "name",
        ""
    )

    if not isinstance(raw_category_name, str):

        return jsonify({
            "error":
                "Category name is required."
        }), 400

    category_name = raw_category_name.strip()


    if not category_name:

        return jsonify({
            "error":
                "Category name is required."
        }), 400


    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT
                id,
                name

            FROM categories

            WHERE name = ?
        """, (
            category_name,
        ))


        existing_category = cursor.fetchone()


        if existing_category:

            return jsonify({

                "error":
                    "Category already exists."

            }), 409


        timestamp = get_current_timestamp()


        cursor.execute("""
            INSERT INTO categories
            (
                name,
                createdAt,
                updatedAt,
                syncStatus,
                cloudId
            )

            VALUES (?, ?, ?, ?, ?)
        """, (
            category_name,
            timestamp,
            timestamp,
            "pending",
            str(uuid.uuid4())
        ))


        new_id = cursor.lastrowid


        connection.commit()

        sync_current_cloud_user()


        return jsonify({

            "message":
                "Category added successfully.",

            "category": {

                "id":
                    new_id,

                "name":
                    category_name

            }

        }), 201

    except Exception as error:

        if connection:

            connection.rollback()

        print(
            "Error adding category:",
            error
        )

        return jsonify({
            "error":
                "Failed to add category."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# DELETE CATEGORY
# ==========================================

@app.route(
    "/api/categories/<int:category_id>/products",
    methods=["DELETE"]
)
def delete_category_products(category_id):

    connection = get_db_connection()
    cursor = connection.cursor()

    try:
        category = cursor.execute(
            "SELECT id, name FROM categories WHERE id = ?",
            (category_id,),
        ).fetchone()

        if not category:
            return jsonify({"error": "Category not found."}), 404

        products = cursor.execute(
            "SELECT id, cloudId, syncStatus FROM products WHERE category = ?",
            (category["name"],),
        ).fetchall()

        if not products:
            return jsonify({
                "message": "There are no products in this category.",
                "deletedCount": 0,
            }), 200

        timestamp = get_current_timestamp()
        cursor.executemany("""
            INSERT INTO sync_deletions
                (tableName, recordId, deletedAt, syncStatus, cloudId)
            VALUES ('products', ?, ?, 'pending', ?)
        """, [
            (
                product["id"],
                timestamp,
                product["cloudId"] or (
                    f"legacy:products:{product['id']}"
                    if product["syncStatus"] == "synced"
                    else str(uuid.uuid4())
                ),
            )
            for product in products
        ])
        cursor.execute(
            "DELETE FROM products WHERE category = ?",
            (category["name"],),
        )
        connection.commit()
        sync_current_cloud_user()

        return jsonify({
            "message": "All products in this category were removed.",
            "deletedCount": len(products),
        }), 200
    except Exception as error:
        connection.rollback()
        print("Error removing category products:", error)
        return jsonify({
            "error": "Failed to remove products from category.",
        }), 500
    finally:
        connection.close()


@app.route(
    "/api/categories/<int:category_id>",
    methods=["DELETE"]
)
def delete_category(category_id):

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT
                id,
                name,
                cloudId,
                syncStatus

            FROM categories

            WHERE id = ?
        """, (
            category_id,
        ))


        category = cursor.fetchone()


        if not category:

            return jsonify({

                "error":
                    "Category not found."

            }), 404


        cursor.execute("""
            SELECT
                COUNT(*) AS count

            FROM products

            WHERE category = ?
        """, (
            category["name"],
        ))


        result = cursor.fetchone()


        if result["count"] > 0:

            return jsonify({

                "error":
                    "Cannot delete this category because "
                    "products are using it."

            }), 400


        timestamp = get_current_timestamp()


        cursor.execute("""
            INSERT INTO sync_deletions
            (
                tableName,
                recordId,
                deletedAt,
                syncStatus,
                cloudId
            )

            VALUES (?, ?, ?, ?, ?)
        """, (
            "categories",
            category_id,
            timestamp,
            "pending",
            category["cloudId"] or (
                f"legacy:categories:{category_id}"
                if category["syncStatus"] == "synced"
                else str(uuid.uuid4())
            )
        ))


        cursor.execute("""
            DELETE FROM categories

            WHERE id = ?
        """, (
            category_id,
        ))


        connection.commit()

        sync_current_cloud_user()


        return jsonify({

            "message":
                "Category deleted successfully."

        }), 200


    except Exception as error:

        if connection:

            connection.rollback()

        print(
            "Error deleting category:",
            error
        )

        return jsonify({

            "error":
                "Failed to delete category."

        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# ADD SALE
# ==========================================

@app.route(
    "/api/sales",
    methods=["POST"]
)
def add_sale():

    data = request.get_json()


    if not data:

        return jsonify({
            "error":
                "No sale data provided."
        }), 400


    required_fields = [
        "productId",
        "quantity"
    ]


    for field in required_fields:

        if field not in data:

            return jsonify({
                "error":
                    f"Missing field: {field}"
            }), 400


    try:

        product_id = int(
            data["productId"]
        )

        quantity = int(
            data["quantity"]
        )


    except (
        ValueError,
        TypeError
    ):

        return jsonify({
            "error":
                "Invalid product or quantity."
        }), 400


    if quantity <= 0:

        return jsonify({
            "error":
                "Quantity must be greater than zero."
        }), 400


    connection = get_db_connection()

    cursor = connection.cursor()


    try:

        cursor.execute("""
            SELECT
                id,
                name,
                price,
                stock

            FROM products

            WHERE id = ?
        """, (
            product_id,
        ))


        product = cursor.fetchone()


        if not product:

            connection.close()

            return jsonify({
                "error":
                    "Product not found."
            }), 404


        if product["stock"] < quantity:

            connection.close()

            return jsonify({
                "error":
                    "Not enough stock available."
            }), 400


        total = (
            product["price"] * quantity
        )


        sale_date = datetime.now().isoformat(
            timespec="seconds"
        )


        timestamp = get_current_timestamp()


        cursor.execute("""
            INSERT INTO sales
            (
                productId,
                productName,
                quantity,
                price,
                total,
                date,
                createdAt,
                updatedAt,
                syncStatus
            )

            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            product["id"],
            product["name"],
            quantity,
            product["price"],
            total,
            sale_date,
            timestamp,
            timestamp,
            "pending"
        ))


        cursor.execute("""
            UPDATE products

            SET
                stock = stock - ?,
                updatedAt = ?,
                syncStatus = ?

            WHERE id = ?
        """, (
            quantity,
            timestamp,
            "pending",
            product_id
        ))


        connection.commit()

        sync_current_cloud_user()


        return jsonify({

            "message":
                "Sale recorded successfully.",

            "sale": {

                "productId":
                    product["id"],

                "productName":
                    product["name"],

                "quantity":
                    quantity,

                "price":
                    product["price"],

                "total":
                    total,

                "date":
                    sale_date

            }

        }), 201


    except Exception as error:

        if connection:

            connection.rollback()

        print(
            "Error recording sale:",
            error
        )


        return jsonify({

            "error":
                "Failed to record sale."

        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# DASHBOARD
# ==========================================

@app.route(
    "/api/dashboard",
    methods=["GET"]
)
def get_dashboard():

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT
                COALESCE(SUM(total), 0)
                AS totalSales

            FROM sales
        """)


        total_sales = cursor.fetchone()[
            "totalSales"
        ]


        cursor.execute("""
            SELECT
                COUNT(*) AS count

            FROM sales
        """)


        total_transactions = cursor.fetchone()[
            "count"
        ]


        cursor.execute("""
            SELECT
                COUNT(*) AS count

            FROM products
        """)


        total_products = cursor.fetchone()[
            "count"
        ]


        cursor.execute("""
            SELECT
                id,
                name,
                category,
                price,
                stock,
                minimumStock

            FROM products

            WHERE stock <= minimumStock

            ORDER BY stock ASC
        """)


        low_stock_products = rows_to_dict(
            cursor.fetchall()
        )


        today = datetime.now().date().isoformat()


        cursor.execute("""
            SELECT
                COALESCE(SUM(total), 0)
                AS todaysSales

            FROM sales

            WHERE date(date) = ?
        """, (
            today,
        ))


        todays_sales = cursor.fetchone()[
            "todaysSales"
        ]


        return jsonify({

            "totalSales":
                total_sales,

            "totalTransactions":
                total_transactions,

            "totalProducts":
                total_products,

            "lowStockCount":
                len(low_stock_products),

            "todaysSales":
                todays_sales,

            "lowStockProducts":
                low_stock_products

        })

    except Exception as error:

        print(
            "Error loading dashboard:",
            error
        )

        return jsonify({
            "error":
                "Failed to load dashboard."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# ANALYTICS
# ==========================================

@app.route(
    "/api/analytics",
    methods=["GET"]
)
def get_analytics():

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT
                DATE(date) AS saleDate,
                SUM(total) AS revenue

            FROM sales

            GROUP BY DATE(date)

            ORDER BY saleDate ASC
        """)


        sales_by_date = {}


        for row in cursor.fetchall():

            sales_by_date[
                row["saleDate"]
            ] = row["revenue"]


        cursor.execute("""
            SELECT
                productName,
                SUM(quantity) AS quantity,
                SUM(total) AS revenue

            FROM sales

            GROUP BY productName

            ORDER BY quantity DESC
        """)


        product_performance = []


        for row in cursor.fetchall():

            product_performance.append({

                "productName":
                    row["productName"],

                "quantity":
                    row["quantity"],

                "revenue":
                    row["revenue"]

            })


        return jsonify({

            "salesByDate":
                sales_by_date,

            "productPerformance":
                product_performance

        })

    except Exception as error:

        print(
            "Error loading analytics:",
            error
        )

        return jsonify({
            "error":
                "Failed to load analytics."
        }), 500

    finally:

        if connection:

            connection.close()


# ==========================================
# AI DATA
# ==========================================

@app.route(
    "/api/ai/data",
    methods=["GET"]
)
def get_ai_data():

    connection = None

    try:

        connection = get_db_connection()

        cursor = connection.cursor()


        cursor.execute("""
            SELECT
                productName,
                quantity,
                price,
                total,
                date

            FROM sales

            ORDER BY date ASC
        """)


        sales = cursor.fetchall()

    except Exception as error:

        print(
            "Error loading AI data:",
            error
        )

        return jsonify({
            "error":
                "Failed to load sales history."
        }), 500

    finally:

        if connection:

            connection.close()


    ai_data = []


    for sale in sales:

        try:

            sale_date = datetime.fromisoformat(
                sale["date"]
            )

        except (TypeError, ValueError):

            continue


        ai_data.append({

            "date":
                sale_date.strftime(
                    "%Y-%m-%d"
                ),

            "product":
                sale["productName"],

            "quantity":
                sale["quantity"],

            "price":
                sale["price"],

            "revenue":
                sale["total"],

            "dayOfWeek":
                sale_date.weekday(),

            "month":
                sale_date.month

        })


    return jsonify(ai_data)


# ==========================================
# AI PREDICTION
# ==========================================

@app.route(
    "/api/ai/predict",
    methods=["POST"]
)
def ai_predict():

    data = request.get_json(silent=True)


    if not data:

        return jsonify({

            "error":
                "No prediction data provided."

        }), 400


    product = data.get("product")

    forecast_date = data.get("date")

    if not isinstance(product, str) or not product.strip():
        return jsonify({"error": "Product is required."}), 400

    if not isinstance(forecast_date, str) or not forecast_date.strip():
        return jsonify({"error": "A valid forecast date is required."}), 400

    try:
        datetime.fromisoformat(forecast_date.replace("Z", "+00:00"))
    except ValueError:
        return jsonify({"error": "A valid forecast date is required."}), 400


    try:

        price = float(
            data.get("price")
        )

    except (
        ValueError,
        TypeError
    ):

        return jsonify({

            "error":
                "Invalid price."

        }), 400

    if not math.isfinite(price) or price < 0:
        return jsonify({"error": "Price must be a finite, non-negative number."}), 400

    horizon_days = data.get("days")
    if horizon_days is not None:
        try:
            horizon_days = int(horizon_days)
        except (TypeError, ValueError):
            return jsonify({
                "error": "The forecast period must be a whole number of days."
            }), 400
        if horizon_days < 1 or horizon_days > 180:
            return jsonify({
                "error": "Choose a forecast period between 1 and 180 days."
            }), 400

    product = product.strip()

    try:
        connection = get_db_connection()
        try:
            sales_history = rows_to_dict(connection.execute(
                """
                SELECT date, quantity
                FROM sales
                WHERE productName = ? COLLATE NOCASE
                ORDER BY date ASC
                """,
                (product,),
            ).fetchall())
        finally:
            connection.close()

        if horizon_days is not None:
            forecast = predict_demand_range(
                product,
                price,
                forecast_date,
                horizon_days,
                sales_history=sales_history
            )

            return jsonify({
                "product": product,
                "date": forecast_date,
                **forecast
            })

        prediction = predict_demand(
            product,
            price,
            forecast_date,
            sales_history=sales_history
        )

        return jsonify({
            "product": product,
            "date": forecast_date,
            **prediction
        })


    except Exception as error:

        print(
            "Prediction error:",
            error
        )


        return jsonify({

            "error":
                "Unable to generate prediction."

        }), 500


# ==========================================
# SYNC STATUS
# ==========================================

@app.route(
    "/api/sync-status",
    methods=["GET"]
)
def sync_status():
    return jsonify(get_sync_state(session.get("cloud_user_id")))


@app.route("/api/sync-now", methods=["POST"])
def sync_now():
    user_id = session.get("cloud_user_id")
    if not user_id:
        return jsonify({
            "error": "Connect a cloud account before syncing."
        }), 401
    trigger_sync(user_id)
    return jsonify({"message": "Sync started."}), 202


@app.route("/api/mobile/auth/login", methods=["POST"])
def mobile_cloud_login():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Cloud sign-in details are required."}), 400
    email = data.get("email")
    password = data.get("password")
    if not isinstance(email, str) or not email.strip():
        return jsonify({"error": "Enter your email address."}), 400
    if not isinstance(password, str) or not password:
        return jsonify({"error": "Enter your password."}), 400

    client = None
    try:
        cloud_db, client = get_mongo_database()
        user = cloud_db["users"].find_one({
            "email": email.strip().casefold()
        })
        if (
            not user
            or not user.get("passwordHash")
            or not check_password_hash(user["passwordHash"], password)
        ):
            return jsonify({"error": "Incorrect email or password."}), 401

        user_id = user.get("userId")
        if not user_id:
            user_id = str(uuid.uuid4())
            cloud_db["users"].update_one(
                {"_id": user["_id"]},
                {"$set": {"userId": user_id}},
            )
            user["userId"] = user_id

        user["email"] = user["email"].strip().casefold()
        initialize_mobile_cloud_workspace(user)
        run_sync(user_id, strict=True)
        return mobile_account_response(user)
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 503
    except Exception as error:
        print("Mobile cloud sign-in failed:", error)
        return jsonify({
            "error": "Cloud sign-in or initial sync is unavailable. Check the server and try again."
        }), 503
    finally:
        if client:
            client.close()


@app.route("/api/mobile/auth/register", methods=["POST"])
def mobile_cloud_register():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Cloud account details are required."}), 400
    email = data.get("email")
    password = data.get("password")
    user_name = data.get("userName")
    business_name = data.get("businessName")
    if not isinstance(email, str) or not re.fullmatch(
        r"[^@\s]+@[^@\s]+\.[^@\s]+", email.strip()
    ):
        return jsonify({"error": "Enter a valid email address."}), 400
    if not isinstance(password, str) or len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if not isinstance(user_name, str) or not user_name.strip():
        return jsonify({"error": "Your name is required."}), 400
    if not isinstance(business_name, str) or not business_name.strip():
        return jsonify({"error": "Business name is required."}), 400

    user = {
        "userId": str(uuid.uuid4()),
        "email": email.strip().casefold(),
        "passwordHash": generate_password_hash(password),
        "userName": user_name.strip(),
        "businessName": business_name.strip(),
        "createdAt": get_current_timestamp(),
    }
    client = None
    with CLOUD_ACCOUNT_REGISTRATION_LOCK:
        try:
            cloud_db, client = get_mongo_database()
            users = cloud_db["users"]
            users.create_index("email", unique=True)
            users.create_index("userId", unique=True, sparse=True)
            if users.find_one({"email": user["email"]}):
                return jsonify({
                    "error": "An account already uses that email."
                }), 409
            legacy_user_migration = users.count_documents({}) == 0
            users.insert_one(user)
            if legacy_user_migration:
                for collection_name in (
                    "products",
                    "categories",
                    "sales",
                    "sync_deletions",
                ):
                    cloud_db[collection_name].update_many(
                        {"ownerId": {"$exists": False}},
                        {"$set": {"ownerId": user["userId"]}},
                    )

            initialize_mobile_cloud_workspace(user)
            run_sync(user["userId"], strict=True)
            return mobile_account_response(user, 201)
        except DuplicateKeyError:
            return jsonify({"error": "An account already uses that email."}), 409
        except Exception as error:
            print("Mobile cloud account registration failed:", error)
            return jsonify({
                "error": "Could not create or sync the cloud account. Please try again."
            }), 503
        finally:
            if client:
                client.close()


@app.route("/api/mobile/account/<action>", methods=["POST"])
@mobile_owner_required
def mobile_cloud_account(action):
    if action not in {"get", "update", "password", "delete"}:
        return jsonify({"error": "Account action not found."}), 404
    client = None
    try:
        cloud_db, client = get_mongo_database()
        user_id = request.mobile_user["userId"]
        data = request.get_json(silent=True) or {}
        if action == "get":
            user = cloud_db.users.find_one({"userId": user_id})
            return jsonify({"account": account_payload(user)}), 200
        if action == "update":
            result, error = update_account(cloud_db, user_id, data)
            return error if error else jsonify({"account": result}), 200
        if action == "password":
            return change_account_password(cloud_db, user_id, data)
        return delete_cloud_account(cloud_db, user_id, data)
    except Exception as error:
        print("Mobile cloud account operation failed:", error)
        return jsonify({"error": "Cloud account service is unavailable."}), 503
    finally:
        if client:
            client.close()


@app.route("/api/mobile/sync", methods=["POST"])
@mobile_owner_required
def mobile_cloud_sync():
    user_id = request.mobile_user["userId"]
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Cloud sync data is required."}), 400

    connection = None
    try:
        connection = get_db_connection(user_id)
        _apply_mobile_changes(connection, data)
        connection.commit()
        connection.close()
        connection = None

        run_sync(user_id, strict=True)
        connection = get_db_connection(user_id)
        snapshot = mobile_cloud_snapshot(connection)
        return jsonify({
            **snapshot,
            "profile": {
                "userId": request.mobile_user["userId"],
                "email": request.mobile_user["email"],
            },
            "syncedAt": get_current_timestamp(),
        }), 200
    except ValueError as error:
        if connection:
            connection.rollback()
        return jsonify({"error": str(error)}), 400
    except RuntimeError as error:
        if connection:
            connection.rollback()
        return jsonify({"error": str(error)}), 503
    except Exception as error:
        if connection:
            connection.rollback()
        print("Mobile cloud sync failed:", error)
        return jsonify({"error": "Cloud sync failed. Your data remains on this device."}), 503
    finally:
        if connection:
            connection.close()


# ==========================================
# RUN SERVER
# ==========================================

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False,
        use_reloader=False
    )
