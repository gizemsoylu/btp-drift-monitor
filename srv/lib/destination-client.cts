import type { Subaccount, Destination, FetchDestinationsResult } from "./types.cts";
import type { AxiosResponse } from "axios";
const axios = require("axios");

const SENSITIVE_FIELD_PATTERN = /password|secret|token|key|clientcert/i;

interface TokenResponse {
  access_token: string;
}

function describeError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const err = e as { response?: { status: number; statusText: string }; message: string };
    return err.response ? `${err.response.status} ${err.response.statusText}` : err.message;
  }
  return e instanceof Error ? e.message : String(e);
}

async function getToken(tokenUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const { data }: AxiosResponse<TokenResponse> = await axios.post(
    `${tokenUrl}/oauth/token`,
    new URLSearchParams({ grant_type: "client_credentials" }),
    { auth: { username: clientId, password: clientSecret } }
  );
  return data.access_token;
}

/** Fetches all destinations for one subaccount from the Destination service. Never throws — returns { ok:false, error } instead. */
async function fetchDestinations(sa: Subaccount): Promise<FetchDestinationsResult> {
  try {
    const token = await getToken(sa.tokenUrl, sa.clientId, sa.clientSecret);
    const { data }: AxiosResponse<Destination[]> = await axios.get(
      `${sa.apiUrl}/destination-configuration/v1/subaccountDestinations`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { label: sa.label, ok: true, destinations: data };
  } catch (e: unknown) {
    return { label: sa.label, ok: false, error: describeError(e), destinations: [] };
  }
}

async function fetchAllDestinations(subaccounts: Subaccount[]): Promise<FetchDestinationsResult[]> {
  return Promise.all(subaccounts.map(fetchDestinations));
}

/**
 * Fetches one Destination service instance's own (instance-scoped) destinations — distinct from
 * the subaccount-wide list, and only visible via credentials bound to that specific instance.
 * Never throws — returns { ok:false, error } instead.
 */
async function fetchInstanceDestinations(label: string, instanceName: string, creds: Subaccount): Promise<FetchDestinationsResult> {
  try {
    const token = await getToken(creds.tokenUrl, creds.clientId, creds.clientSecret);
    const { data }: AxiosResponse<Destination[]> = await axios.get(
      `${creds.apiUrl}/destination-configuration/v1/instanceDestinations`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { label, instanceName, ok: true, destinations: data };
  } catch (e: unknown) {
    return { label, instanceName, ok: false, error: describeError(e), destinations: [] };
  }
}

async function fetchAllInstanceDestinations(
  entries: { label: string; instanceName: string; creds: Subaccount }[]
): Promise<FetchDestinationsResult[]> {
  return Promise.all(entries.map((e) => fetchInstanceDestinations(e.label, e.instanceName, e.creds)));
}

function hasMaskedSensitiveField(dest: Destination): boolean {
  for (const [key, value] of Object.entries(dest)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      if (value === undefined || value === null || value === "" || value === "****" || value === "***") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Writes a destination to the target subaccount via POST on the *collection* endpoint (no name
 * in the URL — the Name comes from the body). Verified empirically: PUT with the name in the URL
 * returns 405 there, and PUT on the bare collection returns 404 — POST is the create verb this
 * API's gateway actually routes (its OPTIONS Allow header lists more methods than are implemented).
 */
async function pushDestination(target: Subaccount, destination: Destination): Promise<void> {
  const token = await getToken(target.tokenUrl, target.clientId, target.clientSecret);
  await axios.post(
    `${target.apiUrl}/destination-configuration/v1/subaccountDestinations`,
    destination,
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
}

/** Same as pushDestination, but writes into one Destination service instance's own instance-scoped list. */
async function pushInstanceDestination(target: Subaccount, destination: Destination): Promise<void> {
  const token = await getToken(target.tokenUrl, target.clientId, target.clientSecret);
  await axios.post(
    `${target.apiUrl}/destination-configuration/v1/instanceDestinations`,
    destination,
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
}

module.exports = {
  fetchDestinations,
  fetchAllDestinations,
  fetchInstanceDestinations,
  fetchAllInstanceDestinations,
  hasMaskedSensitiveField,
  pushDestination,
  pushInstanceDestination,
};
