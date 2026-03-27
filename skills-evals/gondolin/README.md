# Pi Eval Gondolin Image

This directory contains the version-controlled recipe and lock metadata for the
custom Gondolin image used by `pi-eval`.

## Files

- `pi-eval-image.json`: Gondolin build configuration (includes pinned `pi` package).
- `guest-source.lock.json`: fallback Gondolin guest source repository/ref for image builds when the installed npm package does not expose guest sources.
- `image.lock.json`: generated lock metadata for the built image.
- `scripts/build-image.sh`: builds and verifies the image into `image/current`.
- `scripts/write-image-lock.ts`: emits lock metadata from built assets.

## Gondolin Package Source

`pi-eval` depends on the published npm package `@earendil-works/gondolin`.
Refresh that dependency from `skills-evals/pi-eval/`:

```bash
cd skills-evals/pi-eval && bun install
```

### Notes

- `scripts/build-image.sh` prefers the installed package's bundled `dist/guest` sources.
- If those guest sources are unavailable, the script falls back to `guest-source.lock.json` and syncs the pinned repo/ref into a cache directory outside the workspace.

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
- Build requires `git` only when the installed Gondolin package does not expose
  guest sources and the script falls back to `guest-source.lock.json`.
- Rebuild and refresh lock metadata whenever `pi` version or base image inputs change.
