# Contributing

Thanks for helping improve Fossel.

## How to contribute

- **Bugs or ideas:** [open an issue](https://github.com/7vignesh/fossel/issues).
- **Code:** fork the repo, create a branch, and open a PR with a clear description of what changed and why.

## Development

```bash
npm install
npm run ci    # typecheck + build + smoke tests
```

Keep changes focused on one concern when possible.

## Publishing

Maintainers: releases use git tags `v*` and CI publishes to npm (see `.github/workflows/publish.yml`). Bump `package.json` version before tagging a new release.
