import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import Column from "sap/m/Column";
import ColumnListItem from "sap/m/ColumnListItem";
import Text from "sap/m/Text";
import HBox from "sap/m/HBox";
import Button from "sap/m/Button";
import Icon from "sap/ui/core/Icon";
import type Control from "sap/ui/core/Control";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import MultiComboBox from "sap/m/MultiComboBox";
import SearchField from "sap/m/SearchField";
import Table from "sap/m/Table";
import Dialog from "sap/m/Dialog";
import type Event from "sap/ui/base/Event";
import type Context from "sap/ui/model/Context";
import type ODataV4Context from "sap/ui/model/odata/v4/Context";
import type ListBinding from "sap/ui/model/ListBinding";
import type ODataModel from "sap/ui/model/odata/v4/ODataModel";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";

// Fields compared to decide whether a destination is identical across the selected subaccounts.
const COMPARED_FIELDS = ["type", "url", "authentication", "proxyType"] as const;

type CellStatus = "MATCH" | "DRIFT" | "MISSING";
type IconColor = "Positive" | "Critical" | "Neutral";

const STATUS: Record<CellStatus, { icon: string; color: IconColor; textKey: string }> = {
  MATCH: { icon: "sap-icon://sys-enter-2", color: "Positive", textKey: "compareLegendMatch" },
  DRIFT: { icon: "sap-icon://message-warning", color: "Critical", textKey: "compareLegendDrift" },
  MISSING: { icon: "sap-icon://less", color: "Neutral", textKey: "compareLegendMissing" },
};

interface SelectedSubaccount {
  id: string;
  displayName: string;
}

interface DriftCell {
  subaccount: string;
  status: CellStatus;
  sourceLabel?: string | null;
}

interface DriftPivotRow {
  destinationName: string;
  cells: DriftCell[];
}

// Shapes of our own CDS action/function results (see srv/destination-service.cds) — @sap/cds
// tooling doesn't generate client-side types, so these are hand-written to match.
interface CheckSessionResult {
  loggedIn: boolean;
  globalAccountName: string;
}

interface BtpGlobalAccountOption {
  number: number;
  name: string;
}

interface LoginStatusResult {
  status: "idle" | "running" | "choosing" | "success" | "error";
  log: string;
  ssoUrl?: string;
  globalAccounts?: BtpGlobalAccountOption[];
}

interface BtpSubaccountOption {
  id: string;
  displayName: string;
  subdomain: string;
  region: string;
}

interface DriftRowRecord {
  destinationName: string;
  subaccount: string;
  present: boolean;
  type: string;
  url: string;
  authentication: string;
  proxyType: string;
  [key: string]: unknown;
}

interface ServiceInstanceRecord {
  name: string;
  planId: string;
  ready: boolean;
}

interface TransportResult {
  ok: boolean;
  warning: string | null;
}

interface ProvisioningStatusResult {
  status: "running" | "success" | "error";
  error: string | null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Playful, rotating status lines shown while a destination service instance/key is being
// provisioned via the btp CLI in the background — this can take a while, so keep it lively.
const PROVISIONING_MESSAGES = [
  "Talking to the btp CLI...",
  "Provisioning a destination service instance...",
  "Minting a fresh service key...",
  "This can take a minute on a cold subaccount...",
  "Still working — the CLI is doing the heavy lifting...",
  "Almost there, just binding the service key...",
];

/**
 * @namespace btp.drift.destinationdrift.controller
 */
export default class Compare extends Controller {
  private _requestSeq = 0; // guards against out-of-order responses when selection changes rapidly
  private _currentSelection: SelectedSubaccount[] = [];
  private _loginPoll: ReturnType<typeof setInterval> | undefined;
  private _provisioningMessageInterval: ReturnType<typeof setInterval> | undefined;
  private _pendingChoiceKind: "login" | "switch" = "login"; // which backend action onGlobalAccountPress should answer

