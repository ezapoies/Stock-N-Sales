import os
import threading
import time
import uuid
from collections import Counter
from datetime import datetime

from dotenv import load_dotenv
from pymongo import MongoClient

from backend.database import get_db_connection


config_directory = os.getenv("STOCK_N_SALES_CONFIG_DIR")
if config_directory:
    load_dotenv(os.path.join(config_directory, ".env"))
else:
    load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
MONGO_DATABASE = "stock_n_sales"
sync_state = {
    "status": "idle",
    "message": "",
    "products": 0,
    "categories": 0,
    "sales": 0,
    "deletions": 0,
    "ownerId": None,
}
sync_state_lock = threading.Lock()
sync_lock = threading.Lock()


def set_sync_state(
    status,
    message="",
    products=0,
    categories=0,
    sales=0,
    deletions=0,
    owner_id=None,
):
    with sync_state_lock:
        sync_state.update({
            "status": status,
            "message": message,
            "products": products,
            "categories": categories,
            "sales": sales,
            "deletions": deletions,
            "ownerId": owner_id,
        })


def get_sync_state(owner_id=None):
    with sync_state_lock:
        state = dict(sync_state)

    if state["ownerId"] != owner_id:
        return {
            "status": "idle",
            "message": "",
            "products": 0,
            "categories": 0,
            "sales": 0,
            "deletions": 0,
        }
    return state


def get_mongo_database():
    if not MONGO_URI:
        raise RuntimeError("MONGO_URI was not found in .env")

    client = MongoClient(
        MONGO_URI,
        serverSelectionTimeoutMS=5000,
    )
    client.admin.command("ping")
    return client[MONGO_DATABASE], client


def _records(connection, table_name):
    return connection.execute(
        f"SELECT * FROM {table_name}"
    ).fetchall()


def _ensure_cloud_ids(connection, mongo_db, owner_id):
    cursor = connection.cursor()
    for table_name in ("products", "categories", "sales"):
        collection = mongo_db[table_name]
        cloud_docs = list(collection.find({"ownerId": owner_id}))
        local_updated_at = {
            row["id"]: row["updatedAt"]
            for row in connection.execute(
                f"SELECT id, updatedAt FROM {table_name}"
            ).fetchall()
        }

        for document in cloud_docs:
            updates = {}
            cloud_id = document.get("_cloudId")
            if not cloud_id:
                local_id = document.get("_localId")
                cloud_id = (
                    f"legacy:{table_name}:{local_id}"
                    if local_id is not None
                    else f"legacy:{table_name}:{uuid.uuid4()}"
                )
                updates["_cloudId"] = cloud_id

            if not document.get("updatedAt"):
                updates["updatedAt"] = (
                    local_updated_at.get(document.get("_localId"))
                    or
                    document.get("createdAt")
                    or document.get("date")
                    or datetime.now().isoformat(timespec="seconds")
                )

            if updates:
                collection.update_one(
                    {"_id": document["_id"], "ownerId": owner_id},
                    {"$set": updates},
                )
                document.update(updates)

        if table_name == "sales":
            legacy_product_ids = {
                row["id"]: row["cloudId"]
                for row in connection.execute(
                    "SELECT id, cloudId FROM products"
                ).fetchall()
            }
            cloud_products = list(
                mongo_db["products"].find({"ownerId": owner_id})
            )
            product_name_counts = Counter(
                (product.get("name") or "").strip().casefold()
                for product in cloud_products
                if product.get("name")
            )
            unique_product_names = {
                product["name"].strip().casefold(): product["_cloudId"]
                for product in cloud_products
                if product.get("name")
                and product_name_counts[product["name"].strip().casefold()] == 1
            }
            for document in cloud_docs:
                if not document.get("productCloudId"):
                    legacy_product_id = document.get("productId")
                    product_cloud_id = (
                        legacy_product_ids.get(legacy_product_id)
                        or unique_product_names.get(
                            (document.get("productName") or "").strip().casefold()
                        )
                    )
                    if product_cloud_id:
                        collection.update_one(
                            {"_id": document["_id"], "ownerId": owner_id},
                            {"$set": {"productCloudId": product_cloud_id}},
                        )
                        document["productCloudId"] = product_cloud_id

        legacy_ids = {
            document.get("_localId"): document["_cloudId"]
            for document in cloud_docs
            if document.get("_localId") is not None
        }

        for row in _records(connection, table_name):
            if row["cloudId"]:
                continue

            if row["syncStatus"] == "synced":
                cloud_id = legacy_ids.get(row["id"]) or (
                    f"legacy:{table_name}:{row['id']}"
                )
            else:
                cloud_id = str(uuid.uuid4())
            cursor.execute(
                f"UPDATE {table_name} SET cloudId = ? WHERE id = ?",
                (cloud_id, row["id"]),
            )

    product_cloud_ids = {
        row["id"]: row["cloudId"]
        for row in connection.execute(
            "SELECT id, cloudId FROM products"
        ).fetchall()
    }
    for sale in connection.execute(
        "SELECT id, productId, productCloudId FROM sales"
    ).fetchall():
        if not sale["productCloudId"]:
            cursor.execute(
                "UPDATE sales SET productCloudId = ? WHERE id = ?",
                (product_cloud_ids.get(sale["productId"]), sale["id"]),
            )

    connection.commit()


