# RemoraHQ - Auditor Role

MeshCentral plugin providing server-side storage for the RemoraHQ Auditor role
— a shared list of user-ids granted read-only access to audit + reports + alerts.

## Identity

| Field | Value |
|-------|-------|
| Display name | `RemoraHQ - Auditor Role` |
| Short name (Mesh shortName) | `remoraAuditor` |
| Entry file | `remoraAuditor.js` |
| Source repo folder | `RemoraHQ-Auditor-Role-Plugins` |
| Deploy folder under Mesh | `meshcentral/plugins/remoraAuditor` |

## Storage

Single JSON file at `<datapath>/remora-auditor-state.json`. Atomic write via
temp-file + rename, serialised through a write-queue Promise chain.

Schema:

```jsonc
{ "auditorUserIds": ["user//alice", "user//bob"] }
```

## Wire protocol

| Action | Payload | Reply |
|--------|---------|-------|
| `list` | — | `{ auditorUserIds }` |
| `set` | `{ userId, isAuditor }` | `{ auditorUserIds }` |

Real-time broadcast on every successful `set`:

```jsonc
{
  "action": "plugin",
  "plugin": "remoraAuditor",
  "pluginaction": "changed",
  "auditorUserIds": [...]
}
```

## Install (development)

```powershell
# from MeshCentral root
New-Item -ItemType SymbolicLink `
  -Path .\plugins\remoraAuditor `
  -Target "D:\…\RemoraHQ-Auditor-Role-Plugins"
```

Then register via `Admin → Plugins → Add` with the `configUrl` from `config.json`.

## License

Apache-2.0 (matches MeshCentral). See `LICENSE`.