  onInit(): void {
    this.getView()!.setModel(new JSONModel({ hasSelection: false, rows: [] }), "compare");
    this.getView()!.setModel(new JSONModel({ hasSelection: false, rows: [] }), "instancesCompare");
    this.getView()!.setModel(
      new JSONModel({
        step: "login", // 'login' | 'ready'
        loginStatus: "idle",
        loginStatusText: "",
        ssoUrl: "",
        globalAccounts: [],
        subdomain: "",
        globalAccountName: "",
        subaccounts: [],
        registeredLabels: [], // subaccounts already provisioned this session — skip re-provisioning
        provisioning: false,
        provisioningStatusText: "",
      }),
      "wizard"
    );
    void this._checkSession();
  }

  private _oDataModel(): ODataModel {
    return this.getOwnerComponent()!.getModel() as ODataModel;
  }

  private _bundle(): ResourceBundle {
    return (this.getView()!.getModel("i18n") as ResourceModel).getResourceBundle() as ResourceBundle;
  }

  private async _checkSession(): Promise<void> {
    const oDataModel = this._oDataModel();
    const wizardModel = this.getView()!.getModel("wizard") as JSONModel;
    const op = oDataModel.bindContext("/checkBtpSession(...)");
    await op.execute();
    const result = op.getBoundContext()!.getObject() as CheckSessionResult;

    if (result.loggedIn) {
      wizardModel.setProperty("/globalAccountName", result.globalAccountName);
      wizardModel.setProperty("/step", "ready");
      await this._loadSubaccounts();
    } else {
      wizardModel.setProperty("/step", "login");
    }
  }

  onLoginPress = async (): Promise<void> => {
    const oDataModel = this._oDataModel();
    const wizardModel = this.getView()!.getModel("wizard") as JSONModel;
    const bundle = this._bundle();

    wizardModel.setProperty("/loginStatus", "running");
    wizardModel.setProperty("/loginStatusText", bundle.getText("btpLoginRunning"));

    const startOp = oDataModel.bindContext("/btpLoginStart(...)");
    startOp.setParameter("url", "https://cli.btp.cloud.sap");
    startOp.setParameter("subdomain", wizardModel.getProperty("/subdomain") || null);
    try {
      await startOp.execute();
    } catch (e: unknown) {
      wizardModel.setProperty("/loginStatus", "error");
      wizardModel.setProperty("/loginStatusText", errorMessage(e));
      return;
    }

    let ssoWindowOpened = false;
    let dialogOpened = false;
    clearInterval(this._loginPoll);
    this._loginPoll = setInterval(async () => {
      try {
        const statusOp = oDataModel.bindContext("/btpLoginStatus(...)");
        await statusOp.execute();
        const result = statusOp.getBoundContext()!.getObject() as LoginStatusResult;

        if (result.status === "running") {
          if (result.ssoUrl) {
            wizardModel.setProperty("/ssoUrl", result.ssoUrl);
            wizardModel.setProperty("/loginStatusText", bundle.getText("btpLoginOpenSso"));
            if (!ssoWindowOpened) {
              ssoWindowOpened = true;
              window.open(result.ssoUrl, "_blank");
            }
          }
          return;
        }

        if (result.status === "choosing") {
          wizardModel.setProperty("/ssoUrl", "");
          wizardModel.setProperty("/globalAccounts", result.globalAccounts || []);
          this._pendingChoiceKind = "login";
          if (!dialogOpened) {
            dialogOpened = true;
            this._openGlobalAccountDialog();
          }
          return;
        }

        clearInterval(this._loginPoll);
        wizardModel.setProperty("/ssoUrl", "");

        if (result.status !== "success") {
          wizardModel.setProperty("/loginStatus", "error");
          const shortLog = (result.log || "").slice(0, 300);
          wizardModel.setProperty("/loginStatusText", bundle.getText("btpLoginFailed", [shortLog]));
          return;
        }

        wizardModel.setProperty("/loginStatus", "success");
        await this._checkSession();
      } catch (e: unknown) {
        clearInterval(this._loginPoll);
        wizardModel.setProperty("/loginStatus", "error");
        wizardModel.setProperty("/loginStatusText", errorMessage(e));
      }
    }, 2000);
  };

  private _openGlobalAccountDialog(): void {
    (this.byId("globalAccountSearch") as SearchField).setValue("");
    (this.byId("globalAccountList")!.getBinding("items") as ListBinding | undefined)?.filter([]);
    (this.byId("globalAccountDialog") as Dialog).open();
  }