def _push_local_changes(connection, mongo_db, owner_id):
    cursor = connection.cursor()
    synced = {"products": 0, "categories": 0, "sales": 0, "deletions": 0}

    product_ids = {
        row["id"]: row["cloudId"]
        for row in _records(connection, "products")
    }

    for table_name in ("products", "categories", "sales"):
        rows = connection.execute(
            f"SELECT * FROM {table_name} WHERE syncStatus = 'pending'"
        ).fetchall()
        collection = mongo_db[table_name]

        for row in rows:
            document = dict(row)
            local_id = document.pop("id")
            document.pop("syncStatus", None)
            cloud_id = document.pop("cloudId")
            if table_name == "sales":
                document["productCloudId"] = product_ids.get(
                    document["productId"]
                )

            document["_cloudId"] = cloud_id
            document["_localId"] = local_id
            collection.update_one(
                {"_cloudId": cloud_id, "ownerId": owner_id},
                {"$set": {**document, "ownerId": owner_id}},
                upsert=True,
            )
            cursor.execute(
                f"UPDATE {table_name} SET syncStatus = 'synced' WHERE id = ?",
                (local_id,),
            )
            synced[table_name] += 1

    deletions = connection.execute("""
        SELECT id, tableName, recordId, deletedAt, cloudId
        FROM sync_deletions
        WHERE syncStatus = 'pending'
        ORDER BY id ASC
    """).fetchall()
    tombstones = mongo_db["sync_deletions"]

    for deletion in deletions:
        table_name = deletion["tableName"]
        if table_name not in ("products", "categories"):
            continue

        cloud_id = deletion["cloudId"] or (
            f"legacy:{table_name}:{deletion['recordId']}"
        )
        tombstones.update_one(
            {"_cloudId": cloud_id, "ownerId": owner_id},
            {"$setOnInsert": {
                "_cloudId": cloud_id,
                "ownerId": owner_id,
                "tableName": table_name,
                "deletedAt": deletion["deletedAt"],
            }},
            upsert=True,
        )
        mongo_db[table_name].delete_one({
            "_cloudId": cloud_id,
            "ownerId": owner_id,
        })
        cursor.execute(
            "UPDATE sync_deletions SET cloudId = ?, syncStatus = 'synced' WHERE id = ?",
            (cloud_id, deletion["id"]),
        )
        synced["deletions"] += 1

    connection.commit()
    return synced


def _apply_tombstones(connection, mongo_db, owner_id):
    cursor = connection.cursor()
    tombstones = list(
        mongo_db["sync_deletions"].find({"ownerId": owner_id})
    )

    for tombstone in tombstones:
        table_name = tombstone.get("tableName")
        cloud_id = tombstone.get("_cloudId")
        if table_name not in ("products", "categories") or not cloud_id:
            continue

        cursor.execute(
            f"DELETE FROM {table_name} WHERE cloudId = ?",
            (cloud_id,),
        )
        mongo_db[table_name].delete_one({
            "_cloudId": cloud_id,
            "ownerId": owner_id,
        })

    connection.commit()
    return len(tombstones)


def _local_product_id(connection, cloud_id, fallback_name):
    product = connection.execute(
        "SELECT id FROM products WHERE cloudId = ?",
        (cloud_id,),
    ).fetchone() if cloud_id else None

    if not product and fallback_name:
        product = connection.execute(
            "SELECT id FROM products WHERE name = ? COLLATE NOCASE",
            (fallback_name,),
        ).fetchone()

    return product["id"] if product else None


