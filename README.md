# SCORM Gradebook

A single-teacher app for connecting **single-SCO SCORM 1.2 HTML packages** to an external gradebook. Railway hosts the app; Neon stores the exams, roster and attempts. Original ZIPs are not retained on the server.

## Run locally

Node 22+ and PostgreSQL are required. Install with `npm ci` (or `npm install` for the initial checkout before a lockfile exists). Set the variables in `.env.example` securely, then run `node --env-file=.env server.js`. For development use `PUBLIC_URL=http://localhost:3000`. The app applies additive schema creation on startup. `GET /health` checks database connectivity.

Use `npm run check` and `npm test`. The API tests use an isolated in-memory PostgreSQL emulator, not Neon. A successful emulator test does not verify hosted PostgreSQL, Railway, or MOE compatibility.

## Vercel + Neon deployment

The `api/index.js` Node function initializes the database schema once per warm instance and forwards requests to Express. `vercel.json` routes the dashboard and API to it. No persistent filesystem is required.

1. Import `kamelbshara/scorm-to-lms` from GitHub and choose branch `main`, repository root directory, and framework preset **Other**. Use Node 22 or newer; do not configure a static output directory or a custom build command.
2. Add `DATABASE_URL` (your Neon connection string), `ADMIN_KEY` (at least 12 random characters), and `PUBLIC_URL` (the stable production HTTPS domain) to Vercel's **Production** environment variables. `LMS_ORIGINS` defaults to `https://lms.moe.gov.ae`; adjust only to actual package-serving origins. Redeploy after changing variables.
3. Visit `/health`, then test teacher login and a connected ZIP. Generate connected ZIPs only after the stable domain is configured. Do not use preview deployments with real student data.

Vercel Functions have a 4.5 MB request/response ceiling. This app limits ZIP uploads and connected downloads to **4 MB on Vercel**, allowing space for multipart overhead. Larger SCORM exams need Railway or a future object-storage upload flow. Rate limits here are per function instance, not a distributed abuse-control service.

Adding `DATABASE_URL` in Vercel does not configure it in this development workspace. If Neon already exists, neither a Neon management API key nor a Railway token is needed for a Git-connected Vercel deployment. This does not verify MOE connectivity or browser-reported identities.

### Troubleshoot startup on Vercel

If the login page reports startup failure, this happens before teacher authentication. Check all three variable names (case-sensitive) in the Production scope: `DATABASE_URL`, `ADMIN_KEY` (12+ characters), and `PUBLIC_URL` (your HTTPS origin, e.g. `https://scormrecord.vercel.app`). The database value must be the raw PostgreSQL URL, without a `psql` command or surrounding shell quotes. Redeploy after saving variables. The updated handler reports safe configuration guidance and logs a startup error code without credential values. A database permissions error means the connection role needs schema creation privileges for the initial migration. Do not share connection strings or teacher keys in screenshots or logs.

## Railway + Neon deployment

1. Create a Neon PostgreSQL project in a suitable region for your school's data requirements. Obtain its connection string securely; leave TLS enabled.
2. Deploy this directory to Railway with Node 22+ (`railway.json` supplies start and health-check configuration). Set `DATABASE_URL` to the Neon connection string. Never expose it to the browser.
3. Set `ADMIN_KEY` to at least 12 random characters (for example generate with `openssl rand -hex 32`). This is the teacher dashboard password. Store it in Railway's private variables.
4. Generate a Railway HTTPS domain and set `PUBLIC_URL` to its full URL. Set `LMS_ORIGINS` to comma-separated exact allowed LMS origins, initially `https://lms.moe.gov.ae`. If the LMS serves packages from another origin, add that exact origin after inspecting the test launch. No wildcard or null-origin access is enabled.
5. Redeploy and verify `/health`, teacher login, CSV import and a connected ZIP. Set `PUBLIC_URL` before generating ZIPs: changing domains requires reconnecting the original packages.

An account-scoped Railway API token and Neon API key are required for automated provisioning; they are not configured by this repository. Do not put these credentials into chat or source control. Hosted deployment is not complete until verified against the actual services.

## Teacher workflow

Unlock the dashboard using the teacher key (kept in memory until lock/reload). Upload the original SCORM ZIP and download its connected version. Upload that version to your LMS. Import a UTF-8 roster CSV with `student_id,name` headers matching the LMS's `cmi.core.student_id`. Refresh the gradebook or export CSV; students outside the roster also appear once they report an attempt. The main table shows the latest received attempt; attempt history remains available.

## Delivery and storage

The injected connector forwards SCORM calls to the existing LMS API while reading student ID/name, raw score and lesson status. It never includes database or teacher credentials. It sends only those result fields plus exam/attempt IDs and an increasing revision. Scores must be 0–100; question-level answers and arbitrary pre-existing browser storage are not imported.

Pending snapshots are written to **localStorage in the LMS package's origin**, isolated by exam ID. The newest snapshot for each attempt is retained until the server acknowledges it. Delivery retries every 15 seconds while an instrumented exam is open, on the browser's online event, and on a later launch. There is no background sync after the browser closes. Clearing storage, switching browser/device, private browsing, storage restrictions or never reopening can lose unsent results. When storage is unavailable, a memory queue survives only while the page is open. The server conditionally upserts by attempt ID and revision, so duplicate retries and older snapshots do not overwrite newer scores. `LMSFinish` ends the attempt; initialize starts/resumes an attempt using sessionStorage. Retakes and resumption behavior must be tested with the target authoring tool.

## Compatibility and trust limits

- The LMS must expose an accessible SCORM 1.2 API and a nonempty student ID. No identity is invented when unavailable.
- Only a root `imsmanifest.xml`, one SCO, and an HTML launch file are supported. ZIP uploads are limited to 25 MB, 150 MB expanded and 5,000 files. Existing CSP, unusual launch/API discovery code, sandboxing, nested manifests and non-UTF-8 HTML can prevent instrumentation. Test representative packages first.
- The package must be permitted to execute the connector and connect to your HTTPS domain. CORS on this app cannot override the LMS's sandbox or content-security policy. Without LMS settings access, a blocked connection may make this design unusable there.
- Package tokens authorize result writes for that exam; they are visible to students. Browser-reported scores and identities can be forged. CORS and rate limits reduce accidental exposure/abuse but do not make results verified official grades. This app must not be used as an authoritative high-stakes grading system without authenticated LMS integration.
- This version is a single-teacher prototype, not multi-tenant. The teacher key grants access to all records. Use synthetic students until the school's data handling and hosting requirements are satisfied. Before wider operation, add institution authentication, audit/deletion workflows and backup policy.

## MOE acceptance test (required before student use)

Using a synthetic student, launch a connected exam from the LMS; submit a known score and finish. Confirm the student ID, score, status and attempt in the dashboard. Simulate offline mode, submit a new attempt, reconnect and verify it is stored exactly once. Refresh/reopen the package and verify its retry behavior; then test a second student and a retake. These checks cannot be performed from this repository without access to the actual LMS.
