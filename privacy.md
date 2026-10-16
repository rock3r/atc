# Android Traffic Control (`atc`) privacy policy

Android Traffic Control (`atc`) stores device coordination data locally. The CLI and plugin have no analytics, telemetry, tracking, or developer-operated data collection service. The developers do not collect, sell, or share personal data through `atc`.

## Local operation

The plugin helps a coding agent run the CLI against local Android SDK tools (`adb`, `emulator`, and the official `android` CLI). `atc` stores lease records, queue tickets, and configuration in a user-private state directory. The documented paths are `~/.local/share/atc`, `~/Library/Application Support/atc`, and `%LOCALAPPDATA%\atc`. `atc` does not send these records over the network.

## Third-party services

The coding agent and its model provider handle prompts, tool results, and files under their own settings and privacy policies.

The Android SDK, Android Emulator, and `adb` are separate tools governed by Google's Android SDK terms and privacy policy. This policy covers only the `atc` CLI and plugin.

## Support

Report problems through [GitHub Issues](https://github.com/rock3r/atc/issues). GitHub handles information posted in public issues, where anyone can read it. Keep credentials and private project files out of public issues.
