import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";

const storeSource = await readFile(
    new URL("../js/mobile-store.js", import.meta.url),
    "utf8"
);

function loadStore() {
    globalThis.indexedDB = new IDBFactory();
    globalThis.window = {
        location: { origin: "https://localhost" }
    };
    globalThis.Response = Response;
    (0, eval)(storeSource);
    return window.mobileStore;
}

async function request(store, path, { method = "GET", body } = {}) {
    const response = await store.handle(`https://localhost/api${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
        status: response.status,
        body: await response.json()
    };
}

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
    delete globalThis.window;
    delete globalThis.indexedDB;
});

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

test("creates and selects separate local business workspaces", async () => {
    const store = loadStore();
    const first = await request(store, "/workspaces", {
        method: "POST",
        body: { userName: "Ari", businessName: "Market One" }
    });
    const second = await request(store, "/workspaces", {
        method: "POST",
        body: { userName: "Sam", businessName: "Market Two" }
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const listed = await request(store, "/workspaces");
    assert.equal(listed.body.workspaces.length, 2);
    assert.equal(listed.body.activeWorkspaceId, second.body.workspace.id);

    await request(store, "/workspaces/select", {
        method: "POST",
        body: { workspaceId: first.body.workspace.id }
    });
    const profile = await request(store, "/profile");
    assert.equal(profile.body.businessName, "Market One");
});

test("records sales atomically against local stock and keeps workspaces isolated", async () => {
    const store = loadStore();
    const workspace = await request(store, "/workspaces", {
        method: "POST",
        body: { userName: "Ari", businessName: "Market One" }
    });
    const product = await request(store, "/products", {
        method: "POST",
        body: {
            name: "Tea",
            category: "Drinks",
            price: 5,
            stock: 8,
            minimumStock: 2
        }
    });
    const sale = await request(store, "/sales", {
        method: "POST",
        body: { productId: product.body.product.id, quantity: 3 }
    });

    assert.equal(sale.status, 201);
    assert.equal(sale.body.sale.total, 15);
    let products = await request(store, "/products");
    assert.equal(products.body[0].stock, 5);

    const blockedSale = await request(store, "/sales", {
        method: "POST",
        body: { productId: product.body.product.id, quantity: 6 }
    });
    assert.equal(blockedSale.status, 400);

    await request(store, "/workspaces/leave", { method: "POST" });
    const noWorkspace = await request(store, "/products");
    assert.equal(noWorkspace.status, 409);

    await request(store, "/workspaces/select", {
        method: "POST",
        body: { workspaceId: workspace.body.workspace.id }
    });
    products = await request(store, "/products");
    assert.equal(products.body.length, 1);
    assert.equal(products.body[0].stock, 5);
});

test("supports categories, inventory edits, and on-device analytics", async () => {
    const store = loadStore();
    await request(store, "/workspaces", {
        method: "POST",
        body: { userName: "Ari", businessName: "Market One" }
    });
    const category = await request(store, "/categories", {
        method: "POST",
        body: { name: "Pantry" }
    });
    assert.equal(category.status, 201);

    const product = await request(store, "/products", {
        method: "POST",
        body: {
            name: "Rice",
            category: "Pantry",
            price: 10,
            stock: 4,
            minimumStock: 2
        }
    });
    assert.equal(product.status, 201);

    const update = await request(store, `/products/${product.body.product.id}`, {
        method: "PUT",
        body: {
            name: "Rice",
            category: "Pantry",
            price: 12,
            stock: 4,
            minimumStock: 2
        }
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.product.price, 12);

    const sale = await request(store, "/sales", {
        method: "POST",
        body: { productId: product.body.product.id, quantity: 1 }
    });
    assert.equal(sale.status, 201);

    const analytics = await request(store, "/analytics");
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.productPerformance[0].revenue, 12);
    const dashboard = await request(store, "/dashboard");
    assert.equal(dashboard.body.totalProducts, 1);
    assert.equal(dashboard.body.lowStockCount, 0);

    const prediction = await request(store, "/ai/predict", {
        method: "POST",
        body: { product: "Rice", price: 12, date: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }
    });
    assert.equal(prediction.status, 200);
    assert.equal(prediction.body.modelStatus, "limited_history");
    assert.equal(prediction.body.predictedDemand, 1);
    assert.equal(prediction.body.trend.direction, "stable");

    const horizon = await request(store, "/ai/predict", {
        method: "POST",
        body: {
            product: "Rice",
            price: 12,
            date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            days: 14
        }
    });
    assert.equal(horizon.status, 200);
    assert.equal(horizon.body.horizonDays, 14);
    assert.equal(horizon.body.daily.length, 14);
    assert.equal(horizon.body.totalDemand, 14);
    assert.ok(horizon.body.trend && horizon.body.trend.label);
});

test("registers a cloud workspace by uploading the selected local data", async () => {
    const store = loadStore();
    await request(store, "/workspaces", {
        method: "POST",
        body: { userName: "Ari", businessName: "Market One" }
    });
    await request(store, "/products", {
        method: "POST",
        body: {
            name: "Tea",
            category: "Drinks",
            price: 4,
            stock: 8,
            minimumStock: 2
        }
    });

    let uploaded;
    globalThis.fetch = async (url, options) => {
        if (url.endsWith("/api/mobile/auth/register")) {
            return jsonResponse({
                accessToken: "device-token",
                profile: {
                    userId: "cloud-user-1",
                    email: "owner@example.com",
                    userName: "Ari",
                    businessName: "Market One"
                }
            }, 201);
        }
        assert.equal(url, "https://cloud.example.com/api/mobile/sync");
        assert.equal(options.headers.Authorization, "Bearer device-token");
        uploaded = JSON.parse(options.body);
        return jsonResponse({
            ...uploaded,
            profile: { userId: "cloud-user-1", email: "owner@example.com" }
        });
    };

    await store.connectCloud({
        apiBaseUrl: "https://cloud.example.com/",
        mode: "register",
        payload: {
            email: "owner@example.com",
            password: "password123",
            userName: "Ari",
            businessName: "Market One"
        }
    });

    assert.equal(uploaded.products.length, 1);
    assert.equal(uploaded.products[0].name, "Tea");
    assert.ok(uploaded.products[0].cloudId);
    const profile = await request(store, "/profile");
    assert.equal(profile.body.cloudConnected, true);
    assert.equal(profile.body.email, "owner@example.com");
    const products = await request(store, "/products");
    assert.equal(products.body.length, 1);
    const workspaces = await request(store, "/workspaces");
    assert.equal(workspaces.body.workspaces.length, 2);
    assert.ok(!JSON.stringify(workspaces.body).includes("device-token"));
});

test("signs in to a separate cloud workspace and downloads its snapshot", async () => {
    const store = loadStore();
    await request(store, "/workspaces", {
        method: "POST",
        body: { userName: "Ari", businessName: "Local Only" }
    });
    globalThis.fetch = async (url, options) => {
        if (url.endsWith("/api/mobile/auth/login")) {
            return jsonResponse({
                accessToken: "device-token",
                profile: {
                    userId: "cloud-user-2",
                    email: "owner@example.com",
                    userName: "Sam",
                    businessName: "Cloud Shop"
                }
            });
        }
        assert.deepEqual(JSON.parse(options.body), {
            products: [],
            categories: [],
            sales: [],
            deletions: []
        });
        return jsonResponse({
            products: [{
                id: 91,
                cloudId: "product-cloud-91",
                name: "Coffee",
                category: "Drinks",
                price: 5,
                stock: 6,
                minimumStock: 1,
                createdAt: "2026-02-01T09:00:00",
                updatedAt: "2026-02-01T09:00:00"
            }],
            categories: [],
            sales: [],
            deletions: []
        });
    };

    await store.connectCloud({
        apiBaseUrl: "https://cloud.example.com",
        mode: "login",
        payload: { email: "owner@example.com", password: "password123" }
    });

    const workspaces = await request(store, "/workspaces");
    assert.equal(workspaces.body.workspaces.length, 2);
    const cloudWorkspace = workspaces.body.workspaces.find(item =>
        item.businessName === "Cloud Shop"
    );
    assert.ok(cloudWorkspace);
    const products = await request(store, "/products");
    assert.equal(products.body.length, 1);
    assert.equal(products.body[0].cloudId, "product-cloud-91");

    await request(store, "/workspaces/select", {
        method: "POST",
        body: { workspaceId: workspaces.body.workspaces.find(item =>
            item.businessName === "Local Only"
        ).id }
    });
    const localProfile = await request(store, "/profile");
    assert.equal(localProfile.body.cloudConnected, false);
    const localProducts = await request(store, "/products");
    assert.equal(localProducts.body.length, 0);
});

test("requires a secure HTTPS URL for mobile cloud sync", async () => {
    const store = loadStore();
    await assert.rejects(
        store.connectCloud({
            apiBaseUrl: "http://cloud.example.com",
            mode: "login",
            payload: { email: "owner@example.com", password: "password123" }
        }),
        /secure HTTPS URL/
    );
});

test("sends mobile product deletions as cloud tombstones", async () => {
    const store = loadStore();
    let syncCount = 0;
    let deletedCloudId;
    globalThis.fetch = async (url, options) => {
        if (url.endsWith("/api/mobile/auth/login")) {
            return jsonResponse({
                accessToken: "device-token",
                profile: {
                    userId: "cloud-user-3",
                    email: "owner@example.com",
                    userName: "Ari",
                    businessName: "Market One"
                }
            });
        }
        syncCount += 1;
        const changes = JSON.parse(options.body);
        if (syncCount === 1) {
            return jsonResponse({
                products: [{
                    id: 1,
                    cloudId: "product-to-delete",
                    name: "Tea",
                    category: "Drinks",
                    price: 4,
                    stock: 3,
                    minimumStock: 1,
                    createdAt: "2026-02-01T09:00:00",
                    updatedAt: "2026-02-01T09:00:00"
                }],
                categories: [],
                sales: [],
                deletions: []
            });
        }
        deletedCloudId = changes.deletions[0]?.cloudId;
        return jsonResponse({
            products: [],
            categories: [],
            sales: [],
            deletions: changes.deletions
        });
    };

    await store.connectCloud({
        apiBaseUrl: "https://cloud.example.com",
        mode: "login",
        payload: { email: "owner@example.com", password: "password123" }
    });
    const products = await request(store, "/products");
    const deletion = await request(store, `/products/${products.body[0].id}`, {
        method: "DELETE"
    });
    assert.equal(deletion.status, 200);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(deletedCloudId, "product-to-delete");
    const remaining = await request(store, "/products");
    assert.equal(remaining.body.length, 0);
});

test("preserves offline edits when reconnecting a cached cloud workspace", async () => {
    const store = loadStore();
    let syncCount = 0;
    let reconnectedChanges;
    globalThis.fetch = async (url, options) => {
        if (url.endsWith("/api/mobile/auth/login")) {
            return jsonResponse({
                accessToken: `device-token-${syncCount}`,
                profile: {
                    userId: "cloud-user-4",
                    email: "owner@example.com",
                    userName: "Ari",
                    businessName: "Market One"
                }
            });
        }
        syncCount += 1;
        const changes = JSON.parse(options.body);
        if (syncCount === 1) {
            return jsonResponse({
                products: [],
                categories: [],
                sales: [],
                deletions: []
            });
        }
        reconnectedChanges = changes;
        return jsonResponse({
            products: changes.products,
            categories: changes.categories,
            sales: changes.sales,
            deletions: changes.deletions
        });
    };
    const credentials = {
        apiBaseUrl: "https://cloud.example.com",
        mode: "login",
        payload: { email: "owner@example.com", password: "password123" }
    };

    await store.connectCloud(credentials);
    await store.disconnectCloud();
    await request(store, "/products", {
        method: "POST",
        body: {
            name: "Offline Tea",
            category: "Drinks",
            price: 3,
            stock: 5,
            minimumStock: 1
        }
    });
    await store.connectCloud(credentials);

    assert.equal(reconnectedChanges.products.length, 1);
    assert.equal(reconnectedChanges.products[0].name, "Offline Tea");
});
