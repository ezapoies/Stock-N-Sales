# Android app (Capacitor)

The Android app packages the existing interface in a Capacitor WebView and
uses IndexedDB on the phone for separate business workspaces, inventory,
categories, sales, dashboard totals, analytics, and basic 7-day demand
estimates. It does not start Python or require a server for those local
workflows. Desktop continues to use Flask and SQLite.

## Build a debug APK on Windows

Install Node.js, **JDK 21**, and
Android Studio with Android SDK Platform 35 and Android SDK Build-Tools 35.0.0.
Do not use Java 17 or 25. Set `ANDROID_HOME` or
`ANDROID_SDK_ROOT` to the Android SDK directory. From the project root:

```powershell
npm install
npm run android:apk
```

The Windows APK build script automatically prefers JDK 21 under
`%LOCALAPPDATA%\Programs\Eclipse Adoptium` or `C:\Program Files\Eclipse
Adoptium`, so it can use the user-local Temurin JDK without changing the
system Java installation.

The debug APK, signed with Android's standard debug key for testing, is written to
`android\app\build\outputs\apk\debug\app-debug.apk`. Install it with
`adb install -r android\app\build\outputs\apk\debug\app-debug.apk`, or open
the `android` folder in Android Studio and run it on a connected phone or
emulator. For Android Studio:

```powershell
npm run android:open
```

For iterative web changes, use `npm run android:sync` before running again.
The build script regenerates the launcher icons from `Logo.png`.

## Mobile cloud sync

Mobile cloud sync is optional. Local workspaces continue to work without a
network connection. To connect a phone to Atlas, first host the Flask backend
at a publicly reachable HTTPS address. Configure that backend with its MongoDB
`MONGO_URI` and a persistent `SECRET_KEY`; the same backend and Atlas database
must be used by every device that should share data. Never put MongoDB
credentials in the APK.

In the Android app, enter the server's public HTTPS address once, without the
`/api` suffix, then sign in or create an account. The app saves that address
for future sign-ins on the device. Creating an account
uploads the currently selected local workspace as the new cloud workspace.
Signing in downloads that account's cloud data into a separate workspace and
does not merge or overwrite other local workspaces. Changes sync automatically
when online and can also be sent with **Sync now**. The cloud account's bearer
token is stored in the app's private local IndexedDB storage; disconnecting
removes that device's token but leaves its cached business data on the phone.

The backend must be running a version that includes `/api/mobile/auth/login`,
`/api/mobile/auth/register`, and `/api/mobile/sync`. If the server URL is
unavailable, the workspace remains usable locally and can be synced later.

### Free hosted option: Render

The project includes a Render Blueprint (`render.yaml`) that deploys the Flask
backend as a free Docker web service. Render assigns the service a stable
`onrender.com` HTTPS address; no purchased domain or PC-hosted tunnel is
needed. Free services can sleep when idle, so the first request after a pause
may take about a minute to start.

1. Put this project in a GitHub repository and connect that repository to
   Render using **New > Blueprint**. Render reads `render.yaml` and creates
   the `stock-n-sales-api` web service.
2. When prompted, provide the MongoDB Atlas connection string as `MONGO_URI`.
   Render generates a persistent `SECRET_KEY` for the service.
3. In MongoDB Atlas, add the outbound IP ranges shown for the Render service to
   the project's IP access list. Do not expose the database credential in the
   repository or APK.
4. After deployment, copy the service's HTTPS `onrender.com` address. Use it
   in the mobile app's cloud sign-in field (without `/api`). The app remembers
   the address on that device for later sign-ins.

The Android app still needs its first successful cloud connection before it
can remember the server address. To remove that first manual entry too, set the
deployed address as the app's built-in default and rebuild the APK.

### Free self-hosted option: your PC and a Cloudflare Quick Tunnel

For a no-cost personal setup, run the Flask service on your own PC and use a
Cloudflare Quick Tunnel to give the phone a temporary HTTPS address. The PC
must stay on and connected whenever the phone needs to sync. The Quick Tunnel
address changes when its process restarts. Requests pass through Cloudflare;
the app source and `.env` remain on your PC.

1. Add your PC's current public IP address to the MongoDB Atlas project's IP
   access list. Do not allow all IP addresses.
2. Ensure the project-root `.env` contains `MONGO_URI` and a persistent
   `SECRET_KEY`.
3. Install `cloudflared` and make sure it is available on `PATH`.
4. Double-click `Start Cloud Sync.bat` in the project folder. It starts the
   backend if it is not already listening on port 5000, then opens a separate
   Cloudflare tunnel window. If the backend does not start, check that window
   for errors.
5. Copy the generated `https://<random-name>.trycloudflare.com` address from
   the tunnel window and enter it in the Android app. Do not add `/api`.

Keep `.env` private. The tunnel makes the backend publicly reachable at its
temporary HTTPS address, so share that address only with people who should
access the service. If your home internet IP changes, update the Atlas
allowlist. Closing either window, turning off the PC, or losing the internet
connection stops cloud sync; offline mobile workspaces remain available.

## Other mobile limitations

- Mobile demand prediction uses the mean daily sales in the previous 28
  calendar days. It is a simpler estimate than the server's trained model.
- Existing desktop SQLite databases are not imported automatically. Export or
  migrate business data explicitly before relying on the phone as the primary
  device; the mobile app can upload its own local workspace when creating a
  cloud account.
- The debug APK is for testing and direct installation. A public release
  requires a protected Android signing key and a signed release build.

The PWA shell remains available for HTTPS browser installation, and its service
worker never caches API responses.
