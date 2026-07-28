-- Deployment determination + workflow capture/replay (SCL v0.2: CAPTURE/REPLAY).
CREATE TABLE IF NOT EXISTS technology_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, vendor TEXT,
  surfaces TEXT NOT NULL,           -- JSON array of binding affordances
  notes TEXT, source_url TEXT
);
CREATE TABLE IF NOT EXISTS workflow_packages (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT,
  source_receipt_id TEXT NOT NULL, cell TEXT,
  steps_json TEXT NOT NULL, params_json TEXT,
  status TEXT DEFAULT 'captured',   -- captured | approved | retired
  receipt_id TEXT NOT NULL, created_at REAL
);
INSERT OR REPLACE INTO technology_profiles VALUES
 ('tp_enverus','enverus','Enverus','["api","file_export"]','Developer APIs and exports; hosts no third-party plugins — integrate via web service sync','https://www.enverus.com/developers/'),
 ('tp_quickbooks','quickbooks','Intuit','["api","app_store"]','QuickBooks Online API + app marketplace','https://developer.intuit.com/'),
 ('tp_excel','excel','Microsoft','["addin","file_drop"]','Office.js task-pane add-ins','https://learn.microsoft.com/office/dev/add-ins/'),
 ('tp_sap','sap','SAP','["api"]','OData/BAPI service integration','https://api.sap.com/'),
 ('tp_salesforce','salesforce','Salesforce','["api","managed_package","webhook"]','REST APIs, AppExchange packages, platform events','https://developer.salesforce.com/'),
 ('tp_autocad','autocad','Autodesk','["plugin_sdk"]','.NET / AutoLISP plugin SDK','https://www.autodesk.com/developer-network/platform-technologies/autocad'),
 ('tp_banner','banner','Ellucian','["api"]','Ethos API gateway','https://developer.ellucian.com/'),
 ('tp_blackboard','blackboard','Anthology','["api","lti"]','REST APIs + LTI tools','https://developer.blackboard.com/'),
 ('tp_sharepoint','sharepoint','Microsoft','["addin","api"]','SPFx add-ins, Graph API','https://learn.microsoft.com/sharepoint/dev/'),
 ('tp_slack','slack','Slack','["bot","webhook","api"]','Bot apps and webhooks','https://api.slack.com/'),
 ('tp_teams','teams','Microsoft','["bot","connector","api"]','Teams bots/connectors, Graph','https://learn.microsoft.com/microsoftteams/platform/'),
 ('tp_copilot','copilot','Microsoft','["connector"]','Copilot Studio custom connectors (MCP supported)','https://learn.microsoft.com/microsoft-copilot-studio/'),
 ('tp_workday','workday','Workday','["api"]','Workday REST/SOAP APIs','https://developer.workday.com/'),
 ('tp_oracle','oracle','Oracle','["api"]','Oracle Cloud REST APIs','https://docs.oracle.com/en/cloud/'),
 ('tp_netsuite','netsuite','Oracle','["api","suiteapp"]','SuiteTalk APIs, SuiteApps','https://developer.oracle.com/netsuite/'),
 ('tp_stripe','stripe','Stripe','["api","webhook"]','REST API + webhooks','https://stripe.com/docs/api'),
 ('tp_hubspot','hubspot','HubSpot','["api","app"]','APIs + app marketplace','https://developers.hubspot.com/'),
 ('tp_docusign','docusign','Docusign','["api","webhook"]','eSignature REST API + Connect webhooks','https://developers.docusign.com/'),
 ('tp_snowflake','snowflake','Snowflake','["api","native_app"]','SQL API, Native Apps','https://docs.snowflake.com/'),
 ('tp_outlook','outlook','Microsoft','["addin","api"]','Outlook add-ins, Graph','https://learn.microsoft.com/office/dev/add-ins/outlook/'),
 ('tp_gmail','gmail','Google','["addon","api"]','Workspace add-ons, Gmail API','https://developers.google.com/workspace/'),
 ('tp_sonris','sonris','LDNR','["portal"]','State portal — assisted filing only, no automation surface','https://www.denr.louisiana.gov/'),
 ('tp_northstar','northstar','NDIC','["portal"]','State portal — assisted filing only','https://www.dmr.nd.gov/oilgas/'),
 ('tp_postgres','postgres','PostgreSQL','["direct_db"]','Direct database integration','https://www.postgresql.org/docs/'),
 ('tp_mysql','mysql','MySQL','["direct_db"]','Direct database integration','https://dev.mysql.com/doc/');
