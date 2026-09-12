import type {
  BtpGlobalAccountOption,
  BtpLoginState,
  BtpSubaccountInfo,
  BtpSwitchState,
  DestinationServiceCredentials,
  ServiceInstanceInfo,
} from "./types.cts";
const { spawn, spawnSync } = require("child_process");
const { BTP_EXE } = require("./btp-exe.cts");
const { getSessionConfigPath } = require("./session.cts");

const INSTANCE_NAME = "btp-drift-monitor-dest";
const BINDING_NAME = "btp-drift-monitor-dest-key";

type ChildProcessWithoutNullStreams = import("child_process").ChildProcessWithoutNullStreams;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const SSO_URL_PATTERN = /Please authenticate at:\s*(https:\/\/\S+)/;
const MENU_PATTERN = /Choose a global account:\n([\s\S]*?)\nChoose option>\s*$/;
const MENU_ITEM_PATTERN = /\[(\d+)\]\s+(.+)/g;

/** Per-browser-session login state — every session gets its own `btp login`, never shared. */
interface LoginSession {
  state: BtpLoginState;
  child: ChildProcessWithoutNullStreams | null;
  choosingAnswered: boolean;
}

const loginSessions = new Map<string, LoginSession>();

function getLoginSession(sessionId: string): LoginSession {
  let session = loginSessions.get(sessionId);
  if (!session) {
    session = { state: { status: "idle", log: "", ssoUrl: "", globalAccounts: [] }, child: null, choosingAnswered: false };
    loginSessions.set(sessionId, session);
  }
  return session;
}

function appendLog(session: LoginSession, chunk: Buffer | string): void {
  session.state.log = (session.state.log + chunk.toString()).slice(-6000);
  const plain = session.state.log.replace(ANSI_PATTERN, "");

  if (!session.state.ssoUrl) {
    const match = plain.match(SSO_URL_PATTERN);
    if (match) session.state.ssoUrl = match[1];
  }

  // `btp login` prints a numbered "Choose a global account:" menu once, then waits at
  // "Choose option> " for a number when the account is ambiguous — parse it into options.
  if (!session.choosingAnswered) {
    const menuMatch = plain.match(MENU_PATTERN);
    if (menuMatch) {
      const options: BtpGlobalAccountOption[] = [];
      for (const m of menuMatch[1].matchAll(MENU_ITEM_PATTERN)) {
        options.push({ number: Number(m[1]), name: m[2].trim() });
      }
      if (options.length > 0) {
        session.state.globalAccounts = options;
        session.state.status = "choosing";
      }
    }
  }
}

