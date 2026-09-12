/** Credentials for one subaccount's Destination service, from a Destination service key. */
export interface Subaccount {
  label: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
}

/** A single destination, as returned by the BTP Destination Configuration API. */
export interface Destination {
  Name: string;
  Type?: string;
  URL?: string;
  ProxyType?: string;
  Authentication?: string;
  Description?: string;
  [key: string]: unknown;
}

export interface FetchDestinationsResult {
  label: string;
  ok: boolean;
  error?: string;
  destinations: Destination[];
  /** Set when these are one Destination service instance's own (instance-scoped) destinations, rather than the subaccount-wide list. */
  instanceName?: string;
}

/** One (instanceName, destinationName, subaccountLabel) row, flattened for the DriftRows list report. */
export interface DriftRow {
  ID: string;
  destinationName: string;
  /** Empty for a subaccount-wide destination; otherwise the Destination service instance it's scoped to. */
  instanceName: string;
  subaccount: string;
  present: boolean;
  type: string;
  url: string;
  authentication: string;
  proxyType: string;
  hasDrift: boolean;
  driftFields: string;
  missingIn: string;
  rawJson: string;
}

export interface BtpSubaccountInfo {
  id: string;
  displayName: string;
  subdomain: string;
  region: string;
}

export interface DestinationServiceCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
}

export interface ServiceInstanceInfo {
  name: string;
  planId: string;
  ready: boolean;
}

export type BtpLoginStatus = "idle" | "running" | "success" | "error" | "choosing";

export interface BtpGlobalAccountOption {
  number: number;
  name: string;
}

export interface BtpLoginState {
  status: BtpLoginStatus;
  log: string;
  ssoUrl: string;
  /** Populated when `btp login` is waiting at "Choose option> " for the user to pick a global account. */
  globalAccounts: BtpGlobalAccountOption[];
}

export type BtpSwitchStatus = "idle" | "running" | "choosing" | "success" | "error";

export interface BtpSwitchState {
  status: BtpSwitchStatus;
  log: string;
  /** Populated when `btp target --hierarchy` is waiting for the user to pick a global account. */
  globalAccounts: BtpGlobalAccountOption[];
}
