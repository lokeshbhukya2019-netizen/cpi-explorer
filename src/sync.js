const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fetch = require("node-fetch");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const glob = require("glob");

// ==========================================================
// CONFIGURATION
// ==========================================================
// All tenant-specific values come from environment variables.
// Copy .env.example to .env and fill in your own values - never
// commit real credentials to source control.

const CONFIG = {
  tokenUrl: process.env.CPI_TOKEN_URL,
  clientId: process.env.CPI_CLIENT_ID,
  clientSecret: process.env.CPI_CLIENT_SECRET,
  apiHost: process.env.CPI_API_HOST,
};

for (const [key, value] of Object.entries(CONFIG)) {
  if (!value) {
    console.error(
      `Missing required environment variable for "${key}". Copy .env.example to .env and fill in your CPI tenant details.`
    );
    process.exit(1);
  }
}

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "cpi-data.json");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const METADATA_FILE = path.join(DATA_DIR, "metadata.json");
const ARTIFACT_FOLDER = path.join(DATA_DIR, "artifacts");
const EXTRACT_FOLDER = path.join(DATA_DIR, "extracted");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ==========================================================
// ACCESS TOKEN
// ==========================================================

async function getAccessToken() {
  console.log("Getting Access Token...");
  const auth = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString("base64");
  const response = await fetch(`${CONFIG.tokenUrl}?grant_type=client_credentials`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) throw new Error(await response.text());
  const json = await response.json();
  console.log("Access Token OK");
  return json.access_token;
}

// ==========================================================
// GENERIC GET
// ==========================================================

async function apiGet(token, apiPath) {
  const response = await fetch(CONFIG.apiHost + apiPath, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    console.log("\nRequest Failed:", apiPath, response.status);
    console.log(await response.text());
    return null;
  }
  const json = await response.json();
  return json.d?.results ?? json.d;
}

// ==========================================================
// DOWNLOAD + EXTRACT ARTIFACT
// ==========================================================

async function downloadArtifact(token, iflowId, version) {
  const url = `${CONFIG.apiHost}/api/v1/IntegrationDesigntimeArtifacts(Id='${encodeURIComponent(
    iflowId
  )}',Version='${encodeURIComponent(version)}')/\$value`;

  console.log("Downloading", iflowId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    console.log("Download Failed:", await response.text());
    return false;
  }

  if (!fs.existsSync(ARTIFACT_FOLDER)) fs.mkdirSync(ARTIFACT_FOLDER);
  const buffer = await response.buffer();
  const zipFile = path.join(ARTIFACT_FOLDER, `${iflowId}.zip`);
  fs.writeFileSync(zipFile, buffer);
  console.log("Saved", zipFile);
  return true;
}

function extractArtifact(iflowId) {
  const zipFile = path.join(ARTIFACT_FOLDER, `${iflowId}.zip`);
  if (!fs.existsSync(zipFile)) {
    console.log("ZIP not found:", zipFile);
    return false;
  }

  const targetFolder = path.join(EXTRACT_FOLDER, iflowId);
  fs.mkdirSync(targetFolder, { recursive: true });

  try {
    const zip = new AdmZip(zipFile);
    zip.extractAllTo(targetFolder, true);
    console.log("Extracted:", iflowId);
    return true;
  } catch (err) {
    console.log(err.message);
    return false;
  }
}

// ==========================================================
// PROPERTY EXTRACTION HELPERS
// ==========================================================

function extractProperties(properties) {
  if (!properties) return [];
  if (!Array.isArray(properties)) properties = [properties];
  return properties.map((p) => ({ key: p.key, value: p.value }));
}

// ==========================================================
// BUILD METADATA
// ----------------------------------------------------------
// KEY FIX: instead of globbing ALL extracted folders and trying to
// reverse-guess which iFlow a file belongs to (fragile, and broken
// on Windows due to path.sep vs glob's forward slashes), we iterate
// indexData directly - which already has the correct package/iflow/id
// from the sync loop - and look ONLY inside that artifact's own
// extracted/<id>/ folder. No guessing, no cross-contamination.
// ==========================================================

