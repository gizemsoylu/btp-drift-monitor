// @sap/cds injects the CQL builders (SELECT/INSERT/UPDATE/DELETE/CREATE/DROP) as globals
// at runtime; it ships no ambient types for them, so we declare minimal ones here.
declare const SELECT: any;
declare const INSERT: any;
declare const UPDATE: any;
declare const DELETE: any;
