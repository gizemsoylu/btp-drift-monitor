using DestinationDriftService as service from './destination-service';

annotate service.DriftRows with @(
  UI.HeaderInfo: {
    TypeName      : '{i18n>driftRows.headerInfo.typeName}',
    TypeNamePlural: '{i18n>driftRows.headerInfo.typeNamePlural}',
    Title         : { Value: destinationName },
    Description   : { Value: subaccount }
  },
  UI.SelectionFields: [ destinationName, subaccount, hasDrift, proxyType ],
  UI.LineItem: [
    { Value: destinationName, Label: '{i18n>field.destinationName}' },
    { Value: subaccount,      Label: '{i18n>field.subaccount}' },
    { Value: present,         Label: '{i18n>field.present}' },
    { Value: type,            Label: '{i18n>field.type}' },
    { Value: authentication,  Label: '{i18n>field.authentication}' },
    { Value: proxyType,       Label: '{i18n>field.proxyType}' },
    { Value: hasDrift,        Label: '{i18n>field.hasDrift}', Criticality: driftCriticality },
    { Value: driftFields,     Label: '{i18n>field.driftFields}' },
    { Value: missingIn,       Label: '{i18n>field.missingIn}' }
  ]
);

annotate service.DriftRows with {
  destinationName @Common.Label: '{i18n>field.destinationName}';
  subaccount      @Common.Label: '{i18n>field.subaccount}';
  hasDrift        @Common.Label: '{i18n>field.hasDrift}';
};

annotate service.Subaccounts with @(
  UI.HeaderInfo: {
    TypeName      : '{i18n>subaccounts.headerInfo.typeName}',
    TypeNamePlural: '{i18n>subaccounts.headerInfo.typeNamePlural}',
    Title         : { Value: label },
    Description   : { Value: apiUrl }
  },
  UI.LineItem: [
    { Value: label,    Label: '{i18n>field.label}' },
    { Value: apiUrl,   Label: '{i18n>field.apiUrl}' },
    { Value: tokenUrl, Label: '{i18n>field.tokenUrl}' }
  ],
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: '{i18n>subaccounts.facet.general}', Target: '@UI.FieldGroup#General' }
  ],
  UI.FieldGroup#General: {
    Data: [
      { Value: label },
      { Value: apiUrl },
      { Value: tokenUrl },
      { Value: clientId }
    ]
  }
);

annotate service.Subaccounts with {
  label    @Common.Label: '{i18n>field.label}';
  apiUrl   @Common.Label: '{i18n>field.apiUrl}';
  tokenUrl @Common.Label: '{i18n>field.tokenUrl}';
  clientId @Common.Label: '{i18n>field.clientId}';
};

annotate service.TransportLog with @(
  UI.LineItem: [
    { Value: createdAt,        Label: '{i18n>field.createdAt}' },
    { Value: destinationName,  Label: '{i18n>field.destinationName}' },
    { Value: sourceSubaccount, Label: '{i18n>field.sourceSubaccount}' },
    { Value: targetSubaccount, Label: '{i18n>field.targetSubaccount}' },
    { Value: result,           Label: '{i18n>field.result}', Criticality: resultCriticality },
    { Value: detail,           Label: '{i18n>field.detail}' }
  ]
);
