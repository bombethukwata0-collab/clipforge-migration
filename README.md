# Clipforge Migration

This repository is the destination workspace for migrating Clipforge from AppDeploy to Netlify.

## Migration status

- [x] Original AppDeploy source snapshot copied into this repository (21 original files).
- [x] Netlify Vite build configuration added.
- [x] Netlify Functions API implemented for project creation, listing, updating, and deletion.
- [x] The API function is explicitly routed to the frontend's `/api/*` URLs.
- [x] React single-page application fallback added for client-side routes.
- [x] Project records are scoped to the authenticated Netlify Identity user, with cross-user access blocked.
- [x] Project and caption validation, safe storage-error handling, and non-cacheable API responses added.
- [x] Public health endpoint preserved; user-specific API routes verify Netlify Identity users server-side.
- [x] Replaced the AppDeploy frontend API client and team-SSO placeholder with Netlify Identity signup, login, logout, email confirmation callbacks, and password recovery.
- [x] Added a 512 KiB project API body limit and deterministic most-recently-updated project listing (50-project API limit).
- [x] Automated API tests cover CRUD, settings/caption round-trips, malformed and oversized requests, authentication, ordering, and user isolation.
- [ ] Enable Netlify Identity in the Netlify dashboard (Identity settings are dashboard-only).
- [ ] Connect this repository to the existing Netlify project.
- [ ] Deploy the repository and verify project storage/retrieval against live Netlify Blobs.
- [ ] Complete AI analysis, smart reframe, and transcription using an explicitly approved provider.
- [ ] Verify background processing and completion notifications.
- [ ] Re-run and confirm the build, API tests, and Netlify API TypeScript check on the final routing commits.
- [ ] Complete end-to-end testing on the deployed site, including Identity signup/login and saved-project persistence.

## Safety and cost notes

- The original AppDeploy project remains unchanged.
- The AI endpoints currently return a clear "not enabled" response. No paid AI provider or API key has been configured.
- App authentication uses `@netlify/identity`; server routes call `getUser()` and scope every project key to the verified Identity user ID.
- Netlify Identity must be enabled manually in the project dashboard. The destination project's current visitor-access settings do not require a site password or team SSO; app data routes remain protected by Identity.
- API tests use an in-memory Blobs-compatible store and inject a test-only user resolver. Live Netlify Blobs storage, Identity login, and end-to-end behaviour still require deployment and real-site testing.
- The latest routing commits do not yet have a confirmed CI result or a Netlify deployment.

## Destination

Netlify project: https://app.netlify.com/projects/clipforge-0lpc
