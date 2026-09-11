import type { Destination, DriftRow, FetchDestinationsResult } from "./types.cts";

/** Builds a flat drift-row list from two or more subaccounts' destination results.
 *  Each row is one (destinationName, subaccountLabel) combination — flattened this
 *  way because the Fiori Elements List Report needs a flat entity set to bind to. */
function buildDriftRows(results: FetchDestinationsResult[]): DriftRow[] {
  const labels = results.map((r) => r.label);
  const byName = new Map<string, Map<string, Destination>>();
  for (const r of results) {
    if (!r.ok) continue;
    for (const dest of r.destinations) {
      if (!byName.has(dest.Name)) byName.set(dest.Name, new Map());
      byName.get(dest.Name)!.set(r.label, dest);
    }
  }

  const rows: DriftRow[] = [];
  for (const [name, perLabel] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
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
        ID: `${name}::${label}`,
        destinationName: name,
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
