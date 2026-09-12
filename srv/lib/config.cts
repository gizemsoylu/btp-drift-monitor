import type { Subaccount } from "./types.cts";
const cds = require("@sap/cds");

/** Row shape of the btp.drift.Subaccounts DB table (see db/schema.cds). */
interface SubaccountRow {
  label: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
}

/** Reads this session's registered subaccounts (with credentials) straight from the DB. */
async function loadSubaccounts(sessionId: string): Promise<Subaccount[]> {
  const db = await cds.connect.to("db");
  const rows: SubaccountRow[] = await db.run(SELECT.from("btp.drift.Subaccounts").where({ sessionId }));
  return rows.map((r) => ({
    label: r.label,
    tokenUrl: r.tokenUrl,
    clientId: r.clientId,
    clientSecret: r.clientSecret,
    apiUrl: r.apiUrl,
  }));
}

/** Row shape of the btp.drift.DestinationServiceInstanceKeys DB table (see db/schema.cds). */
interface InstanceKeyRow {
  subaccountLabel: string;
  instanceName: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
}

export interface InstanceKey extends Subaccount {
  instanceName: string;
}

/** Reads one destination-service instance's own credentials, if this session has provisioned them. */
async function loadInstanceKey(sessionId: string, label: string, instanceName: string): Promise<InstanceKey | undefined> {
  const db = await cds.connect.to("db");
  const row: InstanceKeyRow | undefined = await db.run(
    SELECT.one.from("btp.drift.DestinationServiceInstanceKeys").where({ sessionId, subaccountLabel: label, instanceName })
  );
  if (!row) return undefined;
  return { label, instanceName: row.instanceName, tokenUrl: row.tokenUrl, clientId: row.clientId, clientSecret: row.clientSecret, apiUrl: row.apiUrl };
}

/** Reads every provisioned instance-scoped destination-service key for this session, across the given subaccount labels. */
async function loadInstanceKeysForLabels(sessionId: string, labels: string[]): Promise<InstanceKey[]> {
  if (labels.length === 0) return [];
  const db = await cds.connect.to("db");
  const rows: InstanceKeyRow[] = await db.run(
    SELECT.from("btp.drift.DestinationServiceInstanceKeys").where({ sessionId, subaccountLabel: labels })
  );
  return rows.map((r) => ({
    label: r.subaccountLabel,
    instanceName: r.instanceName,
    tokenUrl: r.tokenUrl,
    clientId: r.clientId,
    clientSecret: r.clientSecret,
    apiUrl: r.apiUrl,
  }));
}

module.exports = { loadSubaccounts, loadInstanceKey, loadInstanceKeysForLabels };