  onGlobalAccountSearch = (event: Event<{ newValue: string }>): void => {
    const query = event.getParameter("newValue") || "";
    const binding = this.byId("globalAccountList")!.getBinding("items") as ListBinding;
    binding.filter(query ? new Filter("name", FilterOperator.Contains, query) : []);
  };

  onGlobalAccountPress = async (event: Event): Promise<void> => {
    const source = event.getSource() as Control;
    const optionNumber = (source.getBindingContext("wizard")!.getObject() as BtpGlobalAccountOption).number;
    (this.byId("globalAccountDialog") as Dialog).close();

    const oDataModel = this._oDataModel();
    const wizardModel = this.getView()!.getModel("wizard") as JSONModel;
    const bundle = this._bundle();

    const actionName = this._pendingChoiceKind === "switch" ? "btpChooseSwitchAccount" : "btpChooseGlobalAccount";
    const op = oDataModel.bindContext(`/${actionName}(...)`);
    op.setParameter("optionNumber", optionNumber);
    try {
      await op.execute();
    } catch (e: unknown) {
      MessageBox.error(errorMessage(e));
      return;
    }
    wizardModel.setProperty("/loginStatusText", bundle.getText("btpLoginRunning"));
  };

  onLogoutPress = async (): Promise<void> => {
    await this._logout();
  };

  /** Switches global account via `btp target --hierarchy` — stays logged in, no SSO needed. */
  onSwitchGlobalAccountPress = async (): Promise<void> => {
    const oDataModel = this._oDataModel();
    const wizardModel = this.getView()!.getModel("wizard") as JSONModel;
    const bundle = this._bundle();

    const startOp = oDataModel.bindContext("/btpSwitchAccountStart(...)");
    try {
      await startOp.execute();
    } catch (e: unknown) {
      MessageBox.error(errorMessage(e));
      return;
    }

    let dialogOpened = false;
    clearInterval(this._loginPoll);
    this._loginPoll = setInterval(async () => {
      try {
        const statusOp = oDataModel.bindContext("/btpSwitchAccountStatus(...)");
        await statusOp.execute();
        const result = statusOp.getBoundContext()!.getObject() as LoginStatusResult;

        if (result.status === "running") return;

        if (result.status === "choosing") {
          wizardModel.setProperty("/globalAccounts", result.globalAccounts || []);
          this._pendingChoiceKind = "switch";
          if (!dialogOpened) {
            dialogOpened = true;
            this._openGlobalAccountDialog();
          }
          return;
        }

        clearInterval(this._loginPoll);

        if (result.status !== "success") {
          MessageBox.error(bundle.getText("btpLoginFailed", [(result.log || "").slice(0, 300)])!);
          return;
        }

        // The subaccounts (and their registered destination keys) belonged to the old global account.
        this._currentSelection = [];
        (this.byId("compareSubaccountSelect") as MultiComboBox).setSelectedKeys([]);
        (this.getView()!.getModel("compare") as JSONModel).setData({ hasSelection: false, rows: [] });
        (this.getView()!.getModel("instancesCompare") as JSONModel).setData({ hasSelection: false, rows: [] });
        this._rebuildColumns([]);
        this._rebuildInstanceColumns([]);
        wizardModel.setProperty("/registeredLabels", []);
        await this._checkSession();
        MessageToast.show(bundle.getText("btpSwitchSuccess")!);
      } catch (e: unknown) {
        clearInterval(this._loginPoll);
        MessageBox.error(errorMessage(e));
      }
    }, 2000);
  };

