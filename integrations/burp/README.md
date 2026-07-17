# Hawk Burp Companion

This Java 21 Montoya extension streams explicitly scoped Burp traffic to the
loopback-only Hawk evidence plane. It is disabled by default, applies both a
user-defined URL scope and Burp Suite scope by default, redacts credential
headers, rate-limits forwarding, and uses a bounded background queue.

## Build

```text
gradle --no-daemon -p integrations/burp clean jar
```

Load `build/libs/hawk-burp-companion-0.1.0.jar` as a Java extension in Burp.
Open the **Hawk** tab, paste the pairing JSON copied from Hawk Security IDE,
choose the authorized scope, and enable capture.
