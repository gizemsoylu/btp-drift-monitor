import type { Destination, DriftRow, FetchDestinationsResult } from "./types.cts";

/** Builds a flat drift-row list from two or more subaccounts' destination results — both
 *  subaccount-wide (instanceName undefined) and instance-scoped (instanceName set) results are
 *  accepted together; each (instanceName, destinationName) combination is compared independently,
 *  so a destination scoped to one Destination service instance is never confused with a
 *  same-named one at the subaccount level or on a different instance.
 *  Each row is one (instanceName, destinationName, subaccountLabel) combination — flattened this
 *  way because the Fiori Elements List Report needs a flat entity set to bind to. */
function buildDriftRows(results: FetchDestinationsResult[]): DriftRow[] {
  const labels = [...new Set(results.map((r) => r.label))];
  const byScope = new Map<string, Map<string, Destination>>();
  const scopeInstanceName = new Map<string, string>();

  function scopeKey(instanceName: string | undefined, destinationName: string): string {
    return `${instanceName ?? ""}::${destinationName}`;
  }

  for (const r of results) {
    if (!r.ok) continue;
    for (const dest of r.destinations) {
      const key = scopeKey(r.instanceName, dest.Name);
      if (!byScope.has(key)) {
        byScope.set(key, new Map());
        scopeInstanceName.set(key, r.instanceName ?? "");
      }
      byScope.get(key)!.set(r.label, dest);
    }
  }

  const rows: DriftRow[] = [];
  const sortedKeys = [...byScope.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    const perLabel = byScope.get(key)!;
    const instanceName = scopeInstanceName.get(key)!;
    const name = key.slice(instanceName.length + 2);

    const presentLabels = labels.filter((l) => perLabel.has(l));
    const all = [...perLabel.values()];
    const fields = new Set<string>();
    for (const d of all) for (const k of Object.keys(d)) if (k !== "Name") fields.add(k);

    const driftFields: string[] = [];
    for (const field of fields) {
      const values = new Set(presentLabels.map((l) => String(perLabel.get(l)![field] ?? "")));
      if (values.size > 1) driftFields.push(field);
    }

    for (const label of labels) {
      const dest = perLabel.get(label);
      const present = !!dest;
      const missingIn = labels.filter((l) => !perLabel.has(l));
      rows.push({
        ID: `${instanceName}::${name}::${label}`,
        destinationName: name,
        instanceName,
        subaccount: label,
        present,
        type: (dest?.Type as string) ?? "",
        url: (dest?.URL as string) ?? "",
        authentication: (dest?.Authentication as string) ?? "",
        proxyType: (dest?.ProxyType as string) ?? "",
        hasDrift: driftFields.length > 0 || missingIn.length > 0,
        driftFields: driftFields.join(", "),
        missingIn: missingIn.join(", "),
        rawJson: dest ? JSON.stringify(dest) : "",
      });
    }
  }
  return rows;
}

module.exports = { buildDriftRows };