  private async _logout(): Promise<void> {
    clearInterval(this._loginPoll);
    (this.byId("globalAccountDialog") as Dialog).close();

    const oDataModel = this._oDataModel();
    const wizardModel = this.getView()!.getModel("wizard") as JSONModel;
    const bundle = this._bundle();

    const op = oDataModel.bindContext("/btpLogout(...)");
    try {
      await op.execute();
    } catch (e: unknown) {
      MessageBox.error(errorMessage(e));
      return;
    }

    this._currentSelection = [];
    (this.getView()!.getModel("compare") as JSONModel).setData({ hasSelection: false, rows: [] });
    (this.getView()!.getModel("instancesCompare") as JSONModel).setData({ hasSelection: false, rows: [] });
    this._rebuildColumns([]);
    this._rebuildInstanceColumns([]);
    wizardModel.setData({
      step: "login",
      loginStatus: "idle",
      loginStatusText: "",
      ssoUrl: "",
      globalAccounts: [],
      subdomain: "",
      globalAccountName: "",
      subaccounts: [],
      registeredLabels: [],
      provisioning: false,
      provisioningStatusText: "",
    });
    MessageToast.show(bundle.getText("btpLogoutSuccess")!);
  }

  private async _loadSubaccounts(): Promise<void> {
    const oDataModel = this._oDataModel();
    const wizardModel = this.getView()!.getModel("wizard") as JSONModel;
    const listOp = oDataModel.bindContext("/listBtpSubaccounts(...)");
    try {
      await listOp.execute();
    } catch (e: unknown) {
      MessageBox.error(errorMessage(e));
      return;
    }
    const result = listOp.getBoundContext()!.getObject() as { value?: BtpSubaccountOption[] };
    wizardModel.setProperty("/subaccounts", result.value || []);
  }

  onSubaccountSelectionChange = async (): Promise<void> => {
    const selectControl = this.byId("compareSubaccountSelect") as MultiComboBox;
    const selectedItems = selectControl.getSelectedItems();
    const selected: SelectedSubaccount[] = selectedItems.map((item) => ({ id: item.getKey(), displayName: item.getText() }));
    const compareModel = this.getView()!.getModel("compare") as JSONModel;
    const instancesModel = this.getView()!.getModel("instancesCompare") as JSONModel;
    const wizardModel = this.getView()!.getModel("wizard") as JSONModel;
    const seq = ++this._requestSeq;
    this._currentSelection = selected;

    if (selected.length < 2) {
      compareModel.setData({ hasSelection: false, rows: [] });
      instancesModel.setData({ hasSelection: false, rows: [] });
      this._rebuildColumns([]);
      this._rebuildInstanceColumns([]);
      return;
    }

    const registeredLabels: string[] = wizardModel.getProperty("/registeredLabels");
    const toProvision = selected.filter((s) => !registeredLabels.includes(s.displayName));

    if (toProvision.length > 0) {
      wizardModel.setProperty("/provisioning", true);
      let messageIndex = 0;
      wizardModel.setProperty("/provisioningStatusText", PROVISIONING_MESSAGES[0]);
      clearInterval(this._provisioningMessageInterval);
      this._provisioningMessageInterval = setInterval(() => {
        messageIndex = (messageIndex + 1) % PROVISIONING_MESSAGES.length;
        wizardModel.setProperty("/provisioningStatusText", PROVISIONING_MESSAGES[messageIndex]);
      }, 2500);

      try {
        for (const sa of toProvision) {
          await this._provisionSubaccount(sa);
          registeredLabels.push(sa.displayName);
        }
        wizardModel.setProperty("/registeredLabels", registeredLabels);
      } catch (e: unknown) {
        clearInterval(this._provisioningMessageInterval);
        wizardModel.setProperty("/provisioning", false);
        MessageBox.error(errorMessage(e));
        return;
      }
      clearInterval(this._provisioningMessageInterval);
      wizardModel.setProperty("/provisioning", false);
    }

    if (seq !== this._requestSeq) return; // a newer selection change has since superseded this request
    void this._loadAndCompare(selected, seq);
    void this._loadAndCompareInstances(selected, seq);
  };

  /** Starts background provisioning for one subaccount and polls until it succeeds or fails. */
  private async _provisionSubaccount(sa: SelectedSubaccount): Promise<void> {
    const oDataModel = this._oDataModel();

    const startOp = oDataModel.bindContext("/registerBtpSubaccountStart(...)");
    startOp.setParameter("subaccountId", sa.id);
    await startOp.execute();

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusOp = oDataModel.bindContext("/registerBtpSubaccountStatus(...)");
      statusOp.setParameter("subaccountId", sa.id);
      statusOp.setParameter("displayName", sa.displayName);
      statusOp.setParameter("label", sa.displayName);
      await statusOp.execute();
      const result = statusOp.getBoundContext()!.getObject() as ProvisioningStatusResult;

      if (result.status === "running") continue;
      if (result.status === "error") throw new Error(result.error || `Failed to provision ${sa.displayName}.`);
      return;
    }
  }