def _merge_cloud_records(connection, mongo_db, owner_id):
    cursor = connection.cursor()
    changed = {"products": 0, "categories": 0, "sales": 0}
    tombstone_ids = {
        item.get("_cloudId")
        for item in mongo_db["sync_deletions"].find({"ownerId": owner_id})
    }

    for table_name in ("products", "categories", "sales"):
        for document in mongo_db[table_name].find({"ownerId": owner_id}):
            cloud_id = document.get("_cloudId")
            if not cloud_id or cloud_id in tombstone_ids:
                continue

            local = connection.execute(
                f"SELECT * FROM {table_name} WHERE cloudId = ?",
                (cloud_id,),
            ).fetchone()

            if table_name == "products":
                fields = (
                    "name", "category", "price", "stock", "minimumStock",
                    "createdAt", "updatedAt",
                )
            elif table_name == "categories":
                fields = ("name", "createdAt", "updatedAt")
            else:
                fields = (
                    "productId", "productName", "quantity", "price", "total",
                    "date", "createdAt", "updatedAt", "productCloudId",
                )

            values = {field: document.get(field) for field in fields}
            if table_name == "sales":
                values["productId"] = _local_product_id(
                    connection,
                    document.get("productCloudId"),
                    document.get("productName"),
                ) or 0

            if local:
                local_is_pending = local["syncStatus"] == "pending"
                local_updated = local["updatedAt"] or ""
                cloud_updated = document.get("updatedAt") or ""
                if local_is_pending or local_updated >= cloud_updated:
                    continue

                assignments = ", ".join(
                    f"{field} = ?" for field in fields
                )
                cursor.execute(
                    f"UPDATE {table_name} SET {assignments}, "
                    "syncStatus = 'synced' WHERE id = ?",
                    (*[values[field] for field in fields], local["id"]),
                )
                changed[table_name] += 1
                continue

            if table_name == "categories":
                existing_name = connection.execute(
                    "SELECT id, cloudId FROM categories "
                    "WHERE name = ? COLLATE NOCASE",
                    (values["name"],),
                ).fetchone()
                if existing_name:
                    if not existing_name["cloudId"]:
                        cursor.execute(
                            "UPDATE categories SET cloudId = ?, syncStatus = 'synced' WHERE id = ?",
                            (cloud_id, existing_name["id"]),
                        )
                    continue

            columns = [*fields, "cloudId", "syncStatus"]
            cursor.execute(
                f"INSERT INTO {table_name} "
                f"({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                (
                    *[values[field] for field in fields],
                    cloud_id,
                    "synced",
                ),
            )
            changed[table_name] += 1

    connection.commit()
    return changed


def run_sync(owner_id=None, startup=False, strict=False):
    if not owner_id:
        set_sync_state("idle", "Sign in to sync this workspace.")
        if strict:
            raise ValueError("Sign in to a cloud account before syncing.")
        return

    if not sync_lock.acquire(blocking=False):
        if strict:
            raise RuntimeError("A cloud sync is already running. Try again shortly.")
        return

    connection = None
    client = None
    try:
        if startup:
            set_sync_state(
                "syncing",
                "Connecting to cloud...",
                owner_id=owner_id,
            )

        mongo_db, client = get_mongo_database()
        connection = get_db_connection(owner_id)

        _ensure_cloud_ids(connection, mongo_db, owner_id)
        pushed = _push_local_changes(connection, mongo_db, owner_id)
        deleted = _apply_tombstones(connection, mongo_db, owner_id)
        pulled = _merge_cloud_records(connection, mongo_db, owner_id)

        counts = {
            key: pushed[key] + pulled.get(key, 0)
            for key in ("products", "categories", "sales")
        }
        counts["deletions"] = pushed["deletions"] + deleted

        message = "Data synced across devices."
        print(
            "[SYNC] Complete:",
            f"{counts['products']} products,",
            f"{counts['categories']} categories,",
            f"{counts['sales']} sales,",
            f"{counts['deletions']} deletions."
        )

        if startup:
            set_sync_state(
                "synced",
                message,
                owner_id=owner_id,
                **counts,
            )
            threading.Thread(
                target=_clear_startup_status,
                args=(owner_id,),
                daemon=True,
            ).start()
    except Exception as error:
        print("[SYNC] Cloud sync unavailable; local data is safe.")
        print("[SYNC] Details:", error)
        set_sync_state(
            "offline",
            "Cloud sync is unavailable. Your local data is safe.",
            owner_id=owner_id,
        )
        if strict:
            raise
    finally:
        if connection:
            connection.close()
        if client:
            client.close()
        sync_lock.release()


def _clear_startup_status(owner_id):
    time.sleep(8)
    if get_sync_state(owner_id)["status"] == "synced":
        set_sync_state("idle", owner_id=owner_id)


def trigger_sync(owner_id):
    if not owner_id:
        return
    threading.Thread(
        target=run_sync,
        args=(owner_id,),
        kwargs={"startup": True},
        daemon=True,
    ).start()
