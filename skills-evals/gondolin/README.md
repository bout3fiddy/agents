# Pi Eval Gondolin Image

This directory contains the version-controlled recipe and lock metadata for the
custom Gondolin image used by `pi-eval`.

## Files

- `pi-eval-image.json`: Gondolin build configuration (includes pinned `pi` package).
- `guest-source.lock.json`: pinned Gondolin guest source repository/ref for image builds.
- `image.lock.json`: generated lock metadata for the built image.
- `scripts/build-image.sh`: builds and verifies the image into `image/current`.
- `scripts/write-image-lock.ts`: emits lock metadata from built assets.

## Build

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
4. guest source sync into `skills-evals/gondolin/vendor/gondolin` (when needed)

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
