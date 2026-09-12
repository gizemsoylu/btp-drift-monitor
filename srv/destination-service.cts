import type { Subaccount, FetchDestinationsResult } from "./lib/types.cts";
import type { InstanceKey } from "./lib/config.cts";
const cds = require("@sap/cds");
const { loadSubaccounts, loadInstanceKey, loadInstanceKeysForLabels } = require("./lib/config.cts");
const {
  fetchAllDestinations,
  fetchDestinations,
  fetchInstanceDestinations,
  fetchAllInstanceDestinations,
  hasMaskedSensitiveField,
  pushDestination,
  pushInstanceDestination,
} = require("./lib/destination-client.cts");
const { buildDriftRows } = require("./lib/drift.cts");
const btpCli = require("./lib/btp-cli.cts");
const { getSessionId } = require("./lib/session.cts");

const DbSubaccounts = "btp.drift.Subaccounts";
const DbInstanceKeys = "btp.drift.DestinationServiceInstanceKeys";
const DbTransportLog = "btp.drift.TransportLog"; // write directly to the DB entity to bypass @readonly on the service projection

interface RawHttpRequest {
  headers: { cookie?: string };
}

interface RawHttpResponse {
  setHeader(name: string, value: string): void;
}

/** The raw Express req/res CAP exposes on every request — used only to read/set the session cookie. */
interface RawHttp {
  req: RawHttpRequest;
  res: RawHttpResponse;
}

/** The minimal shape of a CAP request this service actually reads/calls — @sap/cds ships no public types. */
interface CdsRequest<TData = Record<string, unknown>> {
  data: TData;
  error(code: number, message: string): void;
  query?: { SELECT?: { where?: unknown[] } };
  http?: RawHttp;
  _?: RawHttp;
}

/**
 * Resolves the calling browser session's isolated id (minting + cookie-ing a new one on first
 * contact) — every `btp` CLI call and every DB row for this request is scoped to it, so two people
 * using this app at once never share a `btp login` identity or see each other's subaccounts.
 */
function sessionIdFrom<TData>(req: CdsRequest<TData>): string {
  const http = req.http || req._;
  if (!http) throw new Error("No HTTP context available for this request.");
  return getSessionId(http.req, http.res);
}

interface SubaccountDbRow {
  label: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string | null;
  apiUrl: string;
}