// Replaces any {{Token}} placeholders in an adapter property's value with
// the actual externalized value from that iFlow's Configurations, so
// "{{Protocol-Hostname-Port}}/sap/bc/..." becomes the real resolved URL.
function resolvePlaceholders(value, configurations) {
  if (typeof value !== "string" || !value.includes("{{")) return value;

  return value.replace(/\{\{([^}]+)\}\}/g, (match, token) => {
    const cleanToken = token.trim();
    const config = (configurations || []).find(
      (c) => c.ParameterKey === cleanToken
    );
    return config ? config.ParameterValue : match; // leave as-is if not found
  });
}

function buildMetadata(indexData, configData) {
  console.log("\n==================================");
  console.log("Building metadata.json");
  console.log("==================================");

  const parser = new XMLParser({ ignoreAttributes: false });
  const metadata = [];

  // Quick lookup: iFlow id -> its externalized configurations
  const configByIflowId = {};
  for (const c of configData) {
    configByIflowId[c.id] = c.configurations || [];
  }

  for (const entry of indexData) {
    // Scope the glob to THIS artifact's own folder only.
    const pattern = path
      .join(EXTRACT_FOLDER, entry.id, "**", "integrationflow", "*.iflw")
      .split(path.sep)
      .join("/"); // glob always wants forward slashes, even on Windows

    const iflowFiles = glob.sync(pattern);

    if (iflowFiles.length === 0) {
      console.log(`  ! No .iflw file found for ${entry.id}, skipping`);
      continue;
    }

    const file = iflowFiles[0]; // one iFlow = one .iflw file
    console.log("Reading:", entry.iflow, "->", file);

    const xml = fs.readFileSync(file, "utf8");
    const json = parser.parse(xml);

    const collaboration = json["bpmn2:definitions"]?.["bpmn2:collaboration"];
    const messageFlows = collaboration?.["bpmn2:messageFlow"];

    const record = {
      package: entry.package,
      iflow: entry.iflow,
      id: entry.id,
      file,
      adapters: [],
    };

    if (messageFlows) {
      const flows = Array.isArray(messageFlows) ? messageFlows : [messageFlows];
      const configurations = configByIflowId[entry.id] || [];

      for (const flow of flows) {
        const rawProps = extractProperties(flow["bpmn2:extensionElements"]?.["ifl:property"]);

        // Resolve {{placeholder}} tokens against this iFlow's Configurations
        const props = rawProps.map((p) => ({
          key: p.key,
          value: resolvePlaceholders(p.value, configurations),
          rawValue: p.value, // keep original in case resolution failed or wasn't needed
        }));

        record.adapters.push({
          name: flow["@_name"],
          direction: props.find((p) => String(p.key).toLowerCase() === "direction")?.value || "",
          properties: props,
        });
      }
    }

    metadata.push(record);
  }

  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  console.log(`\n${METADATA_FILE} generated (${metadata.length} iFlows)`);
}

// ==========================================================
// SEARCH METADATA
// ==========================================================

function searchMetadata(searchText) {
  if (!fs.existsSync(METADATA_FILE)) {
    console.log(`${METADATA_FILE} not found. Run: npm run sync`);
    return;
  }

  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
  const keyword = searchText.toLowerCase();
  let found = false;

  console.log(`\nSearching for: ${searchText}\n`);

  for (const flow of metadata) {
    for (const adapter of flow.adapters || []) {
      for (const property of adapter.properties || []) {
        const key = String(property.key || "").toLowerCase();
        const value = String(property.value || "").toLowerCase(); // resolved value

        if (key.includes(keyword) || value.includes(keyword)) {
          found = true;
          console.log("======================================================");
          console.log("Package      :", flow.package);
          console.log("iFlow        :", flow.iflow, `(${flow.id})`);
          console.log("");
          console.log("Adapter      :", adapter.name);
          console.log("Direction    :", adapter.direction);
          console.log("");
          console.log("Property     :", property.key);
          console.log("Value        :", property.value);
          if (property.rawValue && property.rawValue !== property.value) {
            console.log("(raw, before resolving {{}}) :", property.rawValue);
          }
          console.log("======================================================\n");
        }
      }
    }
  }

  if (!found) console.log("No matches found.");
}

