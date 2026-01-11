#!/bin/sh
set -e

if [ -n "$NO_COLOR" ]; then
    BOLD=""
    RESET=""
else
    BOLD="\033[1m"
    RESET="\033[0m"
fi


usage() {
    cat <<EOF
sqlite-hello-install 0.1.6

USAGE:
    $0 [static|loadable] [--target=target] [--prefix=path]

OPTIONS:
    --target
            Specify a different target platform to install. Available targets: android-aarch64, android-armv7a, android-i686, android-x86_64, ios-aarch64, iossimulator-aarch64, iossimulator-x86_64, linux-aarch64, linux-x86_64, macos-aarch64, macos-x86_64, windows-x86_64

    --prefix
            Specify a different directory to save the binaries. Defaults to the current working directory.
EOF
}




current_target() {
  if [ "$OS" = "Windows_NT" ]; then
    # TODO disambiguate between x86 and arm windows
    target="windows-x86_64"
    return 0
  fi
  case $(uname -sm) in
  "Darwin x86_64") target=macos-x86_64 ;;
  "Darwin arm64") target=macos-aarch64 ;;
  "Linux x86_64") target=linux-x86_64 ;;
  *) target=$(uname -sm);;
  esac
}



process_arguments() {
  while [[ $# -gt 0 ]]; do
      case "$1" in
          --help)
              usage
              exit 0
              ;;
          --target=*)
              target="\${1#*=}"
              ;;
          --prefix=*)
              prefix="\${1#*=}"
              ;;
          static|loadable)
              type="$1"
              ;;
          *)
              echo "Unrecognized option: $1"
              usage
              exit 1
              ;;
      esac
      shift
  done
  if [ -z "$type" ]; then
    type=loadable
  fi
  if [ "$type" != "static" ] && [ "$type" != "loadable" ]; then
      echo "Invalid type '$type'. It must be either 'static' or 'loadable'."
      usage
      exit 1
  fi
  if [ -z "$prefix" ]; then
    prefix="$PWD"
  fi
  if [ -z "$target" ]; then
    current_target
  fi
}




main() {
    local type=""
    local target=""
    local prefix=""
    local url=""
    local checksum=""

    process_arguments "$@"

    echo "${BOLD}Type${RESET}: $type"
    echo "${BOLD}Target${RESET}: $target"
    echo "${BOLD}Prefix${RESET}: $prefix"

    case "$target-$type" in
    "android-aarch64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-android-aarch64.tar.gz"
      checksum="9576fd156a0bd9caa009f9bf8c15e69e69b1246c86607e5232ceafce1951f934"
      ;;
    "ios-aarch64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-ios-aarch64.tar.gz"
      checksum="3fe911095630a401d906facaed1dbec026f0abaec0d9807f607ee73f38191e7f"
      ;;
    "iossimulator-aarch64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-iossimulator-aarch64.tar.gz"
      checksum="a134a7567c1b3fdbb8c411e3fe94621bc736377b3bf18f99277b4103d0f2a3c1"
      ;;
    "macos-aarch64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-macos-aarch64.tar.gz"
      checksum="142e195b654092632fecfadbad2825f3140026257a70842778637597f6b8c827"
      ;;
    "macos-x86_64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-macos-x86_64.tar.gz"
      checksum="35d014e5f7bcac52645a97f1f1ca34fdb51dcd61d81ac6e6ba1c712393fbf8fd"
      ;;
    "android-armv7a-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-android-armv7a.tar.gz"
      checksum="022200d58a3e65c8ab7f8782b04a369a472b80fbb2652af41974a2a9fbfe8239"
      ;;
    "windows-x86_64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-windows-x86_64.tar.gz"
      checksum="f1c615577ad2e692d1e2fe046fe65994dafd8a8cae43e9e864f5f682dc295964"
      ;;
    "android-x86_64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-android-x86_64.tar.gz"
      checksum="8380e02d9b62ac2d17dc04d5fd2a6b31646544b2407d3eadec2e33c30bc426f9"
      ;;
    "linux-x86_64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-linux-x86_64.tar.gz"
      checksum="438e0df29f3f8db3525b3aa0dcc0a199869c0bcec9d7abc5b51850469caf867f"
      ;;
    "android-i686-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-android-i686.tar.gz"
      checksum="c72d3d061192f6066afbbd7f4576af39d3249690af4e01bd00f05f1b2c0337f6"
      ;;
    "iossimulator-x86_64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-iossimulator-x86_64.tar.gz"
      checksum="a404a3d09293faddb0ea1fd42a80460035dbe8216c9318232f81d58612962409"
      ;;
    "linux-aarch64-loadable")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-linux-aarch64.tar.gz"
      checksum="d6e4ba12c5c0186eaab42fb4449b311008d86ffd943e6377d7d88018cffab3aa"
      ;;
    "ios-aarch64-static")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-static-ios-aarch64.tar.gz"
      checksum="63f18a222deb6de992a1edd58998dedc9adf2fa0cf3a56a7192e0be7d8d81651"
      ;;
    "iossimulator-aarch64-static")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-static-iossimulator-aarch64.tar.gz"
      checksum="ade446ea43f2076877ff42f2c9ec93ec12845f8e53b22139ce004ecdb192757c"
      ;;
    "macos-aarch64-static")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-static-macos-aarch64.tar.gz"
      checksum="4d25de24eeaeeae1a5385c5a79ca377049d62ce8800a882780a909423d1bb882"
      ;;
    "macos-x86_64-static")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-static-macos-x86_64.tar.gz"
      checksum="13c3699119c5d02cc72b7a57e3c0e5ad1637a032cd694878a9e988a7cb59658b"
      ;;
    "linux-x86_64-static")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-static-linux-x86_64.tar.gz"
      checksum="7db8a6f3a963c08eabf3fe591dde330757fb1033706bb375f61e496dbb20a3ed"
      ;;
    "iossimulator-x86_64-static")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-static-iossimulator-x86_64.tar.gz"
      checksum="17e44ae9151047a09458cd0dc25c0a2260b4141b69a0557ff8d65e4b58854496"
      ;;
    "linux-aarch64-static")
      url="https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-static-linux-aarch64.tar.gz"
      checksum="f96a4a9cc91d520f27404c4e5819ec6f7ec8052b9ce4d4ff1a7820d4c5ff4190"
      ;;
    *)
      echo "Unsupported platform $target" 1>&2
      exit 1
      ;;
    esac

    extension="\${url##*.}"

    if [ "$extension" = "zip" ]; then
      tmpfile="$prefix/tmp.zip"
    else
      tmpfile="$prefix/tmp.tar.gz"
    fi

    curl --fail --location --progress-bar --output "$tmpfile" "$url"

    if ! echo "$checksum $tmpfile" | sha256sum --check --status; then
      echo "Checksum fail!"  1>&2
      rm $tmpfile
      exit 1
    fi

    if [ "$extension" = "zip" ]; then
      unzip "$tmpfile" -d $prefix
      rm $tmpfile
    else
      tar -xzf "$tmpfile" -C $prefix
      rm $tmpfile
    fi

    echo "✅ $target $type binaries installed at $prefix."
}



main "$@"