/** Starts `btp login --sso` in the background, isolated to this session's own CLI config file. */
function startLogin(sessionId: string, url: string, subdomain?: string | null): BtpLoginState {
  const session = getLoginSession(sessionId);
  if (session.state.status === "running") return session.state;

  session.state.status = "running";
  session.state.log = "";
  session.state.ssoUrl = "";
  session.state.globalAccounts = [];
  session.choosingAnswered = false;

  const configPath = getSessionConfigPath(sessionId);
  const args = ["--config", configPath, "login", "--url", url];
  if (subdomain) args.push("--subdomain", subdomain);
  args.push("--sso", "manual");

  const child = spawn(BTP_EXE, args, { stdio: ["pipe", "pipe", "pipe"] });
  session.child = child;

  child.stdout.on("data", (chunk: Buffer) => appendLog(session, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendLog(session, chunk));
  child.on("close", (code: number) => {
    session.state.status = code === 0 ? "success" : "error";
    session.child = null;
  });
  child.on("error", (err: Error) => {
    session.state.status = "error";
    appendLog(session, `\n${err.message}`);
    session.child = null;
  });

  return session.state;
}

function getLoginState(sessionId: string): BtpLoginState {
  return getLoginSession(sessionId).state;
}

/** Answers the "Choose a global account>" prompt by writing the chosen number to the CLI's stdin. */
function chooseGlobalAccount(sessionId: string, optionNumber: number): void {
  const session = getLoginSession(sessionId);
  if (!session.child || session.state.status !== "choosing") {
    throw new Error("There is no pending global account choice.");
  }
  session.choosingAnswered = true;
  session.state.status = "running";
  session.state.globalAccounts = [];
  session.child.stdin.write(`${optionNumber}\n`);
}

/** Logs this session's CLI session out (e.g. before switching to a different global account). */
function logout(sessionId: string): void {
  const configPath = getSessionConfigPath(sessionId);
  const result = spawnSync(BTP_EXE, ["--config", configPath, "logout"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (result.error) throw new Error(result.error.message);

  const session = getLoginSession(sessionId);
  session.state.status = "idle";
  session.state.log = "";
  session.state.ssoUrl = "";
  session.state.globalAccounts = [];
}

/** Short-circuits the login UI straight to "success" when this session's CLI session is already valid. */
function markAlreadyLoggedIn(sessionId: string): void {
  const session = getLoginSession(sessionId);
  session.state.status = "success";
  session.state.log = "Already logged in.";
  session.state.ssoUrl = "";
  session.state.globalAccounts = [];
}

/** Per-browser-session account-switch state (`btp target --hierarchy`) — isolated the same way as login. */
interface SwitchSession {
  state: BtpSwitchState;
  child: ChildProcessWithoutNullStreams | null;
  answered: boolean;
}

const switchSessions = new Map<string, SwitchSession>();

function getSwitchSession(sessionId: string): SwitchSession {
  let session = switchSessions.get(sessionId);
  if (!session) {
    session = { state: { status: "idle", log: "", globalAccounts: [] }, child: null, answered: false };
    switchSessions.set(sessionId, session);
  }
  return session;
}

// The trailing prompt varies ("Choose option> " on a fresh login, but "Choose, or hit ENTER to
// stay in '<current>' [<default>]> " for `target --hierarchy`) — just require the whole output
// ends with a line that ends in "> " once the menu header has appeared.
const SWITCH_MENU_PATTERN = /Choose global account, subaccount, or directory:\n([\s\S]*?)\n[^\n]*>\s*$/;
const SWITCH_ITEM_PATTERN = /\[(\d+)\]\s+(.+?)\s*\(global account\)/g;

function appendSwitchLog(session: SwitchSession, chunk: Buffer | string): void {
  session.state.log = (session.state.log + chunk.toString()).slice(-100000);
  const plain = session.state.log.replace(ANSI_PATTERN, "");

  if (!session.answered) {
    const menuMatch = plain.match(SWITCH_MENU_PATTERN);
    if (menuMatch) {
      const options: BtpGlobalAccountOption[] = [];
      for (const m of menuMatch[1].matchAll(SWITCH_ITEM_PATTERN)) {
        options.push({ number: Number(m[1]), name: m[2].trim() });
      }
      if (options.length > 0) {
        session.state.globalAccounts = options;
        session.state.status = "choosing";
      }
    }
  }
}

/** Starts `btp target --hierarchy` in the background — switches global account without logging out. */
function startAccountSwitch(sessionId: string): BtpSwitchState {
  const session = getSwitchSession(sessionId);
  if (session.state.status === "running" || session.state.status === "choosing") return session.state;

  session.state.status = "running";
  session.state.log = "";
  session.state.globalAccounts = [];
  session.answered = false;

  const configPath = getSessionConfigPath(sessionId);
  const child = spawn(BTP_EXE, ["--config", configPath, "target", "--hierarchy"], { stdio: ["pipe", "pipe", "pipe"] });
  session.child = child;

  child.stdout.on("data", (chunk: Buffer) => appendSwitchLog(session, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendSwitchLog(session, chunk));
  child.on("close", (code: number) => {
    session.state.status = code === 0 ? "success" : "error";
    session.child = null;
  });
  child.on("error", (err: Error) => {
    session.state.status = "error";
    appendSwitchLog(session, `\n${err.message}`);
    session.child = null;
  });

  return session.state;
}

function getSwitchState(sessionId: string): BtpSwitchState {
  return getSwitchSession(sessionId).state;
}

/** Answers the "Choose global account, subaccount, or directory>" prompt with the chosen number. */
function chooseSwitchAccount(sessionId: string, optionNumber: number): void {
  const session = getSwitchSession(sessionId);
  if (!session.child || session.state.status !== "choosing") {
    throw new Error("There is no pending global account choice.");
  }
  session.answered = true;
  session.state.status = "running";
  session.state.globalAccounts = [];
  session.child.stdin.write(`${optionNumber}\n`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A `btp list ...` JSON response — either a bare array, or an object wrapping one under a known key. */
type BtpListResponse<T> = T[] | { value?: T[]; [otherKey: string]: T[] | undefined };

function toArray<T>(response: BtpListResponse<T>, ...wrapperKeys: string[]): T[] {
  if (Array.isArray(response)) return response;
  for (const key of ["value", ...wrapperKeys]) {
    const candidate = response[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

interface BtpGlobalAccountRaw {
  displayName?: string;
  subdomain?: string;
}

interface BtpSubaccountRaw {
  guid?: string;
  id?: string;
  subaccountGUID?: string;
  displayName?: string;
  display_name?: string;
  name?: string;
  subdomain?: string;
  region?: string;
  dataCenter?: string;
}

interface BtpServiceInstanceRaw {
  name: string;
  service_plan_id?: string;
  ready?: boolean;
}

interface BtpServiceBindingCredentials {
  url: string;
  clientid: string;
  clientsecret: string;
  uri: string;
}

/** Runs a `btp` command synchronously, isolated to this session's CLI config, and parses its `--format json` output. */
function runBtpJson<T>(sessionId: string, args: string[], { timeout = 60000 }: { timeout?: number } = {}): T {
  const configPath = getSessionConfigPath(sessionId);
  // --format is a global OPTION and must precede the ACTION (e.g. `btp --config ... --format json get ...`).
  const result = spawnSync(BTP_EXE, ["--config", configPath, "--format", "json", ...args], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `btp ${args.join(" ")} failed`).trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Could not parse btp CLI output as JSON: ${result.stdout.slice(0, 500)}`);
  }
}

/**
 * Runs a `btp` command asynchronously (non-blocking — unlike runBtpJson's spawnSync, this keeps
 * the Node event loop free to answer other requests, e.g. status polling, while it runs), isolated
 * to this session's CLI config. Used for the service instance/binding create calls, which can take
 * long enough that a synchronous wait would risk a platform router timing the whole request out.
 */
function runBtpJsonAsync<T>(sessionId: string, args: string[], { timeoutMs = 170000 }: { timeoutMs?: number } = {}): Promise<T> {
  const configPath = getSessionConfigPath(sessionId);
  return new Promise((resolve, reject) => {
    const child = spawn(BTP_EXE, ["--config", configPath, "--format", "json", ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`btp ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `btp ${args.join(" ")} failed`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Could not parse btp CLI output as JSON: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

/** True once this session's `btp login` has succeeded and the CLI session is still valid. */
async function isLoggedIn(sessionId: string): Promise<boolean> {
  try {
    runBtpJson<BtpGlobalAccountRaw>(sessionId, ["get", "accounts/global-account"]);
    return true;
  } catch {
    return false;
  }
}

/** Non-interactive session check — never spawns a login, just probes this session's existing CLI session. */
async function checkSession(sessionId: string): Promise<{ loggedIn: boolean; globalAccountName: string }> {
  try {
    const account = runBtpJson<BtpGlobalAccountRaw>(sessionId, ["get", "accounts/global-account"]);
    return { loggedIn: true, globalAccountName: account.displayName || account.subdomain || "" };
  } catch {
    return { loggedIn: false, globalAccountName: "" };
  }
}

async function listSubaccounts(sessionId: string): Promise<BtpSubaccountInfo[]> {
  const result = runBtpJson<BtpListResponse<BtpSubaccountRaw>>(sessionId, ["list", "accounts/subaccount"]);
  const rows = toArray(result, "subaccounts");
  return rows.map((r) => ({
    id: r.guid || r.id || r.subaccountGUID || "",
    displayName: r.displayName || r.display_name || r.name || r.guid || "",
    subdomain: r.subdomain || "",
    region: r.region || r.dataCenter || "",
  }));
}

/** Lists the service instances in a subaccount (compared by name/plan for the Service Instances tab). */
async function listServiceInstances(sessionId: string, subaccountId: string): Promise<ServiceInstanceInfo[]> {
  const result = runBtpJson<BtpListResponse<BtpServiceInstanceRaw>>(sessionId, ["list", "services/instance", "--subaccount", subaccountId]);
  const rows = toArray(result, "instances");
  return rows.map((r) => ({
    name: r.name,
    planId: r.service_plan_id || "",
    ready: !!r.ready,
  }));
}

/** Recursively searches a parsed JSON object for a nested object containing the Destination service key fields. */
function findCredentials(node: unknown): BtpServiceBindingCredentials | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (["clientid", "clientsecret", "url", "uri"].every((k) => keys.includes(k))) {
    return obj as unknown as BtpServiceBindingCredentials;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findCredentials(v);
      if (found) return found;
    }
  }
  return null;
}

/** Derives a stable, unique-enough binding name for a given destination-service instance's own key. */
function bindingNameForInstance(instanceName: string): string {
  return `${instanceName}-bdmkey`.slice(0, 120);
}

/**
 * Ensures a "destination"-offering service instance (named `instanceName`) + a binding (named
 * `bindingName`) for it exist in the given subaccount (idempotent: reuses them if a previous run
 * already created them), and returns the service-key credentials. Runs entirely under the calling
 * session's own `btp` CLI identity.
 */
async function ensureServiceKeyForInstance(
  sessionId: string,
  subaccountId: string,
  instanceName: string,
  bindingName: string
): Promise<DestinationServiceCredentials> {
  interface ServiceInstanceListItem {
    name: string;
  }
  interface ServiceBindingListItem {
    name: string;
  }

  let instances: BtpListResponse<ServiceInstanceListItem>;
  try {
    instances = await runBtpJsonAsync<BtpListResponse<ServiceInstanceListItem>>(sessionId, [
      "list",
      "services/instance",
      "--subaccount",
      subaccountId,
    ]);
  } catch (e: unknown) {
    throw new Error(`Could not list service instances: ${errorMessage(e)}`);
  }
  const instanceRows = toArray(instances);
  const instance = instanceRows.find((i) => i.name === instanceName);

  if (!instance) {
    try {
      await runBtpJsonAsync(sessionId, [
        "create",
        "services/instance",
        "--subaccount",
        subaccountId,
        "--offering-name",
        "destination",
        "--plan-name",
        "lite",
        "--name",
        instanceName,
        "--wait",
        "2m",
      ]);
    } catch (e: unknown) {
      throw new Error(`Could not create a destination service instance: ${errorMessage(e)}`);
    }
  }

  let bindings: BtpListResponse<ServiceBindingListItem>;
  try {
    bindings = await runBtpJsonAsync<BtpListResponse<ServiceBindingListItem>>(sessionId, ["list", "services/binding", "--subaccount", subaccountId]);
  } catch (e: unknown) {
    throw new Error(`Could not list service bindings: ${errorMessage(e)}`);
  }
  const bindingRows = toArray(bindings);
  const binding = bindingRows.find((b) => b.name === bindingName);

  if (!binding) {
    try {
      await runBtpJsonAsync(sessionId, [
        "create",
        "services/binding",
        "--subaccount",
        subaccountId,
        "--name",
        bindingName,
        "--instance-name",
        instanceName,
        "--wait",
        "2m",
      ]);
    } catch (e: unknown) {
      throw new Error(`Could not create a service binding: ${errorMessage(e)}`);
    }
  }

  let bindingDetail: unknown;
  try {
    bindingDetail = await runBtpJsonAsync<unknown>(sessionId, ["get", "services/binding", "--subaccount", subaccountId, "--name", bindingName]);
  } catch (e: unknown) {
    throw new Error(`Could not read the service binding credentials: ${errorMessage(e)}`);
  }

  const credentials = findCredentials(bindingDetail);
  if (!credentials) {
    throw new Error("The service binding did not contain Destination service credentials (url/clientid/clientsecret/uri).");
  }

  return {
    tokenUrl: credentials.url,
    clientId: credentials.clientid,
    clientSecret: credentials.clientsecret,
    apiUrl: credentials.uri,
  };
}

/** Ensures/reads the credentials for this app's own subaccount-wide monitoring instance. */
async function ensureDestinationServiceKey(sessionId: string, subaccountId: string): Promise<DestinationServiceCredentials> {
  return ensureServiceKeyForInstance(sessionId, subaccountId, INSTANCE_NAME, BINDING_NAME);
}

/**
 * Ensures/reads the credentials for one specific (customer-owned) destination-service instance's
 * own instance-scoped destinations — creating the instance itself (plan "lite") if the target
 * subaccount doesn't have one by that name yet, e.g. when transporting into a subaccount that
 * never had this instance provisioned.
 */
async function ensureInstanceScopedServiceKey(sessionId: string, subaccountId: string, instanceName: string): Promise<DestinationServiceCredentials> {
  return ensureServiceKeyForInstance(sessionId, subaccountId, instanceName, bindingNameForInstance(instanceName));
}

interface BtpServicePlanRaw {
  id: string;
  service_offering_id: string;
}

interface BtpServiceOfferingRaw {
  id: string;
  name: string;
}

// Offering catalog metadata (plan -> offering -> name) is environment/catalog data, not
// session- or subaccount-specific — safe to cache across all sessions for the process lifetime.
const offeringNameByPlanId = new Map<string, string>();

async function resolveOfferingName(sessionId: string, subaccountId: string, planId: string): Promise<string> {
  const cached = offeringNameByPlanId.get(planId);
  if (cached !== undefined) return cached;

  const plan = await runBtpJsonAsync<BtpServicePlanRaw>(sessionId, ["get", "services/plan", planId, "--subaccount", subaccountId]);
  const offering = await runBtpJsonAsync<BtpServiceOfferingRaw>(sessionId, ["get", "services/offering", plan.service_offering_id, "--subaccount", subaccountId]);
  offeringNameByPlanId.set(planId, offering.name);
  return offering.name;
}

/**
 * Lists the names of every "destination"-offering service instance in a subaccount, excluding
 * this app's own monitoring instance — these are the customer's own destination-service instances
 * whose instance-scoped destinations should be compared alongside the subaccount-wide ones.
 *
 * Note: instances created via Cloud Foundry (`cf create-service`) are listed here too, but
 * `ensureInstanceScopedServiceKey`'s `btp create services/binding` call cannot bind to them
 * ("NotFound: service instance not found or not accessible", even by instance ID) — only
 * `cf create-service-key` can. Those instances are silently skipped in startProvisioning rather
 * than failing the whole subaccount; only service-manager-native instances get compared for now.
 */
async function listDestinationServiceInstanceNames(sessionId: string, subaccountId: string): Promise<string[]> {
  const result = await runBtpJsonAsync<BtpListResponse<BtpServiceInstanceRaw>>(sessionId, ["list", "services/instance", "--subaccount", subaccountId]);
  const rows = toArray(result);

  const uniquePlanIds = [...new Set(rows.map((r) => r.service_plan_id).filter((id): id is string => !!id))];
  const destinationPlanIds = new Set<string>();
  for (const planId of uniquePlanIds) {
    try {
      const offeringName = await resolveOfferingName(sessionId, subaccountId, planId);
      if (offeringName === "destination") destinationPlanIds.add(planId);
    } catch {
      // If we can't resolve this plan's offering, just skip it rather than failing the whole scan.
    }
  }

  return rows.filter((r) => r.service_plan_id && destinationPlanIds.has(r.service_plan_id) && r.name !== INSTANCE_NAME).map((r) => r.name);
}

interface ProvisionedInstance {
  name: string;
  credentials: DestinationServiceCredentials;
}

interface ProvisioningState {
  status: "running" | "success" | "error";
  error?: string;
  /** The subaccount-wide monitoring instance's credentials. */
  credentials?: DestinationServiceCredentials;
  /** Every customer-owned "destination"-offering instance found in the subaccount, with its own instance-scoped credentials. */
  instances?: ProvisionedInstance[];
}

/** Keyed by `${sessionId}::${subaccountId}` — two sessions provisioning the same subaccount never collide. */
const provisioningJobs = new Map<string, ProvisioningState>();

function provisioningKey(sessionId: string, subaccountId: string): string {
  return `${sessionId}::${subaccountId}`;
}

/**
 * Starts (or returns the existing) background provisioning job for a subaccount — never blocks the
 * caller. Provisions this app's own subaccount-wide monitoring instance, then discovers every other
 * "destination"-offering instance in the subaccount and provisions a key for each of those too, so
 * their instance-scoped destinations can be compared alongside the subaccount-wide ones.
 */
function startProvisioning(sessionId: string, subaccountId: string): ProvisioningState {
  const key = provisioningKey(sessionId, subaccountId);
  const existing = provisioningJobs.get(key);
  if (existing && existing.status === "running") return existing;

  const state: ProvisioningState = { status: "running" };
  provisioningJobs.set(key, state);

  (async () => {
    const credentials = await ensureDestinationServiceKey(sessionId, subaccountId);
    state.credentials = credentials;

    const instanceNames = await listDestinationServiceInstanceNames(sessionId, subaccountId);
    const instances: ProvisionedInstance[] = [];
    for (const name of instanceNames) {
      try {
        instances.push({ name, credentials: await ensureInstanceScopedServiceKey(sessionId, subaccountId, name) });
      } catch {
        // Best-effort: an instance we can't bind to (e.g. a permission edge case) is skipped
        // rather than failing the whole comparison for this subaccount.
      }
    }
    state.instances = instances;
  })()
    .then(() => {
      state.status = "success";
    })
    .catch((e: unknown) => {
      state.status = "error";
      state.error = errorMessage(e);
    });

  return state;
}

function getProvisioningState(sessionId: string, subaccountId: string): ProvisioningState {
  return provisioningJobs.get(provisioningKey(sessionId, subaccountId)) || { status: "error", error: "No provisioning job was started for this subaccount." };
}

module.exports = {
  startLogin,
  getLoginState,
  chooseGlobalAccount,
  markAlreadyLoggedIn,
  logout,
  startAccountSwitch,
  getSwitchState,
  chooseSwitchAccount,
  isLoggedIn,
  checkSession,
  listSubaccounts,
  listServiceInstances,
  ensureDestinationServiceKey,
  ensureInstanceScopedServiceKey,
  listDestinationServiceInstanceNames,
  startProvisioning,
  getProvisioningState,
};
