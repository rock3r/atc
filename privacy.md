# Android Traffic Control (`atc`) privacy policy

Android Traffic Control (`atc`) does not collect any data. The CLI and plugin contain no analytics, telemetry, tracking, or developer-operated data collection service. They do not sell or share personal data.

## Local operation

The plugin helps your coding agent run the `atc` CLI against the Android SDK (`adb`, `emulator`, and the official `android` CLI) on your computer. Lease records, queue tickets, and configuration stay on your local filesystem under your user-private state directory (`~/.local/share/atc`, `~/Library/Application Support/atc`, or `%LOCALAPPDATA%\atc`); they are never sent over the network by `atc`.

## Third-party services

Your coding agent and its model provider handle prompts, tool results, and files under their own settings and privacy policies.

The Android SDK, Android Emulator, and `adb` are separate tools governed by Google's Android SDK terms and privacy policy. This policy covers only the `atc` CLI and plugin.

## Support

Support is available through [GitHub Issues](https://github.com/rock3r/atc/issues). Information you choose to post in a public issue is handled by GitHub and is publicly visible. Do not include credentials or private project files in a public issue.
