# Local workspaces and cloud sync

Stock N Sales opens to a workspace chooser. Each local business gets a separate
SQLite database. You can switch between saved local businesses from the top bar.

## Connect a business to cloud sync

1. Start the app and create or open a local workspace with a name and business
   name, or choose cloud sign-in from the workspace chooser.
2. Create an account with an email address and password. When registering from
   a local workspace, its inventory is copied into the new cloud workspace.
   Registration from the chooser creates a new empty cloud workspace. The
   account is stored in the Atlas `users` collection; passwords are stored as
   hashes.
3. Allow the initial sync to complete. The first cloud account claims existing
   Atlas inventory that has no owner yet. The local workspace is copied into
   that account's local SQLite database, and its changes are synced to Atlas.
4. On another installation, choose **Sign in to a cloud account** and sign in
   with the same account. That installation downloads the account's products,
   categories, sales, and deletions into its own SQLite database.

Each cloud account has a unique owner ID. Inventory and deletion records are
read, changed, and removed only within that owner's scope. Local changes sync
when possible, or when you choose **Sync now**. **Disconnect this device** returns to the
device-only local workspace without deleting either workspace or its cloud
account. Signing into an existing account does not merge a separate local-only
workspace into that account. Its data remains available from the local
workspace chooser.

Each installation needs access to the Atlas cluster through its network
allowlist and a private `.env` containing the same `MONGO_URI`. Never share
that URI or commit it. Back up SQLite and Atlas data before relying on the app
for business-critical records.
