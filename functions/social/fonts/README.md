# Bundled fonts for card rendering

`sharp` rasterises the card's SVG text through librsvg → fontconfig. On AWS
Lambda there are **no system fonts**, so text would render blank unless we ship
one here and point fontconfig at it.

## One-time setup (do this before the first deploy)

Drop a **DejaVu Sans** TTF (regular + bold) into this folder:

```bash
cd functions/social/fonts
curl -L -o DejaVuSans.ttf https://github.com/dejavu-fonts/dejavu-fonts/raw/master/ttf/DejaVuSans.ttf
curl -L -o DejaVuSans-Bold.ttf https://github.com/dejavu-fonts/dejavu-fonts/raw/master/ttf/DejaVuSans-Bold.ttf
```

(Any TTF works — if you want a punchier headline font, add it and update the
`<edit>` family name in `fonts.conf` to match.)

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