  private async _loadAndCompare(selected: SelectedSubaccount[], seq: number): Promise<void> {
    const labels = selected.map((s) => s.displayName);
    const oDataModel = this._oDataModel();
    const filters = labels.map((label) => new Filter("subaccount", FilterOperator.EQ, label));
    const binding = oDataModel.bindList("/DriftRows", undefined, undefined, new Filter({ filters, and: false }));
    const contexts = (await binding.requestContexts(0, 5000)) as ODataV4Context[];
    if (seq !== this._requestSeq) return; // a newer selection change has since superseded this request
    const flatRows = contexts.map((c) => c.getObject() as DriftRowRecord);

    const byDestination = new Map<string, Map<string, DriftRowRecord>>();
    for (const row of flatRows) {
      if (!byDestination.has(row.destinationName)) byDestination.set(row.destinationName, new Map());
      byDestination.get(row.destinationName)!.set(row.subaccount, row);
    }

    const pivotedRows: DriftPivotRow[] = [...byDestination.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([destinationName, perLabel]) => {
        const presentLabels = labels.filter((l) => perLabel.get(l)?.present);
        const presentRows = presentLabels.map((l) => perLabel.get(l)!);
        const allIdentical = presentRows.every((r) => COMPARED_FIELDS.every((f) => r[f] === presentRows[0][f]));

        const cells: DriftCell[] = labels.map((label) => {
          const row = perLabel.get(label);
          if (!row || !row.present) {
            return { subaccount: label, status: "MISSING", sourceLabel: presentLabels[0] || null };
          }
          return { subaccount: label, status: allIdentical ? "MATCH" : "DRIFT" };
        });
        return { destinationName, cells };
      });

    (this.getView()!.getModel("compare") as JSONModel).setData({ hasSelection: true, rows: pivotedRows });
    this._rebuildColumns(labels);
  }

