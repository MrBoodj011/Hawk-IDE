# Hawk observability

Telemetry and crash reporting are independent and disabled by default.

Local CLI configuration:

```json
{
  "telemetry_enabled": true,
  "crash_reporting_enabled": true,
  "telemetry_endpoint": "https://api.example.com/v1/telemetry/events"
}
```

The IDE exposes the opt-in setting as `hawk.telemetry.enabled`. Cloud sync can
copy that preference but never turns it on without an explicit user action.

The client and server both allowlist event names and remove content-bearing
property names. Crash reports contain only the error type and a normalized
fingerprint. The production monitor probes update and control-plane health
every 15 minutes and opens or updates a `production-incident` issue on failure.
