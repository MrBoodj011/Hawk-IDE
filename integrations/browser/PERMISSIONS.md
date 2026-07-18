# Browser permission rationale

| Permission | Why Hawk needs it |
| --- | --- |
| `storage` | Saves pairing, disabled/enabled state, explicit scope, and local capture preferences. |
| `webRequest` | Observes request and response metadata needed for the local traffic timeline. |
| `<all_urls>` | Lets the operator use one build across different authorized targets. Runtime capture remains disabled by default and is additionally restricted by the operator's regular-expression scope. |
| content script on HTTP(S) | Correlates browser-page activity to requests. It does not enable capture by itself. |

The companion cannot access arbitrary native services. Forwarding is restricted
to a validated loopback HTTP URL and requires the high-entropy token generated
by Hawk.
