# Testing Notes

## launchctl domain leakage

`launchctl` domains are **per-user**, not per-`$HOME`. Running the installer in an isolated test environment (e.g. `HOME=/tmp/test-home projectdispatcher install`) still registers `com.projectdispatcher.daemon` in the real user's `gui/<uid>` domain.

This means installer smoke tests will pollute your actual launchd state. After any test that runs the installer on macOS, clean up with:

```bash
launchctl bootout gui/$(id -u)/com.projectdispatcher.daemon
```

If you skip this, a subsequent `projectdispatcher install` may hit "service already loaded" errors, and the daemon from the test environment may keep running under your real user session.

There is no workaround for this — launchctl does not support domain isolation per-`$HOME`.
