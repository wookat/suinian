#!/bin/bash
set -x
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
cd $ANDROID_HOME
[ -d cmdline-tools/latest ] || { curl -sL -o ct.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && unzip -q ct.zip -d cmdline-tools && mv cmdline-tools/cmdline-tools cmdline-tools/latest && rm ct.zip; }
yes | cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null 2>&1
cmdline-tools/latest/bin/sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools" 2>&1 | tail -3
cd "$(dirname "$0")/../../../android"
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew --no-daemon assembleDebug 2>&1 | tail -25
echo "GRADLE_EXIT=${PIPESTATUS[0]}"
ls -la app/build/outputs/apk/debug/ 2>&1
rm -f local.properties
