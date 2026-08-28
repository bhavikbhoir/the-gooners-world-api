# Bundled fonts for card rendering

`sharp` rasterises the card's SVG text through librsvg → fontconfig. On AWS
Lambda there are **no system fonts**, so text would render blank unless we ship
one here and point fontconfig at it.

## One-time setup (do this before the first deploy)

Drop the **Oswald** TTFs (our brand font) into this folder, plus DejaVu Sans as a
Unicode fallback:

```bash
cd functions/social/fonts
# Oswald (brand font — used on the cards)
curl -L -o Oswald-Regular.ttf   https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-Regular.ttf
curl -L -o Oswald-Medium.ttf    https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-Medium.ttf
curl -L -o Oswald-SemiBold.ttf  https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-SemiBold.ttf
curl -L -o Oswald-Bold.ttf      https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-Bold.ttf
# Fallback for any glyphs Oswald lacks
curl -L -o DejaVuSans.ttf       https://github.com/dejavu-fonts/dejavu-fonts/raw/master/ttf/DejaVuSans.ttf
```

The cards request the `Oswald` family; fontconfig also maps the legacy `Gooners`
family onto Oswald.

The `socialOrchestrator` and `socialDrafts` functions set
`FONTCONFIG_FILE=/var/task/functions/social/fonts/fonts.conf` so librsvg finds it.

## sharp on Lambda

`sharp` ships a platform-specific native binary. Install the Linux build so the
deploy package matches the Lambda runtime (nodejs20.x, x64):

```bash
npm install --os=linux --cpu=x64 sharp
```

If you deploy from macOS/Windows without this, sharp will fail to load in Lambda.
Alternatively use a sharp Lambda layer.
