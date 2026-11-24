# Clipforge Migration

This repository is the destination workspace for migrating Clipforge from AppDeploy to Netlify.

## Migration status

- [x] Original AppDeploy source snapshot copied into this repository (21 original files).
- [x] Netlify Vite build configuration added.
- [x] Netlify Functions API implemented for project creation, listing, updating, and deletion.
- [x] Project records are scoped to the authenticated Netlify user, with cross-user access blocked.
- [x] Project and caption validation, safe storage-error handling, and non-cacheable API responses added.
- [x] Public health endpoint preserved; user-specific API routes verify Netlify Identity users server-side.
- [x] Replaced the AppDeploy frontend API client and team-SSO placeholder with Netlify Identity signup, login, logout, email confirmation callbacks, and password recovery.
- [x] Added a 512 KiB project API body limit and deterministic most-recently-updated project listing (50-project API limit).
- [x] Automated API tests cover CRUD, settings/caption round-trips, malformed and oversized requests, authentication, ordering, and user isolation.
- [ ] Enable Netlify Identity in the Netlify dashboard (Identity settings are dashboard-only).
- [ ] Confirm visitor access is changed from team-only SSO to public site access, with app features protected by Netlify Identity.
- [ ] Verify project storage and retrieval against live Netlify Blobs after deployment.
- [ ] Complete AI analysis, smart reframe, and transcription using an approved provider.
- [ ] Verify background processing and completion notifications.
- [ ] Connect this repository to the existing Netlify project.
- [x] Frontend production build, API tests, and Netlify API TypeScript check pass in GitHub Actions.
- [ ] Connect this repository to the existing Netlify project and deploy.

## Safety and cost notes

- The original AppDeploy project remains unchanged.
- The AI endpoints currently return a clear "not enabled" response. No paid AI provider or API key has been configured.
- App authentication now uses `@netlify/identity`; server routes call `getUser()` and scope every project key to the verified Identity user ID.
- Netlify Identity must be enabled manually in the project dashboard. The existing site-level team SSO gate is still in place until the owner approves replacing it with public site access plus app-level Identity authentication.
- GitHub Actions currently passes the frontend build, API test suite, and Netlify API TypeScript check.
- API tests use an in-memory Blobs-compatible store and inject a test-only user resolver. Live Netlify Blobs storage, Identity login, and end-to-end behaviour still require deployment and real-site testing.

## Destination

Netlify project: https://app.netlify.com/projects/clipforge-0lpc
