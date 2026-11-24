# Clipforge Migration

This repository is the destination workspace for migrating Clipforge from AppDeploy to Netlify.

## Migration status

- [x] Original AppDeploy source snapshot copied into this repository (21 original files).
- [x] Netlify Vite build configuration added.
- [x] Netlify Functions API foundation added for authenticated project CRUD.
- [x] Project records are scoped to the authenticated Netlify user.
- [x] Replaced the AppDeploy frontend API client and authentication lookup with Netlify Functions + protected team SSO.
- [ ] Complete AI analysis, smart reframe, and transcription using an approved provider.
- [ ] Verify background processing and completion notifications.
- [ ] Connect this repository to the existing Netlify project.
- [x] Frontend production build and Netlify API TypeScript check pass in GitHub Actions.
- [ ] Connect this repository to the existing Netlify project and deploy.

## Safety and cost notes

- The original AppDeploy project remains unchanged.
- The AI endpoints currently return a clear "not enabled" response. No paid AI provider or API key has been configured.
- The Netlify API uses the existing team-login protection and `context.user` for server-side identity. The account display is read-only because this protected team-SSO setup does not provide an in-app sign-out flow.
- GitHub Actions successfully builds the frontend and type-checks the Netlify API function. This is a compile check, not a live deployment or end-to-end test.
- The project has not yet been deployed or tested against live Netlify services.

## Destination

Netlify project: https://app.netlify.com/projects/clipforge-0lpc
