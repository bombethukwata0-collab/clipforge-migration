# Clipforge Migration

This repository is the destination workspace for migrating Clipforge from AppDeploy to Netlify.

## Migration status

- [x] Original AppDeploy source snapshot copied into this repository (21 original files).
- [x] Netlify Vite build configuration added.
- [x] Netlify Functions API implemented for project creation, listing, updating, and deletion.
- [x] Project records are scoped to the authenticated Netlify user, with cross-user access blocked.
- [x] Project and caption validation, safe storage-error handling, and non-cacheable API responses added.
- [x] Public health endpoint preserved; user-specific API routes require Netlify team SSO identity.
- [x] Replaced the AppDeploy frontend API client and authentication lookup with Netlify Functions + protected team SSO.
- [x] Automated API tests cover CRUD, settings/caption round-trips, malformed updates, authentication, and user isolation.
- [ ] Verify project storage and retrieval against live Netlify Blobs after deployment.
- [ ] Complete AI analysis, smart reframe, and transcription using an approved provider.
- [ ] Verify background processing and completion notifications.
- [ ] Connect this repository to the existing Netlify project.
- [x] Frontend production build, API tests, and Netlify API TypeScript check pass in GitHub Actions.
- [ ] Connect this repository to the existing Netlify project and deploy.

## Safety and cost notes

- The original AppDeploy project remains unchanged.
- The AI endpoints currently return a clear "not enabled" response. No paid AI provider or API key has been configured.
- The Netlify API uses the existing team-login protection and `context.user` for server-side identity. The account display is read-only because this protected team-SSO setup does not provide an in-app sign-out flow.
- GitHub Actions currently passes the frontend build, API test suite, and Netlify API TypeScript check.
- API tests use an in-memory Blobs-compatible store. Live Netlify Blobs storage, Netlify SSO, and end-to-end behaviour still require deployment and real-site testing.

## Destination

Netlify project: https://app.netlify.com/projects/clipforge-0lpc
