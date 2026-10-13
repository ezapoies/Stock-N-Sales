import os
import tempfile
import unittest
from unittest.mock import patch

from pymongo.errors import DuplicateKeyError
from werkzeug.security import generate_password_hash

_test_directory = tempfile.TemporaryDirectory()
os.environ["STOCK_N_SALES_DB_PATH"] = os.path.join(
    _test_directory.name,
    "test_stock_n_sales.db"
)

from backend.app import app
from backend import sync


class FakeCollection:

    def __init__(self, documents=()):
        self.documents = [dict(document) for document in documents]
        self.next_id = max(
            (document.get("_id", 0) for document in self.documents),
            default=0,
        ) + 1

    def find(self, query):
        return [
            dict(document)
            for document in self.documents
            if self._matches(document, query)
        ]

    @staticmethod
    def _matches(document, query):
        for key, expected in query.items():
            if isinstance(expected, dict) and "$exists" in expected:
                if (key in document) != expected["$exists"]:
                    return False
            elif document.get(key) != expected:
                return False
        return True

    def find_one(self, query):
        return next(iter(self.find(query)), None)

    def count_documents(self, query):
        return len(self.find(query))

    def create_index(self, *args, **kwargs):
        return None

    def insert_one(self, document):
        if document.get("email") and self.find_one({"email": document["email"]}):
            raise DuplicateKeyError("Duplicate email")
        saved = dict(document)
        saved.setdefault("_id", self.next_id)
        self.next_id += 1
        self.documents.append(saved)

    def update_many(self, query, update):
        for document in self.documents:
            if self._matches(document, query):
                document.update(update.get("$set", {}))

    def update_one(self, query, update, upsert=False):
        document = next(
            (
                item for item in self.documents
                if self._matches(item, query)
            ),
            None,
        )
        if document is None and upsert:
            document = {"_id": self.next_id}
            self.next_id += 1
            self.documents.append(document)

        if document is None:
            return

        document.update(update.get("$set", {}))
        if "$setOnInsert" in update:
            document.update(update["$setOnInsert"])

    def delete_one(self, query):
        document = self.find_one(query)
        if document:
            self.documents.remove(document)


class FakeDatabase:

    def __init__(self, **collections):
        self.collections = {
            name: FakeCollection(documents)
            for name, documents in collections.items()
        }

    def __getitem__(self, name):
        return self.collections.setdefault(name, FakeCollection())


class FakeMongoClient:

    def close(self):
        pass