interface DriftRowOut {
  destinationName: string;
  subaccount: string;
  present: boolean;
  hasDrift: boolean;
  [key: string]: unknown;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Walks a CQN WHERE token array/tree (as produced by `subaccount eq 'A' or subaccount eq 'B'`)
 * and returns every literal value directly compared against the "subaccount" column.
 */
function extractSubaccountFilterLabels(where: unknown): string[] {
  const labels: string[] = [];
  if (!Array.isArray(where)) return labels;

  for (let i = 0; i < where.length; i++) {
    const token = where[i] as { ref?: string[]; xpr?: unknown[] } | undefined;
    if (token?.ref && token.ref[token.ref.length - 1] === "subaccount" && where[i + 1] === "=") {
      const valueToken = where[i + 2] as { val?: unknown } | undefined;
      if (valueToken && "val" in valueToken) labels.push(String(valueToken.val));
    }
    if (token && Array.isArray(token.xpr)) {
      labels.push(...extractSubaccountFilterLabels(token.xpr));
    }
  }
  return labels;
}

// cds.service.impl's `this` is a live CAP runtime object (entities attached dynamically, no
// public types shipped by @sap/cds) — this is the one deliberate framework-boundary exception;
// every request/row/error value handled inside is typed explicitly below.
module.exports = cds.service.impl(async function (this: any) {
  const { DriftRows, Subaccounts, TransportLog } = this.entities;
  const db = await cds.connect.to("db");

  function findSubaccount(all: Subaccount[], label: string): Subaccount | undefined {
    return all.find((s) => s.label === label);
  }

  // clientSecret is only ever set via addSubaccountFromServiceKey (raw DB write) — never echoed back.
  this.after("READ", Subaccounts, (rows: SubaccountDbRow | SubaccountDbRow[]) => {
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      if (r && "clientSecret" in r) r.clientSecret = null;
    }
  });

  // Subaccounts/TransportLog rows belong to one browser session — never let a generic READ (e.g.
  // a plain GET on the entity set) leak another session's rows, regardless of any other $filter.
  function scopeToSession(req: CdsRequest): void {
    const sessionId = sessionIdFrom(req);
    const query = req.query as { SELECT?: { where?: unknown[] } } | undefined;
    if (!query?.SELECT) return;
    const sessionClause = [{ ref: ["sessionId"] }, "=", { val: sessionId }];
    query.SELECT.where = query.SELECT.where && query.SELECT.where.length > 0 ? [...query.SELECT.where, "and", ...sessionClause] : sessionClause;
  }
  this.before("READ", Subaccounts, scopeToSession);
  this.before("READ", TransportLog, scopeToSession);

  this.on("addSubaccountFromServiceKey", async (req: CdsRequest<{ label: string; serviceKeyJson: string }>) => {
    const sessionId = sessionIdFrom(req);
    const { label, serviceKeyJson } = req.data;
    if (!label) {
      req.error(400, 'A label is required (e.g. "dev", "qa", "prod").');
      return;
    }

    let key: { url?: string; clientid?: string; clientsecret?: string; uri?: string };
    try {
      key = JSON.parse(serviceKeyJson);
    } catch {
      req.error(400, "The service key is not valid JSON. Paste the full JSON downloaded from the Destination service key.");
      return;
    }

    const tokenUrl = key.url;
    const clientId = key.clientid;
    const clientSecret = key.clientsecret;
    const apiUrl = key.uri;
    if (!tokenUrl || !clientId || !clientSecret || !apiUrl) {
      req.error(400, 'The service key JSON must contain "url", "clientid", "clientsecret" and "uri".');
      return;
    }

    const existing = await db.run(SELECT.one.from(DbSubaccounts).where({ label, sessionId }));
    if (existing) {
      req.error(400, `A subaccount labeled "${label}" already exists.`);
      return;
    }

    await db.run(INSERT.into(DbSubaccounts).entries({ sessionId, label, tokenUrl, clientId, clientSecret, apiUrl }));
    const row = await db.run(SELECT.one.from(DbSubaccounts).where({ label, sessionId }));
    return { ...row, clientSecret: null };
  });

  this.on("READ", DriftRows, async (req: CdsRequest) => {
    const sessionId = sessionIdFrom(req);
    let subaccounts = await loadSubaccounts(sessionId);

    // DriftRows is @cds.persistence.skip (computed live from the Destination API), so CAP's
    // automatic $filter post-processing on a plain-array handler result isn't reliable here —
    // apply the "subaccount eq '...'" filter ourselves so a query for two labels never drags in
    // every other registered subaccount's (possibly a different global account's) destinations.
    const requestedLabels = extractSubaccountFilterLabels(req.query?.SELECT?.where);
    if (requestedLabels.length > 0) {
      subaccounts = subaccounts.filter((s: Subaccount) => requestedLabels.includes(s.label));
    }

    const results: FetchDestinationsResult[] = await fetchAllDestinations(subaccounts);

    // Instance-scoped destinations: every "destination"-offering service instance (other than our
    // own monitoring one) found in these subaccounts also gets its own instance-scoped comparison,
    // so a destination only visible to apps bound to a specific instance isn't missed.
    const instanceKeys: InstanceKey[] = await loadInstanceKeysForLabels(
      sessionId,
      subaccounts.map((s: Subaccount) => s.label)
    );
    const instanceResults: FetchDestinationsResult[] = await fetchAllInstanceDestinations(
      instanceKeys.map((k) => ({ label: k.label, instanceName: k.instanceName, creds: k }))
    );

    const rows: DriftRowOut[] = buildDriftRows([...results, ...instanceResults]);
    return rows.map((r) => ({ ...r, driftCriticality: r.hasDrift ? 1 : 3 })); // 1=Negative(red), 3=Positive(green)
  });

  // TransportLog is read from real SQLite persistency (node:sqlite); fill in the virtual resultCriticality field.
  this.after("READ", TransportLog, (rows: { result: string; resultCriticality?: number } | { result: string; resultCriticality?: number }[]) => {
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      if (r) r.resultCriticality = r.result === "success" ? 3 : 1;
    }
  });

  interface TransportRequestData {
    destinationName: string;
    /** Set when the destination is instance-scoped (belongs to one Destination service instance) rather than subaccount-wide. */
    instanceName?: string;
    sourceSubaccount: string;
    targetSubaccount: string;
    /** The target's real BTP subaccount id (GUID) — only needed when instanceName's instance must be auto-provisioned at the target. */
    targetSubaccountId?: string;
    confirmed: boolean;
  }

