# BTP Destination Drift Monitor

A CAP (Cloud Application Programming Model) app that compares **Destination
Service** configuration and **service instances** across SAP BTP subaccounts,
and lets you **transport** a missing destination from one subaccount to
another with a single click.

Single sign-on only — no service keys are ever pasted by the user. You log in
once via the `btp` CLI (SSO), pick your global account and two or more
subaccounts, and the app auto-provisions the Destination service credentials
it needs in the background.

## Architecture

- **Backend:** CAP Node.js (`@sap/cds` 10.x), service: `DestinationDriftService`
  (`srv/destination-service.cds` + `srv/destination-service.cts`).
  - `DriftRows` — one row per destination per subaccount, computed live from
    the BTP Destination API on every request (not persisted).
  - `Subaccounts` — subaccounts registered for comparison, with the
    Destination service credentials auto-provisioned for them; persisted in
    SQLite (`node:sqlite`, no native build required).
  - `TransportLog` — audit trail of transport operations, same SQLite DB.
  - `btpLoginStart`/`btpLoginStatus`/`btpChooseGlobalAccount`/`btpLogout` —
    drive an interactive `btp login --sso` session in the background and
    resolve the "choose a global account" prompt via a picker dialog.
  - `btpSwitchAccountStart`/`btpSwitchAccountStatus`/`btpChooseSwitchAccount` —
    switch global account (`btp target --hierarchy`) without logging out.
  - `registerBtpSubaccountStart`/`registerBtpSubaccountStatus` — fire-and-poll
    background provisioning of a destination service instance/key for a
    subaccount via the `btp` CLI (`srv/lib/btp-cli.cts`).
  - `transportDestination` — copies a destination from a source subaccount to
    a target subaccount via `POST` on the Destination service's collection
    endpoint.
- **Frontend:** a single SAPUI5/OpenUI5 screen (`app/destination-drift/webapp`),
  written in TypeScript and built to classic `sap.ui.define()` modules via a
  custom Babel-based build script (`scripts/build-ui5-ts.js`) — no compiled
  JavaScript is committed to the repo, only `.ts`/`.cts` sources.
  - BTP Login card, a global-account picker dialog (with search), a
    subaccount multi-select, and an `IconTabBar` with **Destinations** and
    **Service Instances** comparison tables (match / drift / missing, with a
    one-click **Transport** action on missing destinations).

## Local setup

1. `npm install`
2. Download the `btp` CLI for your platform and either put it on `PATH` or
   set `BTP_CLI_PATH` to its full path (see `srv/lib/btp-exe.cts`).
3. `npm run watch` (or `npx cds watch`) — the app opens at
   `http://localhost:4004/destination-drift/webapp/index.html`.
4. Click **BTP Login**, complete SSO in the browser tab that opens, pick your
   global account, then select two or more subaccounts to compare.

## Deployment (Cloud Foundry)

`manifest.yml` deploys two apps: the CAP backend (`nodejs_buildpack`) and a
standalone `@sap/approuter` with `authenticationType: none` (public, no
XSUAA — see `approuter/xs-app.json` and `package.json`'s
`cds.requires.auth.kind: "dummy"`). The `btp` CLI Linux binary is vendored
into `bin/` (not committed — see `.gitignore`) and referenced via
`BTP_CLI_PATH` in `manifest.yml`.

```
cf push
```

## Transport safety

- Transport requires explicit confirmation in the UI; the backend also
  refuses to write without `confirmed:true`.
- If a sensitive field (password/secret) appears masked at the source, the
  user is warned to verify it manually at the target after transport.
- Every transport attempt (success/failure) is recorded in `TransportLog`.
- `Subaccounts.clientSecret` is never readable via the API (write-only).

## Known limitations

- Each browser session gets its own isolated `btp` CLI identity and DB rows
  (see `srv/lib/session.cts`), so concurrent users never share a login.
- `clientSecret` is stored as plain text in SQLite (fine for an internal
  tool; use a proper secret store for production-grade multi-tenant use).
- Instance-scoped destination comparison (`srv/lib/btp-cli.cts`'s
  `listDestinationServiceInstanceNames`) only covers destination-service
  instances created natively via Service Manager (`btp create
  services/instance`). Instances created via Cloud Foundry (`cf
  create-service`) are listed but can't be bound via `btp create
  services/binding` ("NotFound", even by instance ID) — they'd need `cf
  create-service-key` instead, which isn't wired up yet. Such instances are
  skipped rather than failing the whole comparison.
