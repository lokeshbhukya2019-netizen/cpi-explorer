# CPI Explorer

Search across every integration flow in your SAP CPI (Integration Suite) tenant for a host, path, RFC destination, queue name, or any adapter property - instead of opening each iFlow one by one to check.

## The problem

If you work on SAP CPI/PI, this is a familiar situation: another team (FICO, SD, whoever) reports that files aren't showing up somewhere, and the first thing they do is come ask you to check. If you already know which iFlow handles that interface, fine. If you don't, you're opening flows one at a time, checking adapter after adapter, hoping you find the right one - across a tenant that might have hundreds of them.

ABAP developers have a "where-used list" for this. CPI doesn't. This is an attempt to build one.

## How it works

1. **Sync** - authenticates to your CPI tenant and downloads every integration flow's design-time artifact (`.zip`), using the same API CPI's own Web UI uses to download a single iFlow, generalized to loop over all of them.
2. **Parse** - unzips each artifact and reads the underlying `.iflw` (BPMN) XML to pull out every adapter's properties (host, path, RFC destination, etc.).
3. **Resolve** - CPI lets you externalize values as `{{Parameter}}` placeholders configured separately per environment. The sync script fetches each iFlow's `Configurations` and resolves these placeholders back to their real values, so a search for a hostname finds it even if it's not hardcoded in the XML.
4. **Search** - all of this gets written to a local `metadata.json`. A small backend serves it over a `/search` endpoint, and a Chrome extension gives you a search box in your browser toolbar.

## Architecture

```
cpi-explorer/
├── src/sync.js         # Auth, download, parse, resolve tokens -> data/metadata.json
├── server/server.js     # Local REST API that serves metadata.json to the extension
├── extension/            # Chrome extension (popup UI, calls the local server)
├── data/                 # Generated output (gitignored - contains your tenant's data)
└── .env.example          # Template for your tenant credentials
```

Nothing here talks to the internet except your own CPI tenant. The extension only talks to `localhost`.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure your tenant credentials

```bash
cp .env.example .env
```

Fill in `.env` with your tenant's OAuth token URL, client ID/secret, and API host. These come from a service key for the Process Integration Runtime API, generated in BTP Cockpit under your CPI subscription.

### 3. Run a sync

```bash
npm run sync
```

This downloads and parses every iFlow in your tenant and writes `data/metadata.json`. Re-run this whenever you want to refresh the index (there's no live watching - it's a point-in-time snapshot).

### 4. Start the backend

```bash
npm run server
```

Runs on `http://localhost:3000`. Test it directly: `http://localhost:3000/search?q=sftp`

### 5. Load the Chrome extension

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, select the `extension/` folder
4. Pin the extension, click it, and start typing

## Command-line search

You don't need the extension to search - the sync script itself doubles as a CLI:

```bash
node src/sync.js search sftp
```

## Current limitations

- **Localhost only.** The backend and extension only work while `server.js` is running on your machine. Moving this to a small shared/hosted backend (with proper auth) is the natural next step for team-wide use.
- **Point-in-time snapshot.** Search reflects whatever the last `npm run sync` pulled - it won't auto-detect new or changed iFlows.
- **No click-to-open (yet).** Clicking a result doesn't currently deep-link to that exact iFlow in the CPI Web UI.

## Why I built this

I'm not a genius developer solving a hard problem - I'm someone who got tired of manually checking hundreds of flows every time another team said "check if this is broken." If you're in the same position, this might save you some time too. Feedback, issues, and PRs are welcome.

## License

MIT
"# cpi-explorer" 