  this.on("transportDestination", async (req: CdsRequest<TransportRequestData>) => {
    const sessionId = sessionIdFrom(req);
    const { destinationName, instanceName, sourceSubaccount, targetSubaccount, targetSubaccountId, confirmed } = req.data;
    const subaccounts = await loadSubaccounts(sessionId);
    const sourceRegistered = findSubaccount(subaccounts, sourceSubaccount);
    const targetRegistered = findSubaccount(subaccounts, targetSubaccount);

    if (!sourceRegistered || !targetRegistered) {
      req.error(400, "Invalid source or target subaccount.");
      return;
    }
    if (sourceSubaccount === targetSubaccount) {
      req.error(400, "Source and target subaccount cannot be the same.");
      return;
    }
    if (!confirmed) {
      req.error(400, "Transport requires confirmation (confirmed:true).");
      return;
    }

    let source: Subaccount = sourceRegistered;
    let target: Subaccount = targetRegistered;
    let fetchOne: (creds: Subaccount) => Promise<{ destinations: { Name: string }[] }>;
    let pushOne: (creds: Subaccount, dest: { Name: string }) => Promise<void>;

    if (instanceName) {
      const sourceInstance = await loadInstanceKey(sessionId, sourceSubaccount, instanceName);
      if (!sourceInstance) {
        req.error(404, `Destination service instance "${instanceName}" was not found for "${sourceSubaccount}".`);
        return;
      }
      source = sourceInstance;

      let targetInstance = await loadInstanceKey(sessionId, targetSubaccount, instanceName);
      if (!targetInstance) {
        if (!targetSubaccountId) {
          req.error(400, "targetSubaccountId is required to auto-provision a missing destination service instance.");
          return;
        }
        let newCredentials;
        try {
          newCredentials = await btpCli.ensureInstanceScopedServiceKey(sessionId, targetSubaccountId, instanceName);
        } catch (e: unknown) {
          req.error(500, `Could not provision destination service instance "${instanceName}" in "${targetSubaccount}": ${errorMessage(e)}`);
          return;
        }
        await db.run(INSERT.into(DbInstanceKeys).entries({ sessionId, subaccountLabel: targetSubaccount, instanceName, ...newCredentials }));
        targetInstance = { label: targetSubaccount, instanceName, ...newCredentials };
      }
      target = targetInstance;

      fetchOne = (creds) => fetchInstanceDestinations(sourceSubaccount, instanceName, creds);
      pushOne = pushInstanceDestination;
    } else {
      fetchOne = fetchDestinations;
      pushOne = pushDestination;
    }

    const sourceResult = await fetchOne(source);
    const dest = sourceResult.destinations.find((d: { Name: string }) => d.Name === destinationName);
    if (!dest) {
      req.error(404, `"${destinationName}" was not found in the source subaccount.`);
      return;
    }

    const masked = hasMaskedSensitiveField(dest);
    try {
      await pushOne(target, dest);
      await db.run(INSERT.into(DbTransportLog).entries({ sessionId, destinationName, sourceSubaccount, targetSubaccount, result: "success", detail: "" }));
      return {
        ok: true,
        warning: masked
          ? "A sensitive field (password/secret) appeared masked at the source — verify it manually at the target."
          : null,
      };
    } catch (e: unknown) {
      const detail = errorMessage(e);
      await db.run(INSERT.into(DbTransportLog).entries({ sessionId, destinationName, sourceSubaccount, targetSubaccount, result: "failure", detail }));
      req.error(500, detail);
    }
  });

  this.on("checkBtpSession", async (req: CdsRequest) => btpCli.checkSession(sessionIdFrom(req)));

  this.on("btpLoginStart", async (req: CdsRequest<{ url?: string; subdomain?: string }>) => {
    const sessionId = sessionIdFrom(req);
    if (await btpCli.isLoggedIn(sessionId)) {
      btpCli.markAlreadyLoggedIn(sessionId);
      return { message: "Already logged in." };
    }
    btpCli.startLogin(sessionId, req.data.url || "https://cli.btp.cloud.sap", req.data.subdomain);
    return { message: "Login started — check your browser to complete SSO." };
  });

  this.on("btpLoginStatus", async (req: CdsRequest) => {
    const { status, log, ssoUrl, globalAccounts } = btpCli.getLoginState(sessionIdFrom(req));
    return { status, log, ssoUrl, globalAccounts };
  });

