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

module.exports = { loadSubaccounts };