  private async _loadAndCompareInstances(selected: SelectedSubaccount[], seq: number): Promise<void> {
    const oDataModel = this._oDataModel();
    const perSubaccount = await Promise.all(
      selected.map(async (sa) => {
        const op = oDataModel.bindContext("/listServiceInstances(...)");
        op.setParameter("subaccountId", sa.id);
        try {
          await op.execute();
          const result = op.getBoundContext()!.getObject() as { value?: ServiceInstanceRecord[] };
          return { label: sa.displayName, instances: result.value || [] };
        } catch {
          return { label: sa.displayName, instances: [] as ServiceInstanceRecord[] };
        }
      })
    );
    if (seq !== this._requestSeq) return;

    const labels = selected.map((s) => s.displayName);
    const byName = new Map<string, Map<string, ServiceInstanceRecord>>();
    for (const { label, instances } of perSubaccount) {
      for (const inst of instances) {
        if (!byName.has(inst.name)) byName.set(inst.name, new Map());
        byName.get(inst.name)!.set(label, inst);
      }
    }

    const pivotedRows: DriftPivotRow[] = [...byName.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, perLabel]) => {
        const presentRows = labels.map((l) => perLabel.get(l)).filter((r): r is ServiceInstanceRecord => !!r);
        const allIdentical = presentRows.every((r) => r.planId === presentRows[0].planId && r.ready === presentRows[0].ready);

        const cells: DriftCell[] = labels.map((label) => {
          const inst = perLabel.get(label);
          if (!inst) return { subaccount: label, status: "MISSING" };
          return { subaccount: label, status: allIdentical ? "MATCH" : "DRIFT" };
        });
        return { destinationName: name, cells };
      });

    (this.getView()!.getModel("instancesCompare") as JSONModel).setData({ hasSelection: true, rows: pivotedRows });
    this._rebuildInstanceColumns(labels);
  }

  onRefreshPress = async (): Promise<void> => {
    if (this._currentSelection.length < 2) return;
    const bundle = this._bundle();
    const seq = ++this._requestSeq;
    await Promise.all([this._loadAndCompare(this._currentSelection, seq), this._loadAndCompareInstances(this._currentSelection, seq)]);
    if (seq === this._requestSeq) MessageToast.show(bundle.getText("refreshSuccess")!);
  };

  onTransportPress = async (destinationName: string, sourceLabel: string, targetLabel: string): Promise<void> => {
    const bundle = this._bundle();
    const confirmed = await new Promise<boolean>((resolve) => {
      MessageBox.confirm(bundle.getText("transportConfirmMessage", [destinationName, sourceLabel, targetLabel])!, {
        onClose: (action: string | null) => resolve(action === MessageBox.Action.OK),
      });
    });
    if (!confirmed) return;

    const oDataModel = this._oDataModel();
    const op = oDataModel.bindContext("/transportDestination(...)");
    op.setParameter("destinationName", destinationName);
    op.setParameter("sourceSubaccount", sourceLabel);
    op.setParameter("targetSubaccount", targetLabel);
    op.setParameter("confirmed", true);

    try {
      await op.execute();
    } catch (e: unknown) {
      MessageBox.error(bundle.getText("transportFailure", [errorMessage(e)])!);
      return;
    }

    const result = op.getBoundContext()!.getObject() as TransportResult;
    if (result.warning) {
      MessageBox.warning(result.warning);
    } else {
      MessageToast.show(bundle.getText("transportSuccess")!);
    }

    const seq = ++this._requestSeq;
    void this._loadAndCompare(this._currentSelection, seq);
  };

  /** sap.m.Table needs its columns and the per-row cell template rebuilt whenever the subaccount selection changes. */
  private _rebuildColumns(labels: string[]): void {
    const table = this.byId("compareTable") as Table;
    const bundle = this._bundle();

    table.destroyColumns();
    table.unbindItems();
    if (labels.length === 0) return;

    table.addColumn(new Column({ header: new Text({ text: bundle.getText("compareColumnDestination") }) }));
    for (const label of labels) {
      table.addColumn(new Column({ header: new Text({ text: label }), hAlign: "Center" }));
    }

    table.bindItems({
      path: "compare>/rows",
      factory: (_id: string, context: Context) => {
        const row = context.getObject() as DriftPivotRow;
        const cells: Control[] = [new Text({ text: row.destinationName })];
        for (const cell of row.cells) {
          const def = STATUS[cell.status];
          if (cell.status === "MISSING" && cell.sourceLabel) {
            cells.push(
              new HBox({
                justifyContent: "Center",
                items: [
                  new Button({
                    icon: "sap-icon://shipping-status",
                    type: "Transparent",
                    tooltip: bundle.getText("transportButtonText"),
                    press: () => this.onTransportPress(row.destinationName, cell.sourceLabel!, cell.subaccount),
                  }),
                ],
              })
            );
          } else {
            cells.push(
              new HBox({
                justifyContent: "Center",
                items: [new Icon({ src: def.icon, color: def.color, tooltip: bundle.getText(def.textKey) })],
              })
            );
          }
        }
        return new ColumnListItem({ cells });
      },
    });
  }

  private _rebuildInstanceColumns(labels: string[]): void {
    const table = this.byId("instancesTable") as Table;
    const bundle = this._bundle();

    table.destroyColumns();
    table.unbindItems();
    if (labels.length === 0) return;

    table.addColumn(new Column({ header: new Text({ text: bundle.getText("instanceColumnName") }) }));
    for (const label of labels) {
      table.addColumn(new Column({ header: new Text({ text: label }), hAlign: "Center" }));
    }

    table.bindItems({
      path: "instancesCompare>/rows",
      factory: (_id: string, context: Context) => {
        const row = context.getObject() as DriftPivotRow;
        const cells: Control[] = [new Text({ text: row.destinationName })];
        for (const cell of row.cells) {
          const def = STATUS[cell.status];
          cells.push(
            new HBox({
              justifyContent: "Center",
              items: [new Icon({ src: def.icon, color: def.color, tooltip: bundle.getText(def.textKey) })],
            })
          );
        }
        return new ColumnListItem({ cells });
      },
    });
  }
}
