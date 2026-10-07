# Orbit chat

Orbit is a small group chat. The local setup uses Node.js, SQLite, and Socket.IO. Vercel uses serverless API functions, Neon Postgres for persistent data, and Ably for realtime messages and presence.

## Run it on Windows

1. Install **Node.js 22.12 or newer**.
2. Open PowerShell in this project folder and run:

   ```powershell
   npm install
   npm start
   ```

3. Open [http://localhost:3000](http://localhost:3000) and create an account. Share the app's hosted HTTPS address with friends so they can create their own accounts.

The first run creates `data/orbit.sqlite` and a random development session secret in `data/session-secret`. No spaces are created automatically: create one after signing up, then invite your friends. After the first account, registration requires a server invitation. On existing local databases, startup removes the three old starter spaces (`The Hideout`, `Side Quest`, and `Study Buddies`) and their contents. Keep the `data` folder private: it holds account password hashes, chat history, invitations, and session secrets. It is excluded from Git and Vercel uploads.

## Deploy to Vercel

The Vercel deployment is a separate serverless backend; it cannot use the local SQLite file or Socket.IO server. Set up the required hosted services before deploying:

1. Create a Neon Postgres database and copy its **pooled** connection string.
2. Create an Ably app and a private server-side API key with publish, subscribe, and presence access. The server uses this key to issue scoped client tokens; keep the key private.
3. Import this project into Vercel from the repository root. The build creates `public/` from the root `index.html`, `script.js`, and `styles.css` when that folder is absent, then Vercel serves `public/` and routes `/api/*` to serverless functions. This also supports GitHub uploads that contain the website files at the repository root.
4. Add these project environment variables in Vercel for **Development**, **Preview**, and **Production**:
   - `DATABASE_URL`: the pooled Neon connection string.
   - `SESSION_SECRET`: a random secret of at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`.
   - `ABLY_API_KEY`: the private Ably API key. Never put it in `public/` or expose it to browser code.
5. Deploy again after setting the variables. The first API request creates the Postgres tables and removes any old starter spaces. Verify the deployment by creating the first account, creating a space, and sending a message from a second browser session.

Vercel starts with its own empty Neon database; it does not upload or import `data/orbit.sqlite`. Existing local accounts, messages, invitations, and sessions stay on the computer and are not copied to Vercel. Do not point `DATABASE_URL` at the SQLite file. Local `npm start` continues to use SQLite and Socket.IO.

The Vercel API uses signed HTTP-only cookies backed by Postgres sessions and a Postgres-backed rate limit, so authentication and limits work across serverless instances. Ably tokens are scoped to the signed-in user's server memberships; the private Ably API key is used only by the serverless API. Vercel deployments require working Neon and Ably credentials; without them the backend fails fast with an explicit configuration error rather than silently falling back to temporary storage.

## Host it for friends

By default, the local Orbit server listens only on `127.0.0.1`, which is accessible only from the same computer. For a trusted local network, set `$env:HOST = '0.0.0.0'` in PowerShell, run `npm start`, and visit the computer's local address on port 3000. Plain HTTP on a local network is not suitable for sending accounts or passwords over the public internet.

To let friends connect over the internet, deploy Node.js and the persistent `data` directory on a host with a stable HTTPS domain. Create your first account before sharing the site. Put a TLS-terminating reverse proxy in front of the Node server, enable WebSocket upgrades, set `NODE_ENV=production`, set `TRUST_PROXY=1` when using a single trusted reverse proxy, and provide a long, randomly generated `SESSION_SECRET`. Do not expose the plain-HTTP Node port to the public internet. Back up `data/orbit.sqlite` regularly and keep its contents private.

On PowerShell, generate a production secret with:

```powershell
$bytes = New-Object byte[] 48
$rng = [Security.Cryptography.RNGCryptoServiceProvider]::Create()
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$rng.Dispose()
```

Set `SESSION_SECRET`, `NODE_ENV=production`, and (when appropriate) `TRUST_PROXY=1` in the hosting environment before running `npm start`. Use your hosting provider's secret manager rather than committing a secret to this project.

## Accounts and chat

- Create the first account on an empty installation with a 2–24 character username (letters, numbers, and underscores) and a password of at least 10 characters. Create a space after signing in, then invite friends; after the first account, new accounts need a valid invitation link. Sign-in is available to existing accounts without an invitation.
- Passwords are stored as bcrypt hashes. Login and account creation have per-IP rate limits; sessions use an HTTP-only, same-site cookie and are stored in SQLite locally or Postgres on Vercel.
- Members can see messages only in their shared servers. Invitation links expire after seven days and allow up to 20 uses; anyone who has a valid link can join that server. New spaces start private to their creator until they invite others. Messages are limited to 500 characters. Search, member lists, channel creation, and voice-room listings use the backend.
- The voice rooms are placeholders; audio/video calls, direct messages, password reset, and email verification are not implemented.