// ==========================================================
// SYNC ENTIRE TENANT
// ==========================================================

function cleanWorkFolders() {
  // Prevent stale data from previous runs mixing with the current sync -
  // this was the main cause of iFlows getting mismatched in search results.
  for (const folder of [ARTIFACT_FOLDER, EXTRACT_FOLDER]) {
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
}

async function syncAll() {
  console.log("Cleaning previous artifacts/extracted folders...");
  cleanWorkFolders();

  const token = await getAccessToken();

  console.log("\nFetching Packages...");
  const packages = await apiGet(token, "/api/v1/IntegrationPackages");
  if (!packages) {
    console.log("No Packages Found");
    return;
  }
  console.log(`Found ${packages.length} Package(s)\n`);

  const configData = [];
  const indexData = [];

  for (const pkg of packages) {
    console.log("\n=========================================");
    console.log("Package :", pkg.Name, `(${pkg.Id})`);
    console.log("=========================================");

    const iflows = await apiGet(
      token,
      `/api/v1/IntegrationPackages('${encodeURIComponent(pkg.Id)}')/IntegrationDesigntimeArtifacts`
    );

    if (!iflows || iflows.length === 0) {
      console.log("No iFlows");
      continue;
    }
    console.log(`Found ${iflows.length} iFlow(s)\n`);

    for (const iflow of iflows) {
      const iflowId = iflow.Id;
      const version = iflow.Version || "active";

      console.log("-----------------------------------------");
      console.log("iFlow   :", iflow.Name, `(${iflowId})`, "v" + version);

      // Configurations (externalized parameters)
      const configs = await apiGet(
        token,
        `/api/v1/IntegrationDesigntimeArtifacts(Id='${encodeURIComponent(
          iflowId
        )}',Version='${encodeURIComponent(version)}')/Configurations`
      );
      console.log("Configurations:", configs ? configs.length : 0);

      configData.push({
        package: pkg.Name,
        iflow: iflow.Name,
        id: iflowId,
        version,
        configurations: configs || [],
      });

      // Download + extract raw XML (catches hardcoded, non-externalized values)
      const downloaded = await downloadArtifact(token, iflowId, version);
      if (!downloaded) continue;

      const extracted = extractArtifact(iflowId);
      if (!extracted) continue;

      indexData.push({
        package: pkg.Name,
        iflow: iflow.Name,
        id: iflowId,
      });
    }
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(configData, null, 2));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData, null, 2));

  buildMetadata(indexData, configData);

  console.log("\n=========================================");
  console.log("SYNC COMPLETED");
  console.log("=========================================");
  console.log("\nConfiguration File :", DATA_FILE);
  console.log("Search Index       :", INDEX_FILE);
  console.log("Metadata (for search):", METADATA_FILE);
}

// ==========================================================
// CLI ENTRY POINT
// ==========================================================

const [, , command, term] = process.argv;

switch (command) {
  case "sync":
    syncAll().catch((err) => console.error(err));
    break;

  case "search":
    if (!term) {
      console.log("Usage:\nnode cpi-search.js search <text>");
      break;
    }
    searchMetadata(term);
    break;

  default:
    console.log("\nUsage");
    console.log("--------------------------------------");
    console.log("npm run sync");
    console.log("node src/sync.js search <text>");
    console.log("");
}
