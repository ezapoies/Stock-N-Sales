(() => {
    const installButton = document.getElementById("installAppButton");
    if (!installButton) return;

    let installPrompt = null;
    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent)
        && !window.MSStream;
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches
        || window.navigator.standalone === true;

    if ("serviceWorker" in navigator && window.isSecureContext) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register("/service-worker.js").catch(error => {
                console.error("App shell registration failed:", error);
            });
        }, { once: true });
    }

    if (isIos && !isStandalone) {
        installButton.hidden = false;
    }

    window.addEventListener("beforeinstallprompt", event => {
        event.preventDefault();
        installPrompt = event;
        installButton.hidden = false;
    });

    window.addEventListener("appinstalled", () => {
        installPrompt = null;
        installButton.hidden = true;
    });

    installButton.addEventListener("click", async () => {
        if (installPrompt) {
            installPrompt.prompt();
            await installPrompt.userChoice;
            installPrompt = null;
            installButton.hidden = true;
            return;
        }

        if (isIos && typeof showAppDialog === "function") {
            await showAppDialog({
                title: "Install Stock N Sales",
                message: "In Safari, tap Share, then choose Add to Home Screen.",
                confirmText: "Got it",
                cancelText: "Close"
            });
        }
    });
})();
