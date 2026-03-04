# Pi Eval Gondolin Image

This directory contains the version-controlled recipe and lock metadata for the
custom Gondolin image used by `pi-eval`.

## Files

- `pi-eval-image.json`: Gondolin build configuration (includes pinned `pi` package).
- `guest-source.lock.json`: pinned Gondolin guest source repository/ref for image builds.
- `image.lock.json`: generated lock metadata for the built image.
- `scripts/build-image.sh`: builds and verifies the image into `image/current`.
- `scripts/write-image-lock.ts`: emits lock metadata from built assets.
- `vendor/gondolin/`: vendored Gondolin source tracked as a **git subtree** from `https://github.com/bout3fiddy/gondolin.git` (branch `main`, squash-merged).

## Vendored Gondolin (git subtree)

`vendor/gondolin/` is a git subtree of the upstream Gondolin repo. `pi-eval` depends on
`vendor/gondolin/host` via a `file:` dependency instead of the npm-published package, so
local patches are picked up immediately without waiting for an npm release.

### Pull upstream updates

```bash
git subtree pull --prefix=skills-evals/gondolin/vendor/gondolin \
  https://github.com/bout3fiddy/gondolin.git main --squash
```

Then rebuild and reinstall:

```bash
cd skills-evals/gondolin/vendor/gondolin && pnpm install && pnpm --filter @earendil-works/gondolin run build
cd skills-evals/pi-eval && bun install
```

### Notes

- `host/dist/` is gitignored upstream, so it is **not** part of the subtree. You must build after every subtree add/pull.
- `vendor/gondolin/node_modules/` is likewise not tracked; `pnpm install` in the vendor root handles it.

## Image Build

From repo root:

```bash
./skills-evals/gondolin/scripts/build-image.sh
```

Default output directory:

- `skills-evals/gondolin/image/current`

The build script runs:

1. `gondolin build --config ... --output ...`
2. `gondolin build --verify ...`
3. lock generation into `skills-evals/gondolin/image.lock.json`

## Runtime usage

`skills-evals/run.sh` defaults `PI_EVAL_GONDOLIN_IMAGE_PATH` to:

- `skills-evals/gondolin/image/current`

Override when needed:

```bash
PI_EVAL_GONDOLIN_IMAGE_PATH=/abs/path/to/image/current ./skills-evals/run.sh
```

## Notes

- Build requires Docker (or another supported container runtime) because the
  config uses `postBuild.commands` to install `pi` into the guest image.
- Ensure Docker daemon is running before build (`docker run ...` must work).
- Build also requires `git` so the pinned Gondolin guest sources can be fetched
  based on `guest-source.lock.json` when `GONDOLIN_GUEST_SRC` is not provided.
- Rebuild and refresh lock metadata whenever `pi` version or base image inputs change.
