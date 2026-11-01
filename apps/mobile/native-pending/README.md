# Native changes for the next binary

The OTA target is the shipped 1.0.8 native runtime:

| Platform | Fingerprint |
| --- | --- |
| iOS | `2154bf909c8a22aa44a60930381a3137274dc951` |
| Android | `8958057f4e856898a7d59999e0a73ad5670efa04` |

`upstream-native.patch` preserves the native changes deferred after the upstream merge:

- iOS Shortcuts/App Intents, their config plugin, and the voice-chat native module.
- Android notification polling with encrypted custom headers and access-proxy response handling.
- The optional iOS passkey developer entitlement.

The active native sources and configuration match 1.0.8. JavaScript features remain available;
shortcut voice requests become a no-op when the native bridge or its methods are absent. The
existing notification compatibility adapter retries the 1.0.8 signatures with locale preserved.
That binary cannot send custom headers from its background poller; foreground JavaScript requests
keep their custom headers. Shortcuts require the next native build.

To restore these changes for a future **native build**, run from the repository root:

```sh
git apply --check apps/mobile/native-pending/upstream-native.patch
git apply apps/mobile/native-pending/upstream-native.patch
```

The patch also restores the corresponding native contract test expectations. The existing App
Intents tests currently read the archived additions, so their contracts stay covered without
autolinking the new module. Re-run mobile tests, typecheck, and both fingerprints after applying.
Use a new app/runtime version for that binary; applying the patch changes the native fingerprint.

To verify OTA compatibility, run from `apps/mobile` in the same build environment as the baseline:

```sh
npx --no-install fingerprint fingerprint:generate --platform ios
npx --no-install fingerprint fingerprint:generate --platform android
```

No fingerprint sources are ignored or overridden to obtain the 1.0.8 hashes.
