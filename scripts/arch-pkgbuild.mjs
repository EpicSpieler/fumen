// The PKGBUILD for Arch (and CachyOS, EndeavourOS, Manjaro …): the .deb's files, installed on the
// system's own WebKitGTK, GStreamer and Wayland libraries instead of the AppImage's bundled ones.
// Written by linux-build.mjs next to each Linux build (/download/linux-arch); by hand:
//
//   node scripts/arch-pkgbuild.mjs <version> <deb file name> <sha256 of the .deb>
import { fileURLToPath } from "node:url";

const origin = "https://fumen.dertesti.dev";

export function archPkgbuild(version, deb, sha256) {
  return `# Fumen for Arch: the files of Fumen's .deb, on Arch's own WebKitGTK and GStreamer.
#   curl -o PKGBUILD ${origin}/download/linux-arch && makepkg -si
pkgname=fumen-bin
pkgver=${version}
pkgrel=1
pkgdesc="A beatmap library for osu!"
arch=('x86_64')
url="${origin}"
license=('GPL-3.0-or-later')
depends=('webkit2gtk-4.1' 'gtk3' 'gst-plugins-base' 'gst-plugins-good' 'hicolor-icon-theme')
optdepends=('gst-libav: more audio formats')
provides=('fumen')
conflicts=('fumen')
options=('!strip' '!debug')
source=("${deb}::${origin}/updates/${deb}")
sha256sums=('${sha256}')
noextract=("${deb}")

package() {
  cd "$srcdir"
  bsdtar -xf "${deb}" data.tar.gz
  bsdtar -xf data.tar.gz -C "$pkgdir"
}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, deb, sha] = process.argv.slice(2);
  if (!version || !deb || !sha) {
    console.error("usage: node scripts/arch-pkgbuild.mjs <version> <deb file name> <sha256>");
    process.exit(1);
  }
  process.stdout.write(archPkgbuild(version, deb, sha));
}
