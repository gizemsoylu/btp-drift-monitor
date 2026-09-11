namespace btp.drift;

using { cuid, managed } from '@sap/cds/common';

/**
 * A BTP subaccount registered for drift comparison, with the OAuth credentials
 * needed to call its Destination service (from a Destination service key).
 * Persisted in SQLite (node:sqlite — no native build required).
 */
entity Subaccounts : cuid, managed {
  sessionId    : String(36)  not null; // isolates rows per browser session — see srv/lib/session.cts
  label        : String(100) not null; // display label, e.g. "dev", "qa", "prod"
  tokenUrl     : String(300) not null; // service key "url" (UAA/OAuth base url)
  clientId     : String(300) not null; // service key "clientid"
  clientSecret : String(500) not null; // service key "clientsecret"
  apiUrl       : String(300) not null; // service key "uri" (Destination API base url)
}

/** Persistent audit trail of transport operations. */
entity TransportLog : cuid, managed {
  sessionId        : String(36); // isolates rows per browser session — see srv/lib/session.cts
  destinationName  : String(200);
  sourceSubaccount : String(100);
  targetSubaccount : String(100);
  result           : String(20) enum { success; failure; };
  detail           : String(1000);
}
