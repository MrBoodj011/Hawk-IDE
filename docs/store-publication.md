# Hawk companion publication

## Chrome Web Store

The manual `Hawk Companion Store Publish` workflow uses the Chrome Web Store
API v2 to upload a versioned ZIP and submit it for review. The first listing
still requires a publisher account, two-step verification, store listing,
privacy declarations, visibility, and an initial manual publish in the
Developer Dashboard.

Official API documentation:
https://developer.chrome.com/docs/webstore/using-api

## Burp BApp Store

PortSwigger requires a public GitHub source repository and human review. The
workflow builds the JAR and opens a new-extension submission issue against the
official extension portal only when a public source URL and submission token
are supplied.

Official submission and acceptance documentation:

- https://portswigger.net/burp/documentation/desktop/extend-burp/extensions/creating/bapp-store-submitting-extensions
- https://portswigger.net/burp/documentation/desktop/extend-burp/extensions/creating/bapp-store-acceptance-criteria