  this.on("btpChooseGlobalAccount", async (req: CdsRequest<{ optionNumber: number }>) => {
    try {
      btpCli.chooseGlobalAccount(sessionIdFrom(req), req.data.optionNumber);
    } catch (e: unknown) {
      req.error(400, errorMessage(e));
      return;
    }
    return { message: "Choice sent." };
  });

  this.on("btpLogout", async (req: CdsRequest) => {
    try {
      btpCli.logout(sessionIdFrom(req));
    } catch (e: unknown) {
      req.error(500, errorMessage(e));
      return;
    }
    return { message: "Logged out." };
  });

  this.on("btpSwitchAccountStart", async (req: CdsRequest) => {
    btpCli.startAccountSwitch(sessionIdFrom(req));
    return { message: "Switch started." };
  });

  this.on("btpSwitchAccountStatus", async (req: CdsRequest) => {
    const { status, log, globalAccounts } = btpCli.getSwitchState(sessionIdFrom(req));
    return { status, log, globalAccounts };
  });

  this.on("btpChooseSwitchAccount", async (req: CdsRequest<{ optionNumber: number }>) => {
    try {
      btpCli.chooseSwitchAccount(sessionIdFrom(req), req.data.optionNumber);
    } catch (e: unknown) {
      req.error(400, errorMessage(e));
      return;
    }
    return { message: "Choice sent." };
  });

  this.on("listBtpSubaccounts", async (req: CdsRequest) => {
    const sessionId = sessionIdFrom(req);
    if (!(await btpCli.isLoggedIn(sessionId))) {
      req.error(400, "Not logged in to BTP yet — run the login step first.");
      return;
    }
    try {
      return await btpCli.listSubaccounts(sessionId);
    } catch (e: unknown) {
      req.error(500, `Could not list subaccounts: ${errorMessage(e)}`);
    }
  });

  this.on("registerBtpSubaccountStart", (req: CdsRequest<{ subaccountId: string }>) => {
    const { subaccountId } = req.data;
    if (!subaccountId) {
      req.error(400, "subaccountId is required.");
      return;
    }
    btpCli.startProvisioning(sessionIdFrom(req), subaccountId);
    return { message: "Provisioning started." };
  });

  this.on("registerBtpSubaccountStatus", async (req: CdsRequest<{ subaccountId: string; displayName?: string; label?: string }>) => {
    const sessionId = sessionIdFrom(req);
    const { subaccountId, displayName, label: labelInput } = req.data;
    if (!subaccountId) {
      req.error(400, "subaccountId is required.");
      return;
    }
    const state = btpCli.getProvisioningState(sessionId, subaccountId);
    if (state.status !== "success") {
      return { status: state.status, error: state.error || null };
    }

    const label = labelInput || displayName || subaccountId;
    const credentials = state.credentials;
    if (!credentials) {
      req.error(500, "Provisioning reported success but returned no credentials.");
      return;
    }
    const existing = await db.run(SELECT.one.from(DbSubaccounts).where({ label, sessionId }));
    if (existing) {
      await db.run(UPDATE(DbSubaccounts).set(credentials).where({ label, sessionId }));
    } else {
      await db.run(INSERT.into(DbSubaccounts).entries({ sessionId, label, ...credentials }));
    }

    // Persist a key for every customer-owned destination-service instance discovered alongside
    // the subaccount-wide one, so their instance-scoped destinations can be compared too.
    interface ProvisionedInstance {
      name: string;
      credentials: { tokenUrl: string; clientId: string; clientSecret: string; apiUrl: string };
    }
    for (const inst of (state.instances || []) as ProvisionedInstance[]) {
      const existingInstance = await db.run(
        SELECT.one.from(DbInstanceKeys).where({ sessionId, subaccountLabel: label, instanceName: inst.name })
      );
      if (existingInstance) {
        await db.run(UPDATE(DbInstanceKeys).set(inst.credentials).where({ sessionId, subaccountLabel: label, instanceName: inst.name }));
      } else {
        await db.run(INSERT.into(DbInstanceKeys).entries({ sessionId, subaccountLabel: label, instanceName: inst.name, ...inst.credentials }));
      }
    }

    return { status: "success", error: null };
  });

  this.on("listServiceInstances", async (req: CdsRequest<{ subaccountId: string }>) => {
    const { subaccountId } = req.data;
    if (!subaccountId) {
      req.error(400, "subaccountId is required.");
      return;
    }
    try {
      return await btpCli.listServiceInstances(sessionIdFrom(req), subaccountId);
    } catch (e: unknown) {
      req.error(500, `Could not list service instances: ${errorMessage(e)}`);
    }
  });
});
