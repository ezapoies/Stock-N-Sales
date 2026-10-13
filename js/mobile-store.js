(() => {
    const DATABASE_NAME = "stock-n-sales-mobile";
    const DATABASE_VERSION = 3;
    const STORE_NAMES = [
        "workspaces",
        "profiles",
        "products",
        "categories",
        "sales",
        "settings",
        "deletions"
    ];

    let databasePromise;

    function openDatabase() {
        if (databasePromise) return databasePromise;

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = event => {
                const database = request.result;
                for (const storeName of STORE_NAMES) {
                    if (!database.objectStoreNames.contains(storeName)) {
                        database.createObjectStore(storeName, {
                            keyPath: "id",
                            autoIncrement: storeName !== "settings"
                        });
                    }
                }
                for (const storeName of ["profiles", "products", "categories", "sales"]) {
                    const store = request.transaction.objectStore(storeName);
                    if (!store.indexNames.contains("workspaceId")) {
                        store.createIndex("workspaceId", "workspaceId", { unique: false });
                    }
                }
                const deletions = request.transaction.objectStore("deletions");
                if (!deletions.indexNames.contains("workspaceId")) {
                    deletions.createIndex("workspaceId", "workspaceId", { unique: false });
                }
                if (event.oldVersion < 3) {
                    request.transaction.objectStore("settings").delete("lastCloudApiUrl");
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                databasePromise = null;
                reject(request.error || new Error("Could not open mobile storage."));
            };
            request.onblocked = () => {
                databasePromise = null;
                reject(new Error("Mobile storage upgrade is blocked by another app tab."));
            };
        });
        return databasePromise;
    }

    function runTransaction(storeNames, operation) {
        return openDatabase().then(database => new Promise((resolve, reject) => {
            const transaction = database.transaction(storeNames, "readwrite");
            let result;
            let operationError;

            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => {
                reject(operationError || transaction.error || new Error("Mobile data could not be saved."));
            };
            transaction.onabort = () => {
                reject(operationError || transaction.error || new Error("Mobile data update was cancelled."));
            };

            try {
                operation(transaction, value => {
                    result = value;
                }, error => {
                    operationError = error;
                    transaction.abort();
                });
            } catch (error) {
                operationError = error;
                transaction.abort();
            }
        }));
    }

    function requestValue(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function response(body, status = 200) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" }
        });
    }

    function getBody(options) {
        if (!options.body) return {};
        try {
            return JSON.parse(options.body);
        } catch {
            return {};
        }
    }

    function getActiveWorkspaceId(transaction, done, fail) {
        const request = transaction.objectStore("settings").get("activeWorkspaceId");
        request.onsuccess = () => {
            if (!request.result?.value) {
                fail(new Error("Choose or create a local business first."));
                return;
            }
            done(request.result.value);
        };
        request.onerror = () => fail(request.error);
    }

    function timestamp() {
        return new Date().toISOString().slice(0, 19);
    }

    function createCloudId() {
        return globalThis.crypto?.randomUUID?.()
            || `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function validCloudApiUrl(value) {
        let url;
        try {
            url = new URL(String(value || "").trim());
        } catch {
            throw new Error("Enter the HTTPS address of your cloud sync server.");
        }
        if (url.protocol !== "https:" || url.username || url.password
            || url.search || url.hash) {
            throw new Error("The cloud sync server address must be a secure HTTPS URL.");
        }
        return url.href.replace(/\/+$/, "");
    }

    async function remoteCloudRequest(baseUrl, path, token, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const headers = { "Content-Type": "application/json" };
            if (token) headers.Authorization = `Bearer ${token}`;
            const result = await fetch(`${baseUrl}/api/mobile/${path}`, {
                method: "POST",
                headers,
                body: JSON.stringify(body || {}),
                credentials: "omit",
                cache: "no-store",
                signal: controller.signal
            });
            let data;
            try {
                data = await result.json();
            } catch {
                throw new Error("The cloud server returned an invalid response.");
            }
            if (!result.ok) {
                throw new Error(data.error || "Cloud sync request failed.");
            }
            return data;
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error("The cloud server did not respond. Your data remains on this device.");
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    function readWorkspaceData(workspaceId) {
        return runTransaction(
            ["products", "categories", "sales", "deletions"],
            (transaction, setResult, fail) => {
                const names = ["products", "categories", "sales", "deletions"];
                const results = {};
                let remaining = names.length;
                const finish = () => {
                    remaining -= 1;
                    if (remaining) return;
                    const products = results.products;
                    const productIds = new Map();
                    for (const product of products) {
                        product.cloudId ||= createCloudId();
                        productIds.set(product.id, product.cloudId);
                        transaction.objectStore("products").put(product);
                    }
                    for (const category of results.categories) {
                        category.cloudId ||= createCloudId();
                        transaction.objectStore("categories").put(category);
                    }
                    for (const sale of results.sales) {
                        sale.cloudId ||= createCloudId();
                        sale.productCloudId = productIds.get(sale.productId) || null;
                        transaction.objectStore("sales").put(sale);
                    }
                    setResult({
                        products,
                        categories: results.categories,
                        sales: results.sales,
                        deletions: results.deletions
                    });
                };

                for (const name of names) {
                    const request = transaction.objectStore(name)
                        .index("workspaceId").getAll(workspaceId);
                    request.onsuccess = () => {
                        results[name] = request.result;
                        finish();
                    };
                    request.onerror = () => fail(request.error);
                }
            }
        );
    }

    function applyCloudSnapshot(workspaceId, snapshot) {
        return runTransaction(
            ["products", "categories", "sales", "deletions"],
            (transaction, setResult, fail) => {
                const names = ["products", "categories", "sales", "deletions"];
                let remaining = names.length;
                const oldRecords = {};
                const finish = () => {
                    remaining -= 1;
                    if (remaining) return;

                    const incoming = {
                        products: snapshot.products || [],
                        categories: snapshot.categories || [],
                        sales: snapshot.sales || [],
                        deletions: snapshot.deletions || []
                    };
                    const cloudIds = Object.fromEntries(names.map(name => [
                        name,
                        new Set(incoming[name].map(item =>
                            name === "deletions"
                                ? `${item.tableName}:${item.cloudId}`
                                : item.cloudId
                        ))
                    ]));
                    for (const name of names) {
                        oldRecords[name].forEach(record => {
                            const identity = name === "deletions"
                                ? `${record.tableName}:${record.cloudId}`
                                : record.cloudId;
                            if (!cloudIds[name].has(identity)) {
                                transaction.objectStore(name).delete(record.id);
                            }
                        });
                    }

                    const priorIds = Object.fromEntries(names.map(name => [
                        name,
                        new Map(oldRecords[name].map(record => [
                            name === "deletions"
                                ? `${record.tableName}:${record.cloudId}`
                                : record.cloudId,
                            record.id
                        ]))
                    ]));
                    for (const product of incoming.products) {
                        const { id, ...values } = product;
                        const localId = priorIds.products.get(product.cloudId);
                        transaction.objectStore("products").put({
                            ...values,
                            ...(localId ? { id: localId } : {}),
                            workspaceId
                        });
                    }
                    const productsRequest = transaction.objectStore("products")
                        .index("workspaceId").getAll(workspaceId);
                    productsRequest.onsuccess = () => {
                        const productIds = new Map(productsRequest.result.map(product => [
                            product.cloudId,
                            product.id
                        ]));
                        for (const sale of incoming.sales) {
                            const { id, ...values } = sale;
                            const localId = priorIds.sales.get(sale.cloudId);
                            transaction.objectStore("sales").put({
                                ...values,
                                ...(localId ? { id: localId } : {}),
                                productId: productIds.get(sale.productCloudId) || null,
                                workspaceId
                            });
                        }
                        setResult(true);
                    };
                    productsRequest.onerror = () => fail(productsRequest.error);

                    for (const category of incoming.categories) {
                        const { id, ...values } = category;
                        const localId = priorIds.categories.get(category.cloudId);
                        transaction.objectStore("categories").put({
                            ...values,
                            ...(localId ? { id: localId } : {}),
                            workspaceId
                        });
                    }
                    for (const deletion of incoming.deletions) {
                        const identity = `${deletion.tableName}:${deletion.cloudId}`;
                        const localId = priorIds.deletions.get(identity);
                        transaction.objectStore("deletions").put({
                            ...deletion,
                            ...(localId ? { id: localId } : {}),
                            workspaceId
                        });
                    }
                };

                for (const name of names) {
                    const request = transaction.objectStore(name)
                        .index("workspaceId").getAll(workspaceId);
                    request.onsuccess = () => {
                        oldRecords[name] = request.result;
                        finish();
                    };
                    request.onerror = () => fail(request.error);
                }
            }
        );
    }

    async function prepareCloudChanges(workspaceId) {
        const data = await readWorkspaceData(workspaceId);
        return {
            products: data.products,
            categories: data.categories,
            sales: data.sales,
            deletions: data.deletions.map(({ tableName, cloudId, deletedAt }) => ({
                tableName,
                cloudId,
                deletedAt
            }))
        };
    }

    function readCloudRevision(workspaceId) {
        return runTransaction(["settings"], (transaction, setResult, fail) => {
            const request = transaction.objectStore("settings")
                .get(`cloudRevision-${workspaceId}`);
            request.onsuccess = () => setResult(request.result?.value || 0);
            request.onerror = () => fail(request.error);
        });
    }

    async function bumpCloudRevision(workspaceId) {
        return runTransaction(["settings"], (transaction, setResult, fail) => {
            const store = transaction.objectStore("settings");
            const id = `cloudRevision-${workspaceId}`;
            const request = store.get(id);
            request.onsuccess = () => {
                const value = (request.result?.value || 0) + 1;
                store.put({ id, value });
                setResult(value);
            };
            request.onerror = () => fail(request.error);
        });
    }

    async function syncCloudWorkspace(workspace) {
        if (!workspace?.cloudConnected || !workspace.accessToken || !workspace.apiBaseUrl) {
            throw new Error("Connect this workspace to a cloud account first.");
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const revision = await readCloudRevision(workspace.id);
            const changes = await prepareCloudChanges(workspace.id);
            const snapshot = await remoteCloudRequest(
                workspace.apiBaseUrl,
                "sync",
                workspace.accessToken,
                changes
            );
            const latestChanges = await prepareCloudChanges(workspace.id);
            if (
                revision !== await readCloudRevision(workspace.id)
                || JSON.stringify(changes) !== JSON.stringify(latestChanges)
            ) continue;
            await applyCloudSnapshot(workspace.id, snapshot);
            return snapshot;
        }
        throw new Error("Your data changed during sync. Try syncing again.");
    }

    async function getActiveWorkspace() {
        return runTransaction(["settings", "workspaces"], (transaction, setResult, fail) => {
            const activeRequest = transaction.objectStore("settings").get("activeWorkspaceId");
            activeRequest.onsuccess = () => {
                const id = activeRequest.result?.value;
                if (!id) {
                    setResult(null);
                    return;
                }
                const workspaceRequest = transaction.objectStore("workspaces").get(id);
                workspaceRequest.onsuccess = () => setResult(workspaceRequest.result || null);
                workspaceRequest.onerror = () => fail(workspaceRequest.error);
            };
            activeRequest.onerror = () => fail(activeRequest.error);
        });
    }

    const CLOUD_RETRY_MIN_DELAY = 5000;
    const CLOUD_RETRY_MAX_DELAY = 60000;

    let cloudSyncPromise = null;
    let cloudRetryTimer = null;
    let cloudRetryDelay = CLOUD_RETRY_MIN_DELAY;

    function canScheduleRetry() {
        return typeof window !== "undefined"
            && typeof window.setTimeout === "function";
    }

    function cancelCloudRetry() {
        if (cloudRetryTimer !== null
            && canScheduleRetry()
            && typeof window.clearTimeout === "function") {
            window.clearTimeout(cloudRetryTimer);
        }
        cloudRetryTimer = null;
        cloudRetryDelay = CLOUD_RETRY_MIN_DELAY;
    }

    // Queued offline sales are retried with exponential backoff until the
    // connection is stable again, so nothing is lost on PNG's flaky links.
    function scheduleCloudRetry() {
        if (!canScheduleRetry() || cloudRetryTimer !== null) return;
        const delay = cloudRetryDelay;
        cloudRetryDelay = Math.min(delay * 2, CLOUD_RETRY_MAX_DELAY);
        cloudRetryTimer = window.setTimeout(() => {
            cloudRetryTimer = null;
            syncCloud()
                .then(() => cancelCloudRetry())
                .catch(error => {
                    console.error("Cloud sync retry failed:", error);
                    scheduleCloudRetry();
                });
        }, delay);
    }

    function requestError(error) {
        const message = error instanceof Error
            ? error.message
            : "Mobile data could not be loaded.";
        return response({ error: message }, 500);
    }

    function byWorkspace(store, workspaceId, done, fail) {
        const request = store.index("workspaceId").getAll(workspaceId);
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
    }

    // ----- Offline demand forecasting (trend + PNG payday aware) -----

    const PNG_PAYDAY_DAYS = new Set([1, 2, 13, 14, 15, 16, 17, 27, 28, 29, 30, 31]);
    const OFFLINE_TREND_DAMPING = 0.5;
    const OFFLINE_MAX_TREND_STEPS = 28;

    function clampHorizon(value) {
        const days = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 1;
        return Math.min(180, Math.max(1, days));
    }

    function dateKeyAddDays(key, amount) {
        const date = new Date(`${key}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + amount);
        return date.toISOString().slice(0, 10);
    }

    function dateKeyWeekday(key) {
        return new Date(`${key}T00:00:00Z`).getUTCDay();
    }

    function dateKeyDistance(fromKey, toKey) {
        const from = new Date(`${fromKey}T00:00:00Z`).getTime();
        const to = new Date(`${toKey}T00:00:00Z`).getTime();
        return Math.round((to - from) / 86400000);
    }

    function isPngPaydayKey(key) {
        return PNG_PAYDAY_DAYS.has(new Date(`${key}T00:00:00Z`).getUTCDate());
    }

    function linearSlope(values) {
        const count = values.length;
        if (count < 2) return 0;
        const meanX = (count - 1) / 2;
        const meanY = values.reduce((sum, value) => sum + value, 0) / count;
        let numerator = 0;
        let denominator = 0;
        values.forEach((value, index) => {
            numerator += (index - meanX) * (value - meanY);
            denominator += (index - meanX) ** 2;
        });
        return denominator === 0 ? 0 : numerator / denominator;
    }

    function summarizeOfflineTrend(values) {
        const recent = values.slice(-28);
        const slope = linearSlope(recent);
        const average = recent.length
            ? recent.reduce((sum, value) => sum + value, 0) / recent.length
            : 0;
        const weeklyChange = average > 0 ? (slope * 7 / average) * 100 : 0;
        const direction = slope > 0.05 && weeklyChange >= 3
            ? "rising"
            : slope < -0.05 && weeklyChange <= -3
                ? "falling"
                : "stable";
        const labels = {
            rising: "Demand is trending up",
            falling: "Demand is trending down",
            stable: "Demand is broadly steady"
        };
        return {
            direction,
            slopePerDay: Number(slope.toFixed(3)),
            weeklyChangePercent: Number(weeklyChange.toFixed(1)),
            label: labels[direction]
        };
    }

    function offlinePaydayLift(keys, values) {
        if (keys.length < 14) return 1;
        const payday = [];
        const regular = [];
        keys.forEach((key, index) => {
            (isPngPaydayKey(key) ? payday : regular).push(values[index]);
        });
        if (!payday.length || !regular.length) return 1;
        const regularMean = regular.reduce((sum, value) => sum + value, 0) / regular.length;
        if (regularMean <= 0) return 1;
        const paydayMean = payday.reduce((sum, value) => sum + value, 0) / payday.length;
        return Math.min(1.5, Math.max(0.75, paydayMean / regularMean));
    }

    function offlineBaseline(keys, values, targetKey) {
        const count = keys.length;
        if (!count) return 0;

        const recentKeys = keys.slice(-28);
        const recentValues = values.slice(-28);
        const recentAverage = recentValues.reduce((sum, value) => sum + value, 0)
            / recentValues.length;

        const targetWeekday = dateKeyWeekday(targetKey);
        const weekdayValues = [];
        keys.forEach((key, index) => {
            if (dateKeyWeekday(key) === targetWeekday) weekdayValues.push(values[index]);
        });
        const recentWeekday = weekdayValues.slice(-8);

        let prediction;
        if (recentWeekday.length >= 4) {
            const weekdayAverage = recentWeekday.reduce((sum, value) => sum + value, 0)
                / recentWeekday.length;
            prediction = (0.7 * weekdayAverage) + (0.3 * recentAverage);
        } else {
            prediction = recentAverage;
        }

        const slope = linearSlope(recentValues);
        const steps = Math.max(0, Math.min(
            OFFLINE_MAX_TREND_STEPS,
            dateKeyDistance(recentKeys[recentKeys.length - 1], targetKey)
        ));
        prediction += OFFLINE_TREND_DAMPING * slope * steps;

        if (isPngPaydayKey(targetKey)) {
            prediction *= offlinePaydayLift(keys, values);
        }
        return Math.max(0, prediction);
    }

    function buildOfflineForecast(productSales, startKey, days) {
        const dailyTotals = new Map();
        for (const sale of productSales) {
            const key = String(sale.date).slice(0, 10);
            dailyTotals.set(key, (dailyTotals.get(key) || 0) + Number(sale.quantity || 0));
        }
        const observedKeys = [...dailyTotals.keys()].sort();

        const keys = [];
        const values = [];
        if (observedKeys.length) {
            let cursor = observedKeys[0];
            let guard = 0;
            while (cursor < startKey && guard < 4000) {
                keys.push(cursor);
                values.push(dailyTotals.get(cursor) || 0);
                cursor = dateKeyAddDays(cursor, 1);
                guard += 1;
            }
        }

        const trend = summarizeOfflineTrend(values);

        const daily = [];
        let total = 0;
        for (let offset = 0; offset < days; offset += 1) {
            const targetKey = dateKeyAddDays(startKey, offset);
            const value = Math.max(0, offlineBaseline(keys, values, targetKey));
            total += value;
            daily.push({
                date: targetKey,
                dayOfWeek: dateKeyWeekday(targetKey),
                predictedDemand: Number(value.toFixed(2)),
                payday: isPngPaydayKey(targetKey)
            });
            keys.push(targetKey);
            values.push(value);
        }

        return {
            startDate: startKey,
            endDate: dateKeyAddDays(startKey, days - 1),
            horizonDays: days,
            totalDemand: Number(total.toFixed(2)),
            averageDailyDemand: Number((total / days).toFixed(2)),
            daily,
            trend,
            historyDays: observedKeys.length,
            dailySalesRecords: productSales.length
        };
    }

    async function handleLocal(path, method, body) {
        if (path === "/workspaces" && method === "GET") {
            return runTransaction(["workspaces", "settings"], (transaction, setResult, fail) => {
                const workspacesRequest = transaction.objectStore("workspaces").getAll();
                const activeRequest = transaction.objectStore("settings").get("activeWorkspaceId");
                let remaining = 2;
                const finish = () => {
                    remaining -= 1;
                    if (remaining) return;
                    setResult({
                        workspaces: workspacesRequest.result.map(workspace => ({
                            id: workspace.id,
                            userName: workspace.userName,
                            businessName: workspace.businessName,
                            createdAt: workspace.createdAt,
                            cloudConnected: Boolean(workspace.cloudConnected)
                        })),
                        activeWorkspaceId: activeRequest.result?.value || null,
                        cloudConnected: Boolean(workspacesRequest.result.find(
                            workspace => workspace.id === activeRequest.result?.value
                        )?.cloudConnected)
                    });
                };
                workspacesRequest.onsuccess = finish;
                activeRequest.onsuccess = finish;
                workspacesRequest.onerror = () => fail(workspacesRequest.error);
                activeRequest.onerror = () => fail(activeRequest.error);
            }).then(value => response(value));
        }

        if (path === "/workspaces" && method === "POST") {
            const userName = String(body.userName || "").trim();
            const businessName = String(body.businessName || "").trim();
            if (!userName || !businessName) {
                return response({ error: "Your name and business name are required." }, 400);
            }
            return runTransaction(["workspaces", "profiles", "settings"], (transaction, setResult) => {
                const createdAt = timestamp();
                const request = transaction.objectStore("workspaces").add({
                    userName,
                    businessName,
                    createdAt
                });
                request.onsuccess = () => {
                    const id = request.result;
                    transaction.objectStore("profiles").add({
                        id: `profile-${id}`,
                        workspaceId: id,
                        userName,
                        businessName,
                        createdAt,
                        updatedAt: createdAt
                    });
                    transaction.objectStore("settings").put({
                        id: "activeWorkspaceId",
                        value: id
                    });
                    setResult({ id, userName, businessName, createdAt });
                };
            }).then(value => response({ workspace: value }, 201));
        }

        if (path === "/workspaces/select" && method === "POST") {
            const workspaceId = Number(body.workspaceId);
            return runTransaction(["workspaces", "settings"], (transaction, setResult, fail) => {
                const request = transaction.objectStore("workspaces").get(workspaceId);
                request.onsuccess = () => {
                    if (!request.result) {
                        fail(new Error("Business workspace not found."));
                        return;
                    }
                    transaction.objectStore("settings").put({
                        id: "activeWorkspaceId",
                        value: workspaceId
                    });
                    setResult({ message: "Workspace selected." });
                };
            }).then(value => response(value)).catch(requestError);
        }

        if (path === "/workspaces/leave" && method === "POST") {
            return runTransaction(["settings"], transaction => {
                transaction.objectStore("settings").delete("activeWorkspaceId");
            }).then(() => response({ message: "Workspace closed." }));
        }

        if (path === "/profile" && method === "GET") {
            return runTransaction(["settings", "profiles", "workspaces"], (transaction, setResult, fail) => {
                getActiveWorkspaceId(transaction, workspaceId => {
                    const profileRequest = transaction.objectStore("profiles").get(`profile-${workspaceId}`);
                    const workspaceRequest = transaction.objectStore("workspaces").get(workspaceId);
                    let remaining = 2;
                    const finish = () => {
                        remaining -= 1;
                        if (remaining) return;
                        const workspace = workspaceRequest.result || {};
                        setResult(profileRequest.result
                            ? {
                                ...profileRequest.result,
                                configured: true,
                                cloudConnected: Boolean(workspace.cloudConnected),
                                email: workspace.email || null
                            }
                            : { configured: false, cloudConnected: false });
                    };
                    profileRequest.onsuccess = finish;
                    workspaceRequest.onsuccess = finish;
                    profileRequest.onerror = () => fail(profileRequest.error);
                    workspaceRequest.onerror = () => fail(workspaceRequest.error);
                }, fail);
            }).then(value => response(value)).catch(error => {
                if (error.message === "Choose or create a local business first.") {
                    return response({ configured: false, cloudConnected: false });
                }
                return requestError(error);
            });
        }

        if (path === "/profile" && method === "POST") {
            return response({
                error: "The mobile workspace profile is set when you create it."
            }, 400);
        }

        if (path === "/sync-status") {
            return response({
                status: "idle",
                message: "",
                products: 0,
                categories: 0,
                sales: 0,
                deletions: 0
            });
        }

        if (path === "/auth/logout" && method === "POST") {
            return disconnectCloud().then(() => response({
                message: "This device was disconnected from cloud sync.",
                localWorkspaceSelected: true
            }));
        }

        if (path === "/sync-now" || path.startsWith("/cloud/")) {
            return response({
                error: "Use the mobile cloud account screen to connect this device."
            }, 400);
        }

        const match = path.match(/^\/(products|categories|sales|dashboard|analytics|ai\/data|ai\/predict)(?:\/(\d+)(?:\/(products))?)?$/);
        if (!match) return response({ error: "Mobile route not found." }, 404);

        const [, collection, recordId, subresource] = match;
        if (collection === "ai/predict" || collection === "ai/data") {
            return runTransaction(["settings", "sales"], (transaction, setResult, fail) => {
                getActiveWorkspaceId(transaction, workspaceId => {
                    const request = transaction.objectStore("sales")
                        .index("workspaceId").getAll(workspaceId);
                    request.onsuccess = () => {
                        const sales = request.result;
                        if (collection === "ai/data") {
                            setResult(sales.map(sale => {
                                const date = new Date(sale.date);
                                return {
                                    date: sale.date.slice(0, 10),
                                    product: sale.productName,
                                    quantity: sale.quantity,
                                    price: sale.price,
                                    revenue: sale.total,
                                    dayOfWeek: (date.getDay() + 6) % 7,
                                    month: date.getMonth() + 1
                                };
                            }).sort((a, b) => a.date.localeCompare(b.date)));
                            return;
                        }

                        const product = String(body.product || "").trim();
                        const rawStart = String(body.date || "").slice(0, 10);
                        const startDate = new Date(`${rawStart}T00:00:00Z`);
                        if (!product || !/^\d{4}-\d{2}-\d{2}$/.test(rawStart)
                            || !Number.isFinite(startDate.getTime())) {
                            fail(new Error("Product and a valid forecast date are required."));
                            return;
                        }

                        const productSales = sales.filter(sale =>
                            String(sale.productName).toLowerCase() === product.toLowerCase());
                        const horizonDays = clampHorizon(body.days);
                        const forecast = buildOfflineForecast(productSales, rawStart, horizonDays);

                        const modelStatus = forecast.historyDays === 0
                            ? "insufficient_history"
                            : forecast.historyDays < 28
                                ? "limited_history"
                                : "offline_trend";
                        const warning = forecast.historyDays === 0
                            ? "No sales history is available for this product; the forecast is zero until sales are recorded."
                            : forecast.historyDays < 28
                                ? `Only ${forecast.historyDays} calendar days of sales history are available. This on-device estimate blends your recent trend, the day of week and PNG payday weeks, but is still a rough guide.`
                                : "This on-device estimate blends your recent trend, the day of week and PNG payday weeks. Stockouts are not tracked historically, so zero-sales days may understate demand.";

                        if (body.days !== undefined) {
                            setResult({
                                product,
                                date: rawStart,
                                ...forecast,
                                modelStatus,
                                warning
                            });
                            return;
                        }

                        setResult({
                            product,
                            date: rawStart,
                            predictedDemand: forecast.daily.length
                                ? forecast.daily[0].predictedDemand
                                : 0,
                            modelStatus,
                            historyDays: forecast.historyDays,
                            dailySalesRecords: forecast.dailySalesRecords,
                            trend: forecast.trend,
                            warning
                        });
                    };
                    request.onerror = () => fail(request.error);
                }, fail);
            }).then(value => response(value)).catch(error => (
                error.message === "Choose or create a local business first."
                    ? response({ error: error.message }, 409)
                    : requestError(error)
            ));
        }

        const routeStores = collection === "dashboard" || collection === "analytics"
            ? ["settings", "products", "sales"]
            : collection === "categories"
                ? ["settings", "categories", "products", "deletions"]
                : collection === "products"
                    ? ["settings", "products", "deletions"]
                    : ["settings", collection];
        if (collection === "sales" && method === "POST") routeStores.push("products");

        return runTransaction(routeStores, (transaction, setResult, fail) => {
            getActiveWorkspaceId(transaction, workspaceId => {
                const store = transaction.objectStore(collection === "dashboard" || collection === "analytics"
                    ? "sales"
                    : collection);
                const productsStore = routeStores.includes("products")
                    ? transaction.objectStore("products")
                    : null;

                if (collection === "products" && !recordId && method === "GET") {
                    return byWorkspace(store, workspaceId, values => {
                        setResult(values.sort((a, b) => a.id - b.id));
                    }, fail);
                }

                if (collection === "products" && !recordId && method === "POST") {
                    const productName = String(body.name || "").trim();
                    const category = String(body.category || "").trim();
                    const price = Number(body.price);
                    const stock = Number(body.stock);
                    const minimumStock = Number(body.minimumStock);
                    if (!productName || !category || !Number.isFinite(price) || price < 0
                        || !Number.isInteger(stock) || stock < 0
                        || !Number.isInteger(minimumStock) || minimumStock < 0) {
                        return fail(new Error("Enter valid product details."));
                    }
                    const createdAt = timestamp();
                    const request = store.add({
                        workspaceId,
                        name: productName,
                        category,
                        price,
                        stock,
                        minimumStock,
                        createdAt,
                        updatedAt: createdAt
                    });
                    request.onsuccess = () => setResult({
                        message: "Product added successfully.",
                        product: { id: request.result, name: productName, category, price, stock, minimumStock }
                    });
                    return;
                }

                if (collection === "products" && recordId && method === "PUT") {
                    const id = Number(recordId);
                    const request = store.get(id);
                    request.onsuccess = () => {
                        const existing = request.result;
                        if (!existing || existing.workspaceId !== workspaceId) {
                            fail(new Error("Product not found."));
                            return;
                        }
                        const updated = {
                            ...existing,
                            name: String(body.name || "").trim(),
                            category: String(body.category || "").trim(),
                            price: Number(body.price),
                            stock: Number(body.stock),
                            minimumStock: Number(body.minimumStock),
                            updatedAt: timestamp()
                        };
                        if (!updated.name || !updated.category || !Number.isFinite(updated.price)
                            || updated.price < 0 || !Number.isInteger(updated.stock) || updated.stock < 0
                            || !Number.isInteger(updated.minimumStock) || updated.minimumStock < 0) {
                            fail(new Error("Enter valid product details."));
                            return;
                        }
                        store.put(updated);
                        setResult({ message: "Product updated successfully.", product: updated });
                    };
                    return;
                }

                if (collection === "products" && recordId && method === "DELETE") {
                    const id = Number(recordId);
                    const request = store.get(id);
                    request.onsuccess = () => {
                        if (!request.result || request.result.workspaceId !== workspaceId) {
                            fail(new Error("Product not found."));
                            return;
                        }
                        transaction.objectStore("deletions").add({
                            workspaceId,
                            tableName: "products",
                            cloudId: request.result.cloudId || createCloudId(),
                            deletedAt: timestamp()
                        });
                        store.delete(id);
                        setResult({ message: "Product deleted successfully." });
                    };
                    return;
                }

                if (collection === "categories" && !recordId && method === "GET") {
                    return byWorkspace(store, workspaceId, values => {
                        setResult(values.sort((a, b) => a.name.localeCompare(b.name)));
                    }, fail);
                }

                if (collection === "categories" && !recordId && method === "POST") {
                    const name = String(body.name || "").trim();
                    if (!name) return fail(new Error("Category name is required."));
                    const request = store.index("workspaceId").getAll(workspaceId);
                    request.onsuccess = () => {
                        if (request.result.some(item => item.name.toLowerCase() === name.toLowerCase())) {
                            fail(new Error("Category already exists."));
                            return;
                        }
                        const createdAt = timestamp();
                        const addRequest = store.add({ workspaceId, name, createdAt, updatedAt: createdAt });
                        addRequest.onsuccess = () => setResult({
                            message: "Category added successfully.",
                            category: { id: addRequest.result, name }
                        });
                    };
                    return;
                }

                if (collection === "categories" && recordId && subresource === "products" && method === "DELETE") {
                    const categoryId = Number(recordId);
                    const categoryRequest = store.get(categoryId);
                    categoryRequest.onsuccess = () => {
                        const category = categoryRequest.result;
                        if (!category || category.workspaceId !== workspaceId) {
                            fail(new Error("Category not found."));
                            return;
                        }
                        const productsRequest = productsStore.index("workspaceId").getAll(workspaceId);
                        productsRequest.onsuccess = () => {
                            const matches = productsRequest.result.filter(item => item.category === category.name);
                            matches.forEach(item => {
                                transaction.objectStore("deletions").add({
                                    workspaceId,
                                    tableName: "products",
                                    cloudId: item.cloudId || createCloudId(),
                                    deletedAt: timestamp()
                                });
                                productsStore.delete(item.id);
                            });
                            setResult({
                                message: "All products in this category were removed.",
                                deletedCount: matches.length
                            });
                        };
                    };
                    return;
                }

                if (collection === "categories" && recordId && method === "DELETE") {
                    const id = Number(recordId);
                    const request = store.get(id);
                    request.onsuccess = () => {
                        const category = request.result;
                        if (!category || category.workspaceId !== workspaceId) {
                            fail(new Error("Category not found."));
                            return;
                        }
                        const productsRequest = productsStore.index("workspaceId").getAll(workspaceId);
                        productsRequest.onsuccess = () => {
                            if (productsRequest.result.some(item => item.category === category.name)) {
                                fail(new Error("Cannot delete this category because products are using it."));
                                return;
                            }
                            transaction.objectStore("deletions").add({
                                workspaceId,
                                tableName: "categories",
                                cloudId: category.cloudId || createCloudId(),
                                deletedAt: timestamp()
                            });
                            store.delete(id);
                            setResult({ message: "Category removed successfully." });
                        };
                    };
                    return;
                }

                if (collection === "sales" && !recordId && method === "GET") {
                    return byWorkspace(store, workspaceId, values => {
                        setResult(values.sort((a, b) => b.date.localeCompare(a.date)));
                    }, fail);
                }

                if (collection === "sales" && !recordId && method === "POST") {
                    const productId = Number(body.productId);
                    const quantity = Number(body.quantity);
                    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0) {
                        return fail(new Error("Enter a valid product and quantity."));
                    }
                    const productRequest = productsStore.get(productId);
                    productRequest.onsuccess = () => {
                        const product = productRequest.result;
                        if (!product || product.workspaceId !== workspaceId) {
                            fail(new Error("Product not found."));
                            return;
                        }
                        if (product.stock < quantity) {
                            fail(new Error("Not enough stock available."));
                            return;
                        }
                        const saleDate = timestamp();
                        const sale = {
                            workspaceId,
                            productId,
                            productName: product.name,
                            quantity,
                            price: product.price,
                            total: product.price * quantity,
                            date: saleDate,
                            createdAt: saleDate,
                            updatedAt: saleDate
                        };
                        const saleRequest = store.add(sale);
                        productsStore.put({ ...product, stock: product.stock - quantity, updatedAt: saleDate });
                        saleRequest.onsuccess = () => setResult({
                            message: "Sale recorded successfully.",
                            sale: { ...sale, id: saleRequest.result }
                        });
                    };
                    return;
                }

                if (collection === "dashboard" && method === "GET") {
                    const salesRequest = store.index("workspaceId").getAll(workspaceId);
                    const productsRequest = productsStore.index("workspaceId").getAll(workspaceId);
                    let remaining = 2;
                    const finish = () => {
                        remaining -= 1;
                        if (remaining) return;
                        const sales = salesRequest.result;
                        const products = productsRequest.result;
                        const today = new Date().toISOString().slice(0, 10);
                        const lowStockProducts = products
                            .filter(item => item.stock <= item.minimumStock)
                            .sort((a, b) => a.stock - b.stock);
                        setResult({
                            totalSales: sales.reduce((sum, item) => sum + item.total, 0),
                            totalTransactions: sales.length,
                            totalProducts: products.length,
                            lowStockCount: lowStockProducts.length,
                            todaysSales: sales
                                .filter(item => item.date.slice(0, 10) === today)
                                .reduce((sum, item) => sum + item.total, 0),
                            lowStockProducts
                        });
                    };
                    salesRequest.onsuccess = finish;
                    productsRequest.onsuccess = finish;
                    salesRequest.onerror = () => fail(salesRequest.error);
                    productsRequest.onerror = () => fail(productsRequest.error);
                    return;
                }

                if (collection === "analytics" && method === "GET") {
                    const request = store.index("workspaceId").getAll(workspaceId);
                    request.onsuccess = () => {
                        const salesByDate = {};
                        const performance = new Map();
                        for (const sale of request.result) {
                            const day = sale.date.slice(0, 10);
                            salesByDate[day] = (salesByDate[day] || 0) + sale.total;
                            const item = performance.get(sale.productName) || {
                                productName: sale.productName,
                                quantity: 0,
                                revenue: 0
                            };
                            item.quantity += sale.quantity;
                            item.revenue += sale.total;
                            performance.set(sale.productName, item);
                        }
                        setResult({
                            salesByDate: Object.fromEntries(Object.entries(salesByDate).sort(([a], [b]) => a.localeCompare(b))),
                            productPerformance: [...performance.values()].sort((a, b) => b.quantity - a.quantity)
                        });
                    };
                    return;
                }

                fail(new Error("Mobile operation is not supported."));
            }, fail);
        }).then(value => {
            const status = ["products", "categories", "sales"].includes(collection)
                && !recordId && method === "POST"
                ? 201
                : 200;
            return response(value, status);
        }).catch(error => {
            const status = /choose or create/i.test(error.message) ? 409
                : /not found/i.test(error.message) ? 404
                : /already exists/i.test(error.message) ? 409
                    : /not enough|cannot delete|valid|quantity|category|required|stock/i.test(error.message) ? 400
                        : 500;
            return response({ error: error.message }, status);
        });
    }

    async function connectCloud({ apiBaseUrl, mode, payload }) {
        const baseUrl = validCloudApiUrl(apiBaseUrl || await getCloudApiUrl());
        if (!["login", "register"].includes(mode)) {
            throw new Error("Choose sign in or account registration.");
        }

        const auth = await remoteCloudRequest(
            baseUrl,
            `auth/${mode}`,
            null,
            payload
        );
        let sourceWorkspaceId = null;
        const activeWorkspace = await runTransaction(
            ["settings"],
            (transaction, setResult, fail) => {
                const request = transaction.objectStore("settings").get("activeWorkspaceId");
                request.onsuccess = () => setResult(request.result?.value || null);
                request.onerror = () => fail(request.error);
            }
        );
        const existingCloudWorkspaceId = await runTransaction(
            ["workspaces"],
            (transaction, setResult, fail) => {
                const request = transaction.objectStore("workspaces").getAll();
                request.onsuccess = () => {
                    const existing = request.result.find(workspace =>
                        workspace.cloudUserId === auth.profile.userId
                        && workspace.apiBaseUrl === baseUrl
                    );
                    setResult(existing?.id || null);
                };
                request.onerror = () => fail(request.error);
            }
        );
        sourceWorkspaceId = mode === "register"
            ? activeWorkspace
            : existingCloudWorkspaceId;

        const changes = sourceWorkspaceId
            ? await prepareCloudChanges(sourceWorkspaceId)
            : { products: [], categories: [], sales: [], deletions: [] };
        const snapshot = await remoteCloudRequest(
            baseUrl,
            "sync",
            auth.accessToken,
            changes
        );

        const workspaceId = await runTransaction(
            ["workspaces", "profiles", "settings"],
            (transaction, setResult, fail) => {
                const workspaces = transaction.objectStore("workspaces");
                const allRequest = workspaces.getAll();
                allRequest.onsuccess = () => {
                    const existing = allRequest.result.find(workspace =>
                        workspace.cloudUserId === auth.profile.userId
                        && workspace.apiBaseUrl === baseUrl
                    );
                    const workspace = {
                        ...(existing || {}),
                        userName: auth.profile.userName || auth.profile.email.split("@")[0],
                        businessName: auth.profile.businessName || "My Business",
                        email: auth.profile.email,
                        cloudUserId: auth.profile.userId,
                        cloudConnected: true,
                        apiBaseUrl: baseUrl,
                        accessToken: auth.accessToken,
                        createdAt: existing?.createdAt || timestamp()
                    };
                    const saved = existing
                        ? workspaces.put({ ...workspace, id: existing.id })
                        : workspaces.add(workspace);
                    saved.onsuccess = () => {
                        const id = saved.result;
                        transaction.objectStore("profiles").put({
                            id: `profile-${id}`,
                            workspaceId: id,
                            userName: workspace.userName,
                            businessName: workspace.businessName,
                            email: workspace.email,
                            cloudConnected: true,
                            createdAt: workspace.createdAt,
                            updatedAt: timestamp()
                        });
                        transaction.objectStore("settings").put({
                            id: "activeWorkspaceId",
                            value: id
                        });
                        transaction.objectStore("settings").put({
                            id: "lastCloudApiUrl",
                            value: baseUrl
                        });
                        setResult(id);
                    };
                    saved.onerror = () => fail(saved.error);
                };
                allRequest.onerror = () => fail(allRequest.error);
            }
        );
        await applyCloudSnapshot(workspaceId, snapshot);
        return auth.profile;
    }

    function getCloudApiUrl() {
        return runTransaction(["settings"], (transaction, setResult, fail) => {
            const request = transaction.objectStore("settings").get("lastCloudApiUrl");
            request.onsuccess = () => setResult(request.result?.value || "");
            request.onerror = () => fail(request.error);
        });
    }

    async function disconnectCloud() {
        cancelCloudRetry();
        const workspace = await getActiveWorkspace();
        if (!workspace?.cloudConnected) return;
        await runTransaction(["workspaces", "profiles"], (transaction, setResult, fail) => {
            const workspaceStore = transaction.objectStore("workspaces");
            const request = workspaceStore.get(workspace.id);
            request.onsuccess = () => {
                const saved = request.result;
                if (saved) {
                    saved.cloudConnected = false;
                    delete saved.accessToken;
                    workspaceStore.put(saved);
                }
                const profileStore = transaction.objectStore("profiles");
                const profileRequest = profileStore.get(`profile-${workspace.id}`);
                profileRequest.onsuccess = () => {
                    if (profileRequest.result) {
                        profileRequest.result.cloudConnected = false;
                        profileStore.put(profileRequest.result);
                    }
                    setResult(true);
                };
                profileRequest.onerror = () => fail(profileRequest.error);
            };
            request.onerror = () => fail(request.error);
        });
    }

    async function manageCloudAccount(action, payload = {}) {
        const workspace = await getActiveWorkspace();
        if (!workspace?.cloudConnected || !workspace.accessToken || !workspace.apiBaseUrl) {
            throw new Error("Connect this workspace to a cloud account first.");
        }
        const result = await remoteCloudRequest(
            workspace.apiBaseUrl,
            `account/${action}`,
            workspace.accessToken,
            payload
        );
        if (action === "update" && result.account) {
            await runTransaction(["workspaces", "profiles"], (transaction, setResult, fail) => {
                const workspaceStore = transaction.objectStore("workspaces");
                const request = workspaceStore.get(workspace.id);
                request.onsuccess = () => {
                    const saved = request.result;
                    if (saved) {
                        saved.email = result.account.email;
                        saved.userName = result.account.userName;
                        saved.businessName = result.account.businessName;
                        workspaceStore.put(saved);
                        transaction.objectStore("profiles").put({
                            id: `profile-${workspace.id}`,
                            workspaceId: workspace.id,
                            userName: saved.userName,
                            businessName: saved.businessName,
                            email: saved.email,
                            cloudConnected: true,
                            updatedAt: timestamp()
                        });
                    }
                    setResult(true);
                };
                request.onerror = () => fail(request.error);
            });
        }
        if (action === "delete") await disconnectCloud();
        return result;
    }

    async function syncCloud() {
        if (cloudSyncPromise) return cloudSyncPromise;
        cloudSyncPromise = (async () => {
            const workspace = await getActiveWorkspace();
            if (!workspace?.cloudConnected) return null;
            return syncCloudWorkspace(workspace);
        })();
        try {
            const result = await cloudSyncPromise;
            cancelCloudRetry();
            return result;
        } finally {
            cloudSyncPromise = null;
        }
    }

    window.mobileStore = {
        connectCloud,
        getCloudApiUrl,
        manageCloudAccount,
        syncCloud,
        disconnectCloud,
        handle: async (url, options = {}) => {
            try {
                const parsed = new URL(url, window.location.origin);
                const prefix = "/api";
                if (!parsed.pathname.startsWith(`${prefix}/`)) {
                    return response({ error: "Mobile API route not found." }, 404);
                }
                const path = parsed.pathname.slice(prefix.length);
                const method = String(options.method || "GET").toUpperCase();
                const body = getBody(options);
                const result = await handleLocal(path, method, body);
                if (
                    result.ok
                    && method !== "GET"
                    && /^\/(products|categories|sales)(?:\/|$)/.test(path)
                ) {
                    queueMicrotask(async () => {
                        try {
                            const workspace = await getActiveWorkspace();
                            if (workspace) await bumpCloudRevision(workspace.id);
                            await syncCloud();
                        } catch (error) {
                            console.error("Automatic mobile cloud sync failed:", error);
                            scheduleCloudRetry();
                        }
                    });
                }
                return result;
            } catch (error) {
                return requestError(error);
            }
        }
    };

    window.addEventListener?.("online", () => {
        syncCloud().catch(error => {
            console.error("Mobile cloud reconnect failed:", error);
            scheduleCloudRetry();
        });
    });

    window.document?.addEventListener?.("visibilitychange", () => {
        if (window.document.visibilityState === "visible") {
            syncCloud().catch(error => {
                console.error("Mobile cloud resume sync failed:", error);
                scheduleCloudRetry();
            });
        }
    });

    // Flush any sales that were queued while offline as soon as the app opens.
    if (canScheduleRetry()) {
        syncCloud().catch(() => scheduleCloudRetry());
    }
})();
