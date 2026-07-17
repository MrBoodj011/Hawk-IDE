#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: package-appimage.sh <portable-dir> <version> <output.AppImage>" >&2
  exit 2
fi

portable_dir="$(cd "$1" && pwd)"
version="$2"
output="$(realpath -m "$3")"
work="${RUNNER_TEMP:-/tmp}/hawk-appimage-${version}"
appdir="${work}/Hawk.AppDir"

rm -rf "$work"
mkdir -p "$appdir/usr/share/hawk" "$appdir/usr/share/applications" "$appdir/usr/share/icons/hicolor/512x512/apps"
cp -a "$portable_dir"/. "$appdir/usr/share/hawk/"
cp "$portable_dir/resources/app/resources/linux/code.png" "$appdir/usr/share/icons/hicolor/512x512/apps/hawk.png"

cat > "$appdir/hawk.desktop" <<'DESKTOP'
[Desktop Entry]
Name=Hawk Security IDE
Comment=Security-native AI development environment
Exec=hawk %F
Icon=hawk
Type=Application
Categories=Development;Security;
Terminal=false
MimeType=application/x-hawk-workspace;
DESKTOP
cp "$appdir/hawk.desktop" "$appdir/usr/share/applications/hawk.desktop"
ln -s "usr/share/icons/hicolor/512x512/apps/hawk.png" "$appdir/hawk.png"

cat > "$appdir/AppRun" <<'APP_RUN'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/share/hawk/hawk" "$@"
APP_RUN
chmod 755 "$appdir/AppRun"

tool="${work}/appimagetool-x86_64.AppImage"
curl --fail --location --retry 3 \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage" \
  --output "$tool"
chmod 755 "$tool"
mkdir -p "$(dirname "$output")"
ARCH=x86_64 VERSION="$version" "$tool" --appimage-extract-and-run "$appdir" "$output"
test -s "$output"
