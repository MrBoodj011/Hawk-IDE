# Hawk Interaction Chaos

Interaction Chaos finds UI reliability and security race signals from evidence
that the operator already captured during normal, authorized testing. The first
release is deliberately passive: Hawk does not click controls, submit forms, or
generate requests.

## What it detects

- repeated trusted clicks on the same structural control inside a short window;
- rapid submit bursts that may bypass an in-flight guard;
- duplicate `POST`, `PUT`, `PATCH`, or `DELETE` requests;
- duplicated event listeners and client retry storms without a matching click;
- divergent response statuses or 5xx responses during the same burst.

Results remain labelled as signals. A duplicate request is not automatically a
vulnerability: the server may be idempotent and the user-visible state may still
be correct.

## Capture boundary

Interaction capture is a separate Browser Companion opt-in. Hawk retains only:

- click or submit kind;
- sanitized page origin and path;
- timestamp and tab identifier;
- a bounded structural DOM fingerprint;
- tag, role, input type, disabled state, and trusted-event marker.

Hawk does not retain button text, labels, input values, query-string values,
headers, cookies, or request bodies for this feature. The loopback capture store
is bounded and can be cleared from the companion.

## Workflow

1. Pair the Browser Companion with Hawk.
2. Define the narrowest authorized URL scope.
3. Enable capture and the separate **Capture UI interactions** option.
4. Exercise the application normally, including a realistic delayed response.
5. Open Mission Control and choose **Analyze interactions**.
6. Review the correlated interaction and mutation request identifiers.
7. Add an in-flight client guard, server idempotency, and a regression test.
8. Build an evidence pack; Interaction Chaos signals are included in Markdown,
   HTML, JSON, and SARIF output.

MCP clients can run the same pure analyzer through
`hawk_interaction_chaos_analyze` with explicit sanitized records. That tool is
captured-only and cannot send network traffic.

## Deliberate limits

The analyzer uses bounded time windows and structural correlation, so background
requests in the same tab can still create false-positive evidence leads. Hawk
uses an initiator-page check when that metadata exists and never promotes a
signal to a confirmed vulnerability automatically.

Active burst testing is not part of this passive analyzer. A future active mode
must require an exact host-and-action plan, a separate approval hash, strict
rate/side-effect budgets, and an isolated browser worker.