class DeploymentSmokeTests(unittest.TestCase):
    sync_owner_id = "test-owner"

    @classmethod
    def setUpClass(cls):
        app.config.update(
            TESTING=True,
            SECRET_KEY="test-secret-key",
            SESSION_COOKIE_SECURE=False
        )

    @classmethod
    def tearDownClass(cls):
        _test_directory.cleanup()

    def setUp(self):
        self.sync_patcher = patch("backend.app.trigger_sync")
        self.sync_patcher.start()
        self.client = app.test_client()
        from backend.database import create_local_workspace, get_db_connection

        workspace = create_local_workspace("Jordan", "Corner Shop")
        self.local_workspace_id = workspace["id"]
        with self.client.session_transaction() as browser_session:
            browser_session["local_workspace_id"] = self.local_workspace_id

        with app.app_context():
            connection = get_db_connection(self.sync_owner_id)
            for table_name in (
                "user_profile",
                "products",
                "categories",
                "sales",
                "sync_deletions",
            ):
                connection.execute(f"DELETE FROM {table_name}")
            connection.commit()
            connection.close()

    def tearDown(self):
        self.sync_patcher.stop()

    def test_hosted_frontend_assets_are_served(self):
        for path in (
            "/",
            "/manifest.json",
            "/service-worker.js",
            "/icons/app-icon-192.png",
            "/icons/app-icon-512.png",
            "/icons/app-icon-maskable-512.png",
            "/css/style.css",
            "/js/app.js",
            "/js/mobile-store.js",
            "/js/chart.umd.min.js",
            "/js/pwa.js",
            "/Logo.png",
        ):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                body = response.get_data()
                if path == "/":
                    self.assertIn(b'id="appDialog"', body)
                    self.assertIn(b'id="appDialogInput"', body)
                    self.assertIn(b'rel="manifest"', body)
                elif path == "/manifest.json":
                    self.assertEqual(response.mimetype, "application/manifest+json")
                    self.assertEqual(response.json["display"], "standalone")
                elif path == "/service-worker.js":
                    self.assertEqual(response.headers["Cache-Control"], "no-cache")
                    self.assertIn(b'url.pathname.startsWith("/api/")', body)
                response.close()

    def test_local_workspace_opens_without_credentials(self):
        self.client.post("/api/workspaces/leave")
        initial = self.client.get("/api/workspaces")
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(
            initial.json["workspaces"][0]["businessName"],
            "Corner Shop",
        )
        self.assertEqual(self.client.get("/api/products").status_code, 409)

        response = self.client.post(
            "/api/workspaces",
            json={
                "userName": "Jordan",
                "businessName": "Corner Shop"
            }
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(self.client.get("/api/profile").json["configured"])
        self.assertEqual(self.client.get("/api/products").status_code, 200)

    def test_local_workspaces_have_separate_profiles_and_inventory(self):
        first_product = self.client.post(
            "/api/products",
            json={
                "name": "First business item",
                "category": "General",
                "price": 2,
                "stock": 4,
                "minimumStock": 1,
            },
        )
        self.assertEqual(first_product.status_code, 201)
        self.client.post("/api/workspaces/leave")

        second_workspace = self.client.post(
            "/api/workspaces",
            json={
                "userName": "Taylor",
                "businessName": "Taylor's Shop",
            },
        )
        self.assertEqual(second_workspace.status_code, 201)
        self.assertEqual(
            self.client.get("/api/profile").json["businessName"],
            "Taylor's Shop",
        )
        self.assertEqual(self.client.get("/api/products").json, [])

        self.client.post("/api/workspaces/leave")
        opened_first = self.client.post(
            "/api/workspaces/select",
            json={"workspaceId": self.local_workspace_id},
        )
        self.assertEqual(opened_first.status_code, 200)
        self.assertEqual(
            self.client.get("/api/products").json[0]["name"],
            "First business item",
        )

    def test_empty_dashboard_does_not_report_healthy_stock(self):
        response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["totalProducts"], 0)
        self.assertEqual(response.json["lowStockCount"], 0)
        self.assertEqual(response.json["lowStockProducts"], [])

        script_response = self.client.get("/js/app.js")
        script = script_response.get_data(as_text=True)
        script_response.close()
        self.assertIn('if (data.totalProducts === 0)', script)
        self.assertIn("No products yet", script)

    def test_dashboard_reports_healthy_stock_only_when_products_exist(self):
        response = self.client.post(
            "/api/products",
            json={
                "name": "Well-stocked item",
                "category": "General",
                "price": 2,
                "stock": 5,
                "minimumStock": 1,
            },
        )
        self.assertEqual(response.status_code, 201)

        dashboard = self.client.get("/api/dashboard")
        self.assertEqual(dashboard.json["totalProducts"], 1)
        self.assertEqual(dashboard.json["lowStockCount"], 0)
        self.assertEqual(dashboard.json["lowStockProducts"], [])

    def test_category_can_be_added_to_current_local_workspace(self):
        response = self.client.post(
            "/api/categories",
            json={"name": "Drinks"},
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["category"]["name"], "Drinks")

        categories = self.client.get("/api/categories")
        self.assertEqual(categories.status_code, 200)
        self.assertEqual(
            [category["name"] for category in categories.json],
            ["Drinks"],
        )

    def test_registering_cloud_account_claims_legacy_data_and_keeps_guest_copy(self):
        self.client.post(
            "/api/profile",
            json={"userName": "Jordan", "businessName": "Corner Shop"},
        )
        local_product = self.client.post(
            "/api/products",
            json={
                "name": "Tea",
                "category": "Drinks",
                "price": 4.5,
                "stock": 8,
                "minimumStock": 2,
            },
        )
        self.assertEqual(local_product.status_code, 201)

        cloud = FakeDatabase(products=[{
            "_id": 12,
            "_cloudId": "legacy-product",
            "name": "Coffee",
            "category": "Drinks",
            "price": 3,
            "stock": 4,
            "minimumStock": 1,
            "createdAt": "2026-01-01T09:00:00",
            "updatedAt": "2026-01-01T09:00:00",
        }])
        with patch("backend.app.get_mongo_database", return_value=(cloud, FakeMongoClient())):
            response = self.client.post(
                "/api/cloud/register",
                json={
                    "email": "jordan@example.com",
                    "password": "correct horse battery",
                    "userName": "Jordan",
                    "businessName": "Corner Shop",
                },
            )

            self.assertEqual(response.status_code, 201)
            user_id = response.json["userId"]
            self.assertEqual(
                cloud["products"].find_one({"_cloudId": "legacy-product"})["ownerId"],
                user_id,
            )
            self.assertIsNotNone(cloud["users"].find_one({
                "email": "jordan@example.com"
            })["passwordHash"])

            from backend.database import get_db_connection

            cloud_connection = get_db_connection(user_id)
            self.assertEqual(
                cloud_connection.execute(
                    "SELECT COUNT(*) FROM products WHERE name = 'Tea'"
                ).fetchone()[0],
                1,
            )
            cloud_connection.close()

            local_connection = get_db_connection(self.local_workspace_id)
            self.assertEqual(
                local_connection.execute(
                    "SELECT COUNT(*) FROM products WHERE name = 'Tea'"
                ).fetchone()[0],
                1,
            )
            local_connection.close()

            self.client.post("/api/auth/logout")
            self.assertFalse(self.client.get("/api/profile").json["cloudConnected"])

            signed_in = self.client.post(
                "/api/cloud/login",
                json={
                    "email": "JORDAN@example.com",
                    "password": "correct horse battery",
                },
            )
            self.assertEqual(signed_in.status_code, 200)
            self.assertEqual(
                self.client.get("/api/products").json[0]["name"],
                "Tea",
            )

    def test_cloud_unavailable_does_not_block_local_workspace(self):
        self.client.post(
            "/api/profile",
            json={"userName": "Jordan", "businessName": "Corner Shop"},
        )
        with patch(
            "backend.app.get_mongo_database",
            side_effect=RuntimeError("Cloud unavailable"),
        ):
            response = self.client.post(
                "/api/cloud/register",
                json={
                    "email": "jordan@example.com",
                    "password": "correct horse battery",
                    "userName": "Jordan",
                    "businessName": "Corner Shop",
                },
            )

        self.assertEqual(response.status_code, 503)
        self.assertFalse(self.client.get("/api/profile").json["cloudConnected"])
        self.assertEqual(self.client.get("/api/products").status_code, 200)

    def test_cloud_account_can_be_created_before_a_local_workspace(self):
        self.client.post("/api/workspaces/leave")
        cloud = FakeDatabase()
        with patch("backend.app.get_mongo_database", return_value=(cloud, FakeMongoClient())):
            response = self.client.post(
                "/api/cloud/register",
                json={
                    "email": "new@example.com",
                    "password": "correct horse battery",
                    "userName": "New User",
                    "businessName": "New Business",
                },
            )

        self.assertEqual(response.status_code, 201)
        self.assertTrue(self.client.get("/api/profile").json["configured"])
        self.assertTrue(self.client.get("/api/profile").json["cloudConnected"])

    def test_sync_downloads_only_the_signed_in_tenants_records(self):
        cloud = FakeDatabase(
            products=[
                {
                    "_id": 1,
                    "_cloudId": "tenant-a-product",
                    "ownerId": "tenant-a",
                    "name": "Tenant A item",
                    "category": "General",
                    "price": 2,
                    "stock": 4,
                    "minimumStock": 1,
                    "createdAt": "2026-01-01T09:00:00",
                    "updatedAt": "2026-01-01T09:00:00",
                },
                {
                    "_id": 2,
                    "_cloudId": "tenant-b-product",
                    "ownerId": "tenant-b",
                    "name": "Tenant B item",
                    "category": "General",
                    "price": 3,
                    "stock": 5,
                    "minimumStock": 1,
                    "createdAt": "2026-01-01T09:00:00",
                    "updatedAt": "2026-01-01T09:00:00",
                },
            ],
        )
        with patch.object(sync, "get_mongo_database", return_value=(cloud, FakeMongoClient())):
            sync.run_sync("tenant-a", startup=True)

        from backend.database import get_db_connection

        connection = get_db_connection("tenant-a")
        try:
            names = [
                row["name"]
                for row in connection.execute(
                    "SELECT name FROM products ORDER BY name"
                ).fetchall()
            ]
            self.assertEqual(names, ["Tenant A item"])
        finally:
            connection.close()

    def test_product_sale_updates_local_inventory(self):
        self.client.post(
            "/api/profile",
            json={
                "userName": "Jordan",
                "businessName": "Corner Shop",
                "password": "correct horse battery"
            }
        )
        product_response = self.client.post(
            "/api/products",
            json={
                "name": "Tea",
                "category": "Drinks",
                "price": 4.5,
                "stock": 8,
                "minimumStock": 2
            }
        )
        self.assertEqual(product_response.status_code, 201)
        product_id = product_response.json["product"]["id"]

        sale_response = self.client.post(
            "/api/sales",
            json={"productId": product_id, "quantity": 3}
        )
        self.assertEqual(sale_response.status_code, 201)
        self.assertEqual(sale_response.json["sale"]["total"], 13.5)

        inventory_response = self.client.get("/api/products")
        self.assertEqual(inventory_response.status_code, 200)
        self.assertEqual(inventory_response.json[0]["stock"], 5)

    def test_deleting_a_product_creates_cloud_tombstone_identity(self):
        self.client.post(
            "/api/profile",
            json={
                "userName": "Jordan",
                "businessName": "Corner Shop",
                "password": "correct horse battery"
            }
        )
        product_response = self.client.post(
            "/api/products",
            json={
                "name": "Soap",
                "category": "Household",
                "price": 2,
                "stock": 3,
                "minimumStock": 1
            }
        )
        product_id = product_response.json["product"]["id"]
        deleted = self.client.delete(f"/api/products/{product_id}")

        self.assertEqual(deleted.status_code, 200)
        from backend.database import get_db_connection

        connection = get_db_connection(self.local_workspace_id)
        try:
            tombstone = connection.execute(
                "SELECT cloudId FROM sync_deletions WHERE tableName = 'products'"
            ).fetchone()
            self.assertIsNotNone(tombstone["cloudId"])
            self.assertIsNone(connection.execute(
                "SELECT id FROM products WHERE id = ?",
                (product_id,),
            ).fetchone())
        finally:
            connection.close()

    def test_category_with_products_cannot_be_removed(self):
        self.client.post(
            "/api/profile",
            json={
                "userName": "Jordan",
                "businessName": "Corner Shop",
                "password": "correct horse battery"
            }
        )
        category_response = self.client.post(
            "/api/categories",
            json={"name": "Drinks"}
        )
        self.assertEqual(category_response.status_code, 201)
        category_id = category_response.json["category"]["id"]

        product_response = self.client.post(
            "/api/products",
            json={
                "name": "Water",
                "category": "Drinks",
                "price": 1,
                "stock": 5,
                "minimumStock": 1
            }
        )
        self.assertEqual(product_response.status_code, 201)

        response = self.client.delete(f"/api/categories/{category_id}")
        self.assertEqual(response.status_code, 400)
        self.assertIn("products are using it", response.json["error"])

    def test_delete_all_category_products_preserves_category_and_sales(self):
        self.client.post(
            "/api/profile",
            json={
                "userName": "Jordan",
                "businessName": "Corner Shop",
                "password": "correct horse battery"
            }
        )
        category_response = self.client.post(
            "/api/categories",
            json={"name": "Drinks"}
        )
        category_id = category_response.json["category"]["id"]
        product_ids = []
        for name in ("Water", "Juice"):
            product_response = self.client.post(
                "/api/products",
                json={
                    "name": name,
                    "category": "Drinks",
                    "price": 2,
                    "stock": 5,
                    "minimumStock": 1
                }
            )
            product_ids.append(product_response.json["product"]["id"])

        sale = self.client.post(
            "/api/sales",
            json={"productId": product_ids[0], "quantity": 1}
        )
        self.assertEqual(sale.status_code, 201)

        response = self.client.delete(
            f"/api/categories/{category_id}/products"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["deletedCount"], 2)

        from backend.database import get_db_connection

        connection = get_db_connection(self.local_workspace_id)
        try:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM products WHERE category = 'Drinks'"
                ).fetchone()[0],
                0,
            )
            self.assertIsNotNone(connection.execute(
                "SELECT id FROM categories WHERE id = ?",
                (category_id,),
            ).fetchone())
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM sales").fetchone()[0],
                1,
            )
            tombstones = connection.execute(
                "SELECT COUNT(*) FROM sync_deletions "
                "WHERE tableName = 'products' AND syncStatus = 'pending'"
            ).fetchone()[0]
            self.assertEqual(tombstones, 2)
        finally:
            connection.close()

    def test_empty_category_can_be_removed_and_queued_for_sync(self):
        self.client.post(
            "/api/profile",
            json={
                "userName": "Jordan",
                "businessName": "Corner Shop",
                "password": "correct horse battery"
            }
        )
        category_response = self.client.post(
            "/api/categories",
            json={"name": "Seasonal"}
        )
        category_id = category_response.json["category"]["id"]

        response = self.client.delete(f"/api/categories/{category_id}")
        self.assertEqual(response.status_code, 200)

        from backend.database import get_db_connection

        connection = get_db_connection(self.local_workspace_id)
        try:
            self.assertIsNone(connection.execute(
                "SELECT id FROM categories WHERE id = ?",
                (category_id,),
            ).fetchone())
            tombstone = connection.execute(
                "SELECT tableName, cloudId, syncStatus FROM sync_deletions "
                "WHERE tableName = 'categories'"
            ).fetchone()
            self.assertEqual(tombstone["tableName"], "categories")
            self.assertTrue(tombstone["cloudId"])
            self.assertEqual(tombstone["syncStatus"], "pending")
        finally:
            connection.close()

    def test_health_check_reports_database_status(self):
        response = self.client.get("/api/test")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["database"], "connected")

    def test_demand_prediction_uses_sales_history_and_returns_numeric_demand(self):
        self.client.post(
            "/api/profile",
            json={
                "userName": "Jordan",
                "businessName": "Corner Shop",
                "password": "correct horse battery"
            }
        )
        from backend.database import get_db_connection

        connection = get_db_connection(self.local_workspace_id)
        connection.execute(
            """
            INSERT INTO sales
                (productId, productName, quantity, price, total, date,
                 createdAt, updatedAt, syncStatus, cloudId)
            VALUES
                (1, 'Tea', 3, 4.5, 13.5, '2026-01-01T10:00:00',
                 '2026-01-01T10:00:00', '2026-01-01T10:00:00',
                 'synced', 'tea-sale')
            """
        )
        connection.commit()
        connection.close()

        prediction = {
            "predictedDemand": 3.0,
            "historyDays": 1,
            "dailySalesRecords": 1,
            "modelStatus": "limited_history",
            "warning": "Limited history",
        }
        with patch("backend.app.predict_demand", return_value=prediction) as predict:
            response = self.client.post(
                "/api/ai/predict",
                json={
                    "product": "Tea",
                    "price": 4.5,
                    "date": "2026-01-02"
                }
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["predictedDemand"], 3.0)
        self.assertEqual(response.json["modelStatus"], "limited_history")
        predict.assert_called_once_with(
            "Tea",
            4.5,
            "2026-01-02",
            sales_history=[{"date": "2026-01-01T10:00:00", "quantity": 3}]
        )

    def test_demand_prediction_supports_a_flexible_forecast_period(self):
        response = self.client.post(
            "/api/ai/predict",
            json={
                "product": "Rice",
                "price": 12,
                "date": "2026-02-01",
                "days": 30
            }
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["horizonDays"], 30)
        self.assertEqual(len(response.json["daily"]), 30)
        self.assertEqual(response.json["startDate"], "2026-02-01")
        self.assertEqual(response.json["endDate"], "2026-03-02")
        self.assertIn(
            response.json["trend"]["direction"],
            {"rising", "falling", "stable"}
        )
        self.assertGreaterEqual(response.json["totalDemand"], 0)

    def test_demand_prediction_rejects_a_period_outside_the_allowed_range(self):
        response = self.client.post(
            "/api/ai/predict",
            json={
                "product": "Rice",
                "price": 12,
                "date": "2026-02-01",
                "days": 500
            }
        )
        self.assertEqual(response.status_code, 400)

    def test_manual_sync_requires_a_cloud_account(self):
        unauthorized = self.client.post("/api/sync-now")
        self.assertEqual(unauthorized.status_code, 401)

        with self.client.session_transaction() as browser_session:
            browser_session["cloud_user_id"] = "test-cloud-user"

        with patch("backend.app.trigger_sync") as trigger:
            response = self.client.post("/api/sync-now")

        self.assertEqual(response.status_code, 202)
        trigger.assert_called_once_with("test-cloud-user")

    def test_mobile_login_token_can_sync_without_a_browser_session(self):
        cloud = FakeDatabase(users=[{
            "_id": 1,
            "userId": "mobile-test-owner",
            "email": "owner@example.com",
            "passwordHash": generate_password_hash("correct horse battery"),
            "userName": "Ari",
            "businessName": "Market One",
        }])
        with self.client.session_transaction() as browser_session:
            browser_session.clear()
        with (
            patch("backend.app.get_mongo_database", return_value=(cloud, FakeMongoClient())),
            patch("backend.app.run_sync"),
        ):
            login = self.client.post("/api/mobile/auth/login", json={
                "email": "OWNER@example.com",
                "password": "correct horse battery",
            })

        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.json["profile"]["userId"], "mobile-test-owner")
        token = login.json["accessToken"]
        sync_response = self.client.post(
            "/api/mobile/sync",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "products": [{
                    "cloudId": "mobile-product-1",
                    "name": "Tea",
                    "category": "Drinks",
                    "price": 4,
                    "stock": 8,
                    "minimumStock": 2,
                    "createdAt": "2026-02-01T09:00:00",
                    "updatedAt": "2026-02-01T09:00:00",
                }],
                "categories": [],
                "sales": [{
                    "cloudId": "mobile-sale-1",
                    "productCloudId": "mobile-product-1",
                    "productName": "Tea",
                    "quantity": 1,
                    "price": 4,
                    "total": 4,
                    "date": "2026-02-01T10:00:00",
                    "createdAt": "2026-02-01T10:00:00",
                    "updatedAt": "2026-02-01T10:00:00",
                }],
                "deletions": [],
            },
        )

        self.assertEqual(sync_response.status_code, 200)
        self.assertEqual(sync_response.json["profile"]["userId"], "mobile-test-owner")
        self.assertEqual(sync_response.json["products"][0]["cloudId"], "mobile-product-1")
        self.assertEqual(sync_response.json["sales"][0]["productCloudId"], "mobile-product-1")

    def test_mobile_sync_rejects_missing_and_invalid_bearer_tokens(self):
        for headers in ({}, {"Authorization": "Bearer invalid-token"}):
            with self.subTest(headers=headers):
                response = self.client.post(
                    "/api/mobile/sync",
                    headers=headers,
                    json={"products": [], "categories": [], "sales": [], "deletions": []},
                )
                self.assertEqual(response.status_code, 401)

    def test_mobile_registration_creates_a_tokenized_cloud_account(self):
        cloud = FakeDatabase()
        with (
            patch("backend.app.get_mongo_database", return_value=(cloud, FakeMongoClient())),
            patch("backend.app.run_sync"),
        ):
            response = self.client.post("/api/mobile/auth/register", json={
                "email": "new-owner@example.com",
                "password": "password123",
                "userName": "Ari",
                "businessName": "Market One",
            })

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json["accessToken"])
        self.assertEqual(response.json["profile"]["businessName"], "Market One")
        self.assertEqual(
            cloud["users"].find_one({"email": "new-owner@example.com"})["userId"],
            response.json["profile"]["userId"],
        )

    def test_mobile_tokens_keep_cloud_workspaces_separate(self):
        cloud = FakeDatabase(users=[
            {
                "_id": 1,
                "userId": "mobile-owner-one",
                "email": "one@example.com",
                "passwordHash": generate_password_hash("password-one"),
            },
            {
                "_id": 2,
                "userId": "mobile-owner-two",
                "email": "two@example.com",
                "passwordHash": generate_password_hash("password-two"),
            },
        ])
        with (
            patch("backend.app.get_mongo_database", return_value=(cloud, FakeMongoClient())),
            patch("backend.app.run_sync"),
        ):
            tokens = {}
            for owner_id, email, password in (
                ("mobile-owner-one", "one@example.com", "password-one"),
                ("mobile-owner-two", "two@example.com", "password-two"),
            ):
                login = self.client.post("/api/mobile/auth/login", json={
                    "email": email,
                    "password": password,
                })
                self.assertEqual(login.status_code, 200)
                tokens[owner_id] = login.json["accessToken"]
                response = self.client.post(
                    "/api/mobile/sync",
                    headers={"Authorization": f"Bearer {tokens[owner_id]}"},
                    json={
                        "products": [{
                            "cloudId": f"product-{owner_id}",
                            "name": owner_id,
                            "category": "General",
                            "price": 1,
                            "stock": 1,
                            "minimumStock": 0,
                        }],
                        "categories": [],
                        "sales": [],
                        "deletions": [],
                    },
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    [item["name"] for item in response.json["products"]],
                    [owner_id],
                )

    def test_strict_cloud_sync_propagates_atlas_failures(self):
        with patch.object(sync, "get_mongo_database", side_effect=RuntimeError("Atlas unavailable")):
            with self.assertRaisesRegex(RuntimeError, "Atlas unavailable"):
                sync.run_sync("mobile-test-owner", strict=True)

    def test_sync_downloads_cloud_products_categories_and_sales(self):
        cloud = FakeDatabase(
            products=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "product-from-device-one",
                "_localId": 1,
                "name": "Coffee",
                "category": "Drinks",
                "price": 3.5,
                "stock": 12,
                "minimumStock": 2,
                "createdAt": "2026-01-01T09:00:00",
                "updatedAt": "2026-01-01T09:00:00",
            }],
            categories=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "category-from-device-one",
                "_localId": 1,
                "name": "Drinks",
                "createdAt": "2026-01-01T09:00:00",
                "updatedAt": "2026-01-01T09:00:00",
            }],
            sales=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "sale-from-device-one",
                "_localId": 1,
                "productId": 1,
                "productCloudId": "product-from-device-one",
                "productName": "Coffee",
                "quantity": 2,
                "price": 3.5,
                "total": 7.0,
                "date": "2026-01-02T10:00:00",
                "createdAt": "2026-01-02T10:00:00",
                "updatedAt": "2026-01-02T10:00:00",
            }],
        )
        with patch.object(sync, "get_mongo_database", return_value=(cloud, FakeMongoClient())):
            sync.run_sync(self.sync_owner_id, startup=True)

        from backend.database import get_db_connection

        connection = get_db_connection(self.sync_owner_id)
        try:
            product = connection.execute(
                "SELECT id, cloudId, stock FROM products WHERE cloudId = ?",
                ("product-from-device-one",),
            ).fetchone()
            category = connection.execute(
                "SELECT cloudId FROM categories WHERE name = ?",
                ("Drinks",),
            ).fetchone()
            sale = connection.execute(
                "SELECT productId, productCloudId, total FROM sales WHERE cloudId = ?",
                ("sale-from-device-one",),
            ).fetchone()

            self.assertIsNotNone(product)
            self.assertEqual(product["stock"], 12)
            self.assertEqual(category["cloudId"], "category-from-device-one")
            self.assertEqual(sale["productId"], product["id"])
            self.assertEqual(sale["productCloudId"], "product-from-device-one")
            self.assertEqual(sale["total"], 7.0)
        finally:
            connection.close()

    def test_sync_uploads_local_changes_and_applies_cloud_deletions(self):
        from backend.database import get_db_connection

        connection = get_db_connection(self.sync_owner_id)
        connection.execute("""
            INSERT INTO products
                (name, category, price, stock, minimumStock,
                 createdAt, updatedAt, syncStatus, cloudId)
            VALUES
                ('Local item', 'General', 2, 4, 1,
                 '2026-02-01T09:00:00', '2026-02-01T09:00:00',
                 'pending', 'local-product')
        """)
        connection.execute("""
            INSERT INTO products
                (name, category, price, stock, minimumStock,
                 createdAt, updatedAt, syncStatus, cloudId)
            VALUES
                ('Deleted item', 'General', 2, 4, 1,
                 '2026-01-01T09:00:00', '2026-01-01T09:00:00',
                 'synced', 'deleted-product')
        """)
        connection.commit()
        connection.close()

        cloud = FakeDatabase(
            products=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "deleted-product",
                "name": "Deleted item",
                "category": "General",
                "price": 2,
                "stock": 4,
                "minimumStock": 1,
                "createdAt": "2026-01-01T09:00:00",
                "updatedAt": "2026-01-01T09:00:00",
            }],
            sync_deletions=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "deleted-product",
                "tableName": "products",
                "deletedAt": "2026-02-01T10:00:00",
            }],
        )
        with patch.object(sync, "get_mongo_database", return_value=(cloud, FakeMongoClient())):
            sync.run_sync(self.sync_owner_id, startup=True)

        pushed = cloud["products"].find({"_cloudId": "local-product"})
        self.assertEqual(len(pushed), 1)
        self.assertEqual(pushed[0]["name"], "Local item")

        connection = get_db_connection(self.sync_owner_id)
        try:
            self.assertIsNone(connection.execute(
                "SELECT id FROM products WHERE cloudId = ?",
                ("deleted-product",),
            ).fetchone())
            self.assertEqual(
                connection.execute(
                    "SELECT syncStatus FROM products WHERE cloudId = ?",
                    ("local-product",),
                ).fetchone()["syncStatus"],
                "synced",
            )
        finally:
            connection.close()

    def test_sync_publishes_local_deletion_tombstones(self):
        from backend.database import get_db_connection

        connection = get_db_connection(self.sync_owner_id)
        connection.execute("""
            INSERT INTO sync_deletions
                (tableName, recordId, deletedAt, syncStatus, cloudId)
            VALUES
                ('products', 9, '2026-03-01T09:00:00',
                 'pending', 'removed-product')
        """)
        connection.commit()
        connection.close()

        cloud = FakeDatabase(
            products=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "removed-product",
                "name": "Removed item",
                "category": "General",
                "price": 2,
                "stock": 4,
                "minimumStock": 1,
                "createdAt": "2026-01-01T09:00:00",
                "updatedAt": "2026-01-01T09:00:00",
            }],
        )
        with patch.object(sync, "get_mongo_database", return_value=(cloud, FakeMongoClient())):
            sync.run_sync(self.sync_owner_id, startup=True)

        self.assertEqual(
            cloud["products"].find({"ownerId": self.sync_owner_id}),
            [],
        )
        tombstones = cloud["sync_deletions"].find(
            {"_cloudId": "removed-product"}
        )
        self.assertEqual(len(tombstones), 1)

    def test_sync_applies_newer_cloud_edits_to_local_records(self):
        from backend.database import get_db_connection

        connection = get_db_connection(self.sync_owner_id)
        connection.execute("""
            INSERT INTO products
                (name, category, price, stock, minimumStock,
                 createdAt, updatedAt, syncStatus, cloudId)
            VALUES
                ('Tea', 'Drinks', 3, 5, 1,
                 '2026-01-01T09:00:00', '2026-01-01T09:00:00',
                 'synced', 'shared-product')
        """)
        connection.commit()
        connection.close()

        cloud = FakeDatabase(
            products=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "shared-product",
                "name": "Tea",
                "category": "Drinks",
                "price": 3.5,
                "stock": 9,
                "minimumStock": 2,
                "createdAt": "2026-01-01T09:00:00",
                "updatedAt": "2026-02-01T09:00:00",
            }],
        )
        with patch.object(sync, "get_mongo_database", return_value=(cloud, FakeMongoClient())):
            sync.run_sync(self.sync_owner_id, startup=True)

        connection = get_db_connection(self.sync_owner_id)
        try:
            product = connection.execute(
                "SELECT price, stock, minimumStock FROM products "
                "WHERE cloudId = ?",
                ("shared-product",),
            ).fetchone()
            self.assertEqual(product["price"], 3.5)
            self.assertEqual(product["stock"], 9)
            self.assertEqual(product["minimumStock"], 2)
        finally:
            connection.close()

    def test_pending_local_edit_wins_over_cloud_copy(self):
        from backend.database import get_db_connection

        connection = get_db_connection(self.sync_owner_id)
        connection.execute("""
            INSERT INTO products
                (name, category, price, stock, minimumStock,
                 createdAt, updatedAt, syncStatus, cloudId)
            VALUES
                ('Tea', 'Drinks', 4, 7, 1,
                 '2026-01-01T09:00:00', '2026-02-01T09:00:00',
                 'pending', 'shared-product')
        """)
        connection.commit()
        connection.close()

        cloud = FakeDatabase(
            products=[{
                "_id": 1,
                "ownerId": self.sync_owner_id,
                "_cloudId": "shared-product",
                "name": "Tea",
                "category": "Drinks",
                "price": 3,
                "stock": 5,
                "minimumStock": 1,
                "createdAt": "2026-01-01T09:00:00",
                "updatedAt": "2026-01-15T09:00:00",
            }],
        )
        with patch.object(sync, "get_mongo_database", return_value=(cloud, FakeMongoClient())):
            sync.run_sync(self.sync_owner_id, startup=True)

        cloud_product = cloud["products"].find(
            {"_cloudId": "shared-product"}
        )[0]
        self.assertEqual(cloud_product["price"], 4)
        self.assertEqual(cloud_product["stock"], 7)


if __name__ == "__main__":
    unittest.main()
