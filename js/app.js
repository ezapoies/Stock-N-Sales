// ==========================================
// STOCK N SALES
// Main JavaScript
// ==========================================

// ==========================================
// API
// ==========================================

const isLocalFrontend = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    && window.location.port === "5500";
const API_URL = isLocalFrontend
    ? `http://${window.location.hostname}:5000/api`
    : `${window.location.origin}/api`;
const isCapacitorApp = document.querySelector('meta[name="app-mode"]')?.content === "native"
    || window.Capacitor?.isNativePlatform?.() === true;

function apiFetch(url, options = {}) {
    if (isCapacitorApp && window.mobileStore) {
        return window.mobileStore.handle(url, options);
    }
    return fetch(url, {
        ...options,
        credentials: "include"
    });
}

// ==========================================
// PNG CURRENCY (KINA)
// ==========================================
// Papua New Guinea's currency is the Kina (ISO code PGK, symbol "K").
// Every price, sale, receipt and revenue figure is rendered through this
// single helper so the whole app is always formatted consistently.

const kinaFormatter = new Intl.NumberFormat("en-PG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

function formatKina(value) {
    const amount = Number(value);
    return `K ${kinaFormatter.format(Number.isFinite(amount) ? amount : 0)}`;
}

let appToastTimeout = null;

function showAppToast(message, type = "success") {
    const toast = document.getElementById("appToast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.toggle("error", type === "error");
    toast.classList.add("show");
    clearTimeout(appToastTimeout);
    appToastTimeout = setTimeout(() => {
        toast.classList.remove("show");
    }, 3200);
}

function showAppDialog({
    title,
    message,
    confirmText = "Continue",
    cancelText = "Cancel",
    danger = false,
    inputLabel = ""
}) {
    const dialog = document.getElementById("appDialog");
    const form = document.getElementById("appDialogForm");
    const inputLabelElement = document.getElementById("appDialogInputLabel");
    const input = document.getElementById("appDialogInput");
    const cancelButton = document.getElementById("appDialogCancel");
    const confirmButton = document.getElementById("appDialogConfirm");

    if (!dialog || !form || !inputLabelElement || !input || !cancelButton || !confirmButton) {
        return Promise.reject(new Error("The app confirmation dialog is unavailable."));
    }
    if (dialog.open) {
        return Promise.reject(new Error("Another app dialog is already open."));
    }

    document.getElementById("appDialogTitle").textContent = title;
    document.getElementById("appDialogMessage").textContent = message;
    document.getElementById("appDialogInputLabelText").textContent = inputLabel;
    inputLabelElement.hidden = !inputLabel;
    input.value = "";
    confirmButton.textContent = confirmText;
    cancelButton.textContent = cancelText;
    dialog.classList.toggle("app-dialog-danger", danger);

    return new Promise(resolve => {
        let settled = false;
        const finish = confirmed => {
            if (settled) return;
            settled = true;
            dialog.close();
            cancelButton.removeEventListener("click", onCancel);
            form.removeEventListener("submit", onSubmit);
            dialog.removeEventListener("cancel", onNativeCancel);
            resolve({ confirmed, value: input.value.trim() });
        };
        const onCancel = () => finish(false);
        const onSubmit = event => {
            event.preventDefault();
            finish(true);
        };
        const onNativeCancel = event => {
            event.preventDefault();
            finish(false);
        };

        cancelButton.addEventListener("click", onCancel);
        form.addEventListener("submit", onSubmit);
        dialog.addEventListener("cancel", onNativeCancel);
        dialog.showModal();

        if (inputLabel) {
            input.focus();
        } else {
            confirmButton.focus();
        }
    });
}

// ==========================================
// USER / BUSINESS PROFILE
// ==========================================

let currentProfile = null;
let profileConfigured = false;


// ==========================================
// STARTUP SYNC NOTIFICATION
// ==========================================



// ------------------------------------------------------------
// CREATE NOTIFICATION
// ------------------------------------------------------------

function createSyncNotification() {

    let notification =
        document.getElementById(
            "syncNotification"
        );

    if (notification) {
        return notification;
    }

    notification = document.createElement(
        "div"
    );

    notification.id =
        "syncNotification";

    notification.className =
        "sync-notification";

    notification.innerHTML = `
        <div class="sync-notification-icon">
            <span id="syncNotificationIcon">↻</span>
        </div>

        <div id="syncNotificationMessage">
            Syncing stock to cloud...
        </div>
    `;

    document.body.appendChild(
        notification
    );

    return notification;
}


// ------------------------------------------------------------
// SHOW NOTIFICATION
// ------------------------------------------------------------

function showSyncNotification(
    message,
    type = "syncing"
) {

    const notification =
        createSyncNotification();

    const messageElement =
        document.getElementById(
            "syncNotificationMessage"
        );

    const iconElement =
        document.getElementById(
            "syncNotificationIcon"
        );

    if (!messageElement || !iconElement) {
        return;
    }

    messageElement.textContent =
        message;

    if (type === "synced") {

        notification.classList.add(
            "synced"
        );

        iconElement.textContent = "✓";

    } else {

        notification.classList.remove(
            "synced"
        );

        iconElement.textContent = "↻";
    }

    requestAnimationFrame(() => {

        notification.classList.add(
            "show"
        );

    });

}


// ------------------------------------------------------------
// HIDE NOTIFICATION
// ------------------------------------------------------------

function hideSyncNotification() {

    const notification =
        document.getElementById(
            "syncNotification"
        );

    if (!notification) {
        return;
    }

    notification.classList.remove(
        "show"
    );

}


async function syncNow() {
    if (!currentProfile?.cloudConnected) return;

    const button = document.getElementById("syncNowButton");
    if (!button || button.disabled) return;

    button.disabled = true;
    button.textContent = "Syncing...";

    try {
        if (isCapacitorApp && window.mobileStore) {
            await window.mobileStore.syncCloud();
            await loadCategories();
            await loadProductsFromDatabase();
            const activePage = document.querySelector(".nav-item.active")?.dataset.page;
            if (activePage) handleNavigation(activePage);
            showSyncNotification("Data synced across devices.", "synced");
            setTimeout(hideSyncNotification, 1800);
            return;
        }

        const response = await apiFetch(`${API_URL}/sync-now`, {
            method: "POST"
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Could not start sync.");
        }


        window.addEventListener("online", () => {
            if (currentProfile?.cloudConnected) {
                syncNow();
            }
        });

        showSyncNotification("Syncing data across devices...");

        let state;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const statusResponse = await apiFetch(`${API_URL}/sync-status`, {
                cache: "no-store"
            });
            if (!statusResponse.ok) {
                throw new Error("Could not check sync status.");
            }
            state = await statusResponse.json();
            if (state.status === "synced" || state.status === "offline") break;
        }

        if (state?.status === "synced") {
            await loadCategories();
            await loadProductsFromDatabase();
            const activePage = document.querySelector(".nav-item.active")?.dataset.page;
            if (activePage) handleNavigation(activePage);
            showSyncNotification(
                state.message || "Data synced across devices",
                "synced"
            );
            setTimeout(hideSyncNotification, 1800);
        } else if (state?.status === "offline") {
            showSyncNotification(
                state.message || "Cloud sync is unavailable. Your local changes are safe."
            );
        } else {
            throw new Error("Sync is taking longer than expected. Try again shortly.");
        }
    } catch (error) {
        console.error("Manual sync error:", error);
        showSyncNotification(error.message || "Sync failed.");
    } finally {
        button.disabled = false;
        button.textContent = "Sync now";
    }
}


// ==========================================
// PROFILE HELPERS
// ==========================================

// ------------------------------------------------------------
// ESCAPE HTML
// ------------------------------------------------------------
// Prevents names/business names containing special characters
// from being inserted directly as HTML.
// ------------------------------------------------------------

function escapeHtml(value) {

    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// ------------------------------------------------------------
// SHOW / HIDE NAVIGATION
// ------------------------------------------------------------

function setNavigationVisible(visible) {

    const navigation =
        document.querySelector(
            ".main-navigation"
        );

    const systemStatus =
        document.querySelector(
            ".system-status"
        );

    if (navigation) {

        navigation.style.display =
            visible ? "" : "none";

    }

    // Keep cloud account access available from the workspace chooser. The
    // account button is useful before a local workspace is selected too.
    if (systemStatus) systemStatus.style.display = "";
    const switchWorkspaceButton = document.getElementById("switchWorkspaceButton");
    if (switchWorkspaceButton) switchWorkspaceButton.hidden = !visible;
}


// ------------------------------------------------------------
// LOAD PROFILE
// ------------------------------------------------------------

async function loadProfile() {
    try {
        const response = await apiFetch(`${API_URL}/profile`, {
            method: "GET",
            cache: "no-store"
        });
        if (!response.ok) {
            throw new Error("Failed to load local workspace.");
        }

        const profile = await response.json();
        if (profile.configured !== true) {
            currentProfile = null;
            profileConfigured = false;
            setNavigationVisible(false);
            updateCloudControls();
            await loadWorkspaceChooser();
            return false;
        }

        currentProfile = profile;
        profileConfigured = true;
        setNavigationVisible(true);
        updateCloudControls();
        return true;
    } catch (error) {
        console.error("Local workspace loading error:", error);
        currentProfile = null;
        profileConfigured = false;
        setNavigationVisible(false);
        updateCloudControls();
        showProfileError();
        return false;
    }
}


function updateCloudControls() {
    const accountButton = document.getElementById("cloudAccountButton");
    const syncButton = document.getElementById("syncNowButton");
    const statusDot = document.querySelector(".status-dot");
    if (accountButton) {
        accountButton.textContent = currentProfile?.cloudConnected
            ? "Account centre"
            : "Cloud account";
    }
    if (syncButton) {
        syncButton.hidden = !currentProfile?.cloudConnected;
    }
    if (statusDot) {
        statusDot.classList.toggle("cloud-connected", Boolean(currentProfile?.cloudConnected));
    }
}


async function loadWorkspaceChooser() {
    try {
        const response = await apiFetch(`${API_URL}/workspaces`, {
            cache: "no-store"
        });
        if (!response.ok) {
            throw new Error("Could not load local workspaces.");
        }
        const result = await response.json();
        showWorkspaceChooser(result.workspaces || []);
    } catch (error) {
        console.error("Workspace list error:", error);
        showProfileError();
    }
}


function showWorkspaceChooser(workspaces = []) {
    const pageContent = document.getElementById("pageContent");
    if (!pageContent) return;

    pageContent.innerHTML = `
        <div class="workspace-page">
            <section class="workspace-card">
                <h2>Choose a business</h2>
                <p>Each local workspace has its own inventory and sales.</p>
                ${workspaces.length ? `
                    <div class="workspace-list">
                        ${workspaces.map(workspace => `
                            <button class="workspace-option" type="button" data-workspace-id="${escapeHtml(workspace.id)}">
                                <span class="workspace-option-mark">${escapeHtml((workspace.businessName || "?").slice(0, 1).toUpperCase())}</span>
                                <span class="workspace-option-copy">
                                    <strong>${escapeHtml(workspace.businessName)}</strong>
                                    <small>${escapeHtml(workspace.userName)}</small>
                                </span>
                                <span class="workspace-option-arrow">Open</span>
                            </button>
                        `).join("")}
                    </div>
                    <div class="workspace-divider"><span>OR CREATE A SEPARATE LOCAL BUSINESS</span></div>
                ` : ""}
                <form id="localWorkspaceForm">
                    <div class="form-group">
                        <label for="localUserName">Your name</label>
                        <input type="text" id="localUserName" autocomplete="name" required>
                    </div>
                    <div class="form-group">
                        <label for="localBusinessName">Business name</label>
                        <input type="text" id="localBusinessName" autocomplete="organization" required>
                    </div>
                    <p id="workspaceError" class="cloud-account-error" role="alert"></p>
                    <button type="submit" class="primary-button cloud-account-submit">Create workspace</button>
                </form>
                <button class="cloud-account-switch" type="button" onclick="showCloudAccountScreen('login')">Sign in to a cloud account instead</button>
            </section>
        </div>
    `;

    document.getElementById("localWorkspaceForm")
        ?.addEventListener("submit", createLocalWorkspace);
    pageContent.querySelectorAll("[data-workspace-id]").forEach(button => {
        button.addEventListener("click", () => {
            selectLocalWorkspace(button.dataset.workspaceId);
        });
    });
}


async function createLocalWorkspace(event) {
    event.preventDefault();
    const button = event.submitter;
    const errorElement = document.getElementById("workspaceError");
    button.disabled = true;
    button.textContent = "Creating workspace...";
    errorElement.textContent = "";

    try {
        const response = await apiFetch(`${API_URL}/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                userName: document.getElementById("localUserName").value.trim(),
                businessName: document.getElementById("localBusinessName").value.trim()
            })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not create workspace.");
        await openSelectedWorkspace();
    } catch (error) {
        errorElement.textContent = error.message || "Could not create workspace.";
        button.disabled = false;
        button.textContent = "Create workspace";
    }
}


async function selectLocalWorkspace(workspaceId) {
    try {
        const response = await apiFetch(`${API_URL}/workspaces/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not open workspace.");
        await openSelectedWorkspace();
    } catch (error) {
        showAppToast(error.message || "Could not open workspace.", "error");
    }
}


async function openSelectedWorkspace() {
    if (!await loadProfile()) return;
    await loadCategories();
    await loadProductsFromDatabase();
    showDashboard();
}


async function switchWorkspace() {
    try {
        const response = await apiFetch(`${API_URL}/workspaces/leave`, {
            method: "POST"
        });
        if (!response.ok) throw new Error("Could not close the current workspace.");
        currentProfile = null;
        profileConfigured = false;
        setNavigationVisible(false);
        updateCloudControls();
        await loadWorkspaceChooser();
    } catch (error) {
        showAppToast(error.message || "Could not switch workspace.", "error");
    }
}


function showCloudAccountScreen(mode = "login") {
    const pageContent = document.getElementById("pageContent");
    if (!pageContent) return;

    if (currentProfile?.cloudConnected) {
        pageContent.innerHTML = `
            <div class="cloud-account-page">
                <section class="cloud-account-card">
                    <h2>Account</h2>
                    <p>Update the details linked to your account.</p>
                    <div id="accountCentreError" class="cloud-account-error" role="alert"></div>
                    <form id="accountDetailsForm">
                        <div class="form-group"><label for="accountName">Your name</label><input id="accountName" required></div>
                        <div class="form-group"><label for="accountBusiness">Business name</label><input id="accountBusiness" required></div>
                        <div class="form-group"><label for="accountEmail">Email</label><input id="accountEmail" type="email" required></div>
                        <button class="primary-button cloud-account-submit" type="submit">Save changes</button>
                    </form>
                    <details class="account-settings-disclosure">
                        <summary>Change password</summary>
                        <form id="accountPasswordForm">
                            <div class="form-group"><label for="accountCurrentPassword">Current password</label><input id="accountCurrentPassword" type="password" autocomplete="current-password" required></div>
                            <div class="form-group"><label for="accountNewPassword">New password</label><input id="accountNewPassword" type="password" minlength="8" autocomplete="new-password" required></div>
                            <button class="secondary-button" type="submit">Update password</button>
                        </form>
                    </details>
                    <div class="cloud-account-actions">
                        <button class="secondary-button" type="button" onclick="showDashboard()">Back to dashboard</button>
                        <button class="logout-button" type="button" onclick="logout()">Sign out on this device</button>
                    </div>
                    <details class="account-settings-disclosure account-danger-zone">
                        <summary>Delete account</summary>
                        <p>This permanently deletes your account and cloud data.</p>
                        <form id="accountDeleteForm">
                            <div class="form-group"><label for="accountDeletePassword">Current password</label><input id="accountDeletePassword" type="password" autocomplete="current-password" required></div>
                            <button class="logout-button" type="submit">Delete account</button>
                        </form>
                    </details>
                </section>
            </div>
        `;
        setupAccountCentre();
        return;
    }

    const creatingAccount = mode === "register";
    const cloudAccountDescription = isCapacitorApp
        ? "Connect to cloud sync to back up your data."
        : creatingAccount
            ? "Register this business to sync its inventory across your devices."
            : "Sign in to download this business's inventory and sync changes across devices. Any separate local-only inventory on this device stays local and is not merged.";
    pageContent.innerHTML = `
        <div class="cloud-account-page">
            <section class="cloud-account-card">
                <span class="cloud-account-eyebrow">OPTIONAL CLOUD SYNC</span>
                <h2>${creatingAccount ? "Create a cloud account" : "Connect your cloud account"}</h2>
                <p>${cloudAccountDescription}</p>
                <form id="cloudAccountForm" data-mode="${creatingAccount ? "register" : "login"}">
                    <div class="form-group">
                        <label for="cloudEmail">Email</label>
                        <input type="email" id="cloudEmail" autocomplete="email" required>
                    </div>
                    <div class="form-group">
                        <label for="cloudPassword">Password</label>
                        <input type="password" id="cloudPassword" autocomplete="${creatingAccount ? "new-password" : "current-password"}" minlength="8" required>
                    </div>
                    ${creatingAccount ? `
                        <div class="form-group">
                            <label for="cloudUserName">Your name</label>
                            <input type="text" id="cloudUserName" value="${escapeHtml(currentProfile?.userName || "")}" autocomplete="name" required>
                        </div>
                        <div class="form-group">
                            <label for="cloudBusinessName">Business name</label>
                            <input type="text" id="cloudBusinessName" value="${escapeHtml(currentProfile?.businessName || "")}" autocomplete="organization" required>
                        </div>
                    ` : ""}
                    <p id="cloudAccountError" class="cloud-account-error" role="alert"></p>
                    <button type="submit" class="primary-button cloud-account-submit">${creatingAccount ? "Create account and sync" : "Sign in and sync"}</button>
                </form>
                <button class="cloud-account-switch" type="button" onclick="showCloudAccountScreen('${creatingAccount ? "login" : "register"}')">
                    ${creatingAccount ? "Already have an account? Sign in" : "New to cloud sync? Create an account"}
                </button>
                <button class="cloud-account-local" type="button" onclick="showDashboard()">Continue using this device only</button>
            </section>
        </div>
    `;

    document.getElementById("cloudAccountForm")
        ?.addEventListener("submit", handleCloudAccount);

}


async function setupAccountCentre() {
    const errorElement = document.getElementById("accountCentreError");
    const request = async (action, payload = {}) => {
        if (isCapacitorApp && window.mobileStore) {
            return window.mobileStore.manageCloudAccount(action, payload);
        }
        const route = action === "get" ? "/account" : action === "update" ? "/account" : `/account/${action}`;
        const response = await apiFetch(`${API_URL}${route}`, {
            method: action === "get" ? "GET" : action === "update" ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            ...(action === "get" ? {} : { body: JSON.stringify(payload) })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Account request failed.");
        return result;
    };
    try {
        const { account } = await request("get");
        document.getElementById("accountName").value = account.userName || "";
        document.getElementById("accountBusiness").value = account.businessName || "";
        document.getElementById("accountEmail").value = account.email || "";
    } catch (error) {
        errorElement.textContent = error instanceof TypeError
            ? "Couldn't load your account. Check your connection and try again."
            : error.message;
    }
    document.getElementById("accountDetailsForm").addEventListener("submit", async event => {
        event.preventDefault();
        try {
            await request("update", {
                userName: document.getElementById("accountName").value.trim(),
                businessName: document.getElementById("accountBusiness").value.trim(),
                email: document.getElementById("accountEmail").value.trim()
            });
            await loadProfile();
            errorElement.textContent = "Account details saved.";
        } catch (error) { errorElement.textContent = error.message; }
    });
    document.getElementById("accountPasswordForm").addEventListener("submit", async event => {
        event.preventDefault();
        try {
            const result = await request("password", {
                currentPassword: document.getElementById("accountCurrentPassword").value,
                newPassword: document.getElementById("accountNewPassword").value
            });
            errorElement.textContent = result.message || "Password updated.";
            event.currentTarget.reset();
        } catch (error) { errorElement.textContent = error.message; }
    });
    document.getElementById("accountDeleteForm").addEventListener("submit", async event => {
        event.preventDefault();
        if (!window.confirm("Permanently delete this cloud account and all synced inventory? This cannot be undone.")) return;
        try {
            await request("delete", { password: document.getElementById("accountDeletePassword").value });
            if (isCapacitorApp && window.mobileStore) await logout();
            else { currentProfile = null; await loadWorkspaceChooser(); }
            showAppToast("Cloud account and synced data deleted.");
        } catch (error) { errorElement.textContent = error.message; }
    });
}


async function logout() {
    try {
        let result;
        if (isCapacitorApp && window.mobileStore) {
            await window.mobileStore.disconnectCloud();
            result = { localWorkspaceSelected: true };
        } else {
            const response = await apiFetch(`${API_URL}/auth/logout`, {
                method: "POST"
            });
            if (!response.ok) throw new Error("Unable to sign out.");
            result = await response.json();
        }
        if (result.localWorkspaceSelected) {
            await openSelectedWorkspace();
        } else {
            currentProfile = null;
            profileConfigured = false;
            setNavigationVisible(false);
            updateCloudControls();
            await loadWorkspaceChooser();
        }
        showAppToast("Disconnected. Your inventory remains on this device.");
    } catch (error) {
        console.error("Sign out error:", error);
        showAppToast(error.message || "Unable to sign out.", "error");
    }
}


async function handleCloudAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const mode = form.dataset.mode;

    const button = form.querySelector('button[type="submit"]');
    const errorElement = document.getElementById("cloudAccountError");
    const payload = {
        email: document.getElementById("cloudEmail").value.trim(),
        password: document.getElementById("cloudPassword").value
    };

    if (mode === "register") {
        payload.userName = document.getElementById("cloudUserName").value.trim();
        payload.businessName = document.getElementById("cloudBusinessName").value.trim();
    }

    button.disabled = true;
    button.textContent = mode === "register" ? "Creating account..." : "Signing in...";
    errorElement.textContent = "";

    try {
        if (isCapacitorApp && window.mobileStore) {
            await window.mobileStore.connectCloud({
                mode,
                payload
            });
            await openSelectedWorkspace();
            showAppToast("Cloud account connected. Your data is synced.");
            return;
        }

        const response = await apiFetch(`${API_URL}/cloud/${mode}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Could not connect your cloud account.");
        }

        await loadProfile();
        await loadCategories();
        await loadProductsFromDatabase();
        showDashboard();
        showAppToast("Cloud account connected. Syncing your inventory.");
        await syncNow();
    } catch (error) {
        errorElement.textContent = error.message || "Cloud account connection failed.";
        button.disabled = false;
        button.textContent = mode === "register"
            ? "Create account and sync"
            : "Sign in and sync";
    }
}


// ------------------------------------------------------------
// PROFILE ERROR
// ------------------------------------------------------------

function showProfileError() {

    const pageContent =
        document.getElementById(
            "pageContent"
        );

    if (!pageContent) {
        return;
    }


    pageContent.innerHTML = `

        <div
            style="
                min-height: calc(100vh - 120px);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 40px 20px;
            "
        >

            <div
                style="
                    width: 100%;
                    max-width: 520px;
                    background: var(--surface);
                    border: 1px solid var(--border);
                    box-shadow: var(--shadow-md);
                    padding: 36px;
                    border-radius: var(--radius-lg);
                    text-align: center;
                "
            >

                <h2>
                    Unable to load your profile
                </h2>

                <p
                    style="
                        color: var(--text-muted);
                        line-height: 1.6;
                    "
                >
                    Stock N Sales could not reach its
                    local app service. Your saved data
                    remains on this device. Check that
                    the app is running, then try again.
                </p>

                <button
                    class="primary-button"
                    onclick="retryAppStartup(this)"
                >
                    Try Again
                </button>

            </div>

        </div>

    `;
}


async function retryAppStartup(button) {
    button.disabled = true;
    button.textContent = "Reconnecting...";

    const profileLoaded = await loadProfile();
    if (!profileLoaded) {
        button.disabled = false;
        button.textContent = "Try Again";
        return;
    }

    try {
        await loadCategories();
        await loadProductsFromDatabase();
        showDashboard();
        if (currentProfile?.cloudConnected) {
            await syncNow();
        }
    } catch (error) {
        console.error("App reconnect error:", error);
        showProfileError();
    }
}


// ==========================================
// CATEGORY DATA
// ==========================================

let categories = [];


async function loadCategories() {

    try {

        const response =
            await apiFetch(
                `${API_URL}/categories`
            );


        if (!response.ok) {

            throw new Error(
                "Failed to load categories."
            );

        }


        categories =
            await response.json();


        console.log(
            "Categories loaded from database:",
            categories
        );


    } catch (error) {

        console.error(
            "Error loading categories:",
            error
        );

    }

}


// ==========================================
// PRODUCT DATA
// ==========================================

let products = [];


async function loadProductsFromDatabase() {

    try {

        const response =
            await apiFetch(
                `${API_URL}/products`
            );


        if (!response.ok) {

            throw new Error(
                "Failed to load products."
            );

        }


        const databaseProducts =
            await response.json();


        products =
            databaseProducts;


        console.log(
            "Products loaded from database:",
            products
        );


        if (
            document.getElementById(
                "inventoryTableBody"
            )
        ) {

            renderInventory();

        }


    } catch (error) {

        console.error(
            "Error loading products:",
            error
        );

    }

}


// ==========================================
// SALES DATA
// ==========================================

let sales = [];


// ==========================================
// PAGE LOAD
// ==========================================

document.addEventListener(
    "DOMContentLoaded",
    async function () {

        console.log(
            "Stock N Sales loaded successfully."
        );


        setupNavigation();

        setupDashboard();

        const cloudAccountButton =
            document.getElementById("cloudAccountButton");

        if (cloudAccountButton) {
            cloudAccountButton.addEventListener("click", () => {
                showCloudAccountScreen();
            });
        }

        const syncNowButton =
            document.getElementById("syncNowButton");

        if (syncNowButton) {
            syncNowButton.addEventListener("click", syncNow);
        }

        document.getElementById("switchWorkspaceButton")
            ?.addEventListener("click", switchWorkspace);

        try {
            const response = await apiFetch(`${API_URL}/workspaces`, {
                cache: "no-store"
            });
            if (!response.ok) throw new Error("Could not load workspaces.");
            const workspaceState = await response.json();
            if (
                !workspaceState.activeWorkspaceId
                && !workspaceState.cloudConnected
            ) {
                currentProfile = null;
                profileConfigured = false;
                setNavigationVisible(false);
                updateCloudControls();
                showWorkspaceChooser(workspaceState.workspaces || []);
                return;
            }
        } catch (error) {
            console.error("Workspace startup error:", error);
            showProfileError();
            return;
        }

        if (!await loadProfile()) return;
        await loadCategories();
        await loadProductsFromDatabase();
        showDashboard();
        if (currentProfile?.cloudConnected) await syncNow();

    }
);


// ==========================================
// NAVIGATION
// ==========================================

function setupNavigation() {

    const navigationItems =
        document.querySelectorAll(
            ".nav-item"
        );


    navigationItems.forEach(
        function (item) {

            item.addEventListener(
                "click",
                function (event) {

                    event.preventDefault();


                    // Do not allow navigation
                    // before profile setup.

                    if (!profileConfigured) {

                        return;

                    }


                    navigationItems.forEach(
                        function (nav) {

                            nav.classList.remove(
                                "active"
                            );

                        }
                    );


                    this.classList.add(
                        "active"
                    );


                    const pageName =
                        this.dataset.page;


                    console.log(
                        "Navigation clicked:",
                        pageName
                    );


                    handleNavigation(
                        pageName
                    );

                }
            );

        }
    );

}


// ==========================================
// HANDLE NAVIGATION
// ==========================================

function handleNavigation(pageName) {

    if (!profileConfigured) {
        return;
    }


    switch (pageName) {

        case "Dashboard":

            showDashboard();

            break;


        case "Inventory":

            showInventory();

            break;


        case "Sales":

            showSales();

            break;


        case "AI Prediction":

            showPrediction();

            break;


        case "Analytics":

            showReports();

            break;


        default:

            console.log(
                "Unknown page:",
                pageName
            );

    }

}


// ==========================================
// DASHBOARD
// ==========================================

function setupDashboard() {

    const salesPeriod =
        document.getElementById(
            "salesPeriod"
        );


    if (salesPeriod) {

        salesPeriod.addEventListener(
            "change",
            function () {

                console.log(
                    "Sales period changed to:",
                    this.value
                );

            }
        );

    }

}


async function showDashboard() {

    const pageContent =
        document.getElementById(
            "pageContent"
        );


    if (!pageContent) {
        return;
    }


    if (!profileConfigured) {

        await loadWorkspaceChooser();

        return;

    }


    const userName =
        currentProfile
            ? escapeHtml(
                currentProfile.userName
            )
            : "there";


    const businessName =
        currentProfile
            ? escapeHtml(
                currentProfile.businessName
            )
            : "";


    pageContent.innerHTML = `

    <div class="dashboard-page">

        <div class="page-header">

            <div>

                <h2>
                    Welcome back, ${userName}
                </h2>

                <small
                    style="
                        display: block;
                        margin-top: 4px;
                        color: var(--text-muted);
                    "
                >
                    Here's an overview of ${businessName}'s performance.
                </small>

            </div>

        </div>


        <div class="stats-grid dashboard-stats">

            <div class="dashboard-card stat-card">

                <span class="dashboard-stat-icon revenue-icon" aria-hidden="true">K</span>
                <span>Total Sales</span>

                <strong id="dashboardTotalSales">
                    K 0.00
                </strong>

            </div>


            <div class="dashboard-card stat-card">

                <span class="dashboard-stat-icon transactions-icon" aria-hidden="true">↗</span>
                <span>Transactions</span>

                <strong id="dashboardTransactions">
                    0
                </strong>

            </div>


            <div class="dashboard-card stat-card">

                <span class="dashboard-stat-icon products-icon" aria-hidden="true">▦</span>
                <span>Products</span>

                <strong id="dashboardProducts">
                    0
                </strong>

            </div>


            <div class="dashboard-card stat-card">

                <span class="dashboard-stat-icon stock-icon" aria-hidden="true">!</span>
                <span>Low Stock</span>

                <strong id="dashboardLowStock">
                    0
                </strong>

            </div>


            <div class="dashboard-card stat-card">

                <span class="dashboard-stat-icon today-icon" aria-hidden="true">◷</span>
                <span>Today's Sales</span>

                <strong id="dashboardTodaySales">
                    K 0.00
                </strong>

            </div>

        </div>


        <div class="dashboard-overview-grid">

        <div class="dashboard-card dashboard-low-stock-card">

            <div class="card-header">

                <div>

                    <h3>
                        Low Stock Products
                    </h3>

                    <p>
                        Products that may need
                        restocking.
                    </p>

                </div>

            </div>


            <div id="dashboardLowStockList">

                Loading...

            </div>

        </div>

        <div class="dashboard-card dashboard-actions-card">
            <div class="card-header">
                <div>
                    <h3>Record a sale</h3>
                    <p>Quickly enter a new transaction.</p>
                </div>
            </div>

            <div class="dashboard-quick-actions">
                <button type="button" class="primary-button dashboard-record-sale" onclick="showSales()">
                    Record sale
                    <span aria-hidden="true">→</span>
                </button>
            </div>
        </div>

        </div>

    `;


    await loadDashboardData();

}


async function loadDashboardData() {

    try {

        const response =
            await apiFetch(
                `${API_URL}/dashboard`
            );


        if (!response.ok) {

            throw new Error(
                "Failed to load dashboard."
            );

        }


        const data =
            await response.json();


        document
            .getElementById(
                "dashboardTotalSales"
            )
            .textContent =
            `${formatKina(data.totalSales)}`;


        document
            .getElementById(
                "dashboardTransactions"
            )
            .textContent =
            data.totalTransactions;


        document
            .getElementById(
                "dashboardProducts"
            )
            .textContent =
            data.totalProducts;


        document
            .getElementById(
                "dashboardLowStock"
            )
            .textContent =
            data.lowStockCount;


        document
            .getElementById(
                "dashboardTodaySales"
            )
            .textContent =
            `${formatKina(data.todaysSales)}`;


        const lowStockList =
            document.getElementById(
                "dashboardLowStockList"
            );


        if (data.totalProducts === 0) {

            lowStockList.innerHTML = `
                <div class="dashboard-stock-empty">
                    <span class="dashboard-stock-empty-icon" aria-hidden="true">▦</span>
                    <div>
                        <strong>No products yet</strong>
                        <p>Add products to your inventory to see which items need restocking.</p>
                        <button type="button" class="secondary-button" onclick="handleNavigation('Inventory')">Add products</button>
                    </div>
                </div>
            `;

            return;

        }

        if (data.lowStockProducts.length === 0) {

            lowStockList.innerHTML = `
                <div class="dashboard-stock-clear">
                    <span class="dashboard-stock-clear-icon" aria-hidden="true">✓</span>
                    <div>
                        <strong>Stock levels look good</strong>
                        <p>All your products are above their minimum stock level.</p>
                    </div>
                </div>
            `;

            return;

        }


        lowStockList.innerHTML = "";


        data.lowStockProducts.forEach(
            function(product) {

                const item =
                    document.createElement(
                        "div"
                    );


                item.className =
                    "low-stock-item";


                item.innerHTML = `

                    <strong>
                        ${product.name}
                    </strong>

                    <span>
                        ${product.stock}
                        units remaining
                    </span>

                `;


                lowStockList.appendChild(
                    item
                );

            }
        );


    } catch (error) {

        console.error(
            "Dashboard error:",
            error
        );

    }

}


function renderRecentSales() {

    if (sales.length === 0) {

        return `
            <div class="empty-state">
                No sales recorded yet.
            </div>
        `;

    }


    const recentSales =
        [...sales]
            .reverse()
            .slice(0, 5);


    return recentSales.map(
        function (sale) {

            return `

                <div class="recent-sale-item">

                    <div>

                        <strong>
                            ${sale.productName}
                        </strong>

                        <small>
                            ${sale.date}
                        </small>

                    </div>


                    <div>

                        <strong>
                            ${formatKina(sale.total)}
                        </strong>

                        <small>
                            ${sale.quantity} sold
                        </small>

                    </div>

                </div>

            `;

        }
    ).join("");

}


function renderLowStockAlerts() {

    const lowStock =
        products.filter(
            product =>
                product.stock <=
                product.minimumStock
        );


    if (lowStock.length === 0) {

        return `
            <div class="empty-state">
                ✓ All products are sufficiently stocked.
            </div>
        `;

    }


    return lowStock.map(
        function (product) {

            return `

                <div class="low-stock-item">

                    <div>

                        <strong>
                            ${product.name}
                        </strong>

                        <small>
                            Minimum:
                            ${product.minimumStock}
                        </small>

                    </div>


                    <span class="stock-danger">

                        ${product.stock} left

                    </span>

                </div>

            `;

        }
    ).join("");

}


// ==========================================
// ANALYTICS
// ==========================================

async function showAnalytics() {

    const pageContent =
        document.getElementById(
            "pageContent"
        );


    pageContent.innerHTML = `

        <div class="page-header">

            <div>

                <h2>
                    Sales Analytics
                </h2>

                <p>
                    Analyze sales performance
                    and product movement.
                </p>

            </div>

        </div>


        <div class="dashboard-card">

            <div class="card-header">

                <div>

                    <h3>
                        Sales Trend
                    </h3>

                    <p>
                        Revenue generated over time.
                    </p>

                </div>

            </div>


            <div class="chart-container">

                <canvas
                    id="salesChart"
                ></canvas>

            </div>

        </div>


        <div class="dashboard-card">

            <div class="card-header">

                <div>

                    <h3>
                        Product Performance
                    </h3>

                    <p>
                        Products ranked by units sold.
                    </p>

                </div>

            </div>


            <div class="sales-table-container">

                <table class="inventory-table">

                    <thead>

                        <tr>

                            <th>
                                Product
                            </th>

                            <th>
                                Units Sold
                            </th>

                            <th>
                                Revenue
                            </th>

                        </tr>

                    </thead>


                    <tbody
                        id="analyticsTableBody"
                    >

                    </tbody>

                </table>

            </div>

        </div>

    `;


    await loadAnalytics();

}


async function loadAnalytics() {

    try {

        const response =
            await apiFetch(
                `${API_URL}/analytics`
            );


        if (!response.ok) {

            throw new Error(
                "Failed to load analytics."
            );

        }


        const data =
            await response.json();


        const tableBody =
            document.getElementById(
                "analyticsTableBody"
            );


        tableBody.innerHTML = "";


        data.productPerformance.forEach(
            function(product) {

                const row =
                    document.createElement(
                        "tr"
                    );


                row.innerHTML = `

                    <td>
                        <strong>
                            ${product.productName}
                        </strong>
                    </td>

                    <td>
                        ${product.quantity}
                    </td>

                    <td>
                        ${formatKina(product.revenue)}
                    </td>

                `;


                tableBody.appendChild(
                    row
                );

            }
        );


        const labels =
            Object.keys(
                data.salesByDate
            );


        const values =
            Object.values(
                data.salesByDate
            );


        const canvas =
            document.getElementById(
                "salesChart"
            );


        new Chart(
            canvas,
            {

                type: "line",

                data: {

                    labels: labels,

                    datasets: [{

                        label:
                            "Sales Revenue",

                        data: values,

                        tension: 0.3

                    }]

                },

                options: {

                    responsive: true,

                    maintainAspectRatio: false

                }

            }
        );


    } catch (error) {

        console.error(
            "Analytics error:",
            error
        );

    }

}


// ==========================================
// INVENTORY PAGE
// ==========================================

function showInventory() {

    const pageContent =
        document.getElementById(
            "pageContent"
        );


    if (!pageContent) {

        console.error(
            "pageContent element was not found."
        );

        return;

    }


    const totalUnits = products.reduce(
        (total, product) => total + (Number(product.stock) || 0),
        0
    );
    const lowStockCount = products.filter(
        product => Number(product.stock) <= Number(product.minimumStock)
    ).length;

    pageContent.innerHTML = `

        <section class="inventory-hero">
            <div class="inventory-hero-copy">
                <span class="inventory-eyebrow">STOCK CONTROL</span>
                <h2>Inventory</h2>
                <p>Keep your products organized and your stock levels in check.</p>
            </div>

            <div class="inventory-overview" aria-label="Inventory overview">
                <div class="inventory-overview-item">
                    <span>Total products</span>
                    <strong>${products.length}</strong>
                </div>
                <div class="inventory-overview-item">
                    <span>Units on hand</span>
                    <strong>${totalUnits.toLocaleString()}</strong>
                </div>
                <div class="inventory-overview-item inventory-overview-alert">
                    <span>Need restocking</span>
                    <strong>${lowStockCount}</strong>
                </div>
            </div>
        </section>

        <div class="inventory-section-heading">
            <div>
                <h3>Browse categories</h3>
                <p>Choose a category to view and manage its products.</p>
            </div>
            <label class="inventory-search-control">
                <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
                    <circle cx="8.8" cy="8.8" r="5.6"></circle>
                    <path d="m13 13 4 4"></path>
                </svg>
                <input
                    type="search"
                    id="productSearch"
                    placeholder="Search inventory"
                    aria-label="Search products or categories"
                >
            </label>
        </div>


        <div
            id="categoryGrid"
            class="category-grid"
        ></div>


        <div
            id="categoryProducts"
            style="display: none;"
        ></div>

    `;


    renderCategoryGrid();


    document
        .getElementById(
            "productSearch"
        )
        .addEventListener(
            "input",
            filterInventory
        );

}


function renderCategoryGrid() {

    const categoryGrid =
        document.getElementById(
            "categoryGrid"
        );


    if (!categoryGrid) return;


    let html = `

        <div
            class="category-card active all-products-card"
            onclick="showCategoryProducts('all')"
        >
            <span class="category-card-icon">ALL</span>
            <span class="category-card-copy">
                <strong>All Products</strong>
                <span>${products.length} products</span>
            </span>
            <span class="category-card-arrow" aria-hidden="true">→</span>
        </div>

    `;


    categories.forEach(
        function(category) {

            html += `

                <div
                    class="category-card"
                    onclick="showCategoryProducts('${category.name}')"
                >
                    <span class="category-card-icon">${escapeHtml(category.name.slice(0, 1).toUpperCase())}</span>
                    <span class="category-card-copy">
                        <strong>${escapeHtml(category.name)}</strong>
                        <span>${products.filter(product => product.category === category.name).length} products</span>
                    </span>
                    <span class="category-card-arrow" aria-hidden="true">→</span>
                </div>

            `;

        }
    );


    html += `

        <div
            class="category-card add-category-card"
            onclick="showAddCategoryForm()"
        >
            <span class="category-card-icon">+</span>
            <span class="category-card-copy">
                <strong>Add category</strong>
                <span>Create a new group</span>
            </span>
            <span class="category-card-arrow" aria-hidden="true">→</span>
        </div>

    `;


    categoryGrid.innerHTML =
        html;

}


async function deleteCategory(categoryId) {
    const category = categories.find(item => item.id === categoryId);
    if (!category) {
        showAppToast("Category not found.", "error");
        return;
    }

    const confirmation = await showAppDialog({
        title: "Are you sure you want to remove it?",
        message: `Remove the "${category.name}" category? Categories that still contain products cannot be removed.`,
        confirmText: "Yes, remove it",
        danger: true
    });

    if (!confirmation.confirmed) return;

    try {
        const response = await apiFetch(`${API_URL}/categories/${categoryId}`, {
            method: "DELETE"
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Failed to remove category.");
        }

        await loadCategories();
        showInventory();
        showAppToast("Category removed.");
    } catch (error) {
        console.error("Error removing category:", error);
        showAppToast(error.message || "Failed to remove category.", "error");
    }
}

async function deleteAllCategoryProducts(categoryId) {
    const category = categories.find(item => item.id === categoryId);
    if (!category) {
        showAppToast("Category not found.", "error");
        return;
    }

    const categoryProducts = products.filter(
        product => product.category === category.name
    );
    if (categoryProducts.length === 0) {
        showAppToast("There are no products in this category.", "error");
        return;
    }

    const confirmation = await showAppDialog({
        title: "Delete all products?",
        message: `Are you sure you want to remove all ${categoryProducts.length} product${categoryProducts.length === 1 ? "" : "s"} from "${category.name}"? This cannot be undone. The category will remain.`,
        confirmText: "Yes, delete all",
        danger: true
    });

    if (!confirmation.confirmed) return;

    try {
        const response = await apiFetch(
            `${API_URL}/categories/${categoryId}/products`,
            { method: "DELETE" }
        );
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Failed to remove category products.");
        }

        await loadProductsFromDatabase();
        showCategoryProducts(category.name);
        showAppToast(
            `${result.deletedCount} product${result.deletedCount === 1 ? "" : "s"} removed from ${category.name}.`
        );
    } catch (error) {
        console.error("Error removing category products:", error);
        showAppToast(
            error.message || "Failed to remove category products.",
            "error"
        );
    }
}


function showCategoryProducts(
    categoryName
) {

    const categoryGrid =
        document.getElementById(
            "categoryGrid"
        );


    const categoryProducts =
        document.getElementById(
            "categoryProducts"
        );


    if (
        !categoryGrid ||
        !categoryProducts
    ) {
        return;
    }


    categoryGrid.style.display =
        "none";


    categoryProducts.style.display =
        "block";


    let filteredProducts;


    if (
        categoryName === "all"
    ) {

        filteredProducts =
            products;

    } else {

        filteredProducts =
            products.filter(
                product =>
                    product.category ===
                    categoryName
            );

    }


    categoryProducts.innerHTML = `

        <div class="selected-category-header">

            <button
                class="category-back-button"
                onclick="backToCategories()"
            >
                ← Categories
            </button>

            <div class="selected-category-title">
                <h3>${categoryName === "all" ? "All Products" : escapeHtml(categoryName)}</h3>
                <p>${filteredProducts.length} product${filteredProducts.length === 1 ? "" : "s"} in this view</p>
            </div>


            <button
                class="primary-button add-product-button"
                onclick="showAddProductForm('${categoryName}')"
            >
                + Add Product
            </button>

            ${categoryName !== "all" ? `
                ${filteredProducts.length > 0 ? `
                    <button
                        class="category-delete-products-action"
                        type="button"
                        onclick="deleteAllCategoryProducts(${categories.find(category => category.name === categoryName)?.id})"
                    >
                        Delete all products
                    </button>
                ` : ""}
                <button
                    class="category-remove-action"
                    type="button"
                    onclick="deleteCategory(${categories.find(category => category.name === categoryName)?.id})"
                >
                    Remove category
                </button>
            ` : ""}

        </div>


        <div
            class="dashboard-card inventory-table-card"
        >

            <table class="inventory-table">

                <thead>

                    <tr>

                        <th>Product</th>
                        <th>Category</th>
                        <th>Price</th>
                        <th>Stock</th>
                        <th>Minimum</th>
                        <th>Status</th>
                        <th>Actions</th>

                    </tr>

                </thead>


                <tbody
                    id="inventoryTableBody"
                >

                </tbody>

            </table>

        </div>

    `;


    renderFilteredInventory(
        filteredProducts
    );

}


function backToCategories() {

    const categoryGrid =
        document.getElementById(
            "categoryGrid"
        );


    const categoryProducts =
        document.getElementById(
            "categoryProducts"
        );


    if (
        !categoryGrid ||
        !categoryProducts
    ) {
        return;
    }


    categoryProducts.style.display =
        "none";


    categoryGrid.style.display =
        "grid";


    const search =
        document.getElementById(
            "productSearch"
        );


    if (search) {

        search.value = "";

    }

}


function renderCategoryTabs() {

    const categoryTabs =
        document.getElementById(
            "categoryTabs"
        );


    if (!categoryTabs) return;


    categoryTabs.innerHTML =
        "";


    const allTab =
        document.createElement(
            "button"
        );


    allTab.className =
        "category-tab active";


    allTab.textContent =
        "All";


    allTab.addEventListener(
        "click",
        function() {

            selectCategory("all");

        }
    );


    categoryTabs.appendChild(
        allTab
    );


    categories.forEach(
        function(category) {

            const tab =
                document.createElement(
                    "button"
                );


            tab.className =
                "category-tab";


            tab.textContent =
                category.name;


            tab.dataset.category =
                category.name;


            tab.addEventListener(
                "click",
                function() {

                    selectCategory(
                        category.name
                    );

                }
            );


            categoryTabs.appendChild(
                tab
            );

        }
    );

}


let selectedCategory =
    "all";


function selectCategory(
    category
) {

    selectedCategory =
        category;


    document
        .querySelectorAll(
            ".category-tab"
        )
        .forEach(
            function(tab) {

                tab.classList.remove(
                    "active"
                );

            }
        );


    document
        .querySelectorAll(
            ".category-tab"
        )
        .forEach(
            function(tab) {

                if (
                    category === "all" &&
                    tab.textContent === "All"
                ) {

                    tab.classList.add(
                        "active"
                    );

                }

                else if (
                    tab.textContent ===
                    category
                ) {

                    tab.classList.add(
                        "active"
                    );

                }

            }
        );


    const title =
        document.getElementById(
            "selectedCategoryTitle"
        );


    if (title) {

        title.textContent =
            category === "all"
                ? "All Products"
                : category;

    }


    filterInventory();

}


function showAddProductForm(
    selectedCategory = ""
) {

    const pageContent =
        document.getElementById(
            "pageContent"
        );


    pageContent.innerHTML = `

        <div class="page-header">

            <div>

                <h2>
                    Add Product
                </h2>

                <p>
                    Add a new product to
                    your inventory.
                </p>

            </div>

        </div>


        <div
            class="dashboard-card product-form-card"
        >

            <form id="productForm">

                <div class="form-group">

                    <label>
                        Product Name
                    </label>

                    <input
                        type="text"
                        id="productName"
                        placeholder="e.g. Coca-Cola"
                        required
                    >

                </div>


                <div class="form-group">

                    <label>
                        Category
                    </label>

                    <select
                        id="productCategory"
                        required
                    >

                        <option value="">
                            Select Category
                        </option>

                        ${
                            categories.map(
                                function(category) {

                                    return `
                                        <option
                                            value="${category.name}"
                                            ${
                                                selectedCategory ===
                                                category.name
                                                    ? "selected"
                                                    : ""
                                            }
                                        >
                                            ${category.name}
                                        </option>
                                    `;

                                }
                            ).join("")
                        }

                    </select>

                </div>

                <div class="form-row">

                    <div class="form-group">

                        <label>
                            Selling Price (K)
                        </label>

                        <input
                            type="number"
                            id="productPrice"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            required
                        >

                    </div>


                    <div class="form-group">

                        <label>
                            Current Stock
                        </label>

                        <input
                            type="number"
                            id="productStock"
                            min="0"
                            placeholder="0"
                            required
                        >

                    </div>


                    <div class="form-group">

                        <label>
                            Minimum Stock Level
                        </label>

                        <input
                            type="number"
                            id="productMinimumStock"
                            min="0"
                            placeholder="0"
                            required
                        >

                    </div>

                </div>


                <div class="form-actions">

                    <button
                        type="button"
                        class="secondary-button"
                        onclick="showInventory()"
                    >
                        Cancel
                    </button>

                    <button
                        type="submit"
                        class="primary-button"
                    >
                        Add Product
                    </button>

                </div>

            </form>

        </div>

    `;


    document
        .getElementById(
            "productForm"
        )
        .addEventListener(
            "submit",
            addProduct
        );

}

async function addProduct(event) {

    event.preventDefault();


    const name =
        document
            .getElementById(
                "productName"
            )
            .value
            .trim();


    const category =
        document
            .getElementById(
                "productCategory"
            )
            .value;


    const price =
        Number(
            document
                .getElementById(
                    "productPrice"
                )
                .value
        );


    const stock =
        Number(
            document
                .getElementById(
                    "productStock"
                )
                .value
        );


    const minimumStock =
        Number(
            document
                .getElementById(
                    "productMinimumStock"
                )
                .value
        );


    const newProduct = {

        name:
            name,

        category:
            category,

        price:
            price,

        stock:
            stock,

        minimumStock:
            minimumStock

    };


    try {

        const response =
            await apiFetch(
                `${API_URL}/products`,
                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify(
                            newProduct
                        )

                }
            );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.error ||
                "Failed to add product."
            );

        }


        showAppToast("Product added successfully.");


        await loadProductsFromDatabase();


        showInventory();


    } catch (error) {

        console.error(
            "Error adding product:",
            error
        );


        showAppToast(
            error.message || "Failed to add product. Please check the backend.",
            "error"
        );

    }

}


// ==========================================
// RENDER INVENTORY
// ==========================================

function renderInventory() {

    const tableBody =
        document.getElementById(
            "inventoryTableBody"
        );


    if (!tableBody) return;


    tableBody.innerHTML =
        "";


    products.forEach(
        function(product) {

            let statusHTML;


            if (
                product.stock <=
                product.minimumStock
            ) {

                statusHTML = `
                    <span class="stock-danger">
                        Low Stock
                    </span>
                `;

            } else {

                statusHTML = `
                    <span class="stock-good">
                        In Stock
                    </span>
                `;

            }


            const row =
                document.createElement(
                    "tr"
                );


            row.innerHTML = `

                <td>
                    <strong>
                        ${product.name}
                    </strong>
                </td>

                <td>
                    ${product.category}
                </td>

                <td>
                    ${formatKina(product.price)}
                </td>

                <td>
                    ${product.stock}
                </td>

                <td>
                    ${product.minimumStock}
                </td>

                <td>
                    ${statusHTML}
                </td>

                <td>

                    <button
                        class="action-button edit-button"
                        onclick="editProduct(${product.id})"
                    >
                        Edit
                    </button>

                    <button
                        class="action-button delete-button"
                        onclick="deleteProduct(${product.id})"
                    >
                        Delete
                    </button>

                </td>

            `;


            tableBody.appendChild(
                row
            );

        }
    );

}


function filterInventory() {

    const searchInput =
        document.getElementById(
            "productSearch"
        );


    if (!searchInput) return;


    const searchText =
        searchInput.value
            .toLowerCase()
            .trim();


    const categoryGrid =
        document.getElementById(
            "categoryGrid"
        );


    const categoryProducts =
        document.getElementById(
            "categoryProducts"
        );


    if (
        !categoryGrid ||
        !categoryProducts
    ) {
        return;
    }


    if (searchText === "") {

        if (
            categoryProducts.style.display !==
            "none"
        ) {

            return;

        }


        return;

    }


    const filteredProducts =
        products.filter(
            function(product) {

                const productName =
                    (
                        product.name ||
                        ""
                    ).toLowerCase();


                const productCategory =
                    (
                        product.category ||
                        ""
                    ).toLowerCase();


                return (
                    productName.includes(
                        searchText
                    ) ||
                    productCategory.includes(
                        searchText
                    )
                );

            }
        );


    categoryGrid.style.display =
        "none";


    categoryProducts.style.display =
        "block";


    categoryProducts.innerHTML = `

        <div
            class="selected-category-header"
        >

            <div>

                <button
                    class="category-back-button"
                    onclick="backToCategories()"
                >
                    ← Back to Categories
                </button>

                <h3>
                    Search Results
                </h3>

                <p>
                    ${filteredProducts.length}
                    product(s) found
                </p>

            </div>


            <button
                class="primary-button add-product-button"
                onclick="showAddProductForm()"
            >
                + Add Product
            </button>

        </div>


        <div
            class="dashboard-card inventory-table-card"
        >

            <table class="inventory-table">

                <thead>

                    <tr>

                        <th>Product</th>
                        <th>Category</th>
                        <th>Price</th>
                        <th>Stock</th>
                        <th>Minimum</th>
                        <th>Status</th>
                        <th>Actions</th>

                    </tr>

                </thead>


                <tbody
                    id="inventoryTableBody"
                >

                </tbody>

            </table>

        </div>

    `;


    renderFilteredInventory(
        filteredProducts
    );

}


async function showAddCategoryForm() {
    const result = await showAppDialog({
        title: "Add a category",
        message: "Create a category to organize your products.",
        confirmText: "Add category",
        inputLabel: "Category name"
    });

    if (result.confirmed && result.value) {
        await addCategory(result.value);
    }
}


async function addCategory(
    categoryName
) {

    if (!categoryName) return;


    try {

        const response =
            await apiFetch(
                `${API_URL}/categories`,
                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify({

                            name:
                                categoryName

                        })

                }
            );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.error ||
                "Failed to add category."
            );

        }


        showAppToast("Category added successfully.");


        await loadCategories();


        showInventory();


    } catch (error) {

        console.error(
            "Error adding category:",
            error
        );


        showAppToast(error.message || "Failed to add category.", "error");

    }

}


function renderFilteredInventory(
    filteredProducts
) {

    const tableBody =
        document.getElementById(
            "inventoryTableBody"
        );


    if (!tableBody) return;


    tableBody.innerHTML =
        "";


    filteredProducts.forEach(
        function(product) {

            let statusHTML;


            if (
                product.stock <=
                product.minimumStock
            ) {

                statusHTML = `
                    <span class="stock-danger">
                        Low Stock
                    </span>
                `;

            } else {

                statusHTML = `
                    <span class="stock-good">
                        In Stock
                    </span>
                `;

            }


            const row =
                document.createElement(
                    "tr"
                );


            row.innerHTML = `

                <td>
                    <strong>
                        ${product.name}
                    </strong>
                </td>

                <td>
                    ${product.category}
                </td>

                <td>
                    ${formatKina(product.price)}
                </td>

                <td>
                    ${product.stock}
                </td>

                <td>
                    ${product.minimumStock}
                </td>

                <td>
                    ${statusHTML}
                </td>

                <td>

                    <button
                        class="action-button edit-button"
                        onclick="editProduct(${product.id})"
                    >
                        Edit
                    </button>

                    <button
                        class="action-button delete-button"
                        onclick="deleteProduct(${product.id})"
                    >
                        Delete
                    </button>

                </td>

            `;


            tableBody.appendChild(
                row
            );

        }
    );

}


// ==========================================
// EDIT PRODUCT
// ==========================================

function editProduct(id) {

    const product =
        products.find(
            product =>
                product.id === id
        );


    if (!product) return;


    const pageContent =
        document.getElementById(
            "pageContent"
        );


    pageContent.innerHTML = `

        <div class="page-header">

            <div>

                <h2>
                    Edit Product
                </h2>

                <p>
                    Update product information
                    and stock levels.
                </p>

            </div>

        </div>


        <div
            class="dashboard-card product-form-card"
        >

            <form id="editProductForm">

                <div class="form-group">

                    <label>
                        Product Name
                    </label>

                    <input
                        type="text"
                        id="editProductName"
                        value="${product.name}"
                        required
                    >

                </div>

                <div class="form-group">

                    <label>
                        Category
                    </label>

                    <select
                        id="editProductCategory"
                        required
                    >

                        ${
                            categories.map(
                                function(category) {

                                    return `
                                        <option
                                            value="${category.name}"
                                            ${
                                                product.category ===
                                                category.name
                                                    ? "selected"
                                                    : ""
                                            }
                                        >
                                            ${category.name}
                                        </option>
                                    `;

                                }
                            ).join("")
                        }

                    </select>

                </div>


                <div class="form-group">

                    <label>
                        Selling Price (K)
                    </label>

                    <input
                        type="number"
                        id="editProductPrice"
                        value="${product.price}"
                        step="0.01"
                        min="0"
                        required
                    >

                </div>


                <div class="form-group">

                    <label>
                        Current Stock
                    </label>

                    <input
                        type="number"
                        id="editProductStock"
                        value="${product.stock}"
                        min="0"
                        required
                    >

                </div>


                <div class="form-group">

                    <label>
                        Minimum Stock
                    </label>

                    <input
                        type="number"
                        id="editProductMinimumStock"
                        value="${product.minimumStock}"
                        min="0"
                        required
                    >

                </div>


                <div class="form-actions">

                    <button
                        type="submit"
                        class="primary-button"
                    >
                        Save Changes
                    </button>

                    <button
                        type="button"
                        class="secondary-button"
                        onclick="showInventory()"
                    >
                        Cancel
                    </button>

                </div>

            </form>

        </div>

    `;

    document
        .getElementById(
            "editProductForm"
        )
        .addEventListener(
            "submit",
            function(event) {

                updateProduct(
                    event,
                    product.id
                );

            }
        );

}


async function updateProduct(
    event,
    id
) {

    event.preventDefault();


    const updatedProduct = {

        name:
            document
                .getElementById(
                    "editProductName"
                )
                .value
                .trim(),

        category:
            document
                .getElementById(
                    "editProductCategory"
                )
                .value,

        price:
            Number(
                document
                    .getElementById(
                        "editProductPrice"
                    )
                    .value
            ),

        stock:
            Number(
                document
                    .getElementById(
                        "editProductStock"
                    )
                    .value
            ),

        minimumStock:
            Number(
                document
                    .getElementById(
                        "editProductMinimumStock"
                    )
                    .value
            )

    };


    try {

        const response =
            await apiFetch(
                `${API_URL}/products/${id}`,
                {

                    method:
                        "PUT",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify(
                            updatedProduct
                        )

                }
            );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.error ||
                "Failed to update product."
            );

        }


        showAppToast("Product updated successfully.");


        await loadProductsFromDatabase();


        showInventory();


    } catch (error) {

        console.error(
            "Error updating product:",
            error
        );


        showAppToast(error.message || "Failed to update product.", "error");

    }

}


// ==========================================
// DELETE PRODUCT
// ==========================================

async function deleteProduct(id) {

    const product =
        products.find(
            product =>
                product.id === id
        );


    if (!product) return;


    const confirmation = await showAppDialog({
        title: "Delete product?",
        message: `"${product.name}" will be removed from your inventory on all synced devices.`,
        confirmText: "Delete product",
        danger: true
    });

    if (!confirmation.confirmed) return;


    try {

        const response =
            await apiFetch(
                `${API_URL}/products/${id}`,
                {
                    method:
                        "DELETE"
                }
            );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.error ||
                "Failed to delete product."
            );

        }


        showAppToast("Product deleted successfully.");


        await loadProductsFromDatabase();


        showInventory();


    } catch (error) {

        console.error(
            "Error deleting product:",
            error
        );


        showAppToast(error.message || "Failed to delete product.", "error");

    }

}


// ==========================================
// SALES
// ==========================================

async function showSales() {

    console.log(
        "Sales selected."
    );


    const pageContent =
        document.getElementById(
            "pageContent"
        );


    pageContent.innerHTML = `

        <div class="page-header">

            <div>

                <h2>
                    Sales
                </h2>

                <p>
                    Record sales and track
                    transactions.
                </p>

            </div>

        </div>


        <div class="sales-layout">


            <div
                class="dashboard-card sale-form-card"
            >

                <div class="card-header">

                    <div>

                        <h3>
                            Record New Sale
                        </h3>

                        <p>
                            Enter the details
                            of the sale.
                        </p>

                    </div>

                </div>


                <form id="saleForm">

                    <div class="form-group">

                        <label>
                            Product
                        </label>

                        <select
                            id="saleProduct"
                            required
                        >

                            <option value="">
                                Loading products...
                            </option>

                        </select>

                    </div>


                    <div class="form-group">

                        <label>
                            Quantity
                        </label>

                        <input
                            type="number"
                            id="saleQuantity"
                            min="1"
                            value="1"
                            required
                        >

                    </div>


                    <div class="sale-summary">

                        <div>

                            <span>
                                Unit Price (K)
                            </span>

                            <strong
                                id="saleUnitPrice"
                            >
                                K 0.00
                            </strong>

                        </div>


                        <div>

                            <span>
                                Total (K)
                            </span>

                            <strong
                                id="saleTotal"
                            >
                                K 0.00
                            </strong>

                        </div>

                    </div>


                    <button
                        type="submit"
                        class="primary-button"
                    >
                        Record Sale
                    </button>


                </form>

            </div>


            <div class="dashboard-card sales-history-card">

                <div class="card-header">

                    <div>

                        <h3>
                            Sales history
                        </h3>

                        <p>
                            Search and review transactions by date or product.
                        </p>

                    </div>

                </div>

                <div class="sales-history-summary">
                    <div>
                        <span>Transactions shown</span>
                        <strong id="salesHistoryCount">0</strong>
                    </div>
                    <div>
                        <span>Sales total</span>
                        <strong id="salesHistoryTotal">K 0.00</strong>
                    </div>
                </div>

                <div class="sales-history-filters">
                    <label class="sales-history-search">
                        <span class="visually-hidden">Search sales</span>
                        <input
                            type="search"
                            id="salesHistorySearch"
                            placeholder="Search product..."
                        >
                    </label>
                    <label>
                        <span class="visually-hidden">Filter sales by period</span>
                        <select id="salesHistoryPeriod">
                            <option value="all">All time</option>
                            <option value="today">Today</option>
                            <option value="7days">Last 7 days</option>
                            <option value="month">This month</option>
                        </select>
                    </label>
                    <label>
                        <span class="visually-hidden">Filter sales by product</span>
                        <select id="salesHistoryProduct">
                            <option value="all">All products</option>
                        </select>
                    </label>
                </div>

                <div
                    class="sales-table-container"
                >

                    <table
                        class="inventory-table"
                    >

                        <thead>

                            <tr>

                                <th>
                                    Product
                                </th>

                                <th>
                                    Quantity
                                </th>

                                <th>
                                    Price
                                </th>

                                <th>
                                    Total
                                </th>

                                <th>
                                    Date
                                </th>

                            </tr>

                        </thead>


                        <tbody
                            id="salesTableBody"
                        >

                            <tr>

                                <td colspan="5">
                                    Loading sales...
                                </td>

                            </tr>

                        </tbody>

                    </table>

                </div>

            </div>


        </div>

    `;


    await loadSalesProducts();

    await loadSalesHistory();

    document
        .getElementById("salesHistorySearch")
        .addEventListener("input", renderSalesHistory);

    document
        .getElementById("salesHistoryPeriod")
        .addEventListener("change", renderSalesHistory);

    document
        .getElementById("salesHistoryProduct")
        .addEventListener("change", renderSalesHistory);


    document
        .getElementById(
            "saleForm"
        )
        .addEventListener(
            "submit",
            recordSale
        );


    document
        .getElementById(
            "saleProduct"
        )
        .addEventListener(
            "change",
            updateSaleTotal
        );


    document
        .getElementById(
            "saleQuantity"
        )
        .addEventListener(
            "input",
            updateSaleTotal
        );

}


async function loadSalesProducts() {

    const select =
        document.getElementById(
            "saleProduct"
        );


    try {

        const response =
            await apiFetch(
                `${API_URL}/products`
            );


        if (!response.ok) {

            throw new Error(
                "Failed to load products."
            );

        }


        const databaseProducts =
            await response.json();


        select.innerHTML = `

            <option value="">
                Select a product
            </option>

        `;


        databaseProducts.forEach(
        function(product) {

                const option =
                    document.createElement(
                        "option"
                    );


                option.value =
                    product.id;


                option.textContent =
                    `${product.name} — ${formatKina(product.price)} — Stock: ${product.stock}`;


                    

                select.appendChild(
                    option
                );

            }
        );


    } catch (error) {

        console.error(
            "Error loading sale products:",
            error
        );


        select.innerHTML = `

            <option value="">
                Failed to load products
            </option>

        `;

    }

}


function updateSaleTotal() {

    const productId =
        Number(
            document
                .getElementById(
                    "saleProduct"
                )
                .value
        );


    const quantity =
        Number(
            document
                .getElementById(
                    "saleQuantity"
                )
                .value
        );


    const product =
        products.find(
            product =>
                product.id === productId
        );


    const unitPrice =
        product
            ? product.price
            : 0;


    const total =
        unitPrice * quantity;


    document
        .getElementById(
            "saleUnitPrice"
        )
        .textContent =
        `${formatKina(unitPrice)}`;


    document
        .getElementById(
            "saleTotal"
        )
        .textContent =
        `${formatKina(total)}`;

}


async function recordSale(event) {

    event.preventDefault();


    const productId =
        Number(
            document
                .getElementById(
                    "saleProduct"
                )
                .value
        );


    const quantity =
        Number(
            document
                .getElementById(
                    "saleQuantity"
                )
                .value
        );


    if (!productId) {

        showAppToast("Please select a product.", "error");

        return;

    }


    if (quantity <= 0) {

        showAppToast("Quantity must be greater than zero.", "error");

        return;

    }


    try {

        const response =
            await apiFetch(
                `${API_URL}/sales`,
                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify({

                            productId:
                                productId,

                            quantity:
                                quantity

                        })

                }
            );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.error ||
                "Failed to record sale."
            );

        }


        showAppToast("Sale recorded successfully.");


        await loadProductsFromDatabase();


        showSales();


    } catch (error) {

        console.error(
            "Error recording sale:",
            error
        );


        showAppToast(error.message || "Failed to record sale.", "error");

    }

}


async function loadSalesHistory() {

    const tableBody =
        document.getElementById(
            "salesTableBody"
        );


    if (!tableBody) return;


    try {

        const response =
            await apiFetch(
                `${API_URL}/sales`
            );


        if (!response.ok) {

            throw new Error(
                "Failed to load sales."
            );

        }


        const databaseSales =
            await response.json();


        // Keep global sales data updated
        // for Reports and recent sales.

        sales =
            databaseSales;

        const productFilter =
            document.getElementById("salesHistoryProduct");

        if (productFilter) {
            const productOptions = new Map();
            sales.forEach(sale => {
                productOptions.set(
                    String(sale.productId),
                    sale.productName
                );
            });

            productFilter.innerHTML = `
                <option value="all">All products</option>
                ${Array.from(productOptions.entries())
                    .sort((a, b) => a[1].localeCompare(b[1]))
                    .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`)
                    .join("")}
            `;
        }

        renderSalesHistory();


    } catch (error) {

        console.error(
            "Error loading sales:",
            error
        );


        tableBody.innerHTML = `

            <tr>

                <td colspan="5">
                    Failed to load sales.
                </td>

            </tr>

        `;

    }

}


function getSaleDateKey(dateValue) {
    const dateText = String(dateValue || "");
    const isoDate = dateText.match(/^(\d{4}-\d{2}-\d{2})/);

    if (isoDate) {
        return isoDate[1];
    }

    const parsedDate = new Date(dateValue);
    if (Number.isNaN(parsedDate.getTime())) {
        return "unknown";
    }

    const year = parsedDate.getFullYear();
    const month = String(parsedDate.getMonth() + 1).padStart(2, "0");
    const day = String(parsedDate.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}


function renderSalesHistory() {
    const tableBody = document.getElementById("salesTableBody");
    if (!tableBody) return;

    const search = (
        document.getElementById("salesHistorySearch")?.value || ""
    ).trim().toLowerCase();
    const period =
        document.getElementById("salesHistoryPeriod")?.value || "all";
    const productId =
        document.getElementById("salesHistoryProduct")?.value || "all";

    const now = new Date();
    const todayKey = getSaleDateKey(now);
    const monthPrefix = todayKey.slice(0, 7);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const sevenDaysAgoKey = getSaleDateKey(sevenDaysAgo);

    const filteredSales = sales.filter(sale => {
        const saleDateKey = getSaleDateKey(sale.date);
        const matchesSearch =
            !search || String(sale.productName || "").toLowerCase().includes(search);
        const matchesProduct =
            productId === "all" || String(sale.productId) === productId;
        let matchesPeriod = true;

        if (period === "today") {
            matchesPeriod = saleDateKey === todayKey;
        } else if (period === "7days") {
            matchesPeriod = saleDateKey >= sevenDaysAgoKey && saleDateKey <= todayKey;
        } else if (period === "month") {
            matchesPeriod = saleDateKey.startsWith(monthPrefix);
        }

        return matchesSearch && matchesProduct && matchesPeriod;
    });

    const countElement = document.getElementById("salesHistoryCount");
    const totalElement = document.getElementById("salesHistoryTotal");
    if (countElement) countElement.textContent = String(filteredSales.length);
    if (totalElement) {
        const total = filteredSales.reduce(
            (sum, sale) => sum + (Number(sale.total) || 0),
            0
        );
        totalElement.textContent = `${formatKina(total)}`;
    }

    if (filteredSales.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" class="sales-history-empty">
                    ${sales.length ? "No sales match these filters." : "No sales recorded yet."}
                </td>
            </tr>
        `;
        return;
    }

    const groupedSales = new Map();
    filteredSales.forEach(sale => {
        const key = getSaleDateKey(sale.date);
        if (!groupedSales.has(key)) groupedSales.set(key, []);
        groupedSales.get(key).push(sale);
    });

    tableBody.innerHTML = Array.from(groupedSales.entries())
        .map(([dateKey, daySales]) => {
            const dateLabel = dateKey === "unknown"
                ? "Date unavailable"
                : new Date(`${dateKey}T12:00:00`).toLocaleDateString(undefined, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric"
                });
            const dayTotal = daySales.reduce(
                (sum, sale) => sum + (Number(sale.total) || 0),
                0
            );
            const rows = daySales.map(sale => {
                const saleDate = new Date(sale.date);
                const timeLabel = Number.isNaN(saleDate.getTime())
                    ? "—"
                    : saleDate.toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit"
                    });

                return `
                    <tr>
                        <td><strong>${escapeHtml(sale.productName)}</strong></td>
                        <td>${sale.quantity}</td>
                        <td>${formatKina(sale.price)}</td>
                        <td><strong>${formatKina(sale.total)}</strong></td>
                        <td>${timeLabel}</td>
                    </tr>
                `;
            }).join("");

            return `
                <tr class="sales-date-group">
                    <td colspan="5">
                        <span>${dateLabel}</span>
                        <strong>${daySales.length} sale${daySales.length === 1 ? "" : "s"} · ${formatKina(dayTotal)}</strong>
                    </td>
                </tr>
                ${rows}
            `;
        })
        .join("");
}


// ==========================================
// AI PREDICTION
// ==========================================

const PREDICTION_PERIOD_PRESETS = [7, 14, 30, 60, 90];

function getPredictionHorizon() {
    const select = document.getElementById("predictionHorizon");
    const custom = document.getElementById("predictionHorizonCustom");

    let days = 7;
    if (select && select.value === "custom") {
        days = Number(custom?.value);
    } else if (select && select.value) {
        days = Number(select.value);
    }
    if (!Number.isFinite(days)) {
        days = 7;
    }
    return Math.min(180, Math.max(1, Math.trunc(days)));
}

function predictionPeriodLabel(days) {
    return `${days} day${days === 1 ? "" : "s"}`;
}

function predictionPeriodPhrase(days) {
    return days === 1 ? "the next day" : `the next ${days} days`;
}

function showPrediction() {
    const pageContent =
        document.getElementById(
            "pageContent"
        );

    if (!pageContent) return;

    pageContent.innerHTML = `
        <div class="page-header prediction-page-header">
            <div>
                <h2>Demand Prediction</h2>
                <p>Estimate upcoming sales with recent trends and plan your stock for any period.</p>
            </div>
            <button
                type="button"
                class="secondary-button prediction-help-button"
                onclick="showDemandPredictionInstructions()"
            >
                How Demand prediction works
            </button>
        </div>

        ${isCapacitorApp ? `
            <p class="prediction-offline-note">
                On this phone, forecasts run on the device using your recent sales trend, the day of week and Papua New Guinea payday weeks.
            </p>
        ` : ""}

        <div class="dashboard-card prediction-form-card">
            <div class="prediction-form-heading">
                <div>
                    <h3>Forecast a product</h3>
                    <p>Choose an item and how far ahead you want to plan.</p>
                </div>
                <span class="prediction-period" id="predictionPeriodBadge">Next 7 days</span>
            </div>

            ${products.length ? `
                <form id="predictionForm" class="prediction-form">
                    <div class="prediction-form-row">
                        <div class="form-group">
                            <label for="predictionProduct">Product</label>
                            <select id="predictionProduct" required>
                                <option value="">Choose a product</option>
                                ${products.map(product => `
                                    <option
                                        value="${escapeHtml(product.name)}"
                                        data-price="${Number(product.price)}"
                                    >${escapeHtml(product.name)} · ${escapeHtml(product.category)}</option>
                                `).join("")}
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="predictionHorizon">Forecast period</label>
                            <select id="predictionHorizon">
                                ${PREDICTION_PERIOD_PRESETS.map(days => `
                                    <option value="${days}" ${days === 7 ? "selected" : ""}>Next ${predictionPeriodLabel(days)}</option>
                                `).join("")}
                                <option value="custom">Custom period…</option>
                            </select>
                            <input
                                type="number"
                                id="predictionHorizonCustom"
                                min="1"
                                max="180"
                                value="21"
                                placeholder="Number of days"
                                hidden
                            >
                        </div>
                    </div>
                    <button type="submit" class="primary-button" id="predictionSubmitButton">
                        Generate 7-day forecast
                    </button>
                </form>
            ` : `
                <div class="prediction-empty-state">
                    <strong>Add a product before forecasting</strong>
                    <p>Create products in Inventory, then record sales to build a useful demand history.</p>
                    <button type="button" class="secondary-button" onclick="handleNavigation('Inventory')">Go to Inventory</button>
                </div>
            `}
        </div>

        <div id="predictionResult" class="dashboard-card prediction-result-card" hidden>
            <h3>Forecast results</h3>
            <div id="predictionContent"></div>
        </div>
    `;

    const form =
        document.getElementById(
            "predictionForm"
        );

    const horizonSelect = document.getElementById("predictionHorizon");
    const horizonCustom = document.getElementById("predictionHorizonCustom");

    const syncPeriodLabels = () => {
        const days = getPredictionHorizon();
        const badge = document.getElementById("predictionPeriodBadge");
        if (badge) badge.textContent = `Next ${predictionPeriodLabel(days)}`;
        const button = document.getElementById("predictionSubmitButton");
        if (button) button.textContent = `Generate ${days}-day forecast`;
        if (horizonCustom) horizonCustom.hidden = horizonSelect?.value !== "custom";
    };

    horizonSelect?.addEventListener("change", () => {
        syncPeriodLabels();
        if (horizonSelect.value === "custom") {
            horizonCustom?.focus();
        }
    });
    horizonCustom?.addEventListener("input", syncPeriodLabels);
    syncPeriodLabels();

    form?.addEventListener("submit", generatePrediction);
}


function showDemandPredictionInstructions() {
    const pageContent = document.getElementById("pageContent");
    if (!pageContent) return;

    pageContent.innerHTML = `
        <div class="page-header prediction-instructions-header">
            <div>
                <h2>How Demand prediction works</h2>
                <p>Use your recorded sales to estimate how many units may sell over the period you choose.</p>
            </div>
            <button type="button" class="secondary-button" onclick="showPrediction()">Back to Demand Prediction</button>
        </div>

        <section class="dashboard-card prediction-instructions-card">
            <div class="prediction-instructions-intro">
                <span class="prediction-instructions-icon" aria-hidden="true">↗</span>
                <div>
                    <h3>Before you start</h3>
                    <p>Add your products to Inventory and record sales in the Sales area. The forecast uses past sales for the selected product, so it becomes more useful as you build a consistent sales history.</p>
                </div>
            </div>

            <ol class="prediction-instruction-steps">
                <li>
                    <span>1</span>
                    <div><strong>Add the product to Inventory</strong><p>Enter its name, category, price, current stock, and minimum stock level. The current stock values are used when the result checks whether you may need to restock.</p></div>
                </li>
                <li>
                    <span>2</span>
                    <div><strong>Record each sale as it happens</strong><p>Use the Sales area to record the correct product and quantity. Accurate, regular entries help the forecast reflect your business's actual demand.</p></div>
                </li>
                <li>
                    <span>3</span>
                    <div><strong>Allow time to build history</strong><p>A few sales can only give an early, rough estimate. For the trained forecast, the app needs at least 28 calendar days of sales history for the product. Keep recording sales over multiple weeks for a more useful pattern. No history means there is not enough information to estimate demand reliably.</p></div>
                </li>
                <li>
                    <span>4</span>
                    <div><strong>Choose a product, period and generate the forecast</strong><p>Return to Demand Prediction, select the product and a forecast period (from one week up to a custom number of days), then generate the forecast. The result shows the overall trend, estimated demand, a day-by-day chart, payday weeks, and a suggested restock quantity.</p></div>
                </li>
                <li>
                    <span>5</span>
                    <div><strong>Use the result as a guide, not a guarantee</strong><p>Compare the forecast with your current stock and minimum target. Consider upcoming events, supplier delays, seasonal changes, and stockouts that may not appear in your sales records before deciding how much to order.</p></div>
                </li>
            </ol>

            <div class="prediction-instructions-note">
                <strong>How to improve your estimates</strong>
                <ul>
                    <li>Record every sale promptly and against the right product.</li>
                    <li>Keep product names consistent instead of creating duplicates.</li>
                    <li>Keep inventory stock levels current.</li>
                    <li>Review the forecast regularly; demand can change over time.</li>
                </ul>
            </div>

            <button type="button" class="primary-button prediction-instructions-cta" onclick="showPrediction()">Go to Demand Prediction</button>
        </section>
    `;
}


async function generatePrediction(
    event
) {

    event.preventDefault();

    const horizonDays = getPredictionHorizon();
    const periodLabel = predictionPeriodLabel(horizonDays);
    const periodPhrase = predictionPeriodPhrase(horizonDays);


    const productSelect =
        document.getElementById(
            "predictionProduct"
        );


    const product =
        productSelect.value;


    if (!product) {

        showAppToast("Please select a product.", "error");

        return;

    }


    const selectedOption =
        productSelect.options[
            productSelect.selectedIndex
        ];


    const price =
        parseFloat(
            selectedOption.dataset.price
        );


    const inventoryProduct =
        products.find(
            item =>
                item.name === product
        );


    if (!inventoryProduct) {

        showAppToast("Product not found in inventory.", "error");

        return;

    }


    const resultBox =
        document.getElementById(
            "predictionResult"
        );


    const resultContent =
        document.getElementById(
            "predictionContent"
        );


    resultBox.hidden = false;


    resultContent.innerHTML = `
        <p>
            🤖 Generating ${periodLabel} forecast...
        </p>
    `;


    try {

        const response =
            await apiFetch(
                `${API_URL}/ai/predict`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json"
                    },
                    body:
                        JSON.stringify({
                            product:
                                product,
                            price:
                                price,
                            date:
                                new Date().toISOString().split("T")[0],
                            days:
                                horizonDays
                        })
                }
            );


        if (!response.ok) {

            throw new Error(
                "Prediction request failed."
            );

        }


        const forecastQuality =
            await response.json();


        const forecasts =

            Array.isArray(forecastQuality.daily) && forecastQuality.daily.length

                ? forecastQuality.daily.map(item => ({

                    date:
                        item.date,

                    demand:
                        Number(item.predictedDemand) || 0,

                    payday:
                        Boolean(item.payday)

                }))

                : [{

                    date:
                        forecastQuality.date || new Date().toISOString().split("T")[0],

                    demand:
                        Number(forecastQuality.predictedDemand) || 0,

                    payday:
                        false

                }];


        const totalDemand =
            Number(
                forecasts
                    .reduce(
                        (sum, item) => sum + item.demand,
                        0
                    )
                    .toFixed(2)
            );


        const forecastTrend =
            forecastQuality.trend || null;

        const trendDirection =
            forecastTrend?.direction || "stable";

        const trendSymbol =
            trendDirection === "rising"
                ? "▲"
                : trendDirection === "falling"
                    ? "▼"
                    : "▬";

        const trendLabel =
            forecastTrend?.label || "Demand is broadly steady";

        const trendChange =
            forecastTrend && Number.isFinite(Number(forecastTrend.weeklyChangePercent))
                ? `${Number(forecastTrend.weeklyChangePercent) > 0 ? "+" : ""}${Number(forecastTrend.weeklyChangePercent)}% per week`
                : "";


        const currentStock =
            Number(
                inventoryProduct.stock
            );


        const minimumStock =
            Number(
                inventoryProduct.minimumStock
            );


        const requiredStock =
            Math.ceil(
                totalDemand +
                minimumStock
            );


        const restockQuantity =
            Math.max(
                0,
                requiredStock -
                currentStock
            );


        let statusHTML;
        let statusClass;
        let statusTitle;
        let statusDescription;


        if (
            restockQuantity > 0
        ) {

            statusClass = "prediction-status-warning";
            statusTitle = "Restock recommended";
            statusDescription = `Add about ${restockQuantity} units to cover the forecast and keep your minimum stock.`;

        }

        else if (
            currentStock <=
            minimumStock
        ) {

            statusClass = "prediction-status-warning";
            statusTitle = "Stock is at the minimum";
            statusDescription = "There is no forecasted shortfall, but consider restocking to maintain a comfortable buffer.";

        }

        else {

            statusClass = "prediction-status-good";
            statusTitle = "Stock looks sufficient";
            statusDescription = "Current stock covers the forecast and your minimum stock target.";

        }


        let forecastRows = "";


        forecasts.forEach(
            forecast => {

                forecastRows += `

                    <tr>

                        <td>
                            ${new Date(`${forecast.date}T00:00:00`).toLocaleDateString(undefined, {
                                weekday: "short",
                                month: "short",
                                day: "numeric"
                            })}
                            ${forecast.payday ? `<span class="prediction-payday-tag">Payday</span>` : ""}
                        </td>

                        <td>
                            ${forecast.demand.toFixed(1)}
                        </td>

                    </tr>

                `;

            }
        );


        resultContent.innerHTML = `

            <div class="prediction-result">

                <div class="prediction-heading">
                    <div>
                        <span class="prediction-eyebrow">DEMAND FORECAST</span>
                        <h4>${escapeHtml(product)}</h4>
                        <p>Expected sales over ${periodPhrase}</p>
                    </div>
                    <span class="prediction-period">${periodLabel}</span>
                </div>

                <div class="prediction-trend prediction-trend-${trendDirection}">
                    <span class="prediction-trend-symbol" aria-hidden="true">${trendSymbol}</span>
                    <div>
                        <strong>${escapeHtml(trendLabel)}</strong>
                        <span>${trendChange ? `${escapeHtml(trendChange)} · ` : ""}Based on the last 28 days of sales</span>
                    </div>
                </div>

                <div class="prediction-summary">
                    <div class="prediction-summary-total">
                        <span>Estimated demand</span>
                        <strong>${totalDemand.toFixed(1)} <small>units</small></strong>
                        <span class="prediction-summary-caption">Approximate units customers may buy</span>
                    </div>
                    <div class="prediction-summary-restock ${restockQuantity > 0 ? "needs-restock" : "stock-covered"}">
                        <span>Suggested restock</span>
                        <strong>${restockQuantity} <small>units</small></strong>
                        <span class="prediction-summary-caption">${restockQuantity > 0 ? "To cover demand and minimum stock" : "No additional stock needed"}</span>
                    </div>
                </div>

                <div class="forecast-quality-note ${forecastQuality && forecastQuality.modelStatus === "trained_model" ? "forecast-quality-trained" : "forecast-quality-limited"}">
                    <strong>${
                        forecastQuality && forecastQuality.modelStatus === "trained_model"
                            ? "Based on your recorded sales"
                            : forecastQuality && forecastQuality.modelStatus === "insufficient_history"
                                ? "Not enough sales history yet"
                                : "Early estimate from limited history"
                    }</strong>
                    <span>${
                        forecastQuality
                            ? escapeHtml(forecastQuality.warning)
                            : "This forecast is based on available sales history."
                    }</span>
                </div>


                <div class="prediction-chart-section">
                    <h5>Daily forecast</h5>
                    <div class="prediction-chart">
                        <canvas id="forecastChart"></canvas>
                    </div>
                </div>

                <div class="prediction-breakdown">
                    <div class="prediction-breakdown-heading">
                        <h5>Stock check</h5>
                        <span>Based on the ${periodLabel} estimate</span>
                    </div>
                    <div class="prediction-stock-grid">
                        <div><span>On hand now</span><strong>${currentStock} units</strong></div>
                        <div><span>Minimum target</span><strong>${minimumStock} units</strong></div>
                        <div><span>Needed to cover demand + minimum</span><strong>${requiredStock} units</strong></div>
                    </div>
                </div>

                <div class="prediction-status ${statusClass}">
                    <span class="prediction-status-icon">${restockQuantity > 0 || currentStock <= minimumStock ? "!" : "✓"}</span>
                    <div>
                        <strong>${statusTitle}</strong>
                        <p>${statusDescription}</p>
                    </div>
                </div>

                <details class="prediction-daily-details">
                    <summary>View daily estimates</summary>
                    <table class="prediction-daily-table">
                        <thead><tr><th>Day</th><th>Estimated sales</th></tr></thead>
                        <tbody>${forecastRows}</tbody>
                    </table>
                </details>

            </div>

        `;


        const chartCanvas =
            document.getElementById(
                "forecastChart"
            );


        if (chartCanvas) {

            const labels =
                forecasts.map(
                    forecast =>
                        new Date(`${forecast.date}T00:00:00`).toLocaleDateString(undefined, {
                            weekday: "short",
                            month: "short",
                            day: "numeric"
                        })
                );


            const values =
                forecasts.map(
                    forecast =>
                        forecast.demand
                );


            new Chart(
                chartCanvas,
                {

                    type:
                        "line",

                    data: {

                        labels:
                            labels,

                        datasets: [

                            {

                                label:
                                    "Estimated units sold",

                                data:
                                    values,

                                borderColor:
                                    "#087b3c",

                                backgroundColor:
                                    "rgba(8, 123, 60, 0.12)",

                                fill:
                                    true,

                                tension:
                                    0.35,

                                borderWidth:
                                    3,

                                pointRadius:
                                    4,

                                pointHoverRadius:
                                    6

                            }

                        ]

                    },

                    options: {

                        responsive:
                            true,

                        maintainAspectRatio:
                            false,

                        plugins: {

                            legend: {
                                display: false
                            },

                            tooltip: {
                                callbacks: {
                                    label: context => ` ${Number(context.parsed.y).toFixed(1)} units`
                                }
                            }

                        },

                        scales: {

                            y: {

                                beginAtZero:
                                    true,

                                title: {

                                    display:
                                        true,

                                    text:
                                        "Estimated units"

                                }

                            },

                            x: {

                                title: {

                                    display:
                                        true,

                                    text:
                                        "Day"

                                }

                            }

                        }

                    }

                }
            );

        }


    } catch (error) {

        console.error(
            "Prediction error:",
            error
        );


        resultContent.innerHTML = `

            <p class="stock-danger">

                ❌ Unable to generate
                the ${periodLabel} forecast.

                Make sure the Flask
                server is running.

            </p>

        `;

    }

}


// ==========================================
// REPORTS
// ==========================================

let reportsSalesChart = null;

async function showReports(period = "all") {

    const pageContent =
        document.getElementById(
            "pageContent"
        );


    if (!pageContent) return;

    if (reportsSalesChart) {
        reportsSalesChart.destroy();
        reportsSalesChart = null;
    }

    pageContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Business Reports</h2>
                <p>Understand sales performance and current stock at a glance.</p>
            </div>
        </div>
        <div class="report-loading-state">Loading your latest report...</div>
    `;

    try {
        const response = await apiFetch(`${API_URL}/sales`);
        if (!response.ok) {
            throw new Error("Failed to load report sales.");
        }
        sales = await response.json();
    } catch (error) {
        console.error("Report loading error:", error);
        const loadingState = pageContent.querySelector(".report-loading-state");
        if (loadingState) {
            loadingState.textContent = "Unable to load report data. Check your connection and try again.";
            loadingState.classList.add("report-error-state");
        }
        return;
    }

    const todayKey = getSaleDateKey(new Date());
    const monthKey = todayKey.slice(0, 7);
    const startOfWeek = new Date();
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - 6);
    const weekStartKey = getSaleDateKey(startOfWeek);
    const reportSales = sales.filter(sale => {
        const saleDate = getSaleDateKey(sale.date);
        if (period === "today") return saleDate === todayKey;
        if (period === "7days") return saleDate >= weekStartKey && saleDate <= todayKey;
        if (period === "month") return saleDate.startsWith(monthKey);
        return true;
    });


    const totalRevenue =
        reportSales.reduce(
            (sum, sale) =>
                sum + (Number(sale.total) || 0),
            0
        );


    const totalTransactions =
        reportSales.length;


    const totalUnits =
        reportSales.reduce(
            (sum, sale) =>
                sum + (Number(sale.quantity) || 0),
            0
        );


    const productSales = {};


    reportSales.forEach(
        function(sale) {

            if (
                !productSales[
                    sale.productId
                ]
            ) {

                productSales[
                    sale.productId
                ] = {

                    name:
                        sale.productName,

                    units:
                        0,

                    revenue:
                        0

                };

            }


            productSales[
                sale.productId
            ].units +=
                sale.quantity;


            productSales[
                sale.productId
            ].revenue +=
                sale.total;

        }
    );


    const productSalesList =
        Object.values(
            productSales
        );


    productSalesList.sort(
        (a, b) =>
            b.units - a.units
    );

    const dailyRevenue = new Map();
    reportSales.forEach(sale => {
        const dateKey = getSaleDateKey(sale.date);
        if (dateKey !== "unknown") {
            dailyRevenue.set(
                dateKey,
                (dailyRevenue.get(dateKey) || 0) + (Number(sale.total) || 0)
            );
        }
    });
    const reportDates = Array.from(dailyRevenue.keys()).sort();

    pageContent.innerHTML = `

        <div class="page-header">

            <div>

                <h2>
                    Reports
                </h2>

                <p>
                    Analyse your business
                    sales and inventory.
                </p>

            </div>

            <label class="report-period-control">
                <span>Reporting period</span>
                <select id="reportPeriod" aria-label="Reporting period">
                    <option value="all" ${period === "all" ? "selected" : ""}>All time</option>
                    <option value="today" ${period === "today" ? "selected" : ""}>Today</option>
                    <option value="7days" ${period === "7days" ? "selected" : ""}>Last 7 days</option>
                    <option value="month" ${period === "month" ? "selected" : ""}>This month</option>
                </select>
            </label>

        </div>


        <div class="stats-grid report-stat-grid">

            <div class="stat-card">

                <div class="stat-icon">
                    💰
                </div>

                <div>

                    <p>Revenue in selected period</p>

                    <h3>
                        ${formatKina(totalRevenue)}
                    </h3>

                </div>

            </div>


            <div class="stat-card">

                <div class="stat-icon">
                    🧾
                </div>

                <div>

                    <p>
                        Transactions
                    </p>

                    <h3>
                        ${totalTransactions}
                    </h3>

                </div>

            </div>


            <div class="stat-card">

                <div class="stat-icon">
                    📦
                </div>

                <div>

                    <p>
                        Units Sold
                    </p>

                    <h3>
                        ${totalUnits}
                    </h3>

                </div>

            </div>

            <div class="stat-card">

                <div class="stat-icon">
                    !
                </div>

                <div>

                    <p>
                        Needs Restocking
                    </p>

                    <h3>
                        ${products.filter(product => Number(product.stock) <= Number(product.minimumStock)).length}
                    </h3>

                </div>

            </div>


            <div class="stat-card">

                <div class="stat-icon">
                    🏆
                </div>

                <div>

                    <p>
                        Best Seller
                    </p>

                    <h3>

                        ${
                            productSalesList.length > 0
                                ? escapeHtml(productSalesList[0].name)
                                : "None"
                        }

                    </h3>

                </div>

            </div>

        </div>

        <div class="dashboard-card report-trend-card">
            <div class="card-header">
                <div>
                    <h3>Revenue over time</h3>
                    <p>Daily sales revenue for the selected period.</p>
                </div>
            </div>
            <div class="report-trend-chart">
                <canvas id="reportSalesChart" aria-label="Daily sales revenue chart"></canvas>
                ${
                    reportDates.length === 0
                        ? `<div class="report-chart-empty">No sales in this period yet.</div>`
                        : ""
                }
            </div>
        </div>


        <div class="dashboard-card">

            <div class="card-header">

                <div>

                    <h3>
                        Product Sales Performance
                    </h3>

                    <p>
                        Products ranked by
                        units sold.
                    </p>

                </div>

            </div>


            <div class="inventory-table-card">

                <table
                    class="inventory-table"
                >

                    <thead>

                        <tr>

                            <th>
                                Product
                            </th>

                            <th>
                                Units Sold
                            </th>

                            <th>
                                Revenue
                            </th>

                            <th>
                                Performance
                            </th>

                        </tr>

                    </thead>


                    <tbody>

                        ${
                            productSalesList.length === 0

                            ?

                            `

                                <tr>

                                    <td
                                        colspan="4"
                                        class="empty-state"
                                    >

                                        No sales data
                                        available.

                                    </td>

                                </tr>

                            `

                            :

                            productSalesList
                                .map(
                                    function(item) {

                                        return `

                                            <tr>

                                                <td>

                                                    <strong>
                                                        ${escapeHtml(item.name)}
                                                    </strong>

                                                </td>


                                                <td>
                                                    ${item.units}
                                                </td>


                                                <td>
                                                    ${formatKina(item.revenue)}
                                                </td>


                                                <td>

                                                    <span
                                                        class="performance-badge"
                                                    >

                                                        ${
                                                            item.units >= 10
                                                                ? "Fast Moving"
                                                                : "Normal"
                                                        }

                                                    </span>

                                                </td>

                                            </tr>

                                        `;

                                    }
                                )
                                .join("")

                        }

                    </tbody>

                </table>

            </div>

        </div>


        <div class="dashboard-grid report-stock-grid">


            <div class="dashboard-card">

                <div class="card-header">

                    <div>

                        <h3>
                            Low Stock Products
                        </h3>

                        <p>
                            Products requiring
                            attention.
                        </p>

                    </div>

                </div>


                <div>

                    ${renderLowStockAlerts()}

                </div>

            </div>


            <div class="dashboard-card">

                <div class="card-header">

                    <div>

                        <h3>
                            Current Stock Levels
                        </h3>

                        <p>
                            Stock on hand compared with minimum levels.
                        </p>

                    </div>

                </div>


                <div
                    class="report-inventory-list"
                >

                    ${
                        products.length === 0
                            ? `<div class="report-empty-state">No products in inventory yet.</div>`
                            : products.map(
                            function(product) {
                                const stock = Number(product.stock) || 0;
                                const minimumStock = Number(product.minimumStock) || 0;
                                const stockPercent = minimumStock > 0
                                    ? Math.min(100, Math.round((stock / minimumStock) * 100))
                                    : (stock > 0 ? 100 : 0);
                                const stockClass = stock <= minimumStock
                                    ? "report-stock-low"
                                    : "report-stock-healthy";

                                return `

                                    <div
                                        class="report-inventory-item"
                                    >

                                        <div class="report-inventory-product">
                                            <strong>${escapeHtml(product.name)}</strong>
                                            <span>${escapeHtml(product.category || "Uncategorized")}</span>
                                            <div class="report-stock-track">
                                                <span class="${stockClass}" style="width:${stockPercent}%"></span>
                                            </div>
                                        </div>
                                        <div class="report-inventory-quantity">
                                            <strong>${stock}</strong>
                                            <span>in stock</span>
                                        </div>

                                    </div>

                                `;
                            }
                        ).join("")
                    }

                </div>

            </div>


        </div>

    `;

    const periodSelect = document.getElementById("reportPeriod");
    if (periodSelect) {
        periodSelect.addEventListener("change", event => {
            showReports(event.target.value);
        });
    }

    const chartCanvas = document.getElementById("reportSalesChart");
    if (chartCanvas && reportDates.length > 0 && typeof Chart !== "undefined") {
        reportsSalesChart = new Chart(chartCanvas, {
            type: "line",
            data: {
                labels: reportDates.map(dateKey => new Date(`${dateKey}T12:00:00`).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric"
                })),
                datasets: [{
                    label: "Revenue",
                    data: reportDates.map(dateKey => dailyRevenue.get(dateKey)),
                    borderColor: "#087b3c",
                    backgroundColor: "rgba(8, 123, 60, 0.12)",
                    borderWidth: 3,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    fill: true,
                    tension: 0.32
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: context => ` ${formatKina(context.parsed.y)}`
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: "rgba(16, 54, 83, 0.08)" },
                        ticks: { callback: value => formatKina(value) }
                    },
                    x: {
                        grid: { display: false }
                    }
                }
            }
        });
    }

}
