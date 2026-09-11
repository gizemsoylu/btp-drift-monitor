using { btp.drift as db } from '../db/schema';

/**
 * Destination Drift service: compares Destination Service configuration across
 * SAP BTP subaccounts and transports a selected destination from a source
 * subaccount to a target subaccount.
 */
service DestinationDriftService @(path: '/odata/v4/destination-drift', impl: './destination-service.cts') {

  /** Subaccount x Destination matrix — read live from the BTP Destination API on every request (not persisted). */
  @readonly
  @cds.persistence.skip
  entity DriftRows {
    key ID              : String(300);
        destinationName : String(200)  @title: '{i18n>field.destinationName}';
        subaccount      : String(100)  @title: '{i18n>field.subaccount}';
        present         : Boolean      @title: '{i18n>field.present}';
        type            : String(50)   @title: '{i18n>field.type}';
        url             : String(1000) @title: '{i18n>field.url}';
        authentication  : String(50)   @title: '{i18n>field.authentication}';
        proxyType       : String(50)   @title: '{i18n>field.proxyType}';
        hasDrift        : Boolean      @title: '{i18n>field.hasDrift}';
        driftFields     : String(500)  @title: '{i18n>field.driftFields}';
        missingIn       : String(500)  @title: '{i18n>field.missingIn}';
        rawJson         : LargeString  @title: '{i18n>field.rawJson}';
        virtual driftCriticality : Integer;
  }

  /**
   * Subaccounts registered for drift comparison. Created via the addSubaccountFromServiceKey
   * action (paste a downloaded Destination service key); editable/deletable afterwards.
   * clientSecret is write-only — never returned by READ (see the after-READ redaction handler).
   */
  @Capabilities.InsertRestrictions.Insertable: false
  entity Subaccounts as projection on db.Subaccounts {
    *
  };

  /** Parses a downloaded Destination service key JSON and registers it as a new subaccount. */
  action addSubaccountFromServiceKey(
    label          : String(100),
    serviceKeyJson : LargeString
  ) returns Subaccounts;

  /** Transport audit trail — real SQLite persistency (node:sqlite, no native build required). */
  @readonly
  entity TransportLog as projection on db.TransportLog {
    *,
    virtual null as resultCriticality : Integer
  };

  /** Copies/updates a destination from the source subaccount to the target subaccount. */
  action transportDestination(
    destinationName : String(200),
    sourceSubaccount : String(100),
    targetSubaccount : String(100),
    confirmed        : Boolean
  ) returns {
    ok      : Boolean;
    warning : String(1000);
  };

  /** Quick, non-interactive check for an already-valid `btp` CLI session (e.g. from a prior login). */
  function checkBtpSession() returns { loggedIn : Boolean; globalAccountName : String };

  /** Starts an interactive `btp login --sso` in the background (opens the browser on the server machine). */
  action btpLoginStart(url : String, subdomain : String) returns { message : String };

  /** Polls the background login started by btpLoginStart. status: idle | running | success | error | choosing. */
  function btpLoginStatus() returns {
    status         : String;
    log            : String;
    ssoUrl         : String;
    globalAccounts : array of { number : Integer; name : String };
  };

  /** Answers the "Choose a global account" prompt (status=choosing) by picking one option's number. */
  action btpChooseGlobalAccount(optionNumber : Integer) returns { message : String };

  /** Logs the btp CLI session out. */
  action btpLogout() returns { message : String };

  /** Starts `btp target --hierarchy` in the background — switches global account without logging out. */
  action btpSwitchAccountStart() returns { message : String };

  /** Polls the background switch started by btpSwitchAccountStart. status: idle | running | choosing | success | error. */
  function btpSwitchAccountStatus() returns {
    status         : String;
    log            : String;
    globalAccounts : array of { number : Integer; name : String };
  };

  /** Answers the "Choose global account" prompt (status=choosing) by picking one option's number. */
  action btpChooseSwitchAccount(optionNumber : Integer) returns { message : String };

  /** Lists the subaccounts visible to the logged-in BTP user (requires a successful btpLoginStart first). */
  function listBtpSubaccounts() returns array of {
    id          : String;
    displayName : String;
    subdomain   : String;
    region      : String;
  };

  /**
   * Starts (in the background) registering a subaccount for drift comparison by auto-provisioning
   * a destination service instance/key for it via the btp CLI — no service key is ever pasted by
   * the user. Provisioning can take longer than a platform router's request timeout, so this
   * returns immediately; poll registerBtpSubaccountStatus for the result.
   */
  action registerBtpSubaccountStart(subaccountId : String, displayName : String, label : String) returns { message : String };

  /** Polls the background job started by registerBtpSubaccountStart. status: running | success | error. */
  function registerBtpSubaccountStatus(subaccountId : String, displayName : String, label : String) returns { status : String; error : String };

  /** Lists the service instances in a subaccount (live from `btp list services/instance`), for the Service Instances tab. */
  function listServiceInstances(subaccountId : String) returns array of {
    name   : String;
    planId : String;
    ready  : Boolean;
  };
}

// clientSecret is only ever set through addSubaccountFromServiceKey (a raw DB write) —
// blocked here from generic Create/Update, and redacted on READ in the service handler.
annotate DestinationDriftService.Subaccounts with {
  clientSecret @readonly;
};
