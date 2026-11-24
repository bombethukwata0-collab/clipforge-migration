# Clipforge Migration

This repository is the destination workspace for migrating Clipforge from AppDeploy to Netlify.

## Migration status

- [x] Original AppDeploy source snapshot copied into this repository (21 original files).
- [x] Netlify Vite build configuration added.
- [x] Netlify Functions API foundation added for authenticated project CRUD.
- [x] Project records are scoped to the authenticated Netlify user.
- [ ] Replace the AppDeploy frontend client and authentication calls.
- [ ] Complete AI analysis, smart reframe, and transcription using an approved provider.
- [ ] Verify background processing and completion notifications.
- [ ] Connect this repository to the existing Netlify project.
- [ ] Build, test, and deploy.

## Safety and cost notes

- The original AppDeploy project remains unchanged.
- The AI endpoints currently return a clear "not enabled" response. No paid AI provider or API key has been configured.
- The Netlify API uses the existing team-login protection and `context.user` for server-side identity. The app's current sign-out behavior still needs a supported replacement before release.
- The project has not yet been built, tested, or deployed from this repository.

## Destination

Netlify project: https://app.netlify.com/projects/clipforge-0lpc
